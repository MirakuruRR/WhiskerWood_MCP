import { existsSync, readFileSync } from 'node:fs'
import { ServerConfig } from '../config'
import { GameContext, versionEchoFields } from '../utils/game-context'
import { AiTextResult, renderAiText, Scalar } from '../utils/ai-text'
import { PathSandboxError } from '../utils/path-sandbox'
import { analyzeLua, Analysis, CommentSpan, Reference } from '../utils/lua-analyzer'
import { listSiblingMods, loadModProject, ModProject, relativeTo } from '../utils/mod-project'
import { listInstalledMods, LoadSlot, loadSlot, readLoadOrder } from '../utils/ue4ss-mods'
import { getBridge } from '../utils/bridge-client'
import { findObject, isHookable, ObjectHit, suggestSimilar } from './common'
import { activePitfalls, PitfallHint } from './memory-common'
import { isLevelLoaded } from './bridge-common'

export interface ValidateModArgs {
  mod_root: string
  live?: boolean
}

type Severity = 'error' | 'warn' | 'info'

interface Finding {
  severity: Severity
  code: string
  file: string
  line: number
  column: number
  message: string
  extra?: Record<string, Scalar>
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 }
const CLASS_KINDS = new Set(['Class', 'BlueprintGeneratedClass', 'WidgetBlueprintGeneratedClass'])
const HOOK_FNS = new Set(['RegisterHook', 'WWRegisterHook'])

const MAX_FOREIGN_SOURCE = 512 * 1024

interface HookUse {
  path: string
  file: string
  line: number
}

interface WriteUse {
  key: string
  label: string
  file: string
  line: number
  column: number
  deferred: boolean
}

interface ModSurface {
  hooks: HookUse[]
  writes: WriteUse[]
}

interface ForeignMod {
  name: string
  origin: string
  slot: LoadSlot | null
  surface: ModSurface
}

type ClassResolver = (cls: string) => { key: string; label: string } | null

function classesByName(ctx: GameContext, name: string): Array<{ path: string; kind: string }> {
  return ctx.db
    .query(
      `SELECT path, kind FROM objects
       WHERE name = ? COLLATE NOCASE AND kind IN ('Class','BlueprintGeneratedClass','WidgetBlueprintGeneratedClass')
       LIMIT 5`,
    )
    .all(name) as Array<{ path: string; kind: string }>
}

function expectedArity(ctx: GameContext, functionPath: string): number {
  const row = ctx.db
    .query('SELECT COUNT(*) AS n FROM function_params WHERE function_path = ? AND is_return = 0')
    .get(functionPath) as { n: number }
  return 1 + (row?.n ?? 0)
}

function checkHookPath(
  ctx: GameContext,
  ref: Reference,
  file: string,
  out: Finding[],
  uses: HookUse[],
  probeTargets: Set<string>,
): void {
  const literal = ref.arg!
  const obj: ObjectHit | null = findObject(ctx, literal)
  const at = { file, line: ref.line, column: ref.column }

  if (!obj) {
    const bpish = literal.startsWith('/Game/')
    out.push({
      ...at,
      severity: bpish ? 'warn' : 'error',
      code: bpish ? 'hook_path_not_in_index' : 'hook_path_not_found',
      message: bpish
        ? `${literal}: в индексе нет. BP-путь мог не попасть в дамп — перепроверь ww_verify_hook с live: true при загруженном уровне`
        : `${literal}: такого пути нет в рефлексии — хук молча не сработает`,
      extra: { suggestions: suggestSimilar(ctx, literal, 5).join('; ') || 'нет' },
    })
    probeTargets.add(literal)
    return
  }

  if (obj.kind !== 'Function') {
    out.push({
      ...at,
      severity: 'error',
      code: 'hook_target_not_function',
      message: `${literal} разрешается в ${obj.kind} (${obj.path}); RegisterHook принимает только функцию`,
      extra: obj.object_path ? { object_path: obj.object_path } : {},
    })
    return
  }

  if (!obj.hook_path || !isHookable(obj.kind)) {
    out.push({
      ...at,
      severity: 'error',
      code: 'hook_path_unavailable',
      message: `${obj.path}: хуковый путь не разрезолвлен (${obj.hook_path_status})`,
    })
    return
  }

  if (literal !== obj.hook_path) {
    const noColon = !literal.includes(':')
    out.push({
      ...at,
      severity: 'error',
      code: noColon ? 'hook_path_separator' : 'hook_path_form',
      message: noColon
        ? `${literal}: перед именем функции нужна не точка, а двоеточие`
        : `${literal}: форма пути не совпадает с индексной`,
      extra: { expected: obj.hook_path },
    })
  }

  probeTargets.add(obj.hook_path)
  uses.push({ path: obj.hook_path, file, line: ref.line })

  const expected = expectedArity(ctx, obj.path)
  for (const cb of ref.callbacks) {
    if (cb.slot === 'post' && obj.hook_path.startsWith('/Game/')) {
      out.push({
        file,
        line: cb.line,
        column: 1,
        severity: 'warn',
        code: 'post_hook_on_blueprint',
        message: `${obj.hook_path}: у блюпринтовых функций post-коллбэк на стенде не вызывался — сработает только pre`,
        extra: {
          workaround: 'лови вызов в pre, а правку объекта откладывай через ExecuteWithDelay + ExecuteInGameThread',
          pitfalls_via: 'ww_lua_api symbol=RegisterHook',
        },
      })
    }
    if (cb.hasVararg) continue
    if (cb.params > expected) {
      out.push({
        file,
        line: cb.line,
        column: 1,
        severity: 'warn',
        code: 'hook_callback_arity',
        message: `${cb.slot}-коллбэк объявляет ${cb.params} аргумент(ов), а хук отдаёт ${expected} (Context + параметры функции)`,
        extra: { function_signature_via: 'ww_get_function', function_path: obj.path },
      })
    }
  }
}

function checkObjectPath(ctx: GameContext, ref: Reference, file: string, out: Finding[], probeTargets: Set<string>): void {
  const literal = ref.arg!
  const obj = findObject(ctx, literal)
  const at = { file, line: ref.line, column: ref.column }
  if (!obj) {
    const asset = ctx.db
      .query("SELECT asset_path FROM assets WHERE (asset_path || '.' || name) = ? COLLATE NOCASE LIMIT 1")
      .get(literal) as { asset_path: string } | null
    if (asset) {
      probeTargets.add(literal)
      return
    }
    out.push({
      ...at,
      severity: literal.startsWith('/Game/') ? 'warn' : 'error',
      code: 'object_path_not_found',
      message: `${ref.fn}("${literal}"): пути нет в индексе`,
      extra: { suggestions: suggestSimilar(ctx, literal, 5).join('; ') || 'нет' },
    })
    probeTargets.add(literal)
    return
  }
  const canonical = obj.object_path ?? obj.hook_path
  if (canonical && literal !== canonical) {
    out.push({
      ...at,
      severity: 'warn',
      code: 'object_path_form',
      message: `${literal}: объектная форма пути в индексе записана иначе`,
      extra: { expected: canonical },
    })
  }
  if (canonical) probeTargets.add(canonical)
}

function checkClassName(ctx: GameContext, ref: Reference, file: string, out: Finding[]): void {
  const literal = ref.arg!
  if (literal.startsWith('/')) {
    out.push({
      file,
      line: ref.line,
      column: ref.column,
      severity: 'warn',
      code: 'class_name_expected',
      message: `${ref.fn} принимает короткое имя класса, а не путь: ${literal}`,
      extra: { expected: literal.split(/[.:/]/).pop() ?? literal },
    })
    return
  }
  const hits = classesByName(ctx, literal)
  if (hits.length === 0) {
    out.push({
      file,
      line: ref.line,
      column: ref.column,
      severity: 'error',
      code: 'unknown_class_name',
      message: `${ref.fn}("${literal}"): класса с таким именем нет в индексе`,
      extra: { suggestions: suggestSimilar(ctx, literal, 5).join('; ') || 'нет' },
    })
  }
}

function locateToken(source: string, token: string, comments: CommentSpan[]): { line: number; column: number } | null {
  const lines = source.split(/\r?\n/)
  const inComment = (line: number, column: number): boolean =>
    comments.some((c) => c.line === line && column >= c.from && column <= c.to)
  for (let i = 0; i < lines.length; i++) {
    let at = lines[i].indexOf(token)
    while (at !== -1) {
      const before = at === 0 ? '' : lines[i][at - 1]
      const after = lines[i][at + token.length] ?? ''
      // точка и двоеточие перед токеном это обращение к полю или методу — как раз то, что ловим
      if (!/\w/.test(before) && !/\w/.test(after) && !inComment(i + 1, at + 1)) {
        return { line: i + 1, column: at + 1 }
      }
      at = lines[i].indexOf(token, at + 1)
    }
  }
  return null
}

function checkPitfalls(
  pitfalls: PitfallHint[],
  source: string,
  comments: CommentSpan[],
  file: string,
  out: Finding[],
): number {
  let hits = 0
  for (const p of pitfalls) {
    for (const token of p.tokens) {
      const at = locateToken(source, token, comments)
      if (!at) continue
      hits++
      out.push({
        severity: 'warn',
        code: 'memory_pitfall',
        file,
        line: at.line,
        column: at.column,
        message: `${token}: в проектной памяти на это записаны грабли — ${p.summary}`,
        extra: { public_id: p.public_id, details_via: 'ww_memory_search' },
      })
      break
    }
  }
  return hits
}

/** Один и тот же класс приходит из модов то коротким именем, то путём — сводим к ключу индекса. */
function classResolver(ctx: GameContext): ClassResolver {
  const memo = new Map<string, { key: string; label: string } | null>()
  return (cls) => {
    const cached = memo.get(cls)
    if (cached !== undefined) return cached
    let res: { key: string; label: string } | null = null
    if (cls.startsWith('/')) {
      const obj = findObject(ctx, cls)
      if (obj) res = { key: obj.path, label: obj.name }
    } else {
      const hits = classesByName(ctx, cls)
      if (hits.length === 1) res = { key: hits[0].path, label: cls }
      else if (hits.length > 1) res = { key: `name:${cls.toLowerCase()}`, label: cls }
    }
    memo.set(cls, res)
    return res
  }
}

function collectWrites(resolve: ClassResolver, analysis: Analysis, file: string): WriteUse[] {
  const out: WriteUse[] = []
  const seen = new Set<string>()
  for (const w of analysis.writes) {
    if (!w.cls) continue
    const cls = resolve(w.cls)
    if (!cls) continue
    const key = `${cls.key}#${w.property.toLowerCase()}`
    if (seen.has(`${key}@${w.line}`)) continue
    seen.add(`${key}@${w.line}`)
    out.push({
      key,
      label: `${cls.label}.${w.property}`,
      file,
      line: w.line,
      column: w.column,
      deferred: w.deferred,
    })
  }
  return out
}

function collectSurface(ctx: GameContext, resolve: ClassResolver, mod: ModProject): ModSurface {
  const hooks: HookUse[] = []
  const writes: WriteUse[] = []
  for (const file of mod.luaFiles) {
    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (source.length > MAX_FOREIGN_SOURCE) continue
    const analysis = analyzeLua(source)
    if (analysis.syntaxError) continue
    const rel = relativeTo(mod.root, file)
    for (const ref of analysis.refs) {
      if (!HOOK_FNS.has(ref.fn) || ref.arg === null) continue
      const obj = findObject(ctx, ref.arg)
      hooks.push({ path: obj?.hook_path ?? ref.arg, file: rel, line: ref.line })
    }
    writes.push(...collectWrites(resolve, analysis, rel))
  }
  return { hooks, writes }
}

function collectForeign(ctx: GameContext, config: ServerConfig, resolve: ClassResolver, mod: ModProject): ForeignMod[] {
  const order = readLoadOrder(config)
  const out: ForeignMod[] = []
  const siblings = listSiblingMods(config, mod.root)
  for (const other of siblings) {
    out.push({
      name: other.name,
      origin: 'репозиторий',
      slot: loadSlot(order, other.name),
      surface: collectSurface(ctx, resolve, other),
    })
  }
  // копия репозиторного мода в ue4ss/Mods — это он сам, а не сосед: без этого мод
  // конфликтует со своей же установленной сборкой на каждом хуке
  const known = new Set([mod.name, ...siblings.map((s) => s.name)].map((n) => n.toLowerCase()))
  for (const other of listInstalledMods(config, [mod.root, ...siblings.map((s) => s.root)])) {
    if (known.has(other.dirName.toLowerCase()) || known.has(other.name.toLowerCase())) continue
    out.push({
      name: other.dirName,
      origin: 'установлен',
      slot: loadSlot(order, other.dirName),
      surface: collectSurface(ctx, resolve, other),
    })
  }
  return out
}

function orderNote(mine: LoadSlot | null, other: ForeignMod): string {
  if (!other.slot) return `${other.name} не значится в mods.txt — UE4SS его сейчас не грузит`
  if (!other.slot.enabled) return `${other.name} выключен в mods.txt`
  if (!mine) return 'твоего мода в mods.txt ещё нет: порядок определится после ручного добавления строки'
  if (!mine.enabled) return 'твой мод выключен в mods.txt'
  return mine.index < other.slot.index
    ? `ты грузишься раньше (mods.txt: ты #${mine.index}, ${other.name} #${other.slot.index})`
    : `ты грузишься позже (mods.txt: ${other.name} #${other.slot.index}, ты #${mine.index})`
}

function collisionSeverity(other: ForeignMod): Severity {
  return other.slot?.enabled ? 'warn' : 'info'
}

export async function handleValidateMod(ctx: GameContext, config: ServerConfig, args: ValidateModArgs): Promise<string> {
  const echo = versionEchoFields(ctx)

  let mod: ModProject
  try {
    mod = loadModProject(config, args.mod_root)
  } catch (e) {
    if (e instanceof PathSandboxError) {
      return renderAiText({
        reportType: 'mod_validation',
        fields: {
          ...echo,
          status: 'mod_root_rejected',
          mod_root: args.mod_root,
          sandbox_roots: config.sandboxRoots.join('; '),
        },
      })
    }
    throw e
  }

  if (mod.luaFiles.length === 0) {
    return renderAiText({
      reportType: 'mod_validation',
      fields: {
        ...echo,
        status: 'no_sources',
        mod_root: mod.root,
        hint: 'в каталоге нет ни одного .lua; создай мод через ww_scaffold_mod',
      },
    })
  }

  const pitfalls = activePitfalls(config, mod.name)
  let pitfallHits = 0

  const findings: Finding[] = []
  const probeTargets = new Set<string>()
  const uses: HookUse[] = []
  const myWrites: WriteUse[] = []
  const resolve = classResolver(ctx)
  let dynamicPaths = 0

  if (!existsSync(mod.entry)) {
    findings.push({
      severity: 'error',
      code: 'entry_missing',
      file: relativeTo(mod.root, mod.entry),
      line: 0,
      column: 0,
      message: 'точка входа Scripts/main.lua отсутствует — UE4SS не загрузит мод',
    })
  }

  for (const file of mod.luaFiles) {
    const rel = relativeTo(mod.root, file)
    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch (e) {
      findings.push({ severity: 'error', code: 'unreadable', file: rel, line: 0, column: 0, message: (e as Error).message })
      continue
    }

    const analysis = analyzeLua(source)
    if (analysis.syntaxError) {
      findings.push({
        severity: 'error',
        code: 'syntax_error',
        file: rel,
        line: analysis.syntaxError.line,
        column: analysis.syntaxError.column,
        message: analysis.syntaxError.message,
      })
      continue
    }

    pitfallHits += checkPitfalls(pitfalls, source, analysis.comments, rel, findings)
    myWrites.push(...collectWrites(resolve, analysis, rel))

    for (const lint of analysis.lints) {
      findings.push({ severity: lint.severity, code: lint.code, file: rel, line: lint.line, column: lint.column, message: lint.message })
    }

    if (analysis.usesDirectRegisterHook && !analysis.usesWWRegisterHook) {
      const first = analysis.refs.find((r) => r.fn === 'RegisterHook')
      findings.push({
        severity: 'warn',
        code: 'direct_register_hook',
        file: rel,
        line: first?.line ?? 0,
        column: first?.column ?? 0,
        message:
          'прямой RegisterHook: в dev-цикле (ww_deploy_mod) хуки накопятся при каждой перезагрузке, а на холодном старте упадут на незагруженном классе. Ставь через require("ww.hook").for_mod(MOD, log)',
      })
    }

    if (analysis.usesDirectNotifyOnNewObject) {
      const first = analysis.refs.find((r) => r.fn === 'NotifyOnNewObject')
      findings.push({
        severity: 'warn',
        code: 'direct_notify_on_new_object',
        file: rel,
        line: first?.line ?? 0,
        column: first?.column ?? 0,
        message:
          'прямой NotifyOnNewObject: подписку снять нечем, а Lua-функция глохнет после dev-перезагрузки (ww_deploy_mod) — диспетчер остаётся висеть, но звать уже некого. Ставь через require("ww.watch").for_mod(MOD).on(class, fn)',
      })
    }

    for (const ref of analysis.refs) {
      if (ref.arg === null) {
        dynamicPaths++
        findings.push({
          severity: 'warn',
          code: 'unverifiable_dynamic_path',
          file: rel,
          line: ref.line,
          column: ref.column,
          message: `${ref.fn}: путь собирается динамически, проверить по индексу невозможно`,
        })
        continue
      }
      if (HOOK_FNS.has(ref.fn)) checkHookPath(ctx, ref, rel, findings, uses, probeTargets)
      else if (ref.fn === 'StaticFindObject' || ref.fn === 'StaticConstructObject') checkObjectPath(ctx, ref, rel, findings, probeTargets)
      else if (ref.fn === 'FindFirstOf' || ref.fn === 'FindAllOf') checkClassName(ctx, ref, rel, findings)
      else if (ref.fn === 'NotifyOnNewObject') {
        if (ref.arg.startsWith('/')) checkObjectPath(ctx, ref, rel, findings, probeTargets)
        else checkClassName(ctx, ref, rel, findings)
      }
    }
  }

  const foreign = collectForeign(ctx, config, resolve, mod)
  const mySlot = loadSlot(readLoadOrder(config), mod.name)
  const myHooks = new Map(uses.map((u) => [u.path, u]))
  const myWriteIndex = new Map<string, WriteUse>()
  for (const w of myWrites) if (!myWriteIndex.has(w.key)) myWriteIndex.set(w.key, w)

  let collisions = 0
  let writeCollisions = 0
  for (const other of foreign) {
    const note = orderNote(mySlot, other)
    const severity = collisionSeverity(other)

    for (const use of other.surface.hooks) {
      const hit = myHooks.get(use.path)
      if (!hit) continue
      collisions++
      findings.push({
        severity,
        code: 'hook_collision',
        file: hit.file,
        line: hit.line,
        column: 1,
        message: `на ${use.path} уже вешается мод ${other.name} (${other.origin}, ${use.file}:${use.line}); UE4SS сцепит коллбэки без приоритетов — ${note}`,
      })
    }

    const seenKeys = new Set<string>()
    for (const use of other.surface.writes) {
      const hit = myWriteIndex.get(use.key)
      if (!hit || seenKeys.has(use.key)) continue
      seenKeys.add(use.key)
      writeCollisions++
      findings.push({
        severity,
        code: 'object_write_collision',
        file: hit.file,
        line: hit.line,
        column: hit.column,
        message: `${hit.label} пишет и мод ${other.name} (${other.origin}, ${use.file}:${use.line}); значение останется от того, кто отработает последним`,
        extra:
          hit.deferred || use.deferred
            ? {
                race: 'запись отложена через ExecuteWithDelay: исход определяют тайминги, а не порядок в mods.txt — от запуска к запуску может отличаться',
              }
            : { order: note },
      })
    }
  }

  let liveNote = ''
  let levelLoaded = false
  if (args.live) {
    const bridge = getBridge(config)
    const st = await bridge.readStatusStable()
    if (!bridge.isAlive(st)) {
      liveNote = 'game_not_running: проверка выполнена только по индексу'
    } else if (((levelLoaded = isLevelLoaded(st!.world)), probeTargets.size === 0)) {
      liveNote =
        'нечего пробивать: в моде нет литеральных путей. Имена классов для FindFirstOf/FindAllOf через StaticFindObject не проверяются — их наличие в мире смотри через ww_game_eval'
    } else {
      const targets = [...probeTargets]
      const res = await bridge.call('probe', targets.join('\n'))
      if (res.status !== 'ok') {
        liveNote = `${res.status}: live-проба не выполнена`
      } else {
        liveNote = levelLoaded ? 'ok' : 'ok, но уровень не загружен'
        for (const line of res.body.split('\n')) {
          const m = /^(.*) = (found|not_found) via=(\S+)$/.exec(line.trim())
          if (!m || m[2] === 'found') continue
          const path = m[1]
          findings.push({
            severity: path.startsWith('/Game/') ? 'info' : 'warn',
            code: 'live_not_found',
            file: relativeTo(mod.root, mod.entry),
            line: 0,
            column: 0,
            message: path.startsWith('/Game/')
              ? `${path}: в живой игре не найден, но StaticFindObject видит только загруженное — для BP это не приговор`
              : `${path}: в живой игре не найден (via=${m[3]})`,
          })
        }
      }
    }
  }

  findings.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.file.localeCompare(b.file) || a.line - b.line,
  )

  const errors = findings.filter((f) => f.severity === 'error').length
  const warnings = findings.filter((f) => f.severity === 'warn').length

  const results: AiTextResult[] = findings.map((f) => ({
    fields: {
      severity: f.severity,
      code: f.code,
      at: `${f.file}:${f.line}${f.column ? `:${f.column}` : ''}`,
      message: f.message,
      ...(f.extra ?? {}),
    },
  }))

  return renderAiText({
    reportType: 'mod_validation',
    fields: {
      ...echo,
      status: errors > 0 ? 'invalid' : warnings > 0 ? 'ok_with_warnings' : 'ok',
      mod: mod.name,
      mod_root: mod.root,
      files: mod.luaFiles.length,
      hook_paths_checked: uses.length,
      dynamic_paths: dynamicPaths,
      object_writes: myWriteIndex.size,
      mods_compared: foreign.length,
      load_order: mySlot ? `#${mySlot.index}${mySlot.enabled ? '' : ', выключен'}` : 'нет в mods.txt',
      collisions,
      write_collisions: writeCollisions,
      memory_pitfalls: pitfallHits,
      errors,
      warnings,
      ...(args.live ? { live: liveNote, level_loaded: levelLoaded } : {}),
    },
    results,
  })
}

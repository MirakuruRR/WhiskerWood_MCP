import { existsSync, readFileSync } from 'node:fs'
import { ServerConfig } from '../config'
import { GameContext, versionEchoFields } from '../utils/game-context'
import { AiTextResult, renderAiText, Scalar } from '../utils/ai-text'
import { PathSandboxError } from '../utils/path-sandbox'
import { analyzeLua, Analysis, IgnoreDirective, Reference } from '../utils/lua-analyzer'
import { loadLuaApi } from '../utils/lua-api'
import { listSiblingMods, loadModProject, MOD_DLL, MOD_ENTRY, ModProject, NATIVE_DIR, relativeTo } from '../utils/mod-project'
import {
  checkUe4ssImports,
  describeDll,
  DllInfo,
  gameModDir,
  inspectDll,
  modParts,
  ModParts,
  nativeNewestMtime,
  partsLabel,
  readableSymbol,
  Ue4ssLink,
} from '../utils/mod-native'
import { listInstalledMods, LoadSlot, loadSlot, readLoadOrder } from '../utils/ue4ss-mods'
import { getBridge } from '../utils/bridge-client'
import { findObject, isHookable, ObjectHit, suggestSimilar } from './common'
import { activePitfalls, PitfallHint } from './memory-common'
import { isLevelLoaded } from './bridge-common'

export type ValidateDetail = 'summary' | 'default' | 'full'

export interface ValidateModArgs {
  mod_root: string
  live?: boolean
  detail?: ValidateDetail
  codes?: string[]
  file?: string
  since_last?: boolean
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
const HOOK_FNS = new Set(['RegisterHook', 'WWRegisterHook'])

const MAX_FOREIGN_SOURCE = 512 * 1024

/** Сколько находок одного кода показывать построчно, прежде чем свернуть остальные в список мест. */
const PER_CODE: Record<Severity, number> = { error: Number.POSITIVE_INFINITY, warn: 5, info: 2 }
const COLLAPSED_SITES = 10
const MAX_LINES: Record<ValidateDetail, number> = { summary: 40, default: 60, full: 300 }
const HINTS_SHOWN = 8
const HINT_SUMMARY_CHARS = 160
const HINT_TOKENS_LISTED = 20

/** Пояснение, общее для всех находок кода, печатается один раз. */
const CODE_HINTS: Record<string, string> = {
  hook_path_not_in_index: 'BP-путь мог не попасть в дамп — перепроверь ww_verify_hook с live: true при загруженном уровне',
  post_hook_on_blueprint:
    'лови вызов в pre, а правку объекта откладывай через ExecuteWithDelay + ExecuteInGameThread; грабли — ww_lua_api symbol=RegisterHook',
  hook_callback_arity: 'сигнатура функции — ww_get_function по function_path',
  object_write_collision: 'race=deferred: запись отложена через ExecuteWithDelay, исход решают тайминги, а не порядок в mods.txt',
  unverifiable_dynamic_path: 'путь не литерал и не строковая константа модуля — проверь его вручную через ww_verify_hook',
  memory_pitfall: 'подробности — ww_memory_search по public_id',
}

const IGNORE_VIA = '-- ww:ignore <code|pit-id> (своя и следующая строка), -- ww:ignore-file <code|pit-id>, "validate_ignore": [...] в mod.json'

/** Ключевые слова и стандартная библиотека Lua, общие слова из кода хуков: как триггеры граблей срабатывают везде. */
const TRIGGER_STOPWORDS = new Set([
  'function', 'return', 'local', 'then', 'else', 'elseif', 'while', 'repeat', 'until', 'break', 'goto', 'true', 'false',
  'pairs', 'ipairs', 'require', 'coroutine', 'string', 'table', 'math', 'print', 'type', 'tostring', 'tonumber',
  'select', 'next', 'pcall', 'xpcall', 'error', 'assert', 'setmetatable', 'getmetatable', 'rawget', 'rawset', 'unpack',
  'self', 'Context', 'index', 'build', 'poll', 'value', 'name', 'path',
])

/** Записи про pak-моды Loom к Lua-коду не относятся. */
const LOOM_TOPIC_TAGS = new Set(['loom', 'lift', 'LoomBuild', 'lm', 'types.json', 'CUE4Parse'])

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

interface SourceFile {
  rel: string
  source: string
  analysis: Analysis
}

interface MemoryHint {
  public_id: string
  summary: string
  tokens: string[]
  sites: string[]
}

type ClassResolver = (cls: string) => { key: string; label: string } | null

/** Прошлый прогон по каждому моду — для since_last; живёт, пока жив процесс сервера. */
const lastRuns = new Map<string, Map<string, string>>()

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

function moduleName(rel: string): string {
  return rel.replace(/^Scripts\//, '').replace(/\.lua$/, '').replace(/\//g, '.')
}

/** Два прохода: сначала строковые константы модулей, потом разбор с ними — `guild.CLASS` из require перестаёт быть динамическим. */
function analyzeFiles(root: string, files: string[], maxSource = Number.POSITIVE_INFINITY): { sources: SourceFile[]; unreadable: Finding[] } {
  const raw: Array<{ rel: string; source: string; analysis: Analysis }> = []
  const unreadable: Finding[] = []
  for (const file of files) {
    const rel = relativeTo(root, file)
    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch (e) {
      unreadable.push({ severity: 'error', code: 'unreadable', file: rel, line: 0, column: 0, message: (e as Error).message })
      continue
    }
    if (source.length > maxSource) continue
    raw.push({ rel, source, analysis: analyzeLua(source) })
  }
  const externals = new Map<string, string>()
  for (const f of raw) {
    for (const [k, v] of f.analysis.exports) externals.set(`${moduleName(f.rel)}.${k}`, v)
  }
  if (externals.size === 0) return { sources: raw, unreadable }
  return {
    sources: raw.map((f) => (f.analysis.syntaxError ? f : { ...f, analysis: analyzeLua(f.source, externals) })),
    unreadable,
  }
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
      message: bpish ? `${literal}: в индексе нет` : `${literal}: такого пути нет в рефлексии — хук молча не сработает`,
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
        extra: { function_path: obj.path },
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
      severity: ref.viaConstant ? 'warn' : 'error',
      code: 'unknown_class_name',
      message: ref.viaConstant
        ? `${ref.fn}(${literal}): класса с таким именем нет в индексе — значение взято из константы; если класс создаёт сам мод, погаси ww:ignore`
        : `${ref.fn}("${literal}"): класса с таким именем нет в индексе`,
      extra: { suggestions: suggestSimilar(ctx, literal, 5).join('; ') || 'нет' },
    })
  }
}

function luaApiSymbols(config: ServerConfig): Set<string> {
  try {
    return new Set(loadLuaApi(config).flatMap((e) => [e.symbol, e.symbol.split(/[.:]/).pop() ?? e.symbol]))
  } catch {
    return new Set()
  }
}

/** Триггер — то, что похоже на символ кода: имя из справочника UE4SS или идентификатор с `_`, `.`, `:` либо двумя заглавными. */
function isTrigger(token: string, api: Set<string>): boolean {
  if (TRIGGER_STOPWORDS.has(token)) return false
  return api.has(token) || /[_.:]/.test(token) || /[a-z][A-Z]/.test(token) || /[A-Z].*[A-Z]/.test(token)
}

function luaPitfalls(config: ServerConfig, modName: string): PitfallHint[] {
  const api = luaApiSymbols(config)
  const out: PitfallHint[] = []
  for (const p of activePitfalls(config, modName)) {
    if (p.tags.some((t) => LOOM_TOPIC_TAGS.has(t))) continue
    const tokens = p.tokens.filter((t) => isTrigger(t, api))
    if (tokens.length > 0) out.push({ ...p, tokens })
  }
  return out
}

function ignoredAt(directives: IgnoreDirective[], ids: string[], line: number): boolean {
  return directives.some(
    (d) =>
      (d.file || d.line === line || d.line + 1 === line) && (d.ids.length === 0 || d.ids.some((id) => ids.includes(id))),
  )
}

function collectHints(
  pitfalls: PitfallHint[],
  sources: SourceFile[],
  modIgnores: Set<string>,
  ignores: Map<string, IgnoreDirective[]>,
): { hints: MemoryHint[]; ignored: number } {
  const hints: MemoryHint[] = []
  let ignored = 0
  for (const p of pitfalls) {
    if (modIgnores.has(p.public_id) || modIgnores.has('memory_pitfall')) {
      ignored++
      continue
    }
    const ids = [p.public_id, 'memory_pitfall']
    const tokens = new Set<string>()
    const sites: string[] = []
    let suppressed = false
    for (const f of sources) {
      const directives = ignores.get(f.rel) ?? []
      for (const token of p.tokens) {
        for (const site of f.analysis.symbols.get(token) ?? []) {
          if (ignoredAt(directives, ids, site.line)) {
            suppressed = true
            continue
          }
          tokens.add(token)
          const label = `${f.rel}:${site.line}`
          if (!sites.includes(label)) sites.push(label)
        }
      }
    }
    if (sites.length > 0) hints.push({ public_id: p.public_id, summary: p.summary, tokens: [...tokens], sites })
    else if (suppressed) ignored++
  }
  return { hints, ignored }
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
  for (const { rel, analysis } of analyzeFiles(mod.root, mod.luaFiles, MAX_FOREIGN_SOURCE).sources) {
    if (analysis.syntaxError) continue
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

interface NativeCheck {
  info: DllInfo
  link: Ue4ssLink | null
}

function checkNative(config: ServerConfig, mod: ModProject, parts: ModParts, findings: Finding[]): NativeCheck | null {
  const at = (file: string): Pick<Finding, 'file' | 'line' | 'column'> => ({ file, line: 0, column: 0 })
  if (!parts.dll) {
    if (parts.native) {
      findings.push({
        severity: 'warn',
        code: 'dll_not_built',
        ...at(NATIVE_DIR),
        message: `есть исходники ${NATIVE_DIR}/, но нет ${MOD_DLL}: нативная часть не собрана, и в игру её ставить нечем`,
      })
    }
    return null
  }
  const info = inspectDll(`${mod.root}/${MOD_DLL}`)
  if (!info) return null
  if (info.machine !== 'x64') {
    findings.push({
      severity: 'error',
      code: 'dll_not_x64',
      ...at(MOD_DLL),
      message: `${MOD_DLL}: ${info.machine}, а игра 64-битная — UE4SS её не загрузит`,
    })
  }
  const link = checkUe4ssImports(`${mod.root}/${MOD_DLL}`, config.ue4ssDir)
  if (link && link.missing.length > 0) {
    findings.push({
      severity: 'error',
      code: 'dll_missing_ue4ss_symbols',
      ...at(MOD_DLL),
      message: `${link.missing.length} из ${link.imported} символов, которые DLL берёт из UE4SS.dll, установленная UE4SS не экспортирует — LoadLibrary откажет, и C++-часть не стартует. DLL собрана под другую версию UE4SS: пересобери под установленную. Нет: ${link.missing.slice(0, 5).map(readableSymbol).join('; ')}${link.missing.length > 5 ? ' …' : ''}`,
      extra: { missing_mangled: link.missing.slice(0, 5).join(' ') },
    })
  }
  if (parts.native) {
    const newest = nativeNewestMtime(mod.root)
    if (newest > info.mtimeMs) {
      findings.push({
        severity: 'warn',
        code: 'dll_stale',
        ...at(MOD_DLL),
        message: `исходники ${NATIVE_DIR}/ новее ${MOD_DLL} на ${Math.ceil((newest - info.mtimeMs) / 60000)} мин: пересобери, иначе в игру и в релиз уйдёт старая DLL`,
      })
    }
  }
  const inGame = inspectDll(`${gameModDir(config.ue4ssDir, mod.name)}/${MOD_DLL}`)
  if (!inGame) {
    findings.push({
      severity: 'info',
      code: 'dll_not_in_game',
      ...at(MOD_DLL),
      message: `в каталоге игры нет ${MOD_DLL}: ww_deploy_mod положит её, подхватится при старте игры`,
    })
  } else if (inGame.sha !== info.sha) {
    findings.push({
      severity: 'info',
      code: 'dll_differs_in_game',
      ...at(MOD_DLL),
      message: `в каталоге игры другая сборка DLL (sha256:${inGame.sha}): ww_deploy_mod подменит её, подхватится после перезапуска игры`,
    })
  }
  return { info, link }
}

function atLabel(f: Finding): string {
  return `${f.file}:${f.line}${f.column ? `:${f.column}` : ''}`
}

function findingKey(f: Finding): string {
  return `${f.code}|${f.file}|${f.message}`
}

function findingLine(f: Finding): string {
  const extra = Object.entries(f.extra ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
  return `${f.severity} ${f.code} ${atLabel(f)} — ${f.message}${extra ? ` [${extra}]` : ''}`
}

function renderFindings(findings: Finding[], detail: ValidateDetail): string[] {
  const lines: string[] = []
  let i = 0
  while (i < findings.length) {
    let j = i
    while (j < findings.length && findings[j].code === findings[i].code && findings[j].severity === findings[i].severity) j++
    const group = findings.slice(i, j)
    const sev = group[0].severity
    const limit = detail === 'full' ? Number.POSITIVE_INFINITY : detail === 'summary' && sev !== 'error' ? 0 : PER_CODE[sev]
    for (const f of group.slice(0, limit)) lines.push(findingLine(f))
    const rest = group.slice(limit)
    if (rest.length > 0) {
      const sites = rest.slice(0, COLLAPSED_SITES).map(atLabel).join(', ')
      lines.push(
        `${sev} ${group[0].code} ×${rest.length}${limit > 0 ? ' ещё' : ''}: ${sites}${rest.length > COLLAPSED_SITES ? ' …' : ''}`,
      )
    }
    i = j
  }
  return lines
}

function renderHints(hints: MemoryHint[], detail: ValidateDetail): string[] {
  const shown = detail === 'full' ? hints : detail === 'summary' ? [] : hints.slice(0, HINTS_SHOWN)
  const lines = shown.map((h) => {
    const sites = h.sites.slice(0, 3).join(', ') + (h.sites.length > 3 ? ` +${h.sites.length - 3}` : '')
    const summary =
      detail === 'full' || h.summary.length <= HINT_SUMMARY_CHARS ? h.summary : `${h.summary.slice(0, HINT_SUMMARY_CHARS)}…`
    return `${h.public_id} [${h.tokens.join(', ')} @ ${sites}] ${summary}`
  })
  const rest = hints.slice(shown.length)
  if (rest.length > 0) {
    const tokens = [...new Set(rest.flatMap((h) => h.tokens))]
    const listed = tokens.slice(0, HINT_TOKENS_LISTED).join(', ') + (tokens.length > HINT_TOKENS_LISTED ? ' …' : '')
    lines.push(
      `${shown.length > 0 ? '…ещё ' : ''}${rest.length} записей по символам: ${listed} — detail: "full" или ww_memory_search по символу`,
    )
  }
  return lines
}

function countByCode(findings: Finding[]): string {
  const counts = new Map<string, number>()
  for (const f of findings) counts.set(f.code, (counts.get(f.code) ?? 0) + 1)
  return [...counts].map(([c, n]) => `${c}=${n}`).join(' ')
}

export async function handleValidateMod(ctx: GameContext, config: ServerConfig, args: ValidateModArgs): Promise<string> {
  const echo = versionEchoFields(ctx)
  const detail = args.detail ?? 'default'

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

  const parts = modParts(mod.root, mod.meta?.entry ?? MOD_ENTRY)
  if (mod.luaFiles.length === 0 && !parts.dll && !parts.native) {
    return renderAiText({
      reportType: 'mod_validation',
      fields: {
        ...echo,
        status: 'no_sources',
        mod_root: mod.root,
        hint: 'в Scripts/ нет ни одного .lua; создай мод через ww_scaffold_mod',
      },
    })
  }

  const findings: Finding[] = []
  const probeTargets = new Set<string>()
  const uses: HookUse[] = []
  const myWrites: WriteUse[] = []
  const resolve = classResolver(ctx)
  const dynamic: Finding[] = []
  const ignores = new Map<string, IgnoreDirective[]>()
  const modIgnores = new Set(mod.meta?.validate_ignore ?? [])

  const dllInfo = checkNative(config, mod, parts, findings)

  if (!existsSync(mod.entry) && (mod.luaFiles.length > 0 || !parts.dll)) {
    findings.push({
      severity: parts.dll ? 'warn' : 'error',
      code: 'entry_missing',
      file: relativeTo(mod.root, mod.entry),
      line: 0,
      column: 0,
      message: parts.dll
        ? 'Lua-файлы есть, а точки входа Scripts/main.lua нет — UE4SS загрузит только DLL'
        : 'точка входа Scripts/main.lua отсутствует — UE4SS не загрузит мод',
    })
  }

  const { sources, unreadable } = analyzeFiles(mod.root, mod.luaFiles)
  findings.push(...unreadable)

  for (const { rel, analysis } of sources) {
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

    ignores.set(rel, analysis.ignores)
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
        dynamic.push({
          severity: 'info',
          code: 'unverifiable_dynamic_path',
          file: rel,
          line: ref.line,
          column: ref.column,
          message: `${ref.fn}: путь собирается динамически`,
        })
        continue
      }
      if (HOOK_FNS.has(ref.fn)) checkHookPath(ctx, ref, rel, findings, uses, probeTargets)
      else if (ref.fn === 'StaticFindObject') checkObjectPath(ctx, ref, rel, findings, probeTargets)
      else if (ref.fn === 'FindFirstOf' || ref.fn === 'FindAllOf') checkClassName(ctx, ref, rel, findings)
      else if (ref.fn === 'NotifyOnNewObject') {
        if (ref.arg.startsWith('/')) checkObjectPath(ctx, ref, rel, findings, probeTargets)
        else checkClassName(ctx, ref, rel, findings)
      }
    }
  }

  findings.push(...dynamic)

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
        message: `${hit.label} пишет и мод ${other.name} (${other.origin}, ${use.file}:${use.line}); значение останется от того, кто отработает последним — ${note}`,
        extra: hit.deferred || use.deferred ? { race: 'deferred' } : {},
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

  const active = findings.filter(
    (f) => !modIgnores.has(f.code) && !ignoredAt(ignores.get(f.file) ?? [], [f.code], f.line),
  )
  const { hints, ignored: ignoredHints } = collectHints(luaPitfalls(config, mod.name), sources, modIgnores, ignores)
  const ignored = findings.length - active.length + ignoredHints

  active.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.code.localeCompare(b.code) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  )

  const errors = active.filter((f) => f.severity === 'error').length
  const warnings = active.filter((f) => f.severity === 'warn').length
  const infos = active.length - errors - warnings

  const current = new Map<string, string>()
  for (const f of active) current.set(findingKey(f), `${f.code} ${atLabel(f)}`)
  for (const h of hints) current.set(`memory|${h.public_id}`, `memory_pitfall ${h.public_id}`)
  const baseline = lastRuns.get(mod.root)
  lastRuns.set(mod.root, current)
  const diff = args.since_last && baseline !== undefined
  const isNew = (key: string): boolean => !diff || !baseline!.has(key)
  const resolved = diff ? [...baseline!].filter(([k]) => !current.has(k)).map(([, label]) => label) : []
  const newCount = [...current.keys()].filter(isNew).length

  const fileFilter = args.file?.replace(/\\/g, '/').toLowerCase()
  const shownFindings = active.filter(
    (f) =>
      isNew(findingKey(f)) &&
      (!args.codes || args.codes.includes(f.code)) &&
      (!fileFilter || f.file.toLowerCase().includes(fileFilter)),
  )
  const shownHints = hints.filter(
    (h) =>
      isNew(`memory|${h.public_id}`) &&
      (!args.codes || args.codes.includes('memory_pitfall')) &&
      (!fileFilter || h.sites.some((s) => s.toLowerCase().includes(fileFilter))),
  )

  const limit = MAX_LINES[detail]
  let findingLines = renderFindings(shownFindings, detail)
  let hintLines = renderHints(shownHints, detail)
  const total = findingLines.length + hintLines.length
  const truncated = total > limit
  if (truncated) {
    findingLines = findingLines.slice(0, limit)
    hintLines = hintLines.slice(0, Math.max(0, limit - findingLines.length))
  }

  const shownCodes = new Set(shownFindings.map((f) => f.code))
  if (hintLines.length > 0) shownCodes.add('memory_pitfall')
  const legend = [...shownCodes].filter((c) => CODE_HINTS[c]).map((c) => `${c}: ${CODE_HINTS[c]}`)
  if (findingLines.length + hintLines.length > 0) legend.push(`погасить: ${IGNORE_VIA}`)

  const results: AiTextResult[] = []
  if (findingLines.length > 0) results.push({ fields: { section: 'findings' }, blocks: { findings: findingLines.join('\n') } })
  if (hintLines.length > 0) results.push({ fields: { section: 'memory_hints' }, blocks: { memory_hints: hintLines.join('\n') } })
  if (legend.length > 0) results.push({ fields: { section: 'legend' }, blocks: { legend: legend.join('\n') } })

  const nonZero = (fields: Record<string, number>): Record<string, number> =>
    Object.fromEntries(Object.entries(fields).filter(([, v]) => v > 0))

  return renderAiText({
    reportType: 'mod_validation',
    fields: {
      ...echo,
      status: errors > 0 ? 'invalid' : warnings > 0 ? 'ok_with_warnings' : 'ok',
      mod: mod.name,
      mod_root: mod.root,
      parts: partsLabel(parts),
      ...(dllInfo ? { dll: describeDll(dllInfo.info) } : {}),
      ...(dllInfo?.link
        ? {
            ue4ss_imports:
              dllInfo.link.missing.length === 0
                ? `${dllInfo.link.imported}, все есть в установленной UE4SS.dll`
                : `${dllInfo.link.imported}, не хватает ${dllInfo.link.missing.length}`,
          }
        : {}),
      files: mod.luaFiles.length,
      hook_paths_checked: uses.length,
      mods_compared: foreign.length,
      load_order: mySlot ? `#${mySlot.index}${mySlot.enabled ? '' : ', выключен'}` : 'нет в mods.txt',
      ...nonZero({
        dynamic_paths: dynamic.length,
        object_writes: myWriteIndex.size,
        collisions,
        write_collisions: writeCollisions,
      }),
      errors,
      warnings,
      ...nonZero({ info: infos, memory_hints: hints.length, ignored }),
      ...(active.length > 0 ? { by_code: countByCode(active) } : {}),
      ...(args.since_last
        ? {
            since_last: diff
              ? `новых ${newCount}, ушло ${resolved.length}, без изменений ${current.size - newCount}`
              : 'прошлого прогона в этой сессии сервера нет — показано всё',
            ...(resolved.length > 0
              ? { resolved: resolved.slice(0, 10).join('; ') + (resolved.length > 10 ? ` …ещё ${resolved.length - 10}` : '') }
              : {}),
          }
        : {}),
      ...(args.live ? { live: liveNote, level_loaded: levelLoaded } : {}),
    },
    results,
    ...(truncated ? { truncated: true, totalFound: total, limit } : {}),
  })
}

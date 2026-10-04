import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { ServerConfig } from '../config'
import { GameContext, versionEchoFields } from '../utils/game-context'
import { AiTextResult, renderAiText, FTS_LIMIT, MAX_RESULTS } from '../utils/ai-text'
import { buildFtsQuery, tokenizePattern } from '../utils/fts'
import { KitPaths, requireKit, KitNotConfigured } from '../utils/kit'
import { loomLift } from '../utils/loom'
import { buildSidecar, SidecarError, sidecarExePath } from '../scripts/index-gamedata'
import { normalizeUserPath } from '../scripts/parsers/path-forms'
import { findObject, suggestSimilar, ObjectHit } from './common'
import { pakReaderFor } from '../utils/asset-extract'
import { findSteamGame, WHISKERWOOD_APP_ID } from '../utils/steam-locate'
import { classExport, classNameOf, preprocessExports, printedItems } from '../utils/lift-json'
import {
  applyFallback,
  applyMarks,
  bytecodePath,
  classifyLoomRun,
  deadEnd,
  dropWidgetTree,
  failureChunk,
  firstLine,
  isInside,
  LIFT_RULES_VERSION,
  LiftMark,
  pushMark,
  stampOf,
  stubUnsupportedFunctions,
} from '../utils/lift-fallback'

export interface LiftArgs {
  asset_path?: string
  pattern?: string
  limit?: number
  refresh?: boolean
  version?: string
}

const MAX_ITERATIONS = 40
const MAX_MARKS_SHOWN = 40
const LOOM_TIMEOUT_MS = 120_000
const SIDECAR_TIMEOUT_MS = 180_000
const SNIPPET_CONTEXT = 3
const SNIPPET_LINE_MAX = 200

interface Target {
  assetPath: string
  pakDir: string
  usmap: string
  uplugin: string | null
  mod: string | null
  resolvedBy: string
}

interface Stats {
  hexKeys: number
  tinyFloats: number
}

export async function handleLift(ctx: GameContext, config: ServerConfig, args: LiftArgs): Promise<string> {
  const echo = versionEchoFields(ctx)
  const fail = (status: string, extra: Record<string, string | number | boolean> = {}) =>
    renderAiText({
      reportType: 'blueprint_lift',
      fields: { ...echo, status, ...(args.asset_path ? { asset_path: args.asset_path } : {}), ...extra },
    })

  const assetPath = typeof args.asset_path === 'string' ? args.asset_path.trim() : ''
  const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : ''
  if (assetPath.length > 0 && pattern.length > 0) {
    return fail('args_conflict', {
      error: 'asset_path и pattern заданы вместе',
      hint: 'это два разных режима: asset_path поднимает один Blueprint в исходник, pattern ищет по уже поднятому коду всей игры. Оставь что-то одно.',
    })
  }
  if (assetPath.length === 0 && pattern.length === 0) {
    return fail('args_missing', {
      error: 'не задан ни asset_path, ни pattern',
      hint: 'asset_path="BP_PlayHud" поднимает один Blueprint в исходник Loom, pattern="SetWorkFilter" ищет по поднятому коду всей игры (функция, строка, сниппет). Задай ровно одно.',
    })
  }
  if (pattern.length > 0) return handleCodePattern(ctx, pattern, args.limit)

  let kit: KitPaths
  try {
    kit = requireKit(config)
  } catch (e) {
    if (e instanceof KitNotConfigured) {
      return fail('kit_not_configured', {
        error: e.message,
        hint: 'мод-кит не настроен: пропиши kitDir через /ww-setup — подъём идёт loom.exe из кита и по его types.json',
      })
    }
    throw e
  }

  const usmap = newestUsmap(config.dumpsDir)
  if (!usmap) {
    return fail('no_usmap', {
      dumps_dir: config.dumpsDir,
      hint: 'нет .usmap: сними дампы (ww_capture_dumps), затем bun run dumps:pull',
    })
  }

  const target = resolveTarget(ctx, config, kit, assetPath, usmap)
  if ('status' in target) {
    const suggestions = suggestSimilar(ctx, assetPath)
    return fail(target.status, {
      ...target.extra,
      suggestions: suggestions.length > 0 ? suggestions.join('; ') : 'нет',
    })
  }

  const scratch = `${config.liftDir}/${ctx.gameVersion}`
  if (isInside(scratch, kit.kitDir)) {
    return fail('scratch_inside_kit', {
      scratch,
      hint: 'подъём в <кит>/Content запрещён: LoomBuild собрал бы поднятый исходник поверх игрового BP',
    })
  }
  try {
    ensureScratch(scratch, kit)
  } catch (e) {
    return fail('scratch_failed', { scratch, error: (e as Error).message })
  }

  const key = shortHash(`${target.pakDir}|${target.assetPath}`)
  const cacheFile = `${scratch}/cache/${key}.json`
  const cacheStampNow = () =>
    [
      `rules${LIFT_RULES_VERSION}`,
      `sidecar:${stampOf(sidecarExePath(config))}`,
      stampOf(`${scratch}/Intermediate/Loom/types.json`),
      ctx.indexRevision,
      paksStamp(target.pakDir),
    ].join('|')
  const cacheStamp = cacheStampNow()
  if (!args.refresh) {
    const cached = readCache(cacheFile, cacheStamp)
    if (cached) {
      return renderLift({
        echo,
        status: 'cached',
        target,
        className: cached.className,
        scratch,
        lmPath: cached.lmPath,
        text: cached.text,
        marks: cached.marks,
        stats: cached.stats,
        iterations: cached.iterations,
        cached: true,
      })
    }
  }

  const workJson = `${scratch}/work/${key}.json`
  mkdirSync(dirname(workJson), { recursive: true })

  let sidecarLog = ''
  const sidecarStart = Date.now()
  let exports: unknown[]
  try {
    sidecarLog = runSidecarJson(config, target, workJson)
    exports = JSON.parse(readFileSync(workJson, 'utf8')) as unknown[]
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return fail('export_failed', {
      error: firstLine(message),
      sidecar_ms: Date.now() - sidecarStart,
      hint: 'сайдкар WwParse не отдал JSON пакета: смотри ww_index_status и наличие паков',
    })
  }
  const sidecarMs = Date.now() - sidecarStart

  if (!classExport(exports)) {
    const types = [...new Set(exports.map((e) => (e as { Type?: string }).Type).filter(Boolean))].slice(0, 12)
    return fail('not_blueprint', {
      exports: exports.length,
      export_types: types.join(', ') || 'нет',
      hint: 'в пакете нет BlueprintGeneratedClass: поднимать нечего',
    })
  }

  const stats = preprocessExports(exports)
  const className = classNameOf(exports)
  const marks: LiftMark[] = []
  const addMark = (mark: LiftMark) => pushMark(marks, mark)
  stubUnsupportedFunctions(exports, addMark)

  const relPath = relativeGamePath(target.assetPath)
  const expectedLm = relPath ? `${scratch}/Content/${relPath}.lm` : null
  let iteration = 0
  let lastError = ''
  let lmPath: string | null = null
  let text = ''
  const loomStart = Date.now()

  for (iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    const serialized = JSON.stringify(exports)
    writeFileSync(workJson, serialized)
    const res = await loomLift(kit, [workJson], scratch, { cwd: scratch, timeoutMs: LOOM_TIMEOUT_MS })
    const run = classifyLoomRun(res)
    if (run.kind === 'ok') {
      const wrote = /^wrote\s+(.+)$/m.exec(res.stdout)?.[1]?.trim()
      const candidate = wrote && existsSync(wrote) ? wrote : expectedLm
      if (!candidate || !existsSync(candidate)) {
        lastError = `loom lift вышел без ошибки, но файла нет: ${candidate ?? '(путь неизвестен)'}`
        break
      }
      if (!isInside(candidate, scratch)) {
        const removed = isInside(candidate, config.liftDir) ? (rmSync(candidate, { force: true }), true) : false
        return fail('wrote_outside_scratch', {
          written: candidate,
          scratch,
          removed,
          hint:
            'loom lift записал исходник вне скретч-проекта: подъём в <кит>/Content запрещён, файл не тронут' +
            (removed ? ' (внутри state/lift он убран)' : ''),
        })
      }
      lmPath = candidate
      text = readFileSync(lmPath, 'utf8')
      break
    }
    lastError = run.error
    if (run.kind === 'unavailable') break
    let fix: string | null = null
    if (run.kind === 'overflow' || run.kind === 'silent') {
      const reason = run.kind === 'overflow' ? 'переполнение стека в подъёме' : 'подъём умер без вывода'
      if (dropWidgetTree(exports, reason, addMark)) fix = 'выброшено дерево виджетов'
    }
    fix ??= applyFallback(exports, failureChunk(lastError, target.assetPath), addMark)
    // отказ, который фолбэк не изменил, повторится тем же текстом: дальше итерации бессмысленны
    if (!fix || JSON.stringify(exports) === serialized) break
  }

  const loomMs = Date.now() - loomStart
  if (!text || !lmPath) {
    const dead = lastError ? deadEnd(failureChunk(lastError, target.assetPath)) : null
    return fail('lift_failed', {
      error: firstLine(lastError) || 'подъём не удался',
      iterations: iteration,
      marks: marks.length,
      scratch,
      ...(dead ? { dead_end: dead } : {}),
      hint: dead
        ? 'этот отказ фолбэками не лечится: логику читай через ww_get_bytecode'
        : 'Loom 0.1.0 отказывает на пакет целиком: часть отказов фолбэками не лечится, смотри ww_get_bytecode',
      ...(sidecarLog ? { sidecar_log: firstLine(sidecarLog) } : {}),
    })
  }

  const marked = applyMarks(text, marks, (name) => bytecodePath(target.assetPath, className, name))
  writeFileSync(lmPath, marked)
  writeCache(cacheFile, {
    lmPath,
    text: marked,
    marks,
    stats,
    iterations: iteration,
    stamp: cacheStampNow(),
    assetPath: target.assetPath,
    className,
  })

  return renderLift({
    echo,
    status: 'lifted',
    target,
    className,
    scratch,
    lmPath,
    text: marked,
    marks,
    stats,
    iterations: iteration,
    cached: false,
    extra: {
      sidecar_ms: sidecarMs,
      loom_ms: loomMs,
      ...(sidecarLog ? { sidecar_log: firstLine(sidecarLog) } : {}),
    },
  })
}

interface CodeHitRow {
  function_path: string
  name: string
  kind: string
  asset_path: string
  file: string
  line_from: number
  line_to: number
  stub: number
  text: string
}

/** Поиск по поднятому коду игры: FTS по телам функций, строка и сниппет берутся из самого .lm. */
function handleCodePattern(ctx: GameContext, pattern: string, limit?: number): string {
  const echo = versionEchoFields(ctx)
  const fail = (status: string, extra: Record<string, string | number | boolean> = {}) =>
    renderAiText({ reportType: 'code_search', fields: { ...echo, status, query: pattern, ...extra } })

  const fts = buildFtsQuery(pattern)
  const tokens = tokenizePattern(pattern)
  if (!fts || tokens.length === 0) return fail('error', { error: 'пустой запрос' })

  const table = ctx.db
    .query("SELECT name FROM sqlite_master WHERE name = 'code_fts' AND type = 'table'")
    .get() as { name: string } | null
  if (!table) {
    return fail('no_code_index', {
      hint: 'в этом профиле нет поиска по коду игры: таблицы подъёма наполняет шаг сборки профиля (bun run setup), а этот профиль собран до его появления. Без мод-кита шаг пропускается, и поиск по коду недоступен.',
    })
  }

  const status = ctx.db.query("SELECT value FROM profile_meta WHERE key = 'lift_status'").get() as { value: string } | null
  const functions = ctx.db.query("SELECT value FROM profile_meta WHERE key = 'lift_functions'").get() as
    | { value: string }
    | null
  if ((functions?.value ?? '0') === '0') {
    const reason = ctx.db.query("SELECT value FROM profile_meta WHERE key = 'lift_skip_reason'").get() as
      | { value: string }
      | null
    return fail('no_code_index', {
      lift_status: status?.value ?? 'нет',
      ...(reason?.value ? { lift_skip_reason: reason.value } : {}),
      hint: 'код игры не поднят: пустой индекс подъёма. Причину смотри в profile_meta (lift_skip_reason, lift_last_error)',
    })
  }

  const max = Math.min(Math.max(limit ?? FTS_LIMIT, 1), MAX_RESULTS)
  const rows = ctx.db
    .query(
      `SELECT c.function_path, c.name, c.kind, c.asset_path, c.file, c.line_from, c.line_to, c.stub, c.text
       FROM code_fts f JOIN code_functions c ON c.rowid = f.rowid
       WHERE code_fts MATCH ?
       ORDER BY bm25(code_fts, 8.0, 4.0, 1.0)
       LIMIT ?`,
    )
    .all(fts, max) as CodeHitRow[]
  const total = (ctx.db.query('SELECT COUNT(*) c FROM code_fts WHERE code_fts MATCH ?').get(fts) as { c: number }).c

  const cache = new Map<string, string[]>()
  const linesOf = (file: string): string[] => {
    const cached = cache.get(file)
    if (cached) return cached
    let lines: string[] = []
    try {
      lines = readFileSync(`${ctx.profileDir}/lift/${file}`, 'utf8').replace(/\r\n?/g, '\n').split('\n')
    } catch {
      lines = []
    }
    cache.set(file, lines)
    return lines
  }

  const results: AiTextResult[] = rows.map((row) => {
    const lines = linesOf(row.file)
    const from = Math.max(1, row.line_from)
    const to = Math.min(lines.length > 0 ? lines.length : row.line_to, row.line_to)
    const at = firstMatchLine(lines, tokens, from, to)
    const snippetFrom = Math.max(from, at - SNIPPET_CONTEXT)
    const snippetTo = Math.min(to, at + SNIPPET_CONTEXT)
    const snippet = lines
      .slice(snippetFrom - 1, snippetTo)
      .map((line, i) => `${snippetFrom + i}: ${line.length > SNIPPET_LINE_MAX ? `${line.slice(0, SNIPPET_LINE_MAX)}…` : line}`)
      .join('\n')
    return {
      fields: {
        function: row.function_path,
        kind: row.kind,
        line: at,
        lines: `${from}-${to}`,
        lines_total: to - from + 1,
        ...(row.stub ? { stub: 'тело застаблено: логику смотри через ww_get_bytecode' } : {}),
        asset_path: row.asset_path,
        file: `${ctx.profileDir}/lift/${row.file}`,
      },
      ...(snippet.length > 0 ? { blocks: { snippet } } : {}),
    }
  })

  return renderAiText({
    reportType: 'code_search',
    fields: {
      ...echo,
      status: 'ok',
      query: pattern,
      fts_query: fts,
      functions_indexed: functions?.value ?? '0',
      lift_status: status?.value ?? 'нет',
      truncated: total > rows.length,
      hint: 'полное тело функции поднимает ww_lift asset_path=<asset_path>, байткод — ww_get_bytecode',
    },
    results,
    truncated: total > rows.length,
    totalFound: total,
    limit: max,
  })
}

function firstMatchLine(lines: string[], tokens: string[], from: number, to: number): number {
  if (lines.length === 0) return from
  const boundary = tokens.map((t) => new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(t)}`, 'i'))
  const plain = tokens.map((t) => t.toLowerCase())
  const at = (i: number): string => lines[i - 1] ?? ''

  for (let i = from; i <= to; i++) if (boundary[0].test(at(i))) return i
  for (let i = from; i <= to; i++) {
    const low = at(i).toLowerCase()
    if (plain.some((t) => low.includes(t))) return i
  }
  for (let i = from; i <= to; i++) if (boundary.some((b) => b.test(at(i)))) return i
  return from
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface RenderInput {
  echo: Record<string, string>
  status: string
  target: Target
  className: string | null
  scratch: string
  lmPath: string | null
  text: string
  marks: LiftMark[]
  stats: Stats
  iterations: number
  cached: boolean
  extra?: Record<string, string | number | boolean>
}

function renderLift(input: RenderInput): string {
  const bytecodeOf = (name: string) => bytecodePath(input.target.assetPath, input.className, name)
  const bodies = printedItems(input.text).length
  const stubbedFns = input.marks.filter((m) => m.kind === 'function' || m.kind === 'event').length
  const droppedDefaults = input.marks.filter((m) => m.kind === 'default').length
  const droppedFields = input.marks.filter((m) => m.kind === 'component' || m.kind === 'widget').length
  const widgetTree = input.marks.some((m) => m.kind === 'widget_tree')
  const shown = input.marks.slice(0, MAX_MARKS_SHOWN)
  const status =
    input.status === 'lifted'
      ? stubbedFns > 0
        ? 'lifted_with_stubs'
        : input.marks.length > 0
          ? 'lifted_with_fallbacks'
          : 'lifted'
      : input.status

  const markList = input.marks.map((m) => {
    const command =
      m.kind === 'function' || m.kind === 'event' ? ` → ww_get_bytecode ${bytecodeOf(m.name)}` : ''
    return `${m.kind} ${m.name} — ${m.reason}${command}`
  })

  const results: AiTextResult[] = [
    {
      fields: { body: 'lm', lines: input.text.split('\n').length, not_lifted_total: input.marks.length },
      blocks: { not_lifted: markList.join('\n') || 'нет', lm: input.text },
    },
    ...shown.map((m) => ({
      fields: {
        not_lifted: `${m.kind} ${m.name}`,
        reason: m.reason,
        bytecode:
          m.kind === 'function' || m.kind === 'event' ? `ww_get_bytecode ${bytecodeOf(m.name)}` : '—',
      },
    })),
  ]

  const hint =
    stubbedFns > 0
      ? 'тела застабленных функций читай через ww_get_bytecode: строка // not lifted стоит прямо над телом'
      : widgetTree
        ? 'дерево виджетов не поднято: раскладку показывает ww_ui_tree'
        : input.marks.length > 0
          ? `тела функций и дерево виджетов подняты целиком, но сняты значения, которые Loom не выражает (defaults ${droppedDefaults}, поля компонентов и виджетов ${droppedFields}): что именно — в not_lifted и строках // not lifted`
          : 'поднято целиком, фолбэки не понадобились'

  return renderAiText({
    reportType: 'blueprint_lift',
    fields: {
      ...input.echo,
      status,
      asset_path: input.target.assetPath,
      resolved_by: input.target.resolvedBy,
      ...(input.target.mod ? { mod: input.target.mod } : {}),
      lm_path: input.lmPath ?? '—',
      functions_lifted: bodies,
      functions_stubbed: stubbedFns,
      functions_total: bodies + stubbedFns,
      defaults_dropped: droppedDefaults,
      component_fields_dropped: droppedFields,
      widget_tree: widgetTree ? 'dropped' : 'lifted',
      hex_keys_dropped: input.stats.hexKeys,
      tiny_floats_zeroed: input.stats.tinyFloats,
      iterations: input.iterations,
      cached: input.cached,
      lift_dir: input.scratch,
      hint,
      ...(input.extra ?? {}),
    },
    truncated: input.marks.length > shown.length,
    totalFound: input.marks.length,
    results,
  })
}

function resolveTarget(
  ctx: GameContext,
  config: ServerConfig,
  kit: KitPaths,
  raw: string,
  usmap: string,
): Target | { status: string; extra: Record<string, string | number | boolean> } {
  const norm = normalizeUserPath(raw)
  const modPath = modAssetPath(norm.indexPath) ?? modAssetPath(norm.gameFullPath ?? '')
  if (modPath) return resolveModTarget(config, kit, modPath, usmap)

  const fromIndex = resolveFromIndex(ctx, raw)
  if (fromIndex) {
    return { assetPath: fromIndex, pakDir: dirname(config.pakPath), usmap, uplugin: null, mod: null, resolvedBy: 'индекс' }
  }

  const direct = directGamePath(norm.indexPath)
  if (direct) {
    return { assetPath: direct, pakDir: dirname(config.pakPath), usmap, uplugin: null, mod: null, resolvedBy: 'путь /Game/' }
  }

  return {
    status: 'not_found',
    extra: { hint: 'путь не найден в индексе: возьми asset_path из ww_find_asset или путь класса из ww_find_symbol' },
  }
}

function modAssetPath(path: string): string | null {
  const m = /^\/Game\/Mods\/([^/.]+)\/(.+)$/.exec(path)
  return m ? `${m[1]}/${m[2]}` : null
}

function directGamePath(indexPath: string): string | null {
  if (!indexPath.startsWith('/Game/')) return null
  const noFunc = indexPath.split(':')[0]
  const slash = noFunc.lastIndexOf('/')
  const tail = noFunc.slice(slash + 1)
  const dot = tail.indexOf('.')
  const asset = dot > 0 ? noFunc.slice(0, slash + 1) + tail.slice(0, dot) : noFunc
  return asset.length > '/Game/'.length ? asset : null
}

/** Индексная форма (`BP_PlayHud`, `BP_PlayHud.BP_PlayHud_C`) → asset_path из bp_classes или assets. */
function resolveFromIndex(ctx: GameContext, raw: string): string | null {
  const norm = normalizeUserPath(raw)
  const parts = norm.indexPath.split('.')
  const queries: string[] = []
  if (parts.length >= 2 && parts[1].endsWith('_C')) queries.push(`${parts[0]}.${parts[1]}`)
  queries.push(norm.indexPath, parts[0])
  for (const q of queries) {
    const row = ctx.db
      .query('SELECT asset_path FROM bp_classes WHERE path = ? OR package = ? LIMIT 1')
      .get(q, q) as { asset_path: string | null } | null
    if (row?.asset_path) return row.asset_path
  }

  const hit = findObject(ctx, raw) as ObjectHit | null
  const full = hit?.hook_path ?? hit?.object_path
  if (full?.startsWith('/Game/')) return directGamePath(full)

  const name = parts[parts.length - 1]
  const asset = ctx.db
    .query('SELECT asset_path FROM assets WHERE name = ? COLLATE NOCASE OR asset_path = ? LIMIT 1')
    .get(name, norm.indexPath) as { asset_path: string } | null
  return asset?.asset_path ?? null
}

/** `/Game/Mods/<Мод>/...` в индексе игры нет: пак мода ищем в <saved>/mods, Workshop и паках кита. */
function resolveModTarget(
  config: ServerConfig,
  kit: KitPaths,
  modPath: string,
  usmap: string,
): Target | { status: string; extra: Record<string, string | number | boolean> } {
  const [mod, ...rest] = modPath.split('/')
  const assetPath = `/Game/Mods/${mod}/${rest.join('/')}`
  const name = rest[rest.length - 1]
  const uplugin =
    [`${kit.contentMods}/${mod}/${mod}.uplugin`, `${config.savedDir}/mods/${mod}/${mod}.uplugin`].find((p) =>
      existsSync(p),
    ) ?? null

  const dirs: string[] = []
  if (existsSync(`${config.savedDir}/mods/${mod}`)) dirs.push(`${config.savedDir}/mods/${mod}`)
  const steam = findSteamGame(config.steamAppId || WHISKERWOOD_APP_ID)
  if (steam) {
    const workshop = `${steam.library}/steamapps/workshop/content/${steam.appId}`
    for (const dir of listDirs(workshop)) {
      if (listFiles(dir).some((f) => f.toLowerCase() === `${mod.toLowerCase()}.pak`)) dirs.push(dir)
    }
  }
  if (existsSync(kit.pakOutputDir)) dirs.push(kit.pakOutputDir)

  for (const dir of dirs) {
    if (!pakHasAsset(dir, name)) continue
    const local = uplugin ?? listFiles(dir).find((f) => f.endsWith('.uplugin'))
    return {
      assetPath,
      pakDir: dir,
      usmap,
      uplugin: local ? (local.includes('/') || local.includes('\\') ? local : `${dir}/${local}`) : null,
      mod,
      resolvedBy: dir === kit.pakOutputDir ? 'паки кита' : dir,
    }
  }

  return {
    status: 'mod_pak_not_found',
    extra: {
      mod,
      asset_path: assetPath,
      searched: dirs.join('; ') || 'нет каталогов',
      hint: 'пак мода не найден: собери мод (Cook & Install) или поставь его в <saved>/mods',
    },
  }
}

function pakHasAsset(dir: string, name: string): boolean {
  const lower = `${name.toLowerCase()}.uasset`
  for (const file of listFiles(dir)) {
    if (!file.toLowerCase().endsWith('.pak')) continue
    try {
      const reader = pakReaderFor(`${dir}/${file}`)
      if (reader.list().some((k) => k.toLowerCase().endsWith(`/${lower}`) || k.toLowerCase() === lower)) return true
    } catch {
      continue
    }
  }
  return false
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => statSync(`${dir}/${f}`).isFile())
  } catch {
    return []
  }
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => statSync(`${dir}/${f}`).isDirectory())
      .map((f) => `${dir}/${f}`)
  } catch {
    return []
  }
}

function newestUsmap(dir: string): string | null {
  try {
    const maps = readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.usmap'))
      .map((f) => ({ f, mtime: statSync(`${dir}/${f}`).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    return maps.length > 0 ? `${dir}/${maps[0].f}` : null
  } catch {
    return null
  }
}

function ensureScratch(scratch: string, kit: KitPaths): void {
  mkdirSync(`${scratch}/Intermediate/Loom`, { recursive: true })
  mkdirSync(`${scratch}/Content`, { recursive: true })
  const uproject = `${scratch}/Lift.uproject`
  if (!existsSync(uproject)) writeFileSync(uproject, '{}')
  if (!existsSync(kit.typesJson)) throw new Error(`нет ${kit.typesJson}: собери кит хотя бы раз — LoomBuild дампит типы`)
  const types = `${scratch}/Intermediate/Loom/types.json`
  if (stampOf(kit.typesJson) !== stampOf(types)) copyFileSync(kit.typesJson, types)
}

/** Пересобранный пак мода (свой мод из паков кита, обновлённый Workshop) должен сбрасывать кэш. */
function paksStamp(dir: string): string {
  const paks = listFiles(dir)
    .filter((f) => /\.(pak|utoc|ucas)$/i.test(f))
    .sort()
    .map((f) => `${f}:${stampOf(`${dir}/${f}`)}`)
  return shortHash(paks.join(';'))
}

/** Кэш по (версия игры, ассет): сбрасывается сменой types.json кита, профиля, пака, правил подъёма и бинарника WwParse. */
interface CacheEntry {
  lmPath: string | null
  text: string
  marks: LiftMark[]
  stats: Stats
  iterations: number
  stamp: string
  assetPath: string
  className: string | null
}

function readCache(file: string, stamp: string): CacheEntry | null {
  try {
    const entry = JSON.parse(readFileSync(file, 'utf8')) as CacheEntry
    if (entry.stamp !== stamp) return null
    if (entry.lmPath && !existsSync(entry.lmPath)) writeFileSync(entry.lmPath, entry.text)
    return entry
  } catch {
    return null
  }
}

function writeCache(file: string, entry: CacheEntry): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(entry))
  } catch {}
}

function runSidecarJson(config: ServerConfig, target: Target, out: string): string {
  const args = [
    buildSidecar(config),
    'json',
    '--paks',
    target.pakDir,
    '--usmap',
    target.usmap,
    '--asset',
    target.assetPath,
    '--out',
    out,
  ]
  if (target.uplugin) args.push('--uplugin', target.uplugin)
  let code: number | null = null
  let stderr = ''
  try {
    const proc = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe', timeout: SIDECAR_TIMEOUT_MS })
    code = proc.exitCode
    stderr = new TextDecoder().decode(proc.stderr).trim()
  } catch (e) {
    throw new SidecarError(`WwParse json не запустился: ${(e as Error).message}`)
  }
  if (code !== 0 || !existsSync(out)) {
    throw new SidecarError(
      `WwParse json завершился с кодом ${code ?? -1} (${target.assetPath}):\n${stderr || 'без вывода'}`,
    )
  }
  return stderr
}

function relativeGamePath(assetPath: string): string | null {
  if (!assetPath.startsWith('/Game/')) return null
  return assetPath.slice('/Game/'.length)
}

function shortHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 12)
}

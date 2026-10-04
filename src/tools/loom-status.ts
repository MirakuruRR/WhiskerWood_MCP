import { Database } from 'bun:sqlite'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { ServerConfig } from '../config'
import { AiTextResult, renderAiText, Scalar } from '../utils/ai-text'
import { findEditorProcess, KitPaths, kitStatus } from '../utils/kit'
import { openIndexDb } from '../utils/db'
import { describeProfiles, listProfiles, resolveProfile } from '../utils/game-registry'
import { checkFingerprintLevel1, readCachedFingerprint } from '../utils/game-fingerprint'

export interface LoomStatusArgs {
  version?: string
}

const NATIVE_GAME_MODULES = ['ProjectArco', 'SystemCore', 'LowCore', 'NauticalKit', 'ShaderCore']
const SCRIPT_PREFIX = '/Script/'
const EXAMPLE_LIMIT = 12
const CLASS_KINDS = "('Class', 'BlueprintGeneratedClass', 'WidgetBlueprintGeneratedClass', 'AnimBlueprintGeneratedClass')"
const BP_CALLABLE = /BlueprintCallable|BlueprintPure/
const BP_EVENT = /BlueprintImplementableEvent|BlueprintNativeEvent/
const CLASS_DECL = /^\s*class\s+(?:[A-Z0-9]+_API\s+)?([A-Za-z_]\w*)\s*(?::\s*public\s+[A-Za-z_]\w*)?\s*\{/
const TRAILING_IDENT = /([A-Za-z_]\w*)\s*$/

interface TypesFunction {
  flags?: string[]
  params?: Array<{ type?: string; name?: string; dir?: string }>
}

interface TypesClass {
  functions?: Record<string, TypesFunction>
}

interface DiffOutput {
  fields: Record<string, Scalar>
  results: AiTextResult[]
  total: number
}

function fmtTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

function statOrNull(path: string): { size: number; mtimeMs: number } | null {
  try {
    const s = statSync(path)
    return { size: Number(s.size), mtimeMs: s.mtimeMs }
  } catch {
    return null
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

function firstConfigLine(path: string): string | null {
  try {
    const text = readFileSync(path, 'utf8')
    return text.split(/\r?\n/).find((l) => l.trim().length > 0 && !l.startsWith(';'))?.trim() ?? null
  } catch {
    return null
  }
}

function dirCount(path: string): number {
  try {
    return readdirSync(path).length
  } catch {
    return 0
  }
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function fillKitFields(kit: KitPaths, fields: Record<string, Scalar>): void {
  fields.kit_dir = kit.kitDir
  fields.uproject = kit.uproject
  fields.engine_dir = kit.engineDir ?? 'не найден'
  fields.engine_source = kit.engineSource ?? 'не найден'
  if (kit.engineAssociation) fields.engine_association = kit.engineAssociation

  for (const [key, path] of [
    ['loom_exe', kit.loomExe],
    ['loom_mcp', kit.loomMcp],
    ['types_json', kit.typesJson],
    ['report_json', kit.reportJson],
    ['editor_log', kit.editorLog],
  ] as Array<[string, string]>) {
    const s = statOrNull(path)
    fields[`${key}_found`] = s !== null
    if (s) {
      fields[`${key}_kb`] = Number((s.size / 1024).toFixed(1))
      fields[`${key}_mtime`] = fmtTime(s.mtimeMs)
    }
  }
  fields.ops_entries = dirCount(kit.opsDir)
}

/** Версия Loom: собственный --version loom.exe не умеет, поэтому берём версию компилятора из ops/build.json и версию плагина из .uplugin. */
function fillVersionFields(kit: KitPaths, fields: Record<string, Scalar>): void {
  const ops = readJson<{ version?: string; order?: string[] }>(`${kit.opsDir}/build.json`)
  const plugin = readJson<{ Version?: number; VersionName?: string; EngineVersion?: string }>(
    `${kit.kitDir}/Plugins/LoomEditor/LoomEditor.uplugin`,
  )

  const opsVersion = typeof ops?.version === 'string' ? ops.version : null
  const pluginVersion = typeof plugin?.VersionName === 'string' ? plugin.VersionName : null
  if (ops) {
    fields.loom_ops_version = opsVersion ?? 'нет в build.json'
    fields.loom_ops_files = (ops.order ?? []).length
    fields.loom_ops_version_source = 'Intermediate/Loom/ops/build.json (пишет loom build)'
  } else {
    fields.loom_ops_build_json = 'нет: сборка Loom ещё не проходила'
  }
  fields.loom_plugin_version = pluginVersion ?? 'не прочиталась'
  if (plugin?.EngineVersion) fields.loom_plugin_engine_version = plugin.EngineVersion

  if (opsVersion && pluginVersion) {
    fields.loom_version_state = opsVersion === pluginVersion ? 'match' : 'mismatch'
    if (opsVersion !== pluginVersion) {
      fields.loom_version_hint = `плагин в ките ${pluginVersion}, а ops собраны loom.exe ${opsVersion}: кит или плагин обновляли по отдельности, пересобери Blueprint'ы в редакторе`
    }
  } else {
    fields.loom_version_state = 'unknown'
  }

  const exe = statOrNull(kit.loomExe)
  const build = statOrNull(`${kit.opsDir}/build.json`)
  if (exe && build && exe.mtimeMs > build.mtimeMs) {
    fields.loom_exe_newer_than_ops = true
    fields.loom_exe_newer_hint = `loom.exe обновлён ${fmtTime(exe.mtimeMs)}, а ops собраны ${fmtTime(build.mtimeMs)}: типы и ops могли разойтись`
  }
}

function fillReportFields(kit: KitPaths, fields: Record<string, Scalar>): void {
  const rep = readJson<{
    sources?: number
    ok?: boolean
    errors?: unknown[]
    blueprints?: Array<{ path?: string; source?: string; status?: string }>
  }>(kit.reportJson)
  if (!rep) {
    fields.report_state = existsSync(kit.reportJson) ? 'не разобран' : 'нет (сборок Blueprint не было)'
    return
  }
  const bps = rep.blueprints ?? []
  const by = (status: string): number => bps.filter((b) => b.status === status).length
  fields.report_ok = rep.ok ?? false
  fields.report_errors = (rep.errors ?? []).length
  fields.report_blueprints = bps.length
  fields.report_built = by('built')
  fields.report_unchanged = by('unchanged')
  fields.report_failed = by('failed')
  fields.report_skipped = by('skipped')
  const mods = [...new Set(bps.map((b) => /^\/Game\/Mods\/([^/]+)\//.exec(b.path ?? '')?.[1]).filter(Boolean))] as string[]
  if (mods.length > 0) fields.report_mods = mods.join(', ')
  const firstError = (rep.errors ?? [])[0]
  if (firstError !== undefined) {
    fields.report_first_error = (typeof firstError === 'string' ? firstError : JSON.stringify(firstError)).split('\n')[0].slice(0, 200)
  }
}

interface BpFunction {
  classPath: string
  name: string
  event: boolean
}

interface BpScan {
  functions: BpFunction[]
  bpTotal: number
  eventTotal: number
  ufTotal: number
  headers: number
  scanned: string[]
  absent: string[]
}

function stripClassPrefix(name: string): string {
  if ((name.startsWith('U') || name.startsWith('A') || name.startsWith('F')) && name.length > 1 && /[A-Z]/.test(name[1])) {
    return name.slice(1)
  }
  return name
}

function headerFiles(dir: string, into: string[]): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return into
  }
  for (const e of entries) {
    const full = `${dir}/${e.name}`
    if (e.isDirectory()) headerFiles(full, into)
    else if (e.name.endsWith('.h')) into.push(full)
  }
  return into
}

/** Флаги BlueprintCallable видны только в UHT-дампах UE4SS: в индексе они не сохраняются. */
function scanBlueprintCallable(dumpRoot: string, modules: string[]): BpScan {
  const functions: BpFunction[] = []
  const scanned: string[] = []
  const absent: string[] = []
  let headers = 0
  let ufTotal = 0
  let bpTotal = 0
  let eventTotal = 0

  for (const mod of modules) {
    const root = `${dumpRoot}/${mod}`
    if (!existsSync(root)) {
      absent.push(mod)
      continue
    }
    scanned.push(mod)
    for (const file of headerFiles(root, [])) {
      headers++
      const text = readFileSync(file, 'utf8')
      let cls: string | null = null
      let state: 'idle' | 'spec' | 'decl' = 'idle'
      let spec = ''
      let decl = ''
      let depth = 0

      for (const raw of text.split('\n')) {
        const line = raw.trimEnd()
        if (state === 'idle') {
          const cm = CLASS_DECL.exec(line)
          if (cm) {
            cls = stripClassPrefix(cm[1])
            continue
          }
          const trimmed = line.trimStart()
          if (!trimmed.startsWith('UFUNCTION(')) continue
          state = 'spec'
          spec = ''
        }
        if (state === 'spec') {
          spec += `${line.trim()} `
          for (const ch of line) {
            if (ch === '(') depth++
            else if (ch === ')') depth--
          }
          if (depth > 0) continue
          state = 'decl'
          decl = ''
          continue
        }
        decl += `${line.trim()} `
        if (!line.endsWith(';')) continue
        state = 'idle'
        if (!cls) continue
        ufTotal++
        if (!BP_CALLABLE.test(spec)) continue
        bpTotal++
        const isEvent = BP_EVENT.test(spec)
        if (isEvent) eventTotal++
        const open = decl.indexOf('(')
        if (open < 0) continue
        const name = TRAILING_IDENT.exec(decl.slice(0, open).trim())?.[1]
        if (!name || name === 'PURE_VIRTUAL' || name === 'virtual') continue
        functions.push({ classPath: `${SCRIPT_PREFIX}${mod}.${cls}`, name, event: isEvent })
      }
    }
  }
  return { functions, bpTotal, eventTotal, ufTotal, headers, scanned, absent }
}

function diffTypesAgainstIndex(config: ServerConfig, version: string | undefined, kit: KitPaths): DiffOutput {
  const fields: Record<string, Scalar> = {}
  const results: AiTextResult[] = []
  let total = 0

  const types = readJson<{ classes?: Record<string, TypesClass> }>(kit.typesJson)
  if (!types?.classes) {
    fields.diff = 'skipped'
    fields.diff_reason = `types.json не читается: ${kit.typesJson}`
    fields.diff_hint = 'типы дампит плагин LoomEditor при сборке Blueprint в редакторе'
    return { fields, results, total }
  }
  const classes = types.classes

  const profiles = listProfiles(config.distDir)
  let profile
  try {
    profile = resolveProfile(profiles, version)
  } catch (e) {
    fields.diff = 'skipped'
    fields.diff_reason = 'нет готового профиля индекса'
    fields.index_profiles = describeProfiles(profiles)
    fields.diff_hint = (e as Error).message
    return { fields, results, total }
  }

  fields.index_profile = profile.profileId
  fields.index_game_version = profile.contract!.gameVersion
  fields.index_built_at = profile.contract!.builtAt
  const level1 = checkFingerprintLevel1(config)
  fields.index_fingerprint = level1.status
  const fp = readCachedFingerprint(config)
  if (fp && fp.projectVersion !== profile.contract!.gameVersion) {
    fields.index_stale_warning = `установлена игра ${fp.projectVersion}, профиль собран для ${profile.contract!.gameVersion}: сверка идёт по старому индексу`
  }

  const db: Database = openIndexDb(`${profile.dir}/index.db`)
  const classPaths = new Set<string>()
  for (const row of db
    .query(`SELECT hook_path FROM objects WHERE hook_path IS NOT NULL AND kind IN ${CLASS_KINDS}`)
    .all() as Array<{ hook_path: string }>) {
    classPaths.add(row.hook_path)
  }
  const functionPaths = new Set<string>()
  for (const row of db
    .query("SELECT hook_path FROM objects WHERE hook_path IS NOT NULL AND kind = 'Function'")
    .all() as Array<{ hook_path: string }>) {
    functionPaths.add(row.hook_path)
  }

  const placeholders = NATIVE_GAME_MODULES.map(() => '?').join(', ')
  const paramsByFn = new Map<string, string[]>()
  for (const row of db
    .query(
      `SELECT fp.function_path AS path, fp.name AS name FROM function_params fp
       JOIN objects o ON o.path = fp.function_path
       WHERE o.package IN (${placeholders}) AND fp.is_return = 0`,
    )
    .all(...(NATIVE_GAME_MODULES as never[])) as Array<{ path: string; name: string }>) {
    const list = paramsByFn.get(row.path)
    if (list) list.push(row.name.toLowerCase())
    else paramsByFn.set(row.path, [row.name.toLowerCase()])
  }

  const missingClasses: string[] = []
  const missingFunctions: string[] = []
  const paramsDiffer: string[] = []
  const otherModules = new Set<string>()
  let scopeClasses = 0
  let scopeFunctions = 0
  let scopeMissingClasses = 0
  let scopeMissingFunctions = 0
  let paramsCompared = 0
  let paramsDiffCount = 0
  let otherMissingClasses = 0
  let otherMissingFunctions = 0

  for (const [path, cls] of Object.entries(classes)) {
    if (!path.startsWith(SCRIPT_PREFIX)) continue
    const module = path.slice(SCRIPT_PREFIX.length).split('.')[0]
    const inScope = NATIVE_GAME_MODULES.includes(module)
    const functions = cls.functions ?? {}
    if (inScope) scopeClasses++
    const classMissing = !classPaths.has(path)
    if (classMissing) {
      if (inScope) {
        scopeMissingClasses++
        if (missingClasses.length < EXAMPLE_LIMIT) missingClasses.push(path)
      } else {
        otherMissingClasses++
        otherModules.add(module)
      }
    }
    for (const name of Object.keys(functions)) {
      if (inScope) scopeFunctions++
      if (classMissing) continue
      const fnPath = `${path}:${name}`
      if (!functionPaths.has(fnPath)) {
        if (inScope) {
          scopeMissingFunctions++
          if (missingFunctions.length < EXAMPLE_LIMIT) missingFunctions.push(fnPath)
        } else {
          otherMissingFunctions++
          otherModules.add(module)
        }
        continue
      }
      if (!inScope) continue
      const kitNames = (functions[name].params ?? [])
        .filter((p) => p.dir !== 'return')
        .map((p) => (p.name ?? '').toLowerCase())
      const idxNames = paramsByFn.get(`${path.slice(SCRIPT_PREFIX.length)}.${name}`) ?? []
      paramsCompared++
      if (JSON.stringify(kitNames) !== JSON.stringify(idxNames)) {
        paramsDiffCount++
        if (paramsDiffer.length < EXAMPLE_LIMIT) {
          paramsDiffer.push(`${fnPath} кит=(${kitNames.join(', ')}) игра=(${idxNames.join(', ')})`)
        }
      }
    }
  }

  const scan = scanBlueprintCallable(`${config.dumpsDir}/UHTHeaderDump`, NATIVE_GAME_MODULES)
  fields.uht_modules_scanned = scan.scanned.join(', ') || 'нет'
  if (scan.absent.length > 0) {
    fields.uht_modules_absent = scan.absent.join(', ')
    fields.uht_hint = 'нет каталогов модулей в dumps/UHTHeaderDump: сверка BlueprintCallable не выполнена, дампы снимает ww_capture_dumps'
  }
  fields.uht_headers = scan.headers
  fields.uht_functions = scan.ufTotal
  fields.uht_bp_callable = scan.bpTotal
  fields.uht_bp_events = scan.eventTotal

  const callableMissing: string[] = []
  const eventMissing: string[] = []
  const callableNotCallable: string[] = []
  let callableMissingCount = 0
  let eventMissingCount = 0
  let callableNotCallableCount = 0
  let eventsPresentCount = 0
  let bpMissingClasses = 0

  for (const row of scan.functions) {
    const fn = classes[row.classPath]?.functions?.[row.name]
    if (fn) {
      if (!(fn.flags ?? []).includes('not_callable')) continue
      if (row.event) {
        eventsPresentCount++
        continue
      }
      callableNotCallableCount++
      if (callableNotCallable.length < EXAMPLE_LIMIT) callableNotCallable.push(`${row.classPath}:${row.name}`)
      continue
    }
    if (!classes[row.classPath]) bpMissingClasses++
    if (row.event) {
      eventMissingCount++
      if (eventMissing.length < EXAMPLE_LIMIT) eventMissing.push(`${row.classPath}:${row.name}`)
    } else {
      callableMissingCount++
      if (callableMissing.length < EXAMPLE_LIMIT) callableMissing.push(`${row.classPath}:${row.name}`)
    }
  }

  fields.diff = 'ok'
  fields.kit_native_classes = Object.keys(classes).filter((k) => k.startsWith(SCRIPT_PREFIX)).length
  fields.game_module_classes = scopeClasses
  fields.game_module_functions = scopeFunctions
  fields.kit_classes_missing_from_game = scopeMissingClasses
  fields.kit_functions_missing_from_game = scopeMissingFunctions
  fields.functions_params_compared = paramsCompared
  fields.functions_params_differ = paramsDiffCount
  fields.bp_callable_missing_from_kit = callableMissingCount
  fields.bp_events_missing_from_kit = eventMissingCount
  fields.bp_callable_flagged_not_callable = callableNotCallableCount
  fields.bp_events_present_as_events = eventsPresentCount
  fields.bp_events_hint = 'BlueprintImplementableEvent/NativeEvent в ките помечены event+not_callable: их переопределяют, а не вызывают — это норма'
  fields.bp_classes_missing_from_kit = bpMissingClasses
  fields.other_modules_missing_classes = otherMissingClasses
  fields.other_modules_missing_functions = otherMissingFunctions
  fields.other_modules_hint =
    'счётчики other_modules — движковые и редакторные модули: их нет в shipping-сборке игры, для Loom это норма'
  if (otherModules.size > 0) {
    fields.other_modules_sample = [...otherModules].slice(0, 12).join(', ')
  }

  for (const path of missingClasses) {
    results.push({ fields: { kind: 'kit_class_not_in_game', path, hint: 'класс есть в ките, но не в игре: после патча игры сигнатура могла уехать' } })
  }
  for (const path of missingFunctions) {
    results.push({ fields: { kind: 'kit_function_not_in_game', path, hint: 'функция есть в ките, но не в игре: Loom соберёт мод против несуществующей сигнатуры' } })
  }
  for (const line of paramsDiffer) {
    results.push({ fields: { kind: 'params_differ', path: line.split(' кит=')[0], hint: line } })
  }
  for (const path of callableMissing) {
    results.push({
      fields: {
        kind: 'bp_callable_not_in_kit',
        path,
        hint: 'функция BlueprintCallable в UE4SS-дампах игры, но её нет в types.json: Loom её не видит, а ww_call и UE4SS видят',
      },
    })
  }
  for (const path of eventMissing) {
    results.push({
      fields: {
        kind: 'bp_event_not_in_kit',
        path,
        hint: 'переопределяемого события игры нет в types.json: Loom не сможет его переопределить',
      },
    })
  }
  for (const path of callableNotCallable) {
    results.push({ fields: { kind: 'bp_callable_flagged_not_callable', path, hint: 'функция есть в ките, но помечена not_callable: Loom её не вызовет' } })
  }

  total =
    scopeMissingClasses +
    scopeMissingFunctions +
    paramsDiffCount +
    callableMissingCount +
    eventMissingCount +
    callableNotCallableCount
  return { fields, results, total }
}

/** Сводка расхождений types.json с индексом: doctor печатает её строкой, не разбирая текстовый отчёт инструмента. */
export function loomDrift(config: ServerConfig, version?: string): Record<string, Scalar> {
  const st = kitStatus(config)
  if (!st.kit) return { diff: 'skipped', diff_reason: st.problem ?? 'кит не настроен' }
  return diffTypesAgainstIndex(config, version, st.kit).fields
}

export async function handleLoomStatus(config: ServerConfig, args: LoomStatusArgs): Promise<string> {
  const fields: Record<string, Scalar> = {}
  const results: AiTextResult[] = []

  const pak = statOrNull(config.pakPath)
  fields.game_dir = config.gameDir
  fields.pak_mtime = pak ? fmtTime(pak.mtimeMs) : 'пак не найден'

  const st = kitStatus(config)
  if (!st.configured || !st.kit) {
    fields.status = 'kit_not_configured'
    fields.problem = st.problem ?? 'кит не настроен'
    fields.diff = 'skipped'
    fields.diff_reason = 'кит не настроен: сверять types.json не с чем'
    fields.hint = 'укажи путь к мод-киту ключом kitDir (скилл /ww-setup) — тогда появятся версии Loom, mtime types.json и сверка с индексом'
    return renderAiText({ reportType: 'loom_status', fields })
  }
  const kit = st.kit
  fields.status = 'ok'
  if (st.missing.length > 0) fields.missing = st.missing.join(', ')

  fillKitFields(kit, fields)
  fillVersionFields(kit, fields)
  fillReportFields(kit, fields)

  const editor = findEditorProcess(kit.uproject)
  fields.editor_open = editor !== null
  if (editor) {
    fields.editor_pid = editor.pid
    fields.editor_hint = 'редактор открыт: сохранение .lm запускает сборку сам, headless не нужен'
  } else {
    fields.editor_hint = 'редактор закрыт: сборка только headless (UnrealEditor-Cmd -run=LoomBuild)'
  }

  const installLine = firstConfigLine(kit.gameInstallTxt)
  if (!installLine) {
    fields.game_install_txt = 'нет или пуст'
    fields.game_install_match = false
  } else {
    fields.game_install_txt = installLine
    const fromKit = normPath(installLine.replace(/[\\/]Whiskerwood$/i, ''))
    fields.game_install_match = fromKit === normPath(config.gameDir)
    if (!fields.game_install_match) {
      fields.game_install_hint = `кит смотрит на ${installLine}, а конфиг на ${config.gameDir}`
    }
  }

  const typesStat = statOrNull(kit.typesJson)
  if (typesStat && pak) {
    const lagHours = Math.round((pak.mtimeMs - typesStat.mtimeMs) / 3_600_000)
    fields.types_json_vs_pak = lagHours > 0 ? 'kit_behind' : 'kit_current'
    if (lagHours > 0) {
      fields.kit_lag_hours = lagHours
      fields.types_json_hint = `types.json старше пака игры на ${lagHours} ч: кит мог отстать от патча, Loom соберёт мод против старых сигнатур`
    }
  } else {
    fields.types_json_vs_pak = 'unknown'
    if (!typesStat) fields.types_json_hint = 'types.json нет: ни одной сборки Blueprint в редакторе не проходило'
  }

  const diff = diffTypesAgainstIndex(config, args.version, kit)
  Object.assign(fields, diff.fields)
  results.push(...diff.results)

  const bpMissing = Number(diff.fields.bp_callable_missing_from_kit ?? 0)
  const eventsMissing = Number(diff.fields.bp_events_missing_from_kit ?? 0)
  const kitOnly =
    Number(diff.fields.kit_classes_missing_from_game ?? 0) + Number(diff.fields.kit_functions_missing_from_game ?? 0)
  const paramsDiffer = Number(diff.fields.functions_params_differ ?? 0)
  if (diff.fields.diff === 'ok') {
    if (kitOnly > 0) {
      fields.verdict = `кит разошёлся с игрой: ${kitOnly} сущностей есть в ките, но не в игре — патч игры новее кита`
    } else if (paramsDiffer > 0) {
      fields.verdict = `состав параметров разошёлся у ${paramsDiffer} функций: кит собран под другую сборку игры`
    } else if (eventsMissing > 0) {
      fields.verdict = `в ките нет ${eventsMissing} переопределяемых событий игры: Loom не сможет их переопределить`
    } else if (bpMissing > 0) {
      fields.verdict = `в ките нет ${bpMissing} BlueprintCallable-функций из UE4SS-дампа: Loom их не видит, но уже написанный мод это не ломает`
    } else {
      fields.verdict =
        diff.fields.uht_hint !== undefined
          ? 'кит и игра сходятся по индексу; сверка BlueprintCallable пропущена — нет UHT-дампов'
          : 'кит и игра сходятся: расхождений по своим модулям нет'
    }
  }

  return renderAiText({
    reportType: 'loom_status',
    fields,
    results,
    truncated: diff.total > results.length,
    totalFound: diff.total,
    limit: EXAMPLE_LIMIT,
  })
}

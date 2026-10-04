import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ServerConfig } from '../config'
import { loomTemplates } from '../prompts'
import { renderAiText, Scalar } from '../utils/ai-text'
import { activeJob, cancelJob, isPidAlive, JobRecord, jobProgress, listJobs, readJob, startJob, updateJob } from '../utils/jobs'
import {
  editorPluginPaths,
  findEditorProcess,
  KitPaths,
  kitEngineVersion,
  kitStatus,
  NEW_MOD_SCRIPT,
  newModDir,
  unrealEditorCmd,
} from '../utils/kit'
import { PathSandboxError } from '../utils/path-sandbox'

export interface LoomNewModArgs {
  action: 'create' | 'status' | 'cancel'
  mod_name?: string
  display_name?: string
  description?: string
  version?: string
  created_by?: string
  templates?: string[]
  job_id?: string
  wait_ms?: number
}

const REPORT_TYPE = 'loom_new_mod'
const JOB_KIND = 'new-mod'
const MOD_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_]*$/
const MOD_NAME_MAX = 64
const FIELD_MAX = 500
const DEFAULT_VERSION = '1.0'
const DEFAULT_WAIT_MS = 90_000
const MAX_WAIT_MS = 300_000
const JOB_TIMEOUT_MS = 10 * 60_000
const POLL_MS = 1_000
const CANCEL_SETTLE_MS = 1_500
const CANCEL_LATE_MS = 15_000
const MTIME_SLACK_MS = 2_000
const PLACEHOLDER = '<Мод>'

interface UpluginFields {
  Name: string
  Description: string
  Version: string
  CreatedBy: string
  EngineVersion: string
}

interface NewModParams {
  mod_name: string
  dir: string
  uplugin: UpluginFields
  templates: string[]
  params_path: string
  result_path: string
}

interface ScriptResult {
  ok?: boolean
  stage?: string
  error?: string
  chunk?: number
  used?: number[]
  pak_chunks?: number[]
  labels?: Array<{ package: string; chunk: number }>
  pal_file?: string
  pal_object?: string
  cook_rule?: string
  label_assets_in_my_directory?: boolean
  saved?: boolean
  engine_version?: string
}

interface Outcome {
  finalized: true
  status: 'created' | 'failed' | 'cancelled' | 'finalize_failed'
  chunk?: number
  used?: number[]
  files: string[]
  removed: string[]
  leftover: string[]
  error?: string
  stage?: string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function report(fields: Record<string, Scalar>, blocks: Record<string, string> = {}, hints: string[] = []): string {
  if (hints.length > 0) {
    if (fields.hint === undefined) fields.hint = hints[0]
    if (hints.length > 1) blocks.hints = hints.map((h) => `- ${h}`).join('\n')
  }
  return renderAiText({
    reportType: REPORT_TYPE,
    fields,
    results: Object.keys(blocks).length > 0 ? [{ fields: {}, blocks }] : undefined,
  })
}

function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ').trim()
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

function filesUnder(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${d}/${e.name}`)
      else out.push(`${d}/${e.name}`)
    }
  }
  try {
    walk(dir)
  } catch {}
  return out
}

interface PlannedFile {
  template: string
  file: string
  text: string
}

type Plan = { ok: true; files: PlannedFile[] } | { ok: false; text: string }

function planTemplates(modName: string, requested: string[]): Plan {
  const known = new Map(loomTemplates().map((t) => [t.name.toLowerCase(), t]))
  const names: string[] = []
  for (const raw of requested) {
    const t = known.get(raw.trim().toLowerCase())
    if (!t) {
      return {
        ok: false,
        text: report({ action: 'create', status: 'bad_args', template: raw }, {}, [
          `нет шаблона ${raw}: доступны ${[...known.values()].map((x) => x.name).join(', ')} (ресурсы ww://templates/loom/<имя>)`,
        ]),
      }
    }
    if (!names.includes(t.name)) names.push(t.name)
  }
  if (names.includes('HudOverlay') && names.includes('BP_MapLoad')) {
    return {
      ok: false,
      text: report({ action: 'create', status: 'bad_args', templates: names.join(',') }, {}, [
        'HudOverlay ложится как BP_MapLoad.lm — вместо шаблона BP_MapLoad, а не вместе с ним: выбери один из двух',
      ]),
    }
  }
  if (names.includes('HudOverlay') && !names.includes('WBP_Overlay')) {
    return {
      ok: false,
      text: report({ action: 'create', status: 'bad_args', templates: names.join(',') }, {}, [
        `HudOverlay создаёт виджет WBP_${modName}Overlay и без него не соберётся: добавь WBP_Overlay`,
      ]),
    }
  }
  const files: PlannedFile[] = []
  for (const name of names) {
    const t = known.get(name.toLowerCase())!
    const raw = readFileSync(t.file, 'utf8')
    const text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replaceAll(PLACEHOLDER, modName)
    const m = /^blueprint\s+([A-Za-z0-9_]+)\b/m.exec(text)
    const file = `${m ? m[1] : name}.lm`
    if (files.some((f) => f.file.toLowerCase() === file.toLowerCase())) {
      return {
        ok: false,
        text: report({ action: 'create', status: 'bad_args', templates: names.join(',') }, {}, [
          `шаблоны дают один и тот же файл ${file}: оставь один`,
        ]),
      }
    }
    files.push({ template: name, file, text })
  }
  return { ok: true, files }
}

/** Как TJsonWriter плагина WWModTools: табы, CRLF, без BOM и без перевода строки в конце. */
function upluginText(f: UpluginFields): string {
  const keys: Array<keyof UpluginFields> = ['Name', 'Description', 'Version', 'CreatedBy', 'EngineVersion']
  return `{\r\n${keys.map((k) => `\t${JSON.stringify(k)}: ${JSON.stringify(f[k])}`).join(',\r\n')}\r\n}`
}

function newModStateDir(config: ServerConfig): string {
  return resolve(config.stateDir, 'new-mod').replace(/\\/g, '/')
}

const STATE_KEEP = 40

function pruneState(dir: string): void {
  try {
    const old = readdirSync(dir)
      .map((f) => ({ path: `${dir}/${f}`, mtime: mtimeOf(`${dir}/${f}`) ?? 0 }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(STATE_KEEP)
    for (const f of old) rmSync(f.path, { force: true })
  } catch {}
}

function paramsOf(job: JobRecord): NewModParams | null {
  const p = job.params as Partial<NewModParams> | undefined
  if (!p || typeof p.mod_name !== 'string' || typeof p.result_path !== 'string' || !p.uplugin) return null
  return p as NewModParams
}

function readScriptResult(path: string): ScriptResult | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ScriptResult
  } catch {
    return null
  }
}

/** PAL, который успел сохранить редактор, удаляем только свой: созданный после старта джоба. */
function removeFailedMod(kit: KitPaths, job: JobRecord, modName: string): { removed: string[]; leftover: string[] } {
  let dir: string
  try {
    dir = newModDir(kit, modName, false)
  } catch {
    return { removed: [], leftover: [] }
  }
  if (!existsSync(dir)) return { removed: [], leftover: [] }
  const removed: string[] = []
  const pal = `${dir}/PAL_${modName}.uasset`
  const palTime = mtimeOf(pal)
  if (palTime !== null && palTime >= job.startedAt - MTIME_SLACK_MS) {
    rmSync(pal, { force: true })
    removed.push(pal)
  }
  const leftover = filesUnder(dir)
  if (leftover.length === 0) {
    rmSync(dir, { recursive: true, force: true })
    removed.push(`${dir}/`)
  }
  return { removed, leftover }
}

function writeModFiles(kit: KitPaths, job: JobRecord, p: NewModParams, res: ScriptResult): Outcome {
  const base: Outcome = { finalized: true, status: 'created', chunk: res.chunk, used: res.used, files: [], removed: [], leftover: [] }
  let dir: string
  try {
    dir = newModDir(kit, p.mod_name, false)
  } catch (e) {
    return { ...base, status: 'finalize_failed', error: (e as Error).message }
  }
  const pal = `${dir}/PAL_${p.mod_name}.uasset`
  const palTime = mtimeOf(pal)
  if (palTime === null) return { ...base, status: 'finalize_failed', error: `редактор сообщил об успехе, но ${pal} нет на диске` }
  if (palTime < job.startedAt - MTIME_SLACK_MS) {
    return { ...base, status: 'finalize_failed', error: `${pal} старше джоба: это не наш PAL, файлы мода не пишу` }
  }
  base.files.push(pal)
  const plan = planTemplates(p.mod_name, p.templates)
  if (!plan.ok) return { ...base, status: 'finalize_failed', error: 'шаблоны не разобрались повторно' }
  const writes: Array<{ path: string; data: string }> = [
    { path: `${dir}/${p.mod_name}.uplugin`, data: upluginText(p.uplugin) },
    ...plan.files.map((f) => ({ path: `${dir}/${f.file}`, data: f.text })),
  ]
  for (const w of writes) {
    try {
      writeFileSync(w.path, w.data, { encoding: 'utf8', flag: 'wx' })
      base.files.push(w.path)
    } catch (e) {
      return { ...base, status: 'finalize_failed', error: `${w.path}: ${(e as Error).message}` }
    }
  }
  return base
}

/** lost при живом раннере — ребёнок уже вышел, а итог раннер ещё не записал: мету трогать рано. */
function stillRunning(job: JobRecord): boolean {
  if (job.status === 'running') return true
  return job.status === 'lost' && typeof job.runnerPid === 'number' && isPidAlive(job.runnerPid)
}

function settle(config: ServerConfig, kit: KitPaths, job: JobRecord): Outcome | null {
  const stored = job.result as Outcome | undefined
  if (stored && stored.finalized === true) return stored
  if (stillRunning(job)) return null
  const p = paramsOf(job)
  if (!p) return { finalized: true, status: 'failed', files: [], removed: [], leftover: [], error: 'у джоба нет параметров создания мода' }
  const res = readScriptResult(p.result_path)
  let outcome: Outcome
  if (job.status !== 'cancelled' && res?.ok === true) {
    outcome = writeModFiles(kit, job, p, res)
  } else {
    const cleaned = removeFailedMod(kit, job, p.mod_name)
    outcome = {
      finalized: true,
      status: job.status === 'cancelled' ? 'cancelled' : 'failed',
      chunk: res?.chunk,
      used: res?.used,
      files: [],
      removed: cleaned.removed,
      leftover: cleaned.leftover,
      stage: res?.stage,
      error: res
        ? res.error
        : job.status === 'cancelled'
          ? 'джоб снят до итога скрипта'
          : `скрипт не записал результат ${p.result_path}: редактор, похоже, упал до него — причина в job_log`,
    }
  }
  updateJob(config, job.id, { result: outcome as unknown as Record<string, unknown> })
  return outcome
}

function nextSteps(modName: string): string {
  return `ww_loom_validate mod_name=${modName} → ww_loom_build action=build → ww_loom_install action=start mod_name=${modName}`
}

function jobFields(config: ServerConfig, job: JobRecord): { fields: Record<string, Scalar>; blocks: Record<string, string> } {
  const fields: Record<string, Scalar> = { job_id: job.id, job_status: job.status }
  if (job.exitCode !== null) fields.job_exit = job.exitCode
  if (job.endedAt !== null) fields.job_ms = job.endedAt - job.startedAt
  else fields.job_elapsed_ms = Date.now() - job.startedAt
  const blocks: Record<string, string> = {}
  const progress = jobProgress(config, job.id, 12)
  if (progress && progress.logTail.length > 0) blocks.job_log = progress.logTail
  return { fields, blocks }
}

function outcomeText(config: ServerConfig, kit: KitPaths, job: JobRecord, outcome: Outcome | null, action: string): string {
  const p = paramsOf(job)
  const mod = p?.mod_name ?? '?'
  const jf = jobFields(config, job)
  const fields: Record<string, Scalar> = { action, mod, kit: kit.kitDir, ...jf.fields }
  const blocks: Record<string, string> = {}
  const hints: string[] = []

  if (!outcome) {
    fields.status = 'running'
    fields.next = `ww_loom_new_mod action=status job_id=${job.id}`
    hints.push('редактор создаёт PAL: холодный старт UnrealEditor-Cmd занимает около 30 с; .uplugin и .lm появятся после успеха')
    hints.push(`прервать — ww_loom_new_mod action=cancel job_id=${job.id}`)
    return report(fields, jf.blocks, hints)
  }

  fields.status = outcome.status
  if (outcome.chunk !== undefined) fields.chunk = outcome.chunk
  if (outcome.used) fields.used_chunks = outcome.used.join(',')
  if (outcome.stage) fields.stage = outcome.stage
  if (outcome.error) fields.error = oneLine(outcome.error).slice(0, 400)
  if (outcome.files.length > 0) blocks.files = outcome.files.join('\n')
  if (outcome.removed.length > 0) blocks.removed = outcome.removed.join('\n')
  if (outcome.leftover.length > 0) blocks.leftover = outcome.leftover.join('\n')

  if (outcome.status === 'created' && action === 'cancel') {
    hints.push('отменять было поздно: джоб успел создать мод; если он не нужен, удали папку мода руками')
  }
  if (outcome.status === 'created') {
    fields.mod_dir = p ? newModPathSafe(kit, mod) : ''
    fields.next = nextSteps(mod)
    hints.push('мод создан: PAL с уникальным ChunkId, .uplugin и выбранные заготовки .lm; дальше — правка .lm и цикл validate → build → install')
  } else if (outcome.status === 'finalize_failed') {
    hints.push('PAL создан, но файлы мода дописать не удалось: причина в error; недостающие .uplugin и .lm положи руками или удали папку мода и повтори create')
  } else {
    if (outcome.leftover.length > 0) {
      hints.push('в папке мода остались файлы, которых инструмент не создавал: он их не трогает — разбери руками (блок leftover)')
    } else {
      hints.push(
        outcome.removed.length > 0
          ? 'PAL не создан, недосозданная папка мода убрана: в Content/Mods ничего не осталось'
          : 'PAL не создан, папка мода не появилась: в Content/Mods ничего не записано',
      )
    }
    Object.assign(blocks, jf.blocks)
  }
  return report(fields, blocks, hints)
}

function newModPathSafe(kit: KitPaths, mod: string): string {
  try {
    return newModDir(kit, mod, false)
  } catch {
    return `${kit.contentMods}/${mod}`
  }
}

async function waitJob(config: ServerConfig, id: string, budgetMs: number): Promise<JobRecord | null> {
  const deadline = Date.now() + budgetMs
  let rec = readJob(config, id)
  while (rec && stillRunning(rec) && Date.now() < deadline) {
    await sleep(POLL_MS)
    rec = readJob(config, id)
  }
  return rec
}

function clampWait(waitMs: number | undefined): number {
  if (typeof waitMs !== 'number' || !Number.isFinite(waitMs) || waitMs < 0) return DEFAULT_WAIT_MS
  return Math.min(Math.round(waitMs), MAX_WAIT_MS)
}

function busyText(job: JobRecord, modName: string): string {
  const owner =
    job.kind === 'new-mod'
      ? `ww_loom_new_mod action=status job_id=${job.id}`
      : job.kind === 'cook'
        ? `ww_loom_install action=status job_id=${job.id}`
        : `ww_loom_build action=status job_id=${job.id}`
  return report({ action: 'create', status: 'busy', mod: modName, running_job: job.id, running_kind: job.kind, next: owner }, {}, [
    `в ките идёт джоб ${job.id} (${job.kind}): один джоб на кит, второй процесс редактора на том же проекте недопустим — дождись его`,
  ])
}

function fieldValue(raw: string | undefined, fallback: string): string {
  const v = (raw ?? '').trim()
  return v.length > 0 ? v : fallback
}

async function createText(config: ServerConfig, kit: KitPaths, args: LoomNewModArgs): Promise<string> {
  const modName = (args.mod_name ?? '').trim()
  if (modName.length === 0) {
    return report({ action: 'create', status: 'mod_name_required' }, {}, ['укажи mod_name — имя папки мода в <кит>/Content/Mods'])
  }
  if (!MOD_NAME_RE.test(modName) || modName.length > MOD_NAME_MAX) {
    return report({ action: 'create', status: 'bad_mod_name', mod: modName }, {}, [
      `имя мода — латинские буквы, цифры и _, первым символом буква или цифра, до ${MOD_NAME_MAX} символов: оно же имя папки, PAL_<Мод>, .uplugin и .pak`,
    ])
  }
  for (const [key, value] of Object.entries({ display_name: args.display_name, description: args.description, version: args.version, created_by: args.created_by })) {
    if (value === undefined) continue
    if (/[\r\n]/.test(value) || value.length > FIELD_MAX) {
      return report({ action: 'create', status: 'bad_args', field: key }, {}, [`${key}: одна строка до ${FIELD_MAX} символов — как поле диалога New mod`])
    }
  }
  const plan = planTemplates(modName, args.templates ?? [])
  if (!plan.ok) return plan.text

  const existing = `${kit.contentMods}/${modName}`
  if (existsSync(existing)) {
    const dir = newModPathSafe(kit, modName)
    const files = filesUnder(dir)
    return report(
      { action: 'create', status: 'mod_exists', mod: modName, mod_dir: dir, files: files.length },
      files.length > 0 ? { existing: files.slice(0, 30).join('\n') } : {},
      ['папка мода уже есть: инструмент ничего не перезаписывает — выбери другое имя или работай с существующим модом (ww_loom_validate)'],
    )
  }

  const running = activeJob(config)
  if (running) return busyText(running, modName)

  let dir: string
  try {
    dir = newModDir(kit, modName, true)
  } catch (e) {
    return report({ action: 'create', status: 'sandbox_violation', mod: modName, error: (e as Error).message })
  }

  const proc = findEditorProcess(kit.uproject)
  if (proc) {
    const run = /-run=([A-Za-z0-9_]+)/i.exec(proc.commandLine)?.[1] ?? null
    if (run === null) {
      return report({ action: 'create', status: 'editor_open', mod: modName, pid: proc.pid }, {}, [
        `редактор с этим проектом открыт (pid ${proc.pid}): второй процесс редактора на том же проекте запускать нельзя`,
        'создай мод в открытом редакторе: правый клик по Content/Mods → New mod... (или меню Mod Tools → New Mod...), заготовки .lm возьми из ww://templates/loom/<имя>',
        'или закрой редактор и повтори action=create',
      ])
    }
    return report({ action: 'create', status: 'project_busy', mod: modName, pid: proc.pid, commandlet: run }, {}, [
      `проект занят командиром -run=${run} (pid ${proc.pid}): дождись его завершения и повтори`,
    ])
  }

  const exe = unrealEditorCmd(kit)
  if (!exe || !existsSync(exe)) {
    return report({ action: 'create', status: 'no_editor_exe', mod: modName }, {}, [
      `не найден UnrealEditor-Cmd.exe: ${exe ?? 'движок не найден (EngineAssociation кита не разрешился и engineDir не задан)'}`,
    ])
  }
  const plugins = editorPluginPaths(kit)
  const missingPlugins = plugins ? [plugins.python, plugins.scripting].filter((p) => !existsSync(p)) : []
  if (missingPlugins.length > 0) {
    return report({ action: 'create', status: 'no_python_plugin', mod: modName }, { missing: missingPlugins.join('\n') }, [
      'в движке нет PythonScriptPlugin или EditorScriptingUtilities: создай мод в редакторе (New mod...)',
    ])
  }
  if (!existsSync(NEW_MOD_SCRIPT)) {
    return report({ action: 'create', status: 'no_script', mod: modName, script: NEW_MOD_SCRIPT })
  }

  const stateDir = newModStateDir(config)
  mkdirSync(stateDir, { recursive: true })
  pruneState(stateDir)
  const stampId = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '')
  const params: NewModParams = {
    mod_name: modName,
    dir,
    uplugin: {
      Name: fieldValue(args.display_name, modName),
      Description: fieldValue(args.description, ''),
      Version: fieldValue(args.version, DEFAULT_VERSION),
      CreatedBy: fieldValue(args.created_by, ''),
      EngineVersion: kitEngineVersion(kit),
    },
    templates: plan.files.map((f) => f.template),
    params_path: `${stateDir}/${modName}-${stampId}.params.json`,
    result_path: `${stateDir}/${modName}-${stampId}.result.json`,
  }
  writeFileSync(params.params_path, JSON.stringify(params, null, 2))

  const cmd = [
    exe,
    kit.uproject,
    '-run=pythonscript',
    `-script=${NEW_MOD_SCRIPT}`,
    '-EnablePlugins=PythonScriptPlugin,EditorScriptingUtilities',
    '-unattended',
    '-nosplash',
    '-nullrhi',
    '-nopause',
    '-stdout',
  ]
  const started = startJob(config, {
    kind: JOB_KIND,
    label: `New mod ${modName}`,
    cmd,
    cwd: kit.kitDir,
    project: kit.kitDir,
    timeoutMs: JOB_TIMEOUT_MS,
    env: { WW_NEW_MOD_PARAMS: params.params_path },
    params: params as unknown as Record<string, unknown>,
  })
  if (started.status === 'busy' && started.running) return busyText(started.running, modName)
  if (started.status !== 'started' || !started.job) {
    return report({ action: 'create', status: 'job_start_failed', mod: modName, error: started.error ?? 'не удалось запустить джоб' })
  }

  const job = (await waitJob(config, started.job.id, clampWait(args.wait_ms))) ?? started.job
  return outcomeText(config, kit, job, settle(config, kit, job), 'create')
}

function lastNewModJob(config: ServerConfig, running: boolean): JobRecord | null {
  return listJobs(config).find((j) => j.kind === JOB_KIND && (!running || j.status === 'running')) ?? null
}

type JobPick = { ok: true; job: JobRecord } | { ok: false; text: string }

function pickJob(config: ServerConfig, action: string, jobId: string | undefined): JobPick {
  const job = jobId ? readJob(config, jobId) : (lastNewModJob(config, true) ?? lastNewModJob(config, false))
  if (!job) {
    return {
      ok: false,
      text: report({ action, status: 'no_job', job_id: jobId ?? 'нет' }, {}, [
        jobId ? `джоб ${jobId} не найден в ${config.jobsDir}: хранятся последние 20 джобов` : 'создания модов джобом ещё не было',
      ]),
    }
  }
  if (job.kind !== JOB_KIND) {
    const owner = job.kind === 'cook' ? 'ww_loom_install' : 'ww_loom_build'
    return {
      ok: false,
      text: report({ action, status: 'foreign_job', job_id: job.id, job_kind: job.kind, job_status: job.status }, {}, [
        `джоб ${job.id} вида ${job.kind} принадлежит ${owner}: ${owner} action=${action === 'cancel' ? 'cancel' : 'status'} job_id=${job.id}`,
      ]),
    }
  }
  return { ok: true, job }
}

function statusText(config: ServerConfig, kit: KitPaths, args: LoomNewModArgs): string {
  const picked = pickJob(config, 'status', args.job_id)
  if (!picked.ok) return picked.text
  return outcomeText(config, kit, picked.job, settle(config, kit, picked.job), 'status')
}

async function cancelText(config: ServerConfig, kit: KitPaths, args: LoomNewModArgs): Promise<string> {
  const picked = pickJob(config, 'cancel', args.job_id)
  if (!picked.ok) return picked.text
  const job = picked.job
  if (job.status !== 'running') {
    const settled = stillRunning(job) ? ((await waitJob(config, job.id, CANCEL_LATE_MS)) ?? job) : job
    return outcomeText(config, kit, settled, settle(config, kit, settled), 'cancel')
  }
  cancelJob(config, job.id)
  await sleep(CANCEL_SETTLE_MS)
  const after = readJob(config, job.id) ?? job
  return outcomeText(config, kit, after, settle(config, kit, after), 'cancel')
}

export async function handleLoomNewMod(config: ServerConfig, args: LoomNewModArgs): Promise<string> {
  const action = args.action ?? 'status'
  const st = kitStatus(config)
  if (!st.configured || !st.kit) {
    return report({
      action,
      status: 'kit_not_configured',
      error: st.problem ?? 'кит не настроен',
      hint: 'укажи kitDir в конфиге — каталог кита с Whiskerwood.uproject (скилл /ww-setup)',
    })
  }
  const kit = st.kit
  try {
    if (action === 'create') return await createText(config, kit, args)
    if (action === 'cancel') return await cancelText(config, kit, args)
    return statusText(config, kit, args)
  } catch (e) {
    if (e instanceof PathSandboxError) return report({ action, status: 'sandbox_violation', error: e.message })
    throw e
  }
}

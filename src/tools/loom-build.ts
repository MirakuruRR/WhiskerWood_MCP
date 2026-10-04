import { closeSync, Dirent, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { ServerConfig } from '../config'
import { renderAiText, Scalar } from '../utils/ai-text'
import { activeJob, cancelJob, JobRecord, jobProgress, listJobs, readJob, startJob } from '../utils/jobs'
import { findEditorProcess, KitPaths, kitStatus, unrealEditorCmd } from '../utils/kit'

export interface LoomBuildArgs {
  action?: 'status' | 'build' | 'cancel'
  job_id?: string
  force?: boolean
  wait_ms?: number
}

const JOB_KIND = 'editor-build'

const REPORT_TYPE = 'loom_build'
const DEFAULT_WAIT_MS = 90_000
const MAX_WAIT_MS = 600_000
const JOB_TIMEOUT_MS = 30 * 60_000
const FAST_JOB_MS = 15_000
const SETTLE_MS = 4_000
const FRESH_GRACE_MS = 10_000
const POLL_MS = 1_000
const LOG_WINDOW_BYTES = 1_500_000
const LOG_TAIL_LINES = 40
const AUTOSAVES = 'Saved/Autosaves'
const LOG_LINE_RE = /LogLoom(?:Build(?:Commandlet)?)?:/
const SUMMARY_RE = /LoomBuild: (ok|failed), (\d+) errors, (\d+) Blueprints/i
const LOG_TIME_RE = /^\[(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})\]/
const BLUEPRINT_STATUSES = ['built', 'unchanged', 'failed', 'skipped']

interface ReportError {
  file?: string
  line?: number
  column?: number
  message?: string
}

interface ReportBlueprint {
  path?: string
  source?: string
  status?: string
  uses?: string
}

interface LoomReport {
  ok?: boolean
  sources?: number
  errors?: ReportError[]
  blueprints?: ReportBlueprint[]
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function two(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function stamp(ms: number): string {
  const d = new Date(ms)
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} с`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} мин ${s % 60} с`
  return `${Math.floor(m / 60)} ч ${m % 60} мин`
}

function age(ms: number): string {
  return `${duration(ms)} назад`
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

function finish(fields: Record<string, Scalar>, blocks: Record<string, string>, hints: string[]): string {
  if (hints.length > 0) {
    fields.hint = hints[0]
    blocks.hints = hints.map((h) => `- ${h}`).join('\n')
  }
  return renderAiText({
    reportType: REPORT_TYPE,
    fields,
    results: Object.keys(blocks).length > 0 ? [{ fields: {}, blocks }] : undefined,
  })
}

function readChunk(path: string, bytes: number): string {
  const size = statSync(path).size
  const take = Math.min(size, bytes)
  if (take <= 0) return ''
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(take)
    readSync(fd, buf, 0, take, size - take)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

interface LogView {
  file: string
  lines: string[]
}

/** Редактор переносит Whiskerwood.log в Whiskerwood-backup-<дата>.log на старте, поэтому свежие строки ищем и в последних бэкапах. */
function logCandidates(kit: KitPaths): Array<{ name: string; path: string }> {
  const dir = `${kit.kitDir}/Saved/Logs`
  const out: Array<{ name: string; path: string }> = [{ name: 'Whiskerwood.log', path: kit.editorLog }]
  try {
    const backups = readdirSync(dir)
      .filter((f) => /^Whiskerwood-backup-.*\.log$/.test(f))
      .map((f) => ({ name: f, path: `${dir}/${f}`, mtime: mtimeOf(`${dir}/${f}`) ?? 0 }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 3)
    for (const b of backups) out.push({ name: b.name, path: b.path })
  } catch {}
  return out
}

function loomLogView(kit: KitPaths): LogView | null {
  let first: LogView | null = null
  for (const c of logCandidates(kit)) {
    if (!existsSync(c.path)) continue
    let size = 0
    try {
      size = statSync(c.path).size
    } catch {
      continue
    }
    const text = readChunk(c.path, LOG_WINDOW_BYTES).replace(/\r/g, '')
    const lines = text
      .split('\n')
      .slice(size > LOG_WINDOW_BYTES ? 1 : 0)
      .filter((l) => LOG_LINE_RE.test(l))
    if (!first) first = { file: c.name, lines }
    if (lines.length > 0) return { file: c.name, lines }
  }
  return first
}

function lastBuildLines(lines: string[]): string[] {
  let last = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SUMMARY_RE.test(lines[i])) {
      last = i
      break
    }
  }
  if (last < 0) return lines.slice(-LOG_TAIL_LINES)
  let prev = -1
  for (let i = last - 1; i >= 0; i--) {
    if (SUMMARY_RE.test(lines[i])) {
      prev = i
      break
    }
  }
  const slice = lines.slice(prev + 1, last + 1)
  return slice.length > LOG_TAIL_LINES ? slice.slice(-LOG_TAIL_LINES) : slice
}

/** Метка времени строки лога — UTC, а mtime файла абсолютный: сравнивать их можно напрямую. */
function logInstant(line: string): number | null {
  const m = LOG_TIME_RE.exec(line)
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7]))
}

function lastSummaryLine(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SUMMARY_RE.test(lines[i])) return lines[i]
  }
  return null
}

function lastSummary(lines: string[]): string {
  const line = lastSummaryLine(lines)
  const m = line ? SUMMARY_RE.exec(line) : null
  return m ? `${m[1].toLowerCase()}, ${m[2]} errors, ${m[3]} Blueprints` : 'нет'
}

function blueprintLine(b: ReportBlueprint): string {
  const bits = [`${(b.status ?? '?').padEnd(9)} ${b.path ?? '?'}`]
  if (b.source) bits.push(`источник ${b.source}`)
  if (b.uses) bits.push(`использует непостроенный ${b.uses}`)
  return bits.join('  ')
}

function errorLine(e: ReportError): string {
  const where = e.file ? (e.line ? `${e.file}:${e.line}:${e.column ?? 0}` : e.file) : ''
  return where.length > 0 ? `${where}: ${e.message ?? ''}` : (e.message ?? '')
}

function countAutosaves(kit: KitPaths): number {
  const root = `${kit.kitDir}/${AUTOSAVES}`
  if (!existsSync(root)) return 0
  let out = 0
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(`${dir}/${e.name}`)
      else if (e.name.endsWith('.uasset')) out++
    }
  }
  walk(root)
  return out
}

function failureHints(kit: KitPaths, report: LoomReport): string[] {
  const hints: string[] = []
  const blueprints = report.blueprints ?? []
  const errors = report.errors ?? []
  const failed = blueprints.filter((b) => b.status === 'failed')
  if (failed.length > 0) {
    hints.push(
      `в применителе упал ${failed.length} Blueprint (${failed.map((b) => b.path ?? '?').join(', ')}): перед следующей сборкой удали автосейвы пакетов (*.uasset) из ${kit.kitDir}/${AUTOSAVES} — сейчас там ${countAutosaves(kit)}`,
    )
    hints.push(
      'иначе следующая сборка может упасть на assert FindObject<UBlueprint>: недособранный Blueprint остаётся в памяти редактора и мешает применить его заново',
    )
  } else if (report.ok === false && blueprints.length === 0 && errors.length > 0) {
    hints.push('отказ на уровне исходника (failed, N errors, 0 Blueprints): безопасный, редактор перезапускать и автосейвы чистить не нужно')
  }
  return hints
}

function reportFacts(kit: KitPaths): { fields: Record<string, Scalar>; blocks: Record<string, string>; hints: string[] } {
  const fields: Record<string, Scalar> = {}
  const blocks: Record<string, string> = {}
  const hints: string[] = []
  fields.report_file = kit.reportJson

  const mtime = mtimeOf(kit.reportJson)
  if (mtime === null) {
    fields.report_time = 'нет файла'
    hints.push('report.json ещё нет: сборок Blueprint не было — запусти action=build')
    return { fields, blocks, hints }
  }
  fields.report_time = stamp(mtime)
  fields.report_age = age(Date.now() - mtime)

  let text = ''
  try {
    text = readFileSync(kit.reportJson, 'utf8')
  } catch (e) {
    fields.report_ok = 'не прочитан'
    hints.push(`report.json не читается: ${(e as Error).message}`)
    return { fields, blocks, hints }
  }

  let report: LoomReport
  try {
    report = JSON.parse(text) as LoomReport
  } catch (e) {
    fields.report_ok = 'не разобран'
    blocks.report_raw = text.slice(0, 2000)
    hints.push(`report.json не разбирается как JSON: ${(e as Error).message} — сборка, похоже, прервалась на записи отчёта`)
    return { fields, blocks, hints }
  }

  const blueprints = report.blueprints ?? []
  const errors = report.errors ?? []
  const countOf = (status: string): number => blueprints.filter((b) => b.status === status).length
  fields.report_ok = report.ok === true
  if (typeof report.sources === 'number') fields.sources = report.sources
  fields.blueprints = blueprints.length
  for (const status of BLUEPRINT_STATUSES) fields[`blueprints_${status}`] = countOf(status)
  const other = blueprints.length - BLUEPRINT_STATUSES.reduce((sum, s) => sum + countOf(s), 0)
  if (other > 0) fields.blueprints_other = other
  fields.errors = errors.length
  if (blueprints.length > 0) blocks.blueprints = blueprints.map(blueprintLine).join('\n')
  if (errors.length > 0) blocks.errors = errors.map(errorLine).join('\n')
  hints.push(...failureHints(kit, report))
  return { fields, blocks, hints }
}

function jobFacts(config: ServerConfig, job: JobRecord): { fields: Record<string, Scalar>; blocks: Record<string, string> } {
  const fields: Record<string, Scalar> = {
    job_id: job.id,
    job_kind: job.kind,
    job_status: job.status,
    job_started: stamp(job.startedAt),
  }
  if (job.endedAt !== null) fields.job_ms = job.endedAt - job.startedAt
  if (job.exitCode !== null) fields.job_exit = job.exitCode
  if (job.status === 'running') fields.job_elapsed = duration(Date.now() - job.startedAt)
  if (job.error) fields.job_error = job.error

  if (job.status === 'lost') {
    const ending = jobEndingFromLog(config, job.id)
    if (ending) {
      fields.job_status = ending.timedOut ? 'timeout' : ending.code === 0 ? 'done' : 'failed'
      fields.job_exit = ending.code
      fields.job_ms = ending.seconds * 1000
      fields.job_note = 'итог взят из лога джоба: его мета не успела записать статус'
    }
  }

  const blocks: Record<string, string> = {}
  const progress = jobProgress(config, job.id, 15)
  if (progress) {
    fields.job_log_lines = progress.lines
    if (job.status === 'running' && progress.progress.length > 0) fields.job_progress = progress.progress
    if (progress.logTail.length > 0) blocks.job_log = progress.logTail
  }
  return { fields, blocks }
}

function lastEditorBuildJob(config: ServerConfig): JobRecord | null {
  return listJobs(config).find((j) => j.kind === JOB_KIND) ?? null
}

type JobPick = { ok: true; job: JobRecord | null } | { ok: false; text: string }

/** Чужой джоб (cook) этому инструменту не принадлежит: его статус и отмена — в ww_loom_install. */
function pickJob(config: ServerConfig, kit: KitPaths, action: string, jobId: string | undefined): JobPick {
  if (!jobId) return { ok: true, job: null }
  const job = readJob(config, jobId)
  if (!job) {
    return {
      ok: false,
      text: finish({ action, status: 'no_job', job_id: jobId, kit: kit.kitDir }, {}, [
        `джоб ${jobId} не найден в ${config.jobsDir}: хранятся последние 20 джобов`,
      ]),
    }
  }
  if (job.kind !== JOB_KIND) {
    return {
      ok: false,
      text: finish({ action, status: 'foreign_job', job_id: job.id, job_kind: job.kind, job_status: job.status }, {}, [
        job.kind === 'cook'
          ? `джоб ${job.id} — cook, он принадлежит ww_loom_install: ww_loom_install action=${action === 'cancel' ? 'cancel' : 'status'} job_id=${job.id}`
          : job.kind === 'new-mod'
            ? `джоб ${job.id} — создание мода, он принадлежит ww_loom_new_mod: ww_loom_new_mod action=${action === 'cancel' ? 'cancel' : 'status'} job_id=${job.id}`
            : `джоб ${job.id} вида ${job.kind} — не сборка Blueprint`,
      ]),
    }
  }
  return { ok: true, job }
}

interface JobEnding {
  code: number
  timedOut: boolean
  seconds: number
}

/** Джоб, чей процесс уже умер, а мета ещё не записала итог, опознаётся по строке [exit N за M с] в его логе. */
function jobEndingFromLog(config: ServerConfig, id: string): JobEnding | null {
  const progress = jobProgress(config, id, 60)
  if (!progress) return null
  const m = /\[exit (-?\d+)( \(timeout\))? за (\d+) с\]/.exec(progress.logTail)
  if (!m) return null
  return { code: Number(m[1]), timedOut: m[2] !== undefined, seconds: Number(m[3]) }
}

interface ProjectProc {
  pid: number
  run: string | null
}

/** findEditorProcess ловит и UnrealEditor-Cmd с -run=…: командир (Cook, LoomBuild) занимает проект так же, как редактор. */
function projectProc(kit: KitPaths): ProjectProc | null {
  const proc = findEditorProcess(kit.uproject)
  if (!proc) return null
  const m = /-run=([A-Za-z0-9_]+)/i.exec(proc.commandLine)
  return { pid: proc.pid, run: m ? m[1] : null }
}

function statusText(config: ServerConfig, kit: KitPaths, args: LoomBuildArgs): string {
  const picked = pickJob(config, kit, 'status', args.job_id)
  if (!picked.ok) return picked.text
  const fields: Record<string, Scalar> = { action: 'status', kit: kit.kitDir }
  const blocks: Record<string, string> = {}
  const hints: string[] = []

  const facts = reportFacts(kit)
  Object.assign(fields, facts.fields)
  Object.assign(blocks, facts.blocks)
  hints.push(...facts.hints)

  const view = loomLogView(kit)
  if (view) {
    fields.log_file = view.file
    fields.log_lines = view.lines.length
    fields.last_build = lastSummary(view.lines)
    const tail = lastBuildLines(view.lines)
    if (tail.length > 0) blocks.log_tail = tail.join('\n')
    const summary = lastSummaryLine(view.lines)
    const reported = mtimeOf(kit.reportJson)
    const built = summary ? logInstant(summary) : null
    if (built !== null && reported !== null && built > reported + 2_000) {
      hints.push(
        'последняя сборка в логе новее report.json: отчёт остался от прошлой сборки (редактор, похоже, упал до его записи) — сверься с log_tail',
      )
    }
  } else {
    fields.log_file = 'нет'
  }

  const proc = projectProc(kit)
  if (!proc) fields.editor = 'закрыт'
  else if (proc.run === null) fields.editor = `открыт (pid ${proc.pid})`
  else {
    fields.editor = 'закрыт'
    fields.commandlet = `-run=${proc.run} (pid ${proc.pid})`
  }

  const job = picked.job ?? activeJob(config) ?? lastEditorBuildJob(config)
  if (job) {
    const jf = jobFacts(config, job)
    Object.assign(fields, jf.fields)
    Object.assign(blocks, jf.blocks)
    const jobStatus = typeof jf.fields.job_status === 'string' ? jf.fields.job_status : job.status
    const jobExit = typeof jf.fields.job_exit === 'number' ? jf.fields.job_exit : null
    if (jobStatus === 'running' && job.kind !== JOB_KIND) {
      hints.push(
        job.kind === 'cook'
          ? `в ките идёт cook ${job.id}: пока он работает, сборка ответит busy; его статус и отмена — ww_loom_install job_id=${job.id}`
          : `в ките идёт джоб ${job.id}: пока он работает, сборка ответит busy`,
      )
    } else if (jobStatus === 'running') {
      hints.push(`сборка идёт (джоб ${job.id}): итог появится в report.json, прогресс — в его логе; прервать — ww_loom_build action=cancel job_id=${job.id}`)
      fields.next = `ww_loom_build action=status job_id=${job.id}`
    } else if (jobStatus === 'cancelled') {
      hints.push(`джоб ${job.id} отменён: report.json мог остаться от прошлой сборки — сверь report_time с job_started`)
    } else if (jobExit !== null && jobExit !== 0) {
      hints.push(`джоб ${job.id} завершился с кодом ${jobExit}: смотри job_log и errors из report.json`)
    }
  } else {
    fields.job_id = 'нет'
  }

  if (proc && proc.run === null) {
    hints.push('редактор открыт: сборку запускает плагин при сохранении .lm, headless-запуск при этом недопустим')
  } else if (proc) {
    hints.push(
      `проект занят командиром -run=${proc.run} (pid ${proc.pid}): пока он работает, сборку Blueprint запускать нельзя`,
    )
  } else {
    hints.push('редактор закрыт: action=build запустит headless-сборку джобом')
  }

  return finish(fields, blocks, hints)
}

function busyText(config: ServerConfig, kit: KitPaths, job: JobRecord): string {
  const fields: Record<string, Scalar> = { action: 'build', status: 'busy', kit: kit.kitDir }
  const jf = jobFacts(config, job)
  Object.assign(fields, jf.fields)
  if (job.kind === JOB_KIND) {
    fields.next = `прогресс и итог — ww_loom_build action=status job_id=${job.id}`
    return finish(fields, jf.blocks, [
      'уже идёт сборка этого кита: две сборки одного проекта одновременно недопустимы',
      `дождись завершения джоба ${job.id} (action=status показывает его прогресс и хвост лога) или сними его: action=cancel job_id=${job.id}`,
    ])
  }
  if (job.kind === 'new-mod') {
    fields.next = `ww_loom_new_mod action=status job_id=${job.id}`
    return finish(fields, jf.blocks, [`в ките создаётся мод (${job.id}): редактор занят этим проектом, дождись ww_loom_new_mod action=status job_id=${job.id}`])
  }
  if (job.kind !== 'cook') {
    return finish(fields, jf.blocks, [`в ките идёт джоб ${job.id}: один джоб на кит за раз, дождись его завершения`])
  }
  fields.next = `ww_loom_install action=status job_id=${job.id}`
  return finish(fields, jf.blocks, [
    `в ките идёт джоб ${job.id} (${job.kind}): cook и сборка пишут в один проект, одновременно нельзя`,
    `дождись его через ww_loom_install action=status job_id=${job.id} или сними через ww_loom_install action=cancel job_id=${job.id}`,
  ])
}

function clampWait(waitMs: number | undefined): number {
  if (typeof waitMs !== 'number' || !Number.isFinite(waitMs) || waitMs <= 0) return DEFAULT_WAIT_MS
  return Math.min(Math.round(waitMs), MAX_WAIT_MS)
}

async function watchedBuildText(kit: KitPaths, args: LoomBuildArgs, pid: number): Promise<string> {
  const before = mtimeOf(kit.reportJson)
  const startedAt = Date.now()
  const freshAtStart = before !== null && before >= startedAt - FRESH_GRACE_MS
  const waitMs = clampWait(args.wait_ms)
  const deadline = freshAtStart ? startedAt + Math.min(waitMs, SETTLE_MS) : startedAt + waitMs

  let changed = false
  while (Date.now() < deadline) {
    await sleep(POLL_MS)
    const now = mtimeOf(kit.reportJson)
    if (now !== null && now !== before) {
      changed = true
      break
    }
  }
  if (changed) await sleep(600)

  const fields: Record<string, Scalar> = {
    action: 'build',
    kit: kit.kitDir,
    mode: 'editor',
    editor: `открыт (pid ${pid})`,
    waited_ms: Date.now() - startedAt,
    trigger: 'DirectoryWatcher (плагин собирает при сохранении .lm)',
  }
  const facts = reportFacts(kit)
  Object.assign(fields, facts.fields)
  const blocks: Record<string, string> = { ...facts.blocks }
  const hints: string[] = [...facts.hints]

  if (changed) {
    fields.status = 'picked_up'
    fields.next = 'итог сборки — в полях отчёта выше; Blueprints и errors — в блоках'
    hints.push('редактор подхватил изменение Content и записал свежий report.json')
  } else if (freshAtStart) {
    fields.status = 'already_fresh'
    hints.push(
      `report.json не изменился за ${Math.round((Date.now() - startedAt) / 1000)} с, но он свежий: плагин собрал его незадолго до вызова — сохрани .lm ещё раз, если нужна пересборка`,
    )
  } else {
    fields.status = 'no_build_seen'
    fields.next = 'сохрани .lm (или закрой редактор и вызови action=build) и повтори action=status'
    hints.push(
      `за ${Math.round(waitMs / 1000)} с report.json не обновился: плагин собирает по DirectoryWatcher только при сохранении .lm`,
    )
    hints.push('если редактор только что запущен и ещё грузит проект, сборка могла не успеть — повтори вызов')
  }
  if (args.force === true) {
    hints.push('force доступен только в headless-режиме: закрой редактор и вызови action=build с force')
  }
  return finish(fields, blocks, hints)
}

async function waitJob(config: ServerConfig, id: string, budgetMs: number): Promise<JobRecord | null> {
  const deadline = Date.now() + budgetMs
  let rec = readJob(config, id)
  while (rec && Date.now() < deadline) {
    if (rec.status === 'done' || rec.status === 'failed' || rec.status === 'cancelled') break
    if (rec.status === 'lost' && jobEndingFromLog(config, id)) break
    await sleep(POLL_MS)
    rec = readJob(config, id)
  }
  return rec
}

function finishedJobText(config: ServerConfig, kit: KitPaths, job: JobRecord): string {
  const jf = jobFacts(config, job)
  const jobStatus = typeof jf.fields.job_status === 'string' ? jf.fields.job_status : job.status
  const fields: Record<string, Scalar> = {
    action: 'build',
    status: jobStatus,
    kit: kit.kitDir,
    mode: 'headless',
    cmd: job.cmd.join(' '),
  }
  Object.assign(fields, jf.fields)
  const facts = reportFacts(kit)
  const reportMtime = mtimeOf(kit.reportJson)
  const wrote = reportMtime !== null && reportMtime >= job.startedAt - 2_000
  fields.report_written = wrote
  Object.assign(fields, facts.fields)
  const blocks: Record<string, string> = { ...jf.blocks, ...facts.blocks }
  const hints: string[] = [...facts.hints]
  const exitCode = typeof fields.job_exit === 'number' ? fields.job_exit : null

  if (jobStatus === 'done' && wrote && fields.report_ok === true) {
    hints.push('сборка прошла: Blueprint\'ы применены к ассетам кита, дальше Cook & Install (ww_loom_install)')
  } else if (!wrote) {
    hints.push('headless-сборка не обновила report.json: редактор, похоже, упал до записи отчёта — причина в job_log')
  } else if (exitCode !== null && exitCode !== 0) {
    hints.push(`код выхода ${exitCode}: ошибки сборки перечислены в блоке errors и в job_log`)
  }
  if (jobStatus === 'failed' && fields.report_ok === true) {
    hints.push('отчёт ok, но процесс вышел с ошибкой: смотри хвост job_log — это отказ уже после сборки')
  }
  return finish(fields, blocks, hints)
}

function startedJobText(config: ServerConfig, kit: KitPaths, job: JobRecord, args: LoomBuildArgs): string {
  const fields: Record<string, Scalar> = {
    action: 'build',
    status: 'started',
    kit: kit.kitDir,
    mode: 'headless',
    cmd: job.cmd.join(' '),
    job_timeout_min: Math.round(JOB_TIMEOUT_MS / 60_000),
    next: `ww_loom_build action=status job_id=${job.id} — прогресс, хвост лога и итоговый report.json`,
  }
  const jf = jobFacts(config, job)
  Object.assign(fields, jf.fields)
  const hints = [
    'headless-сборка идёт от десятков секунд до минут (холодный старт редактора дольше): не жди её в блокирующем вызове, статус читается через action=status',
    `джоб переживает перезапуск MCP-сервера; прервать — ww_loom_build action=cancel job_id=${job.id}`,
  ]
  if (args.force === true) hints.push('force: собираются все Blueprint\'ы, включая неизменившиеся')
  return finish(fields, jf.blocks, hints)
}

async function headlessBuildText(config: ServerConfig, kit: KitPaths, args: LoomBuildArgs): Promise<string> {
  const exe = unrealEditorCmd(kit)
  if (!exe || !existsSync(exe)) {
    return finish({ action: 'build', status: 'no_editor_exe', kit: kit.kitDir }, {}, [
      `не найден UnrealEditor-Cmd.exe: ${exe ?? 'движок не найден (EngineAssociation кита не разрешился и engineDir не задан)'}`,
      'проверь кит и ключ engineDir в конфиге, затем повтори',
    ])
  }
  const cmd = [exe, kit.uproject, '-run=LoomBuild', '-unattended', '-nosplash', '-nullrhi', '-nopause', '-stdout']
  if (args.force === true) cmd.push('-force')
  cmd.push(`-report=${kit.reportJson}`)

  const started = startJob(config, {
    kind: 'editor-build',
    label: `LoomBuild ${kit.projectName}${args.force === true ? ' -force' : ''}`,
    cmd,
    cwd: kit.kitDir,
    project: kit.kitDir,
    timeoutMs: JOB_TIMEOUT_MS,
  })
  if (started.status === 'busy' && started.running) return busyText(config, kit, started.running)
  if (started.status !== 'started' || !started.job) {
    return finish({ action: 'build', status: 'job_start_failed', kit: kit.kitDir }, {}, [
      started.error ?? 'не удалось запустить джоб',
    ])
  }

  const job = started.job
  const done = await waitJob(config, job.id, FAST_JOB_MS)
  if (done && done.status !== 'running') return finishedJobText(config, kit, done)
  return startedJobText(config, kit, job, args)
}

async function buildText(config: ServerConfig, kit: KitPaths, args: LoomBuildArgs): Promise<string> {
  const running = activeJob(config)
  if (running) return busyText(config, kit, running)

  const proc = projectProc(kit)
  if (proc && proc.run !== null && proc.run.toLowerCase() === 'loombuild') {
    return finish({ action: 'build', status: 'headless_running', kit: kit.kitDir, pid: proc.pid, next: 'ww_loom_build action=status' }, {}, [
      `headless-сборка этого проекта уже идёт процессом ${proc.pid}: второй запуск недопустим`,
      `если джоб потерян (lost), дождись или сними процесс: taskkill /T /F /PID ${proc.pid}`,
    ])
  }
  if (proc && proc.run !== null) {
    return finish({ action: 'build', status: 'project_busy', kit: kit.kitDir, pid: proc.pid, commandlet: proc.run }, {}, [
      `проект занят командиром -run=${proc.run} (pid ${proc.pid}): две сборки одного проекта одновременно недопустимы`,
      'дождись его завершения (джоб в action=status) и повтори',
    ])
  }
  if (proc) return watchedBuildText(kit, args, proc.pid)
  return headlessBuildText(config, kit, args)
}

async function cancelText(config: ServerConfig, kit: KitPaths, args: LoomBuildArgs): Promise<string> {
  const picked = pickJob(config, kit, 'cancel', args.job_id)
  if (!picked.ok) return picked.text
  const job =
    picked.job ?? listJobs(config).find((j) => j.kind === JOB_KIND && j.status === 'running') ?? lastEditorBuildJob(config)

  if (!job) {
    const proc = projectProc(kit)
    const hints = ['headless-сборок джобом ещё не было: отменять нечего']
    if (proc && proc.run !== null && proc.run.toLowerCase() === 'loombuild') {
      hints.push(`но проект держит -run=LoomBuild (pid ${proc.pid}) без джоба: снять можно только руками — taskkill /T /F /PID ${proc.pid}`)
    }
    return finish({ action: 'cancel', status: 'no_job', kit: kit.kitDir }, {}, hints)
  }

  if (job.status !== 'running') {
    const fields: Record<string, Scalar> = { action: 'cancel', status: 'job_not_running', job_id: job.id, job_status: job.status }
    if (job.exitCode !== null) fields.job_exit = job.exitCode
    const hints = ['отменять нечего: джоб уже завершён, итог — ww_loom_build action=status job_id=' + job.id]
    const proc = projectProc(kit)
    if (job.status === 'lost' && proc && proc.run !== null && proc.run.toLowerCase() === 'loombuild') {
      hints.push(`раннер джоба потерян, а -run=LoomBuild (pid ${proc.pid}) ещё жив: taskkill /T /F /PID ${proc.pid}`)
    }
    return finish(fields, {}, hints)
  }

  const after = cancelJob(config, job.id)
  await sleep(POLL_MS)
  const proc = projectProc(kit)
  const survived = proc !== null && proc.run !== null && proc.run.toLowerCase() === 'loombuild'
  const fields: Record<string, Scalar> = {
    action: 'cancel',
    status: survived ? 'cancel_incomplete' : (after?.status ?? 'unknown'),
    job_id: job.id,
    kit: kit.kitDir,
    job_started: stamp(job.startedAt),
    job_elapsed: duration(Date.now() - job.startedAt),
    next: `ww_loom_build action=status job_id=${job.id}`,
  }
  const hints: string[] = []
  if (survived) {
    hints.push(`джоб помечен отменённым, но -run=LoomBuild (pid ${proc.pid}) ещё жив: taskkill /T /F /PID ${proc.pid}`)
  } else {
    hints.push('сборка снята деревом процессов: раннер → UnrealEditor-Cmd -run=LoomBuild; report.json от неё не записан или неполон')
  }
  hints.push(
    `если сборка успела дойти до применителя, перед следующей удали автосейвы пакетов (*.uasset) из ${kit.kitDir}/${AUTOSAVES} — сейчас там ${countAutosaves(kit)}`,
  )
  return finish(fields, {}, hints)
}

export async function handleLoomBuild(config: ServerConfig, args: LoomBuildArgs): Promise<string> {
  const action = args.action ?? 'status'
  const st = kitStatus(config)
  if (!st.configured || !st.kit) {
    return finish(
      {
        action,
        status: 'kit_not_configured',
        error: st.problem ?? 'кит не настроен',
        hint: 'укажи kitDir в конфиге — каталог кита с Whiskerwood.uproject (скилл /ww-setup)',
      },
      {},
      [],
    )
  }
  const kit = st.kit
  if (action === 'build') return buildText(config, kit, args)
  if (action === 'cancel') return cancelText(config, kit, args)
  return statusText(config, kit, args)
}

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { ServerConfig } from '../config'

export type JobKind = 'cook' | 'editor-build' | 'new-mod'
export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'lost'

export interface JobSpec {
  kind: JobKind
  label: string
  cmd: string[]
  cwd?: string
  project: string
  timeoutMs?: number
  env?: Record<string, string>
  params?: Record<string, unknown>
}

export interface JobRecord {
  id: string
  kind: JobKind
  label: string
  cmd: string[]
  cwd: string | null
  project: string
  startedAt: number
  endedAt: number | null
  exitCode: number | null
  status: JobStatus
  pid: number | null
  runnerPid?: number
  logPath: string
  metaPath: string
  timeoutMs: number
  env?: Record<string, string>
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: string
}

const JOB_KEEP = 20
const START_GRACE_MS = 1500

function norm(p: string): string {
  return p.replace(/\\/g, '/')
}

function jobPaths(config: ServerConfig, id: string): { logPath: string; metaPath: string } {
  return { logPath: norm(`${config.jobsDir}/${id}.log`), metaPath: norm(`${config.jobsDir}/${id}.json`) }
}

function writeMeta(rec: JobRecord): void {
  mkdirSync(dirOf(rec.metaPath), { recursive: true })
  writeFileSync(rec.metaPath, JSON.stringify(rec, null, 2))
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? '.' : p.slice(0, i)
}

export function isPidAlive(pid: number): boolean {
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  try {
    const p = Bun.spawnSync(['tasklist', '/FI', `PID eq ${pid}`, '/NH'], { stdout: 'pipe', stderr: 'pipe' })
    return new TextDecoder().decode(p.stdout).includes(String(pid))
  } catch {
    return false
  }
}

function normalize(rec: JobRecord): JobRecord {
  if (rec.status !== 'running') return rec
  const startedAgo = Date.now() - rec.startedAt
  const alive = rec.pid !== null && isPidAlive(rec.pid)
  if (!alive && startedAgo > START_GRACE_MS) {
    return { ...rec, status: 'lost', endedAt: rec.endedAt ?? Date.now() }
  }
  return rec
}

export function readJob(config: ServerConfig, id: string): JobRecord | null {
  const { metaPath } = jobPaths(config, id)
  try {
    const rec = JSON.parse(readFileSync(metaPath, 'utf8')) as JobRecord
    return normalize(rec)
  } catch {
    return null
  }
}

export function listJobs(config: ServerConfig, limit = JOB_KEEP): JobRecord[] {
  let files: string[]
  try {
    files = readdirSync(config.jobsDir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const out: JobRecord[] = []
  for (const f of files) {
    const rec = readJob(config, f.replace(/\.json$/, ''))
    if (rec) out.push(rec)
  }
  return out.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
}

export function activeJob(config: ServerConfig): JobRecord | null {
  return listJobs(config).find((j) => j.status === 'running') ?? null
}

export interface StartResult {
  status: 'started' | 'busy' | 'failed'
  job: JobRecord | null
  running?: JobRecord
  error?: string
}

export function startJob(config: ServerConfig, spec: JobSpec): StartResult {
  const running = activeJob(config)
  if (running) return { status: 'busy', job: null, running }

  mkdirSync(config.jobsDir, { recursive: true })
  const startedAt = Date.now()
  const id = `${spec.kind}-${new Date(startedAt).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '')}`
  const { logPath, metaPath } = jobPaths(config, id)
  const rec: JobRecord = {
    id,
    kind: spec.kind,
    label: spec.label,
    cmd: spec.cmd,
    cwd: spec.cwd ? norm(spec.cwd) : null,
    project: norm(spec.project),
    startedAt,
    endedAt: null,
    exitCode: null,
    status: 'running',
    pid: null,
    logPath,
    metaPath,
    timeoutMs: spec.timeoutMs ?? 0,
    env: spec.env,
    params: spec.params,
  }
  writeMeta(rec)
  writeFileSync(logPath, `$ ${spec.cmd.join(' ')}\n`)

  const runner = norm(`${import.meta.dir}/../scripts/job-runner.ts`)
  try {
    const proc = Bun.spawn([process.execPath, 'run', runner, metaPath], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      detached: true,
    })
    proc.unref()
    rec.pid = proc.pid
    writeMeta(rec)
  } catch (e) {
    rec.status = 'failed'
    rec.error = (e as Error).message
    writeMeta(rec)
    return { status: 'failed', job: rec, error: (e as Error).message }
  }

  pruneJobs(config)
  return { status: 'started', job: rec }
}

export function updateJob(config: ServerConfig, id: string, patch: Partial<JobRecord>): JobRecord | null {
  const rec = readJob(config, id)
  if (!rec) return null
  const next = { ...rec, ...patch }
  writeMeta(next)
  return next
}

function killTree(pid: number): void {
  try {
    Bun.spawnSync(['taskkill', '/T', '/F', '/PID', String(pid)], { stdout: 'ignore', stderr: 'ignore' })
  } catch {}
}

/** Имя образа живого процесса; null — процесса нет. Вне Windows имя не проверяется. */
function processImage(pid: number): string | null {
  if (process.platform !== 'win32') return isPidAlive(pid) ? '' : null
  try {
    const p = Bun.spawnSync(['tasklist', '/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { stdout: 'pipe', stderr: 'pipe' })
    for (const line of new TextDecoder().decode(p.stdout).split(/\r?\n/)) {
      const cells = /^"([^"]*)","(\d+)"/.exec(line.trim())
      if (cells && Number(cells[2]) === pid) return cells[1].toLowerCase()
    }
  } catch {}
  return null
}

function imageMatches(pid: number, expected: string): boolean {
  const image = processImage(pid)
  if (image === null) return false
  if (image === '') return true
  const want = expected.toLowerCase()
  return image === want || image === `${want}.exe`
}

function exeName(cmd0: string | undefined): string {
  return (cmd0 ?? '').replace(/\\/g, '/').split('/').pop()?.replace(/\.exe$/i, '') ?? ''
}

/** Сначала раннер: иначе он увидит выход ребёнка и перезапишет мету статусом failed.
 *  pid из меты мог достаться чужому процессу, поэтому снимаем только живой процесс с ожидаемым образом. */
export function cancelJob(config: ServerConfig, id: string): JobRecord | null {
  const rec = readJob(config, id)
  if (!rec) return null
  if (rec.status !== 'running') return rec
  const runner = exeName(process.execPath)
  if (typeof rec.runnerPid === 'number' && imageMatches(rec.runnerPid, runner)) killTree(rec.runnerPid)
  if (rec.pid !== null && rec.pid !== rec.runnerPid) {
    const child = rec.runnerPid === undefined ? runner : exeName(rec.cmd[0])
    if (child.length > 0 && imageMatches(rec.pid, child)) killTree(rec.pid)
  }
  return updateJob(config, id, { status: 'cancelled', endedAt: Date.now() })
}

export interface JobProgress {
  job: JobRecord
  alive: boolean
  progress: string
  lines: number
  logTail: string
}

const PROGRESS_PATTERNS: RegExp[] = [
  /\[\d+\/\d+\]\s*(.+)$/,
  /\b(Cooking|Cook|Stage|Staging|Pak|Package|Copying|Build|Building|Deploy)\b.*$/i,
  /LogLoomBuild:\s*(.+)$/,
  /LogLoom:\s*(.+)$/,
]

/** Последняя осмысленная строка лога: по ней видно, на чём стоит долгая операция. */
export function progressLine(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0 && i > lines.length - 500; i--) {
    for (const re of PROGRESS_PATTERNS) {
      if (re.test(lines[i])) return lines[i].trim()
    }
  }
  return ''
}

export function jobProgress(config: ServerConfig, id: string, tailLines = 15): JobProgress | null {
  const rec = readJob(config, id)
  if (!rec) return null
  let text = ''
  try {
    text = readFileSync(rec.logPath, 'utf8')
  } catch {}
  const isNoise = (l: string) => /^\$ /.test(l) || /^\[pid \d+\]$/.test(l) || /^\[exit /.test(l)
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => l.trim().length > 0)
  const spoken = lines.filter((l) => !isNoise(l.trim()))
  const fromPattern = progressLine(spoken)
  const progress = fromPattern.length > 0 ? fromPattern : spoken.length > 0 ? spoken[spoken.length - 1].trim() : ''
  return {
    job: rec,
    alive: rec.pid !== null && isPidAlive(rec.pid),
    progress,
    lines: lines.length,
    logTail: lines.slice(Math.max(0, lines.length - tailLines)).join('\n'),
  }
}

export function pruneJobs(config: ServerConfig): void {
  const all = listJobs(config, 1000)
  for (const old of all.slice(JOB_KEEP)) {
    try {
      rmSync(old.logPath, { force: true })
      rmSync(old.metaPath, { force: true })
    } catch {}
  }
}

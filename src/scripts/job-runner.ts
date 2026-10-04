/**
 * Отсоединяемый исполнитель долгих операций: cook, headless-сборка, пакетный lift.
 * Запускается сервером как отдельный процесс, поэтому переживает его перезапуск.
 * Спецификация и итог лежат в state/jobs/<id>.json, вывод процесса — в <id>.log.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

interface Meta {
  id: string
  kind: string
  label: string
  cmd: string[]
  cwd: string | null
  project: string
  startedAt: number
  endedAt: number | null
  exitCode: number | null
  status: string
  pid: number | null
  logPath: string
  metaPath: string
  timeoutMs: number
  env?: Record<string, string>
  result?: Record<string, unknown>
  error?: string
  runnerPid?: number
}

const metaPath = process.argv[2]
if (!metaPath) {
  console.error('job-runner: нужен путь к meta.json')
  process.exit(2)
}

const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Meta
const save = (patch: Partial<Meta>) => {
  Object.assign(meta, patch)
  writeFileSync(metaPath, JSON.stringify(meta, null, 2))
}

const write = (chunk: string) => {
  try {
    appendFileSync(meta.logPath, chunk)
  } catch {}
}

function killTree(pid: number): void {
  try {
    Bun.spawnSync(['taskkill', '/T', '/F', '/PID', String(pid)], { stdout: 'ignore', stderr: 'ignore' })
  } catch {}
}

function pump(stream: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!stream) return Promise.resolve()
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  return (async () => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      write(decoder.decode(value, { stream: true }))
    }
  })()
}

const started = Date.now()
save({ runnerPid: process.pid })

let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
try {
  proc = Bun.spawn(meta.cmd, {
    cwd: meta.cwd ?? undefined,
    env: meta.env ? { ...process.env, ...meta.env } : undefined,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
} catch (e) {
  write(`\nне удалось запустить: ${(e as Error).message}\n`)
  save({ status: 'failed', endedAt: Date.now(), error: (e as Error).message })
  process.exit(1)
}

save({ pid: proc.pid })
write(`\n[pid ${proc.pid}]\n`)

let timedOut = false
let timer: ReturnType<typeof setTimeout> | null = null
if (meta.timeoutMs > 0) {
  timer = setTimeout(() => {
    timedOut = true
    killTree(proc.pid)
  }, meta.timeoutMs)
}

const code = await proc.exited
await Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>), pump(proc.stderr as ReadableStream<Uint8Array>)])
if (timer) clearTimeout(timer)

const endedAt = Date.now()
write(`\n[exit ${code}${timedOut ? ' (timeout)' : ''} за ${Math.round((endedAt - started) / 1000)} с]\n`)
if (timedOut) save({ status: 'failed', exitCode: code, endedAt, error: `таймаут ${meta.timeoutMs} мс` })
else save({ status: code === 0 ? 'done' : 'failed', exitCode: code, endedAt })
process.exit(0)

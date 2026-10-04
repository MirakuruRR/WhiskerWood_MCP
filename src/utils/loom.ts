import { existsSync } from 'node:fs'
import { KitPaths, unrealPakExe } from './kit'

export type RunOutcome = 'ok' | 'not_configured' | 'not_found' | 'timeout' | 'exit_code' | 'crash'

export interface RunResult {
  outcome: RunOutcome
  code: number | null
  stdout: string
  stderr: string
  ms: number
  cmd: string
  timeoutMs: number
  signal: string | null
}

export interface RunOptions {
  cwd?: string
  timeoutMs?: number
  env?: Record<string, string>
  onLine?: (line: string) => void
}

const DEFAULT_TIMEOUT_MS = 120_000
const TAIL_LINES = 20

export function tail(text: string, lines = TAIL_LINES): string {
  const all = text.replace(/\r/g, '').split('\n').filter((l) => l.trim().length > 0)
  return all.slice(Math.max(0, all.length - lines)).join('\n')
}

function killTree(pid: number): void {
  try {
    Bun.spawnSync(['taskkill', '/T', '/F', '/PID', String(pid)], { stdout: 'ignore', stderr: 'ignore' })
  } catch {}
}

async function drain(
  stream: ReadableStream<Uint8Array> | null,
  sink: (chunk: string) => void,
): Promise<void> {
  if (!stream) return
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let carry = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const text = carry + decoder.decode(value, { stream: true })
    const parts = text.split('\n')
    carry = parts.pop() ?? ''
    for (const line of parts) sink(line)
  }
  if (carry.length > 0) sink(carry)
}

/** Единственная точка запуска внешних программ: loom.exe, UnrealEditor-Cmd, RunUAT, UnrealPak. */
export async function runExternal(cmd: string[], options: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const started = Date.now()
  const shown = cmd.map((c) => (c.includes(' ') ? `"${c}"` : c)).join(' ')

  if (cmd.length === 0 || !existsSync(cmd[0]) && !isOnPath(cmd[0])) {
    return {
      outcome: 'not_found',
      code: null,
      stdout: '',
      stderr: `не найден исполняемый файл: ${cmd[0] ?? '(пусто)'}`,
      ms: 0,
      cmd: shown,
      timeoutMs,
      signal: null,
    }
  }

  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    proc = Bun.spawn(cmd, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : undefined,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (e) {
    return {
      outcome: 'not_found',
      code: null,
      stdout: '',
      stderr: (e as Error).message,
      ms: Date.now() - started,
      cmd: shown,
      timeoutMs,
      signal: null,
    }
  }

  let out = ''
  let err = ''
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killTree(proc.pid)
  }, timeoutMs)

  const pump = Promise.all([
    drain(proc.stdout as ReadableStream<Uint8Array>, (line) => {
      out += `${line}\n`
      out = out.length > 4_000_000 ? out.slice(-2_000_000) : out
      options.onLine?.(line)
    }),
    drain(proc.stderr as ReadableStream<Uint8Array>, (line) => {
      err += `${line}\n`
      err = err.length > 1_000_000 ? err.slice(-500_000) : err
      options.onLine?.(line)
    }),
  ])

  const code = await proc.exited
  await pump
  clearTimeout(timer)

  const ms = Date.now() - started
  const signal = proc.signalCode ?? null
  let outcome: RunOutcome
  if (timedOut) outcome = 'timeout'
  else if (code === 0) outcome = 'ok'
  else if (code === null) outcome = 'crash'
  else outcome = 'exit_code'

  return { outcome, code, stdout: out, stderr: err, ms, cmd: shown, timeoutMs, signal }
}

function isOnPath(exe: string): boolean {
  if (exe.includes('/') || exe.includes('\\')) return false
  const path = process.env.PATH ?? ''
  const names = process.platform === 'win32' && !exe.toLowerCase().endsWith('.exe') ? [exe, `${exe}.exe`] : [exe]
  return path
    .split(';')
    .some((dir) => dir.length > 0 && names.some((n) => existsSync(`${dir.replace(/\\/g, '/')}/${n}`)))
}

export interface JsonRun {
  result: RunResult
  json: unknown | null
  parseError: string | null
}

/** loom check/build/sources печатают JSON и на ошибке выходят с кодом 1: это результат, а не сбой запуска. */
export async function loomJson(kit: KitPaths, args: string[], options: RunOptions = {}): Promise<JsonRun> {
  const result = await loomRun(kit, args, options)
  const text = result.stdout.trim()
  if (text.length === 0) return { result, json: null, parseError: result.outcome === 'ok' ? 'пустой stdout' : null }
  try {
    return { result, json: JSON.parse(text) as unknown, parseError: null }
  } catch {}

  // Лог редактора или предупреждения могут обрамлять JSON: берём срез от первой скобки до последней.
  const starts = [text.indexOf('{'), text.indexOf('[')].filter((i) => i >= 0)
  const start = starts.length > 0 ? Math.min(...starts) : -1
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
  if (start < 0 || end <= start) return { result, json: null, parseError: 'JSON в выводе не найден' }
  const raw = text.slice(start, end + 1)
  try {
    return { result, json: JSON.parse(raw) as unknown, parseError: null }
  } catch (e) {
    return { result, json: null, parseError: (e as Error).message }
  }
}

export async function loomRun(kit: KitPaths, args: string[], options: RunOptions = {}): Promise<RunResult> {
  if (!existsSync(kit.loomExe)) {
    return {
      outcome: 'not_found',
      code: null,
      stdout: '',
      stderr: `нет ${kit.loomExe}`,
      ms: 0,
      cmd: `${kit.loomExe} ${args.join(' ')}`,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: null,
    }
  }
  return runExternal([kit.loomExe, ...args], options)
}

export function loomCheck(kit: KitPaths, options: RunOptions = {}): Promise<JsonRun> {
  return loomJson(kit, ['check', '--project', kit.kitDir, '--json'], options)
}

/** loom lift печатает текст ("wrote …"/"could not lift …"); на отказе выходит с кодом 1, на переполнении
 *  стека умирает без вывода. Подъём идёт в проект `project`, а не в сам кит: поднятый исходник
 *  в <кит>/Content LoomBuild собрал бы поверх игрового BP. */
export function loomLift(kit: KitPaths, jsonFiles: string[], project: string, options: RunOptions = {}): Promise<RunResult> {
  return loomRun(kit, ['lift', ...jsonFiles, '--project', project], options)
}

export async function unrealPakList(kit: KitPaths, pak: string, options: RunOptions = {}): Promise<RunResult> {
  const exe = unrealPakExe(kit)
  if (!exe) {
    return {
      outcome: 'not_found',
      code: null,
      stdout: '',
      stderr: 'не найден UnrealPak.exe (движок не найден)',
      ms: 0,
      cmd: `${pak} -List`,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: null,
    }
  }
  return runExternal([exe, pak, '-List'], { timeoutMs: 120_000, ...options })
}

export function describeRun(res: RunResult): string {
  const bits = [`outcome=${res.outcome}`, `ms=${res.ms}`]
  if (res.code !== null) bits.push(`exit=${res.code}`)
  if (res.signal) bits.push(`signal=${res.signal}`)
  return bits.join(' ')
}

/** Человекочитаемая причина отказа: хвост stderr, иначе хвост stdout. */
export function failureDetail(res: RunResult): string {
  const err = tail(res.stderr, 12)
  if (err.length > 0) return err
  return tail(res.stdout, 12)
}

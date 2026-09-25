import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadConfig } from '../../src/config'
import { listCrashes, listGuardReports, parseGuardVerdict } from '../../src/utils/crash-report'

interface Crash {
  name: string
  atMs: number
  at: string
  detail: string
}

const ADVICE = 'Разбери падение через ww_crash_report. Не отчитывайся об успехе, пока краш не объяснён.'
const SESSION_TTL_MS = 24 * 3600_000

function oneLine(s: string, n: number): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, n)
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

function writeJson(dir: string, path: string, value: unknown): void {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, JSON.stringify(value, null, 2))
  } catch {}
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'post'
  if (!process.env.WWMCP_CONFIG) process.env.WWMCP_CONFIG = resolve(import.meta.dir, '../../wwmcp.config.json')

  let input: { session_id?: string; stop_hook_active?: boolean } = {}
  try {
    input = JSON.parse(await Bun.stdin.text()) ?? {}
  } catch {}
  const sessionId = (input.session_id ?? '').replace(/[^\w-]/g, '')
  if (!sessionId) return

  const config = loadConfig()
  const dir = `${config.stateDir}/crash-watch`
  const handledPath = `${dir}/handled.json`
  const sessionPath = `${dir}/session-${sessionId}.json`

  const newestCrash = (): Crash | null => {
    const engine = listCrashes(config)[0]
    const guard = listGuardReports(config)[0]
    if (guard && (!engine || guard.atMs >= engine.atMs)) {
      let suspect = ''
      try {
        suspect = parseGuardVerdict(readFileSync(guard.path, 'utf8')).suspect
      } catch {}
      return { name: guard.name, atMs: guard.atMs, at: guard.at, detail: suspect }
    }
    return engine ? { name: engine.name, atMs: engine.atMs, at: engine.at, detail: engine.errorMessage } : null
  }

  if (mode === 'arm') {
    if (readJson(sessionPath)) return
    writeJson(dir, sessionPath, { armedAt: Date.now() })
    try {
      for (const f of readdirSync(dir)) {
        if (!f.startsWith('session-')) continue
        const p = `${dir}/${f}`
        if (Date.now() - statSync(p).mtimeMs > SESSION_TTL_MS) rmSync(p, { force: true })
      }
    } catch {}
    return
  }

  const handledAt = readJson<{ crashAtMs: number }>(handledPath)?.crashAtMs ?? 0
  const newest = newestCrash()

  if (mode === 'ack') {
    if (newest && newest.atMs > handledAt) writeJson(dir, handledPath, { crashAtMs: newest.atMs })
    return
  }

  const armedAt = readJson<{ armedAt: number }>(sessionPath)?.armedAt
  if (armedAt === undefined || !newest || newest.atMs <= Math.max(armedAt, handledAt)) return

  const detail = newest.detail ? ` — ${oneLine(newest.detail, 200)}` : ''
  const line = `КРАШ ИГРЫ: ${newest.name}, ${newest.at}${detail}`
  const text = `${line}\n${ADVICE}`

  if (mode === 'stop') {
    if (input.stop_hook_active === true) return
    console.log(JSON.stringify({ decision: 'block', reason: text }))
    return
  }

  console.log(
    JSON.stringify({
      systemMessage: line,
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text },
    }),
  )
}

try {
  await main()
} catch {}

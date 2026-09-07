import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadConfig } from '../../src/config'
import { listCrashes } from '../../src/utils/crash-report'
import { findGameProcess, readState } from '../../src/utils/game-process'

interface Marker {
  crashAtMs: number
  ackExitLaunchedAt: number
}

const ADVICE =
  'Разбери падение через ww_crash_report (детали выхода — ww_game_process). ' +
  'Не отчитывайся об успехе, пока краш не объяснён.'

function oneLine(s: string, n: number): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, n)
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'post'
  if (!process.env.WWMCP_CONFIG) process.env.WWMCP_CONFIG = resolve(import.meta.dir, '../../wwmcp.config.json')

  const config = loadConfig()
  const markerPath = `${config.stateDir}/crash-watch.json`

  const readMarker = (): Marker | null => {
    try {
      return JSON.parse(readFileSync(markerPath, 'utf8')) as Marker
    } catch {
      return null
    }
  }
  const writeMarker = (m: Marker): void => {
    try {
      mkdirSync(config.stateDir, { recursive: true })
      writeFileSync(markerPath, JSON.stringify(m, null, 2))
    } catch {}
  }

  const state = readState(config)
  const newest = listCrashes(config)[0] ?? null
  const launchedAt = state.launchedAt ?? 0
  const exitPending = launchedAt > 0 && (state.stopRequestedAt ?? 0) < launchedAt
  const marker = readMarker()

  if (!marker) {
    const gone = exitPending && findGameProcess(config) === null
    writeMarker({ crashAtMs: newest?.atMs ?? 0, ackExitLaunchedAt: gone ? launchedAt : 0 })
    return
  }

  const freshCrash = newest !== null && newest.atMs > marker.crashAtMs
  const gameGone =
    exitPending && marker.ackExitLaunchedAt !== launchedAt && findGameProcess(config) === null

  if (mode === 'ack') {
    writeMarker({
      crashAtMs: newest?.atMs ?? marker.crashAtMs,
      ackExitLaunchedAt: gameGone ? launchedAt : marker.ackExitLaunchedAt,
    })
    return
  }

  const lines: string[] = []
  if (freshCrash && newest) {
    const err = newest.errorMessage ? ` — ${oneLine(newest.errorMessage, 200)}` : ''
    lines.push(`КРАШ ИГРЫ: ${newest.name}, ${newest.at}${err}`)
  }
  if (gameGone) {
    lines.push(
      `ПРОЦЕСС ИГРЫ ИСЧЕЗ не по команде MCP (запуск ${new Date(launchedAt).toISOString()}); крашдамп может дописываться ещё несколько секунд`,
    )
  }
  if (lines.length === 0) return

  const text = `${lines.join('\n')}\n${ADVICE}`

  if (mode === 'stop') {
    let stopActive = false
    try {
      stopActive = JSON.parse(await Bun.stdin.text())?.stop_hook_active === true
    } catch {}
    if (stopActive) return
    console.log(JSON.stringify({ decision: 'block', reason: text }))
    return
  }

  console.log(
    JSON.stringify({
      systemMessage: lines[0],
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text },
    }),
  )
}

try {
  await main()
} catch {}

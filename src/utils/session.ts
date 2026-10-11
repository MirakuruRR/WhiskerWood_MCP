import { readFileSync } from 'node:fs'
import { ServerConfig } from '../config'
import { Scalar } from './ai-text'
import { findGameProcess, readState, ProcInfo } from './game-process'
import { SESSION, SessionInfo } from './session-id'

export { SESSION }
export type { SessionInfo }

interface Activity extends SessionInfo {
  at: number
  op: string
}

const ACTIVE_WINDOW_MS = 10 * 60_000
const LAUNCH_MATCH_MS = 180_000

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function sessionLabel(s: SessionInfo | null | undefined): string {
  if (!s) return 'неизвестна'
  if (s.pid === SESSION.pid) return `${s.id} (эта сессия)`
  return `${s.id} (другая сессия, ${pidAlive(s.pid) ? 'жива' : 'завершена'})`
}

export function activityPath(config: ServerConfig): string {
  return `${config.stateDir}/game-activity.json`
}

function readActivity(config: ServerConfig): Activity | null {
  try {
    return JSON.parse(readFileSync(activityPath(config), 'utf8')) as Activity
  } catch {
    return null
  }
}

export interface GameOwnership {
  conflict: 'none' | 'external' | 'other_session'
  fields: Record<string, Scalar>
}

/**
 * Чья запущенная игра: этой сессии, другой сессии MCP или запущена мимо MCP.
 * `proc` — уже найденный процесс, чтобы не искать его второй раз за вызов.
 */
export function gameOwnership(config: ServerConfig, proc?: ProcInfo | null): GameOwnership {
  const running = proc === undefined ? findGameProcess(config) : proc
  if (!running) return { conflict: 'none', fields: {} }
  const state = readState(config)
  const fields: Record<string, Scalar> = {}
  const launchedByMcp =
    typeof state.launchedAt === 'number' &&
    running.startedAt > 0 &&
    running.startedAt >= state.launchedAt - 5_000 &&
    running.startedAt <= state.launchedAt + LAUNCH_MATCH_MS
  fields.game_launched_by = !launchedByMcp
    ? 'не через MCP (вручную, Steam или другой стенд)'
    : state.launchedBy
      ? sessionLabel(state.launchedBy)
      : 'MCP, сессия не записана'

  const act = readActivity(config)
  const recent = act && Date.now() - act.at < ACTIVE_WINDOW_MS && act.pid !== SESSION.pid && pidAlive(act.pid)
  if (act && Date.now() - act.at < ACTIVE_WINDOW_MS) {
    fields.game_last_used_by = `${sessionLabel(act)}, ${Math.round((Date.now() - act.at) / 1000)} с назад (${act.op})`
  }

  if (!launchedByMcp) return { conflict: 'external', fields }
  const owner = state.launchedBy
  if ((owner && owner.pid !== SESSION.pid && pidAlive(owner.pid)) || recent) return { conflict: 'other_session', fields }
  return { conflict: 'none', fields }
}

export function ownershipHint(o: GameOwnership, act: 'stop' | 'click' = 'stop'): string {
  if (act === 'click') {
    return 'игрой сейчас пользуется другая сессия MCP: клик собьёт её проверку (курсор, фокус, состояние UI). Договорись или повтори с takeover=true'
  }
  return o.conflict === 'external'
    ? 'игру запустили не через MCP — возможно, в неё играет человек. Закрывать её можно только с takeover=true'
    : 'игрой сейчас пользуется другая сессия MCP: закрыв её, ты сорвёшь её проверку. Договорись или повтори с takeover=true'
}

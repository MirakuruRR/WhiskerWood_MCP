import { GameContext } from '../utils/game-context'
import { BridgeResult, BridgeStatus } from '../utils/bridge-client'
import { Scalar } from '../utils/ai-text'

const MAIN_MENU_RE = /MainMenu/i

export function isLevelLoaded(world: string): boolean {
  return world.length > 0 && !MAIN_MENU_RE.test(world)
}

export function echoFields(ctx: GameContext | null): Record<string, Scalar> {
  return {
    game_version: ctx?.gameVersion ?? 'unknown',
    index_revision: ctx?.indexRevision ?? 'unknown',
  }
}

export const BRIDGE_HINTS: Record<string, string> = {
  game_not_running:
    'мост не отвечает: игра не запущена, либо мод WWBridge не включён в mods.txt. Read-инструменты работают без игры',
  session_changed: 'игра перезапустилась во время вызова; результат отброшен, повторите вызов',
  timeout: 'мост не ответил за отведённое время; увеличьте timeout_ms либо проверьте, не подвис ли игровой поток',
}

export function bridgeFailureFields(res: Exclude<BridgeResult, { status: 'ok' } | { status: 'error' }>): Record<string, Scalar> {
  const fields: Record<string, Scalar> = { status: res.status }
  if (res.status === 'timeout') fields.waited_ms = res.waitedMs
  const hint = BRIDGE_HINTS[res.status]
  if (hint) fields.hint = hint
  return fields
}

export function statusFields(st: BridgeStatus): Record<string, Scalar> {
  return {
    bridge_session: st.session,
    tick: st.tick,
    uptime_s: st.startedTs > 0 ? Math.max(0, st.ts - st.startedTs) : 0,
    heartbeat_age_ms: Math.round(st.freshMs),
    busy: st.busy || 'no',
    world: st.world || 'unknown',
    level_loaded: isLevelLoaded(st.world),
  }
}

import { existsSync } from 'node:fs'
import { ServerConfig } from '../config'
import { GameContext } from '../utils/game-context'
import { getBridge } from '../utils/bridge-client'
import { lastError } from '../utils/ue4ss-log'
import { renderAiText, Scalar } from '../utils/ai-text'
import { echoFields, statusFields } from './bridge-common'

export async function handleGameStatus(ctx: GameContext | null, config: ServerConfig): Promise<string> {
  const bridge = getBridge(config)
  const st = await bridge.readStatusStable()
  const fields: Record<string, Scalar> = { ...echoFields(ctx) }

  if (!st) {
    fields.status = existsSync(bridge.statusPath) ? 'game_not_running' : 'bridge_not_installed'
    fields.bridge_root = bridge.root
    fields.hint =
      fields.status === 'bridge_not_installed'
        ? 'мост ни разу не стартовал: выполните `bun run bridge:deploy`, затем запустите игру'
        : 'файл статуса есть, но не читается; игра, скорее всего, закрыта'
  } else if (!bridge.isAlive(st)) {
    fields.status = 'game_not_running'
    Object.assign(fields, statusFields(st))
    fields.hint = 'heartbeat моста устарел: игра закрыта или подвисла'
  } else {
    fields.status = 'running'
    Object.assign(fields, statusFields(st))
    if (st.lastError) fields.last_bridge_error = st.lastError
  }

  const err = lastError(`${config.ue4ssDir}/UE4SS.log`)
  if (err) {
    fields.last_log_error_at = err.ts
    fields.last_log_error = err.text.split('\n')[0].slice(0, 200)
  }

  return renderAiText({ reportType: 'game_status', fields })
}

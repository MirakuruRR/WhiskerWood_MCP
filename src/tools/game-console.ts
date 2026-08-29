import { ServerConfig } from '../config'
import { GameContext } from '../utils/game-context'
import { getBridge } from '../utils/bridge-client'
import { renderAiText, Scalar } from '../utils/ai-text'
import { bridgeFailureFields, echoFields } from './bridge-common'

export interface GameConsoleArgs {
  command: string
}

export async function handleGameConsole(
  ctx: GameContext | null,
  config: ServerConfig,
  args: GameConsoleArgs,
): Promise<string> {
  const bridge = getBridge(config)
  const command = args.command.replace(/[\r\n]+/g, ' ').trim()
  const fields: Record<string, Scalar> = { ...echoFields(ctx), command }

  if (!command) {
    fields.status = 'bad_request'
    fields.error = 'пустая команда'
    return renderAiText({ reportType: 'game_console', fields })
  }

  const res = await bridge.call('console', command)
  if (res.status === 'ok') {
    fields.status = 'sent'
    fields.elapsed_ms = res.elapsedMs
    fields.note = 'вывод команды идёт в игровую консоль и UE4SS.log; читайте его через ww_game_log'
    return renderAiText({ reportType: 'game_console', fields })
  }
  if (res.status === 'error') {
    fields.status = 'error'
    fields.error = res.body.replace(/[\r\n]+/g, ' ').slice(0, 300)
    if (res.body.includes('no_console_target')) {
      fields.hint = 'ни мира, ни PlayerController: уровень не загружен, команда невыполнима из главного меню'
    }
    return renderAiText({ reportType: 'game_console', fields })
  }
  Object.assign(fields, bridgeFailureFields(res))
  return renderAiText({ reportType: 'game_console', fields })
}

import { ServerConfig } from '../config'
import { GameContext } from '../utils/game-context'
import { getBridge } from '../utils/bridge-client'
import { renderAiText, Scalar } from '../utils/ai-text'
import { bpReach, bpReachLine } from '../utils/bp-reach'
import { bridgeFailureFields, echoFields } from './bridge-common'

export interface GameEvalArgs {
  lua: string
  timeout_ms?: number
}

export async function handleGameEval(
  ctx: GameContext | null,
  config: ServerConfig,
  args: GameEvalArgs,
): Promise<string> {
  const bridge = getBridge(config)
  const timeout = Math.min(Math.max(args.timeout_ms ?? config.bridgeTimeoutMs, 200), 120_000)
  const res = await bridge.call('eval', args.lua, timeout)
  const fields: Record<string, Scalar> = { ...echoFields(ctx) }

  let warning: string | null = null
  if (ctx) {
    try {
      warning = bpReachLine(bpReach(ctx, config, args.lua))
    } catch {
      warning = null
    }
  }

  if (res.status === 'ok') {
    let body = res.body
    const execLine = /^exec=(\w+)\n?/.exec(body)
    if (execLine) {
      fields.exec = execLine[1]
      body = body.slice(execLine[0].length)
    }
    fields.status = 'ok'
    fields.elapsed_ms = res.elapsedMs
    if (warning) fields.bp_warning = warning
    return renderAiText({
      reportType: 'game_eval',
      fields,
      results: [{ fields: {}, blocks: { result: body } }],
    })
  }

  if (res.status === 'error') {
    fields.status = 'lua_error'
    fields.elapsed_ms = res.elapsedMs
    if (warning) fields.bp_warning = warning
    return renderAiText({
      reportType: 'game_eval',
      fields,
      results: [{ fields: {}, blocks: { error: res.body } }],
    })
  }

  Object.assign(fields, bridgeFailureFields(res))
  return renderAiText({ reportType: 'game_eval', fields })
}

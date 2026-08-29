import { existsSync } from 'node:fs'
import { ServerConfig } from '../config'
import { GameContext } from '../utils/game-context'
import { LogLevel, selectLogEntries } from '../utils/ue4ss-log'
import { renderAiText, Scalar } from '../utils/ai-text'
import { echoFields } from './bridge-common'

export interface GameLogArgs {
  since?: string
  level?: LogLevel | 'all'
  mod?: string
  limit?: number
}

const MAX_LIMIT = 500

export function handleGameLog(ctx: GameContext | null, config: ServerConfig, args: GameLogArgs): string {
  const path = `${config.ue4ssDir}/UE4SS.log`
  const fields: Record<string, Scalar> = { ...echoFields(ctx), log_path: path }

  if (!existsSync(path)) {
    fields.status = 'log_not_found'
    return renderAiText({ reportType: 'game_log', fields })
  }

  const limit = Math.min(args.limit ?? 100, MAX_LIMIT)
  const sel = selectLogEntries(path, { since: args.since, level: args.level, mod: args.mod, limit })

  fields.status = 'ok'
  fields.since = sel.sinceResolved
  fields.level = args.level ?? 'all'
  if (args.mod) fields.mod = args.mod
  fields.log_mtime = sel.logMtime
  fields.total_entries = sel.totalEntries
  fields.matched = sel.matched

  const body = sel.entries
    .map((e) => `[${e.ts}] ${e.level.toUpperCase()} ${e.mod ? `[${e.mod}] ` : ''}${e.text}`)
    .join('\n')

  return renderAiText({
    reportType: 'game_log',
    fields,
    truncated: sel.matched > sel.entries.length,
    totalFound: sel.matched,
    limit,
    results: sel.entries.length > 0 ? [{ fields: {}, blocks: { entries: body } }] : [],
  })
}

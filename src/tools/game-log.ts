import { existsSync } from 'node:fs'
import { ServerConfig } from '../config'
import { GameContext } from '../utils/game-context'
import { LogLevel, selectLogEntries } from '../utils/ue4ss-log'
import { formatModLogEntry, LOADER_WARNINGS_LIMIT, selectModLog } from '../utils/mod-log'
import { modlogPath } from '../utils/kit'
import { readState } from '../utils/game-process'
import { renderAiText, Scalar } from '../utils/ai-text'
import { echoFields } from './bridge-common'

export interface GameLogArgs {
  source?: 'ue4ss' | 'modlog'
  since?: string
  level?: LogLevel | 'all'
  mod?: string
  limit?: number
}

const MAX_LIMIT = 500

export function handleGameLog(ctx: GameContext | null, config: ServerConfig, args: GameLogArgs): string {
  return args.source === 'modlog' ? modlogReport(ctx, config, args) : ue4ssReport(ctx, config, args)
}

function ue4ssReport(ctx: GameContext | null, config: ServerConfig, args: GameLogArgs): string {
  const path = `${config.ue4ssDir}/UE4SS.log`
  const fields: Record<string, Scalar> = { ...echoFields(ctx), source: 'ue4ss', log_path: path }

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

function modlogReport(ctx: GameContext | null, config: ServerConfig, args: GameLogArgs): string {
  const path = modlogPath(config)
  const fields: Record<string, Scalar> = { ...echoFields(ctx), source: 'modlog', log_path: path }

  if (!existsSync(path)) {
    fields.status = 'modlog_not_found'
    fields.hint =
      'modlog пишет игра при загрузке модов, MCP его не создаёт: запустите игру (ww_game_process action=start); путь — <Saved>/Logs/modlog.txt'
    return renderAiText({ reportType: 'game_log', fields })
  }

  const limit = Math.min(args.limit ?? 100, MAX_LIMIT)
  const sinceArg = args.since ?? 'session'
  const session = sinceArg === 'session'
  const state = readState(config)
  const savedOffset = typeof state.modlogOffset === 'number' ? state.modlogOffset : null

  const sel = selectModLog(path, {
    offset: session ? (savedOffset ?? 0) : 0,
    since: sinceArg,
    mod: args.mod,
    limit,
  })

  fields.status = 'ok'
  fields.since =
    session && savedOffset === null ? 'all (офсет старта сессии не сохранён)' : sel.sinceResolved
  if (args.mod) fields.mod = args.mod
  if (args.level && args.level !== 'all') fields.level_ignored = args.level
  fields.log_mtime = sel.logMtime
  fields.modlog_size = sel.size
  fields.modlog_offset = sel.offset
  if (sel.clamped) fields.offset_clamped = true
  if (session && savedOffset !== null && state.launchedAt) {
    fields.session_started_at = new Date(state.launchedAt).toISOString()
  }
  fields.lines_in_window = sel.total
  fields.matched = sel.matched
  fields.loader_lines = sel.loaderTotal
  fields.loader_warnings = sel.warnings.length
  if (sel.warnings.length >= LOADER_WARNINGS_LIMIT) fields.loader_warnings_truncated = true

  const blocks: Record<string, string> = {}
  if (sel.warnings.length > 0) blocks.warnings = sel.warnings.map(formatModLogEntry).join('\n')
  if (sel.entries.length > 0) blocks.entries = sel.entries.map(formatModLogEntry).join('\n')

  if (sel.clamped) {
    fields.hint =
      'офсет старта больше размера modlog: игра пересоздала файл; since=all читает его целиком'
  } else if (session && savedOffset === null) {
    fields.hint =
      'офсет старта сессии неизвестен: файл прочитан целиком, в него попадают и прошлые запуски; точную границу сессии даст ww_game_process action=start'
  } else if (sel.matched === 0) {
    fields.hint =
      sel.warnings.length > 0
        ? 'строк самого мода нет, зато есть записи загрузчика про него в блоке warnings: мод не загрузился'
        : 'совпадений нет: mod для modlog — имя из префикса "<Мод>:" у строк ModAPI.LogMessage; since=all читает файл целиком'
  }

  return renderAiText({
    reportType: 'game_log',
    fields,
    truncated: sel.matched > sel.entries.length,
    totalFound: sel.matched,
    limit,
    results: Object.keys(blocks).length > 0 ? [{ fields: {}, blocks }] : [],
  })
}

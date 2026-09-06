import { ServerConfig } from '../config'
import { GameContext } from '../utils/game-context'
import { renderAiText, Scalar } from '../utils/ai-text'
import { echoFields } from './bridge-common'
import { crashesDir, crashLogTail, listCrashes, parseCrashContext } from '../utils/crash-report'
import { readLoadOrder } from '../utils/ue4ss-mods'

export interface CrashReportArgs {
  crash?: string
  list?: boolean
  limit?: number
  tail?: number
}

const oneLine = (s: string, n: number) =>
  s
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n)

export async function handleCrashReport(
  ctx: GameContext | null,
  config: ServerConfig,
  args: CrashReportArgs,
): Promise<string> {
  const all = listCrashes(config)

  if (args.list) {
    if (all.length === 0) {
      return renderAiText({
        reportType: 'crash_report',
        fields: { ...echoFields(ctx), status: 'no_crashes', dir: crashesDir(config) },
      })
    }
    const limit = Math.min(Math.max(args.limit ?? 10, 1), 100)
    return renderAiText({
      reportType: 'crash_report',
      fields: { ...echoFields(ctx), status: 'ok', mode: 'list', total: all.length },
      results: all
        .slice(0, limit)
        .map((c) => ({ fields: { crash: c.name, crashed_at: c.at, error: oneLine(c.errorMessage, 120) } })),
    })
  }

  if (all.length === 0) {
    return renderAiText({
      reportType: 'crash_report',
      fields: {
        ...echoFields(ctx),
        status: 'no_crashes',
        dir: crashesDir(config),
        hint: 'каталог крашей пуст: игра ещё не падала с этим расположением Saved',
      },
    })
  }

  let target = all[0]
  if (args.crash) {
    const needle = args.crash.toLowerCase()
    const hit = all.find((c) => c.name.toLowerCase().includes(needle))
    if (!hit) {
      return renderAiText({
        reportType: 'crash_report',
        fields: {
          ...echoFields(ctx),
          status: 'crash_not_found',
          query: args.crash,
          recent: all.slice(0, 5).map((c) => c.name).join(', '),
        },
      })
    }
    target = hit
  }

  const info = parseCrashContext(`${crashesDir(config)}/${target.name}/CrashContext.runtime-xml`)
  if (!info) {
    return renderAiText({
      reportType: 'crash_report',
      fields: { ...echoFields(ctx), status: 'crash_context_missing', crash: target.name },
    })
  }

  const tailLimit = Math.min(Math.max(args.tail ?? 30, 5), 200)
  const { source, entries } = crashLogTail(config, target.atMs, tailLimit)
  const enabled = [...readLoadOrder(config).values()]
    .filter((s) => s.enabled)
    .sort((a, b) => a.index - b.index)
    .map((s) => s.name)
  const lastLua = [...entries].reverse().find((e) => e.mod !== null)

  const fields: Record<string, Scalar> = {
    ...echoFields(ctx),
    status: 'ok',
    crash: target.name,
    crashed_at: target.at,
    kind: info.kind,
    exception: info.exception === '' ? 'unknown' : info.exception,
    error_message: oneLine(info.errorMessage, 300),
    seconds_since_start: info.secondsSinceStart,
    engine_version: info.engineVersion,
    build: info.build,
    mods_enabled: enabled.length > 0 ? enabled.join(', ') : 'нет включённых строк',
    log_source: source === '' ? 'none' : source,
    log_lines: entries.length,
  }
  if (info.address !== '') fields.address = `0x${info.address}`
  if (lastLua) fields.last_lua_activity = oneLine(`${lastLua.mod}: ${lastLua.text}`, 200)
  if (source === '') fields.hint = 'хвост лога до краша не найден ни в текущем UE4SS.log, ни в архивах state/logs'

  return renderAiText({
    reportType: 'crash_report',
    fields,
    results:
      entries.length > 0
        ? [
            {
              fields: {},
              blocks: { log_tail: entries.map((e) => `[${e.ts}]${e.mod ? ` [${e.mod}]` : ''} ${e.text}`).join('\n') },
            },
          ]
        : undefined,
  })
}

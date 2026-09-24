import { readFileSync } from 'node:fs'
import { ServerConfig } from '../config'
import { GameContext } from '../utils/game-context'
import { renderAiText, Scalar } from '../utils/ai-text'
import { echoFields } from './bridge-common'
import {
  CrashSummary,
  crashesDir,
  crashLogTail,
  GuardReport,
  guardDir,
  listCrashes,
  listGuardReports,
  parseCrashContext,
  parseGuardVerdict,
  trimGuardTimeline,
} from '../utils/crash-report'
import { readLoadOrder } from '../utils/ue4ss-mods'

export interface CrashReportArgs {
  crash?: string
  list?: boolean
  limit?: number
  tail?: number
  engine?: boolean
}

const oneLine = (s: string, n: number) =>
  s
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n)

const PAIR_WINDOW_MS = 120_000

function nearestEngineCrash(all: CrashSummary[], atMs: number): CrashSummary | null {
  let best: CrashSummary | null = null
  for (const c of all) {
    const d = Math.abs(c.atMs - atMs)
    if (d <= PAIR_WINDOW_MS && (!best || d < Math.abs(best.atMs - atMs))) best = c
  }
  return best
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

export async function handleCrashReport(
  ctx: GameContext | null,
  config: ServerConfig,
  args: CrashReportArgs,
): Promise<string> {
  const guard = listGuardReports(config)
  if (!args.engine && guard.length > 0) return guardReport(ctx, config, args, guard)
  return engineReport(ctx, config, args, guard)
}

function guardReport(ctx: GameContext | null, config: ServerConfig, args: CrashReportArgs, guard: GuardReport[]): string {
  if (args.list) {
    const limit = Math.min(Math.max(args.limit ?? 10, 1), 100)
    return renderAiText({
      reportType: 'crash_report',
      fields: { ...echoFields(ctx), status: 'ok', mode: 'list', source: 'wwguard', total: guard.length },
      results: guard.slice(0, limit).map((g) => {
        const v = parseGuardVerdict(readText(g.path) ?? '')
        return {
          fields: {
            crash: g.name,
            crashed_at: g.at,
            confidence: v.confidence,
            suspect: oneLine(v.suspect, 160),
            what: oneLine(v.header.get('What') ?? '', 120),
          },
        }
      }),
    })
  }

  let target = guard[0]
  if (args.crash) {
    const needle = args.crash.toLowerCase()
    const hit = guard.find((g) => g.name.toLowerCase().includes(needle))
    if (!hit) {
      return renderAiText({
        reportType: 'crash_report',
        fields: {
          ...echoFields(ctx),
          status: 'crash_not_found',
          source: 'wwguard',
          query: args.crash,
          recent: guard
            .slice(0, 5)
            .map((g) => g.name)
            .join(', '),
          hint: 'для каталога UECC-Windows-... передай engine: true',
        },
      })
    }
    target = hit
  }

  const text = readText(target.path)
  if (text === null) {
    return renderAiText({
      reportType: 'crash_report',
      fields: { ...echoFields(ctx), status: 'report_unreadable', crash: target.name, report: target.path },
    })
  }
  const v = parseGuardVerdict(text)
  const engineDump = nearestEngineCrash(listCrashes(config), target.atMs)

  const fields: Record<string, Scalar> = {
    ...echoFields(ctx),
    status: 'ok',
    source: 'wwguard',
    crash: target.name,
    report: target.path,
    crashed_at: target.at,
    confidence: v.confidence,
    suspect: v.suspect === '' ? 'unknown' : oneLine(v.suspect, 300),
  }
  for (const [key, name] of [
    ['What', 'what'],
    ['Where', 'where'],
    ['Lua', 'lua'],
    ['Last Lua error', 'last_lua_error'],
    ['Errors', 'errors'],
    ['Warnings', 'warnings'],
  ] as const) {
    const value = v.header.get(key)
    if (value) fields[name] = oneLine(value, 300)
  }
  fields.details = `${guardDir(config)}/${target.name.replace(/\.txt$/, '.jsonl')}`
  fields.engine_dump = engineDump ? engineDump.name : 'none'
  fields.hint =
    v.confidence === 'certain'
      ? 'вердикт однозначный: виновник и место — в suspect и стеке Lua в отчёте; дамп UECC и UE4SS.log обычно не нужны'
      : 'вердикт неуверенный: сверь его с details (все стейты Lua, кольца, хуки), затем engine: true — CrashContext из UECC и хвост UE4SS.log'

  const tailLimit = Math.min(Math.max(args.tail ?? 30, 5), 200)
  return renderAiText({
    reportType: 'crash_report',
    fields,
    results: [{ fields: {}, blocks: { report: trimGuardTimeline(text, tailLimit) } }],
  })
}

function engineReport(ctx: GameContext | null, config: ServerConfig, args: CrashReportArgs, guard: GuardReport[]): string {
  const all = listCrashes(config)
  const guardNote: Record<string, Scalar> =
    guard.length === 0 ? { wwguard: `отчётов WWCrashGuard нет в ${guardDir(config)}` } : {}

  if (args.list) {
    if (all.length === 0) {
      return renderAiText({
        reportType: 'crash_report',
        fields: { ...echoFields(ctx), status: 'no_crashes', dir: crashesDir(config), ...guardNote },
      })
    }
    const limit = Math.min(Math.max(args.limit ?? 10, 1), 100)
    return renderAiText({
      reportType: 'crash_report',
      fields: { ...echoFields(ctx), status: 'ok', mode: 'list', source: 'engine', total: all.length, ...guardNote },
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
        ...guardNote,
        hint: 'каталог крашей пуст: игра ещё не падала с этим расположением Saved',
      },
    })
  }

  let target = all[0]
  if (args.crash) {
    const needle = args.crash.toLowerCase()
    const direct = all.find((c) => c.name.toLowerCase().includes(needle))
    const viaGuard = direct ? undefined : guard.find((g) => g.name.toLowerCase().includes(needle))
    const hit = direct ?? (viaGuard ? nearestEngineCrash(all, viaGuard.atMs) : null)
    if (!hit) {
      return renderAiText({
        reportType: 'crash_report',
        fields: {
          ...echoFields(ctx),
          status: 'crash_not_found',
          source: 'engine',
          query: args.crash,
          recent: all
            .slice(0, 5)
            .map((c) => c.name)
            .join(', '),
          ...(viaGuard ? { hint: `рядом по времени с ${viaGuard.name} каталога UECC нет` } : {}),
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
  const pairedGuard = guard.find((g) => Math.abs(g.atMs - target.atMs) <= PAIR_WINDOW_MS)

  const fields: Record<string, Scalar> = {
    ...echoFields(ctx),
    status: 'ok',
    source: 'engine',
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
    ...guardNote,
  }
  if (info.address !== '') fields.address = `0x${info.address}`
  if (lastLua) fields.last_lua_activity = oneLine(`${lastLua.mod}: ${lastLua.text}`, 200)
  if (pairedGuard) fields.wwguard_report = pairedGuard.name
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

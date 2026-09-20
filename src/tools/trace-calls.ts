import { ServerConfig } from '../config'
import { GameContext } from '../utils/game-context'
import { BridgeResult, getBridge } from '../utils/bridge-client'
import { renderAiText, Scalar } from '../utils/ai-text'
import { bridgeFailureFields, echoFields } from './bridge-common'
import { findObject, isHookable, luaLocal, luaStr } from './common'

export interface TraceCallsArgs {
  paths?: string[]
  action?: 'start' | 'read' | 'stop'
  seconds?: number
  capture_args?: boolean
  max_samples?: number
  session_id?: string
}

type Action = 'start' | 'read' | 'stop' | 'oneshot'

const SLOT = '__WW_TRACE'
const DEFAULT_MAX_SAMPLES = 50
const HARD_MAX_SAMPLES = 200
const MAX_CAPTURED_PARAMS = 12
const DEGRADE_THRESHOLD_PER_S = 200

interface ResolvedTarget {
  hookPath: string
  params: Array<{ name: string }>
}

function resolveTargets(ctx: GameContext, paths: string[]): { resolved: ResolvedTarget[]; unknown: string[] } {
  const unknown: string[] = []
  const resolved: ResolvedTarget[] = []
  for (const p of paths) {
    const obj = findObject(ctx, p)
    if (!obj || !obj.hook_path || !isHookable(obj.kind)) {
      unknown.push(p)
      continue
    }
    const params = ctx.db
      .query('SELECT name FROM function_params WHERE function_path = ? AND is_return = 0 ORDER BY ordinal LIMIT ?')
      .all(obj.path, MAX_CAPTURED_PARAMS) as Array<{ name: string }>
    resolved.push({ hookPath: obj.hook_path, params })
  }
  return { resolved, unknown }
}

// Коллбэк собирается под конкретную функцию: арность и имена параметров — из function_params,
// как в ww_generate_hook. Захват аргумента обёрнут в pcall и авто-деградирует в счётчик,
// если частота хука выше порога — сериализация в горячем хуке иначе съедает кадр.
function hookChunkFor(target: ResolvedTarget): string {
  const paramLocals = target.params.map((p, i) => `a${i + 1}_${luaLocal(p.name)}`)
  const args = ['context', ...paramLocals].join(', ')
  const lines: string[] = []
  lines.push('do')
  lines.push(`  local path = ${luaStr(target.hookPath)}`)
  lines.push('  state.counts[path] = { n = 0 }')
  lines.push('  local ok, pre, post = pcall(RegisterHook, path,')
  lines.push(`    function(${args})`)
  lines.push('      state.total = state.total + 1')
  lines.push('      local c = state.counts[path]')
  lines.push('      c.n = c.n + 1')
  lines.push('      local nowSec = math.floor(os.clock())')
  lines.push('      if nowSec ~= state.secBucket then state.secBucket = nowSec state.secCount = 0 end')
  lines.push('      state.secCount = state.secCount + 1')
  lines.push('      if not state.degraded and state.secCount > state.degradeThreshold then state.degraded = true end')
  lines.push('      if state.capture and not state.degraded then')
  lines.push('        local self_ = "?"')
  lines.push('        pcall(function() self_ = context:get():GetFullName() end)')
  lines.push('        local parts = { "self=" .. self_ }')
  target.params.forEach((p, i) => {
    const local = paramLocals[i]
    lines.push(`        local ok${i}, v${i} = pcall(function() return ${local}:get() end)`)
    lines.push(`        parts[#parts + 1] = ${luaStr(`${p.name}=`)} .. (ok${i} and dump.inline(v${i}) or "<err>")`)
  })
  lines.push(
    '        state.samples[#state.samples + 1] = string.format("#%d t_ms=%.0f %s | %s", state.total, (os.clock() - state.t0) * 1000, path, table.concat(parts, " | "))',
  )
  lines.push('        if #state.samples > state.maxSamples then table.remove(state.samples, 1) end')
  lines.push('      end')
  lines.push('    end,')
  lines.push('    function() end)')
  lines.push('  if ok then state.hooks[#state.hooks + 1] = { path, pre, post } end')
  lines.push('end')
  return lines.join('\n')
}

function startChunk(targets: ResolvedTarget[], captureArgs: boolean, maxSamples: number): string {
  const lines: string[] = []
  lines.push('local dump = require("ww.dump")')
  lines.push(`local existing = _G.${SLOT}`)
  lines.push('if existing then')
  lines.push('  for _, h in ipairs(existing.hooks or {}) do pcall(UnregisterHook, h[1], h[2], h[3]) end')
  lines.push('end')
  lines.push('local state = {')
  lines.push('  session = string.format("%06x", math.random(0, 0xffffff)),')
  lines.push('  t0 = os.clock(),')
  lines.push('  total = 0,')
  lines.push('  counts = {},')
  lines.push('  samples = {},')
  lines.push('  hooks = {},')
  lines.push(`  capture = ${captureArgs ? 'true' : 'false'},`)
  lines.push(`  maxSamples = ${maxSamples},`)
  lines.push(`  degradeThreshold = ${DEGRADE_THRESHOLD_PER_S},`)
  lines.push('  secBucket = math.floor(os.clock()),')
  lines.push('  secCount = 0,')
  lines.push('  degraded = false,')
  lines.push('}')
  lines.push(`_G.${SLOT} = state`)
  for (const t of targets) lines.push(hookChunkFor(t))
  lines.push(`return state.session .. "\\t" .. #state.hooks .. "/" .. ${targets.length}`)
  return lines.join('\n')
}

function reportChunk(stop: boolean, sessionId?: string): string {
  const lines: string[] = []
  lines.push(`local state = _G.${SLOT}`)
  lines.push('if not state then return "not_started" end')
  if (sessionId) {
    lines.push(`if state.session ~= ${luaStr(sessionId)} then return "session_mismatch:" .. state.session end`)
  }
  lines.push('local dt = os.clock() - state.t0')
  if (stop) {
    lines.push('for _, h in ipairs(state.hooks) do pcall(UnregisterHook, h[1], h[2], h[3]) end')
    lines.push(`_G.${SLOT} = nil`)
  }
  lines.push('local lines = {')
  lines.push('  "session=" .. state.session,')
  lines.push('  string.format("window_s=%.1f", dt),')
  lines.push('  "degraded=" .. tostring(state.degraded),')
  lines.push('}')
  lines.push('for path, c in pairs(state.counts) do')
  lines.push('  lines[#lines + 1] = string.format("%d\\t%.2f/s\\t%s", c.n, c.n / math.max(dt, 0.001), path)')
  lines.push('end')
  lines.push('for _, s in ipairs(state.samples) do lines[#lines + 1] = "sample: " .. s end')
  lines.push('return table.concat(lines, "\\n")')
  return lines.join('\n')
}

function renderReport(fields: Record<string, Scalar>, stage: string, res: BridgeResult): string {
  if (res.status === 'error') {
    return renderAiText({
      reportType: 'trace_calls',
      fields: { ...fields, status: 'lua_error', stage },
      results: [{ fields: {}, blocks: { error: res.body } }],
    })
  }
  if (res.status !== 'ok') {
    return renderAiText({ reportType: 'trace_calls', fields: { ...fields, ...bridgeFailureFields(res) } })
  }
  const body = res.body.trim()
  if (body === 'not_started') {
    return renderAiText({ reportType: 'trace_calls', fields: { ...fields, status: 'not_started' } })
  }
  if (body.startsWith('session_mismatch:')) {
    return renderAiText({
      reportType: 'trace_calls',
      fields: { ...fields, status: 'session_mismatch', active_session_id: body.slice('session_mismatch:'.length) },
    })
  }
  return renderAiText({
    reportType: 'trace_calls',
    fields: { ...fields, status: stage === 'stop' ? 'stopped' : 'reading' },
    results: [{ fields: {}, blocks: { calls: body } }],
  })
}

export async function handleTraceCalls(ctx: GameContext, config: ServerConfig, args: TraceCallsArgs): Promise<string> {
  const fields: Record<string, Scalar> = { ...echoFields(ctx) }
  const action: Action = args.action ?? 'oneshot'
  const bridge = getBridge(config)

  if (action === 'read' || action === 'stop') {
    const res = await bridge.call('eval', reportChunk(action === 'stop', args.session_id), 15_000)
    return renderReport(fields, action, res)
  }

  const paths = args.paths ?? []
  if (paths.length === 0) {
    return renderAiText({
      reportType: 'trace_calls',
      fields: { ...fields, status: 'paths_required', hint: 'action=start (по умолчанию — одноразовый режим) требует paths' },
    })
  }

  const { resolved, unknown } = resolveTargets(ctx, paths)
  if (unknown.length > 0) {
    return renderAiText({
      reportType: 'trace_calls',
      fields: {
        ...fields,
        status: 'path_not_hookable',
        unknown: unknown.join('; '),
        hint: 'пути бери из hook_path в ответе ww_verify_hook',
      },
    })
  }

  const maxSamples = Math.min(Math.max(args.max_samples ?? DEFAULT_MAX_SAMPLES, 1), HARD_MAX_SAMPLES)
  const captureArgs = args.capture_args === true

  const started = await bridge.call('eval', startChunk(resolved, captureArgs, maxSamples), 15_000)
  if (started.status === 'error') {
    return renderAiText({
      reportType: 'trace_calls',
      fields: { ...fields, status: 'lua_error', stage: 'start' },
      results: [{ fields: {}, blocks: { error: started.body } }],
    })
  }
  if (started.status !== 'ok') {
    return renderAiText({ reportType: 'trace_calls', fields: { ...fields, ...bridgeFailureFields(started) } })
  }
  const [sessionId, bound] = started.body.trim().split('\t')

  if (action === 'start') {
    return renderAiText({
      reportType: 'trace_calls',
      fields: {
        ...fields,
        status: 'started',
        session_id: sessionId,
        bound: bound ?? '',
        capture_args: captureArgs,
        max_samples: maxSamples,
        hint: 'читай счётчик через action=read с этим session_id, снимай хуки через action=stop',
      },
    })
  }

  const seconds = Math.min(Math.max(args.seconds ?? 10, 1), 120)
  await new Promise((r) => setTimeout(r, seconds * 1000))

  const stopped = await bridge.call('eval', reportChunk(true, sessionId), 15_000)
  if (stopped.status === 'error') {
    return renderAiText({
      reportType: 'trace_calls',
      fields: { ...fields, status: 'lua_error', stage: 'stop' },
      results: [{ fields: {}, blocks: { error: stopped.body } }],
    })
  }
  if (stopped.status !== 'ok') {
    return renderAiText({ reportType: 'trace_calls', fields: { ...fields, ...bridgeFailureFields(stopped) } })
  }

  return renderAiText({
    reportType: 'trace_calls',
    fields: { ...fields, status: 'ok', requested_s: seconds, paths: paths.length },
    results: [{ fields: {}, blocks: { calls: stopped.body.trim() } }],
  })
}

import { ServerConfig } from '../config'
import { GameContext } from '../utils/game-context'
import { getBridge } from '../utils/bridge-client'
import { renderAiText, Scalar } from '../utils/ai-text'
import { bridgeFailureFields, echoFields } from './bridge-common'
import { findObject, isHookable } from './common'

export interface TraceCallsArgs {
  paths: string[]
  seconds?: number
  capture_args?: boolean
}

const SLOT = '__WW_TRACE'

function startChunk(paths: string[], captureArgs: boolean): string {
  const list = paths.map((p) => `[[${p}]]`).join(', ')
  return `
local paths = { ${list} }
if _G.${SLOT} then
  for _, h in ipairs(_G.${SLOT}.hooks or {}) do pcall(UnregisterHook, h[1], h[2], h[3]) end
end
local state = { counts = {}, samples = {}, hooks = {}, t0 = os.clock() }
_G.${SLOT} = state
for _, path in ipairs(paths) do
  state.counts[path] = 0
  local ok, pre, post = pcall(RegisterHook, path,
    function(context, a1, a2)
      state.counts[path] = state.counts[path] + 1
      ${
        captureArgs
          ? `if #state.samples < 20 then
        local self_, arg1 = "?", "?"
        pcall(function() self_ = context:get():GetFullName() end)
        pcall(function() arg1 = tostring(a1:get()) end)
        state.samples[#state.samples + 1] = path .. " | self=" .. self_ .. " | arg1=" .. arg1
      end`
          : ''
      }
    end,
    function() end)
  if ok then state.hooks[#state.hooks + 1] = { path, pre, post } end
end
return "tracing " .. #state.hooks .. "/" .. #paths
`.trim()
}

const stopChunk = `
local state = _G.${SLOT}
if not state then return "not_started" end
local dt = os.clock() - state.t0
for _, h in ipairs(state.hooks) do pcall(UnregisterHook, h[1], h[2], h[3]) end
_G.${SLOT} = nil
local lines = { string.format("window_s=%.1f", dt) }
for path, n in pairs(state.counts) do
  lines[#lines + 1] = string.format("%d\\t%.2f/s\\t%s", n, n / math.max(dt, 0.001), path)
end
for _, s in ipairs(state.samples) do lines[#lines + 1] = "sample: " .. s end
return table.concat(lines, "\\n")
`.trim()

export async function handleTraceCalls(
  ctx: GameContext,
  config: ServerConfig,
  args: TraceCallsArgs,
): Promise<string> {
  const fields: Record<string, Scalar> = { ...echoFields(ctx) }
  const seconds = Math.min(Math.max(args.seconds ?? 10, 1), 120)

  const unknown: string[] = []
  const resolved: string[] = []
  for (const p of args.paths) {
    const obj = findObject(ctx, p)
    if (obj && obj.hook_path && isHookable(obj.kind)) resolved.push(obj.hook_path)
    else unknown.push(p)
  }
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

  const bridge = getBridge(config)
  const started = await bridge.call('eval', startChunk(resolved, args.capture_args === true), 15_000)
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

  await new Promise((r) => setTimeout(r, seconds * 1000))

  const stopped = await bridge.call('eval', stopChunk, 15_000)
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
    fields: { ...fields, status: 'ok', requested_s: seconds, paths: args.paths.length },
    results: [{ fields: {}, blocks: { calls: stopped.body.trim() } }],
  })
}

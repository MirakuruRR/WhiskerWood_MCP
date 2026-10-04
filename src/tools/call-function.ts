import { ServerConfig } from '../config'
import { GameContext, versionEchoFields } from '../utils/game-context'
import { getBridge } from '../utils/bridge-client'
import { renderAiText, Scalar } from '../utils/ai-text'
import { BpFunctionInfo, bpFunction, bpUnavailableHint } from '../utils/loom-types'
import {
  MOD_ASSET_PREFIX,
  ModAssetRef,
  ModFunctionSignature,
  modBlueprintStatus,
  modPathHint,
  modSignature,
  parseModAssetPath,
  probeModPaths,
} from '../utils/mod-asset'
import { bridgeFailureFields } from './bridge-common'
import {
  findObject,
  luaStr,
  modClassSelectionChunk,
  resolveEnumMemberName,
  resolveEnumMemberValue,
  suggestSimilar,
} from './common'

export interface CallFunctionArgs {
  object: string
  object_index?: number
  function_path: string
  args?: Record<string, unknown>
  bp_only?: boolean
}

interface ParamRow {
  ordinal: number
  name: string
  prop_kind: string
  type_name: string | null
  is_return: number
  is_out: number
}

interface ArgSpec {
  prop_kind: string
  type_name: string | null
}

const OBJECT_KINDS = new Set([
  'ObjectProperty',
  'ClassProperty',
  'InterfaceProperty',
  'WeakObjectProperty',
  'SoftObjectProperty',
  'SoftClassProperty',
  'LazyObjectProperty',
  'AssetObjectProperty',
  'ObjectPtrProperty',
])
const NUMERIC_KINDS = new Set([
  'Int8Property',
  'Int16Property',
  'IntProperty',
  'Int64Property',
  'UInt16Property',
  'UInt32Property',
  'UInt64Property',
  'FloatProperty',
  'DoubleProperty',
])
const STRING_KINDS = new Set(['NameProperty', 'StrProperty', 'TextProperty', 'Utf8StrProperty', 'AnsiStrProperty'])
const UNSUPPORTED_KINDS = new Set([
  'ArrayProperty',
  'SetProperty',
  'MapProperty',
  'DelegateProperty',
  'MulticastDelegateProperty',
  'MulticastInlineDelegateProperty',
  'MulticastSparseDelegateProperty',
  'FieldPathProperty',
])

const BP_ONLY_ALLOWED = new Set(['callable', 'pure'])

function jsonToLuaLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'nil'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0'
  if (typeof value === 'string') return luaStr(value)
  if (Array.isArray(value)) return `{ ${value.map(jsonToLuaLiteral).join(', ')} }`
  if (typeof value === 'object') {
    const parts = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${/^[A-Za-z_]\w*$/.test(k) ? k : `[${luaStr(k)}]`} = ${jsonToLuaLiteral(v)}`,
    )
    return `{ ${parts.join(', ')} }`
  }
  return 'nil'
}

function argExprFor(ctx: GameContext, p: ArgSpec, raw: unknown): { expr: string } | { error: string } {
  if (UNSUPPORTED_KINDS.has(p.prop_kind)) {
    return { error: `тип ${p.prop_kind} не поддержан ww_call; для него используй ww_game_eval` }
  }
  if (OBJECT_KINDS.has(p.prop_kind)) {
    if (typeof raw !== 'string') return { error: 'ожидается строка: путь объекта или короткое имя класса' }
    return { expr: `WW_RESOLVE(${luaStr(raw)})` }
  }
  if (p.prop_kind === 'BoolProperty') {
    if (typeof raw !== 'boolean') return { error: 'ожидается boolean' }
    return { expr: raw ? 'true' : 'false' }
  }
  if (NUMERIC_KINDS.has(p.prop_kind)) {
    if (typeof raw !== 'number') return { error: 'ожидается число' }
    return { expr: String(raw) }
  }
  if (p.prop_kind === 'ByteProperty' || p.prop_kind === 'EnumProperty') {
    if (typeof raw === 'number') return { expr: String(raw) }
    if (typeof raw === 'string') {
      const v = resolveEnumMemberValue(ctx, p.type_name, raw)
      if (v === null) return { error: `значение "${raw}" не найдено в enum ${p.type_name ?? '?'}; бери имена через ww_get_type` }
      return { expr: String(v) }
    }
    return { error: 'ожидается число или имя значения enum' }
  }
  if (STRING_KINDS.has(p.prop_kind)) {
    if (typeof raw !== 'string') return { error: 'ожидается строка' }
    return { expr: luaStr(raw) }
  }
  return { expr: jsonToLuaLiteral(raw) }
}

function objectSelectionChunk(object: string, index: number | undefined): string {
  if (object.startsWith('/')) {
    return `local target = StaticFindObject(${luaStr(object)})`
  }
  return `local all = FindAllOf(${luaStr(object)}) or {}
local target = all[${index ?? 1}]`
}

function modObjectSelectionChunk(object: string, index: number | undefined): string {
  const noColon = object.trim().split(':')[0]
  if (noColon.startsWith(MOD_ASSET_PREFIX) && noColon.endsWith('_C')) {
    return modClassSelectionChunk(noColon, index)
  }
  return objectSelectionChunk(object, index)
}

type ArgPlan = { ok: true; exprs: string[] } | { ok: false; status: string; fields: Record<string, Scalar> }

function planArgs(ctx: GameContext, inputs: ParamRow[], provided: Record<string, unknown>): ArgPlan {
  const missing = inputs.filter((p) => !(p.name in provided))
  if (missing.length > 0) {
    return {
      ok: false,
      status: 'missing_args',
      fields: { missing: missing.map((p) => p.name).join(', '), hint: 'сигнатура и типы — через ww_get_function' },
    }
  }
  const known = new Set(inputs.map((p) => p.name))
  const extra = Object.keys(provided).filter((k) => !known.has(k))
  if (extra.length > 0) {
    return { ok: false, status: 'unknown_args', fields: { unknown: extra.join(', ') } }
  }
  const exprs: string[] = []
  for (const p of inputs) {
    const r = argExprFor(ctx, p, provided[p.name])
    if ('error' in r) {
      return { ok: false, status: 'bad_arg', fields: { arg: p.name, prop_kind: p.prop_kind, error: r.error } }
    }
    exprs.push(r.expr)
  }
  return { ok: true, exprs }
}

function outputsOf(params: ParamRow[]): Array<ParamRow & { label: string }> {
  const ret = params.find((p) => p.is_return === 1) ?? null
  const outs = params.filter((p) => p.is_return !== 1 && p.is_out === 1)
  return [...(ret ? [{ ...ret, label: 'return' }] : []), ...outs.map((p) => ({ ...p, label: p.name }))]
}

function callChunk(selection: string, callName: string, argExprs: string[], outputs: Array<ParamRow & { label: string }>): string {
  const lines: string[] = []
  lines.push('local dump = require("ww.dump")')
  lines.push('local function WW_RESOLVE(input)')
  lines.push('  if input:sub(1, 1) == "/" then return StaticFindObject(input) end')
  lines.push('  local all = FindAllOf(input)')
  lines.push('  return all and all[1] or nil')
  lines.push('end')
  lines.push(selection)
  lines.push('if not target or not target:IsValid() then return "object_not_found" end')
  lines.push(`local packed = table.pack(pcall(function() return target:${callName}(${argExprs.join(', ')}) end))`)
  lines.push('if not packed[1] then return "call_error\\n" .. tostring(packed[2]) end')
  lines.push('local out = {}')
  outputs.forEach((o, i) => {
    lines.push(`out[#out + 1] = ${luaStr(`${o.label}=`)} .. dump.inline(packed[${i + 2}], 0, 3)`)
  })
  lines.push('return "call_ok\\n" .. table.concat(out, "\\n")')
  return lines.join('\n')
}

function bpFields(bp: BpFunctionInfo): Record<string, Scalar> {
  const out: Record<string, Scalar> = { bp: bp.status }
  if (bp.loom_call) out.loom_call = bp.loom_call
  if (bp.loom_receiver) out.loom_receiver = bp.loom_receiver
  if (bp.loads_at_build) out.bp_loads_at_build = true
  if (bp.note) out.bp_note = bp.note
  return out
}

function bpRefusalReason(bp: BpFunctionInfo): string {
  switch (bp.status) {
    case 'world_context':
      return 'world_context: пин мира узел вызова заполняет сам, в вызове из Lua его нет — цепочка не переносится один в один (готовый вызов смотри в loom_call)'
    case 'latent':
      return 'latent: Blueprint ждёт такую функцию только в графе событий, а вызов из Lua синхронный'
    case 'editor_only':
      return 'editor_only: работает только в редакторе, в игре такой функции нет'
    case 'internal':
      return 'internal: Loom откажет — «is internal to the engine»'
    case 'deprecated':
      return 'deprecated: Blueprint не привязывает такие функции, Loom откажет'
    case 'not_in_types':
      return bp.note ?? 'функции нет в types.json кита: проверь loom check'
    default:
      return bp.note ?? bp.status
  }
}

export async function handleCallFunction(ctx: GameContext, config: ServerConfig, args: CallFunctionArgs): Promise<string> {
  const echo = versionEchoFields(ctx)
  const modRef = parseModAssetPath(args.function_path)
  if (modRef) return handleModCallFunction(ctx, config, args, modRef, echo)

  const obj = findObject(ctx, args.function_path)
  if (!obj) {
    const suggestions = suggestSimilar(ctx, args.function_path)
    return renderAiText({
      reportType: 'call_function',
      fields: {
        ...echo,
        status: 'not_found',
        query: args.function_path,
        suggestions: suggestions.length > 0 ? suggestions.join('; ') : 'нет',
        ...(args.function_path.trim().startsWith('/') ? {} : { hint: `функция BP-мода ищется только по полному пути: ${modPathHint()}` }),
      },
    })
  }
  if (obj.kind !== 'Function') {
    return renderAiText({
      reportType: 'call_function',
      fields: { ...echo, status: 'not_a_function', resolved_path: obj.path, kind: obj.kind },
    })
  }

  const bp = bpFunction(ctx, config, obj.outer_path ?? '', obj.name)
  const bpOnly = args.bp_only === true
  if (bpOnly) {
    if (!bp) {
      return renderAiText({
        reportType: 'call_function',
        fields: {
          ...echo,
          status: 'bp_unavailable',
          resolved_path: obj.path,
          bp_only: true,
          hint: bpUnavailableHint(config) ?? 'типы кита недоступны',
        },
      })
    }
    if (!BP_ONLY_ALLOWED.has(bp.status)) {
      return renderAiText({
        reportType: 'call_function',
        fields: {
          ...echo,
          status: 'bp_refused',
          resolved_path: obj.path,
          object: args.object,
          bp_only: true,
          ...bpFields(bp),
          bp_reason: bpRefusalReason(bp),
          hint: 'bp_only пропускает только callable и pure: лишь такую цепочку можно проверить вживую и перенести в Loom один в один',
        },
      })
    }
  }

  const params = ctx.db
    .query('SELECT ordinal, name, prop_kind, type_name, is_return, is_out FROM function_params WHERE function_path = ? ORDER BY ordinal')
    .all(obj.path) as ParamRow[]
  const inputs = params.filter((p) => p.is_return !== 1)
  const outputs = outputsOf(params)
  const bpOut = bp ? bpFields(bp) : {}
  const plan = planArgs(ctx, inputs, args.args ?? {})
  if (!plan.ok) {
    return renderAiText({
      reportType: 'call_function',
      fields: { ...echo, status: plan.status, resolved_path: obj.path, ...(bpOnly ? { bp_only: true } : {}), ...bpOut, ...plan.fields },
    })
  }

  const chunk = callChunk(objectSelectionChunk(args.object, args.object_index), obj.name, plan.exprs, outputs)
  const bridge = getBridge(config)
  const res = await bridge.call('eval', chunk, 15_000)

  if (res.status === 'error') {
    return renderAiText({
      reportType: 'call_function',
      fields: { ...echo, status: 'lua_error', resolved_path: obj.path, ...(bpOnly ? { bp_only: true } : {}), ...bpOut },
      results: [{ fields: {}, blocks: { error: res.body } }],
    })
  }
  if (res.status !== 'ok') {
    return renderAiText({ reportType: 'call_function', fields: { ...echo, ...bridgeFailureFields(res), ...bpOut } })
  }

  const body = res.body.replace(/^exec=\w+\n/, '').trim()
  if (body === 'object_not_found') {
    return renderAiText({
      reportType: 'call_function',
      fields: { ...echo, status: 'object_not_found', object: args.object, ...(bpOnly ? { bp_only: true } : {}), ...bpOut },
    })
  }
  if (body.startsWith('call_error')) {
    return renderAiText({
      reportType: 'call_function',
      fields: { ...echo, status: 'call_error', resolved_path: obj.path, ...(bpOnly ? { bp_only: true } : {}), ...bpOut },
      results: [{ fields: {}, blocks: { error: body.slice('call_error\n'.length) } }],
    })
  }

  const rawOutBody = body.startsWith('call_ok\n') ? body.slice('call_ok\n'.length) : body
  const outLines = rawOutBody.length > 0 ? rawOutBody.split('\n') : []
  const outBody = outLines
    .map((line, i) => {
      const o = outputs[i]
      if (!o || (o.prop_kind !== 'ByteProperty' && o.prop_kind !== 'EnumProperty')) return line
      const prefix = `${o.label}=`
      if (!line.startsWith(prefix)) return line
      const num = Number(line.slice(prefix.length))
      if (!Number.isFinite(num)) return line
      const name = resolveEnumMemberName(ctx, o.type_name, num)
      return name ? `${line} (${name})` : line
    })
    .join('\n')

  return renderAiText({
    reportType: 'call_function',
    fields: {
      ...echo,
      status: 'ok',
      resolved_path: obj.path,
      object: args.object,
      outputs: outputs.length,
      ...(bpOnly ? { bp_only: true, bp_live_checked: 'вызов прошёл вживую: параметры и возврат совпали с loom_call' } : {}),
      ...bpOut,
    },
    results: outputs.length > 0 ? [{ fields: {}, blocks: { result: outBody } }] : [],
  })
}

async function handleModCallFunction(
  ctx: GameContext,
  config: ServerConfig,
  args: CallFunctionArgs,
  ref: ModAssetRef,
  echo: Record<string, string>,
): Promise<string> {
  const fail = (status: string, extra: Record<string, Scalar> = {}): string =>
    renderAiText({
      reportType: 'call_function',
      fields: { ...echo, status, function_path: args.function_path, object: args.object, ...extra },
    })

  if (!ref.functionName) {
    return fail('function_required', {
      mod: ref.mod,
      hint: `в пути мода не указана функция: ${modPathHint()}`,
    })
  }

  const sig = modSignature(config, ref)
  if (!sig.ok) {
    return fail(sig.status, {
      mod: ref.mod,
      asset: ref.assetPath,
      detail: sig.detail,
      searched: sig.searched,
      ...(sig.error ? { error: sig.error } : {}),
      hint: 'пак мода ищется в <saved>/mods, в workshop и в паках кита; индекс игры путей /Game/Mods не содержит',
    })
  }
  const s: ModFunctionSignature = sig.signature
  const access = modBlueprintStatus(s.flags)
  const modFields: Record<string, Scalar> = {
    mod: ref.mod,
    mod_class: s.classPath,
    mod_signature: s.source,
    mod_params: s.params.filter((p) => p.is_return !== 1).length,
    mod_flags: s.flags.join(' | ') || 'нет',
    bp: access.status,
    bp_note: access.note,
    ...(s.superPath ? { mod_parent: s.superPath } : {}),
  }

  if (args.bp_only === true && access.status !== 'callable' && access.status !== 'pure') {
    return fail('bp_refused', {
      ...modFields,
      bp_only: true,
      bp_reason: access.note,
      hint: 'bp_only пропускает только BlueprintCallable/Pure',
    })
  }

  const probe = await probeModPaths(config, [s.functionPath])
  if (!probe.ok) {
    if (probe.result.status === 'error') {
      return renderAiText({
        reportType: 'call_function',
        fields: { ...echo, status: 'lua_error', stage: 'probe', function_path: s.functionPath, ...modFields },
        results: [{ fields: {}, blocks: { error: probe.result.body } }],
      })
    }
    return renderAiText({ reportType: 'call_function', fields: { ...echo, ...bridgeFailureFields(probe.result) } })
  }
  const live = probe.probes.get(s.functionPath)
  if (!live || !live.found) {
    return fail('mod_function_not_loaded', {
      ...modFields,
      mod_live: live ? live.via : 'нет ответа',
      hint:
        live?.via === 'class_only'
          ? 'класс мода есть в памяти, а функции с таким именем нет: пак устарел — пересобери мод'
          : 'класса мода нет в памяти: pak подхватывается только при старте игры (ww_game_process action=restart save=…), проверь имя мода и что он включён',
    })
  }

  const inputs = s.params.filter((p) => p.is_return !== 1)
  const outputs = outputsOf(s.params as ParamRow[])
  const plan = planArgs(ctx, inputs as ParamRow[], args.args ?? {})
  if (!plan.ok) {
    return fail(plan.status, { ...modFields, ...plan.fields })
  }

  const chunk = callChunk(modObjectSelectionChunk(args.object, args.object_index), s.functionName, plan.exprs, outputs)
  const res = await getBridge(config).call('eval', chunk, 15_000)
  const common: Record<string, Scalar> = { ...modFields, mod_live: live.via, ...(args.bp_only === true ? { bp_only: true } : {}) }

  if (res.status === 'error') {
    return renderAiText({
      reportType: 'call_function',
      fields: { ...echo, status: 'lua_error', function_path: s.functionPath, ...common },
      results: [{ fields: {}, blocks: { error: res.body } }],
    })
  }
  if (res.status !== 'ok') {
    return renderAiText({ reportType: 'call_function', fields: { ...echo, ...bridgeFailureFields(res) } })
  }

  const body = res.body.replace(/^exec=\w+\n/, '').trim()
  if (body === 'object_not_found') {
    return fail('object_not_found', common)
  }
  if (body.startsWith('call_error')) {
    return renderAiText({
      reportType: 'call_function',
      fields: { ...echo, status: 'call_error', function_path: s.functionPath, ...common },
      results: [{ fields: {}, blocks: { error: body.slice('call_error\n'.length) } }],
    })
  }

  const rawOutBody = body.startsWith('call_ok\n') ? body.slice('call_ok\n'.length) : body
  const outLines = rawOutBody.length > 0 ? rawOutBody.split('\n') : []
  const outBody = outLines
    .map((line, i) => {
      const o = outputs[i]
      if (!o || (o.prop_kind !== 'ByteProperty' && o.prop_kind !== 'EnumProperty')) return line
      const prefix = `${o.label}=`
      if (!line.startsWith(prefix)) return line
      const num = Number(line.slice(prefix.length))
      if (!Number.isFinite(num)) return line
      const name = resolveEnumMemberName(ctx, o.type_name, num)
      return name ? `${line} (${name})` : line
    })
    .join('\n')

  return renderAiText({
    reportType: 'call_function',
    fields: { ...echo, status: 'ok', function_path: s.functionPath, object: args.object, outputs: outputs.length, ...common },
    results: outputs.length > 0 ? [{ fields: {}, blocks: { result: outBody } }] : [],
  })
}

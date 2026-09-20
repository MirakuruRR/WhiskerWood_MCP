import { ServerConfig } from '../config'
import { GameContext, versionEchoFields } from '../utils/game-context'
import { getBridge } from '../utils/bridge-client'
import { renderAiText, Scalar } from '../utils/ai-text'
import { bridgeFailureFields } from './bridge-common'
import { findObject, luaStr, resolveEnumMemberName, resolveEnumMemberValue, suggestSimilar } from './common'

export interface CallFunctionArgs {
  object: string
  object_index?: number
  function_path: string
  args?: Record<string, unknown>
}

interface ParamRow {
  ordinal: number
  name: string
  prop_kind: string
  type_name: string | null
  is_return: number
  is_out: number
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

function argExprFor(ctx: GameContext, p: ParamRow, raw: unknown): { expr: string } | { error: string } {
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
  // StructProperty и всё непойманное выше — обобщённый JSON -> Lua (таблица по именам полей)
  return { expr: jsonToLuaLiteral(raw) }
}

function objectSelectionChunk(object: string, index: number | undefined): string {
  if (object.startsWith('/')) {
    return `local target = StaticFindObject(${luaStr(object)})`
  }
  return `local all = FindAllOf(${luaStr(object)}) or {}
local target = all[${index ?? 1}]`
}

export async function handleCallFunction(ctx: GameContext, config: ServerConfig, args: CallFunctionArgs): Promise<string> {
  const echo = versionEchoFields(ctx)
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
      },
    })
  }
  if (obj.kind !== 'Function') {
    return renderAiText({
      reportType: 'call_function',
      fields: { ...echo, status: 'not_a_function', resolved_path: obj.path, kind: obj.kind },
    })
  }

  const params = ctx.db
    .query('SELECT ordinal, name, prop_kind, type_name, is_return, is_out FROM function_params WHERE function_path = ? ORDER BY ordinal')
    .all(obj.path) as ParamRow[]
  const inputs = params.filter((p) => p.is_return !== 1)
  const ret = params.find((p) => p.is_return === 1) ?? null
  const outs = inputs.filter((p) => p.is_out === 1)

  const provided = args.args ?? {}
  const missing = inputs.filter((p) => !(p.name in provided))
  if (missing.length > 0) {
    return renderAiText({
      reportType: 'call_function',
      fields: {
        ...echo,
        status: 'missing_args',
        resolved_path: obj.path,
        missing: missing.map((p) => p.name).join(', '),
        hint: 'сигнатура и типы — через ww_get_function',
      },
    })
  }
  const known = new Set(inputs.map((p) => p.name))
  const extra = Object.keys(provided).filter((k) => !known.has(k))
  if (extra.length > 0) {
    return renderAiText({
      reportType: 'call_function',
      fields: { ...echo, status: 'unknown_args', resolved_path: obj.path, unknown: extra.join(', ') },
    })
  }

  const argExprs: string[] = []
  for (const p of inputs) {
    const r = argExprFor(ctx, p, provided[p.name])
    if ('error' in r) {
      return renderAiText({
        reportType: 'call_function',
        fields: { ...echo, status: 'bad_arg', resolved_path: obj.path, arg: p.name, prop_kind: p.prop_kind, error: r.error },
      })
    }
    argExprs.push(r.expr)
  }

  const outputs = [...(ret ? [{ ...ret, label: 'return' }] : []), ...outs.map((p) => ({ ...p, label: p.name }))]

  const lines: string[] = []
  lines.push('local dump = require("ww.dump")')
  lines.push('local function WW_RESOLVE(input)')
  lines.push('  if input:sub(1, 1) == "/" then return StaticFindObject(input) end')
  lines.push('  local all = FindAllOf(input)')
  lines.push('  return all and all[1] or nil')
  lines.push('end')
  lines.push(objectSelectionChunk(args.object, args.object_index))
  lines.push('if not target or not target:IsValid() then return "object_not_found" end')
  lines.push(`local packed = table.pack(pcall(function() return target:${obj.name}(${argExprs.join(', ')}) end))`)
  lines.push('if not packed[1] then return "call_error\\n" .. tostring(packed[2]) end')
  lines.push('local out = {}')
  outputs.forEach((o, i) => {
    lines.push(`out[#out + 1] = ${luaStr(`${o.label}=`)} .. dump.inline(packed[${i + 2}], 0, 3)`)
  })
  lines.push('return "call_ok\\n" .. table.concat(out, "\\n")')
  const chunk = lines.join('\n')

  const bridge = getBridge(config)
  const res = await bridge.call('eval', chunk, 15_000)

  if (res.status === 'error') {
    return renderAiText({
      reportType: 'call_function',
      fields: { ...echo, status: 'lua_error', resolved_path: obj.path },
      results: [{ fields: {}, blocks: { error: res.body } }],
    })
  }
  if (res.status !== 'ok') {
    return renderAiText({ reportType: 'call_function', fields: { ...echo, ...bridgeFailureFields(res) } })
  }

  const body = res.body.replace(/^exec=\w+\n/, '').trim()
  if (body === 'object_not_found') {
    return renderAiText({ reportType: 'call_function', fields: { ...echo, status: 'object_not_found', object: args.object } })
  }
  if (body.startsWith('call_error')) {
    return renderAiText({
      reportType: 'call_function',
      fields: { ...echo, status: 'call_error', resolved_path: obj.path },
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
    },
    results: outputs.length > 0 ? [{ fields: {}, blocks: { result: outBody } }] : [],
  })
}

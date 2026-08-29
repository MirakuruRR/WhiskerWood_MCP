import { GameContext, versionEchoFields } from '../utils/game-context'
import { renderAiText } from '../utils/ai-text'
import { findObject, isHookable, renderSignature, suggestSimilar } from './common'

export interface GenerateHookArgs {
  function_path: string
  kind?: 'pre' | 'post' | 'both'
}

interface ParamRow {
  ordinal: number
  name: string
  prop_kind: string
  type_name: string | null
  inner_type: string | null
  type_source: string
  is_return: number
  is_out: number
}

const TEXT_TYPES = new Set(['FName', 'FString', 'FText'])

function luaLocal(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_]/g, '_')
  return /^[A-Za-z_]/.test(safe) ? safe : `p_${safe}`
}

function unwrap(p: ParamRow): string[] {
  const local = luaLocal(p.name)
  const type = p.type_name ?? 'unknown'
  if (TEXT_TYPES.has(type)) {
    return [`    local ${local} = ${local}Param:get():ToString()  -- ${type}`]
  }
  if (p.prop_kind === 'StructProperty') {
    return [
      `    local ${local} = ${local}Param:get()  -- ${type}: поля читаются по имени, например ${local}.X`,
    ]
  }
  if (p.prop_kind === 'ObjectProperty' || p.prop_kind === 'ClassProperty' || p.prop_kind === 'InterfaceProperty') {
    return [
      `    local ${local} = ${local}Param:get()  -- ${type}`,
      `    if not (${local} and ${local}:IsValid()) then return end`,
    ]
  }
  return [`    local ${local} = ${local}Param:get()  -- ${type}`]
}

function callbackBody(params: ParamRow[], label: string): string[] {
  const args = ['Context', ...params.map((p) => `${luaLocal(p.name)}Param`)]
  const lines = [`  function(${args.join(', ')})`]
  if (params.length === 0) {
    lines.push('    -- параметров нет')
  }
  for (const p of params) lines.push(...unwrap(p))
  const shown = params.length > 0 ? params.map((p) => `tostring(${luaLocal(p.name)})`).join(' .. ", " .. ') : '""'
  lines.push(`    log.info("${label}: " .. ${shown})`)
  lines.push('  end')
  return lines
}

export function handleGenerateHook(ctx: GameContext, args: GenerateHookArgs): string {
  const echo = versionEchoFields(ctx)
  const kind = args.kind ?? 'post'
  const obj = findObject(ctx, args.function_path)

  if (!obj) {
    const suggestions = suggestSimilar(ctx, args.function_path)
    return renderAiText({
      reportType: 'hook_skeleton',
      fields: {
        ...echo,
        status: 'not_found',
        query: args.function_path,
        suggestions: suggestions.length > 0 ? suggestions.join('; ') : 'нет',
        hint: 'имя из строк бинарника может отсутствовать в рефлексии; проверь через ww_verify_hook',
      },
    })
  }

  if (obj.kind !== 'Function') {
    return renderAiText({
      reportType: 'hook_skeleton',
      fields: {
        ...echo,
        status: 'not_a_function',
        resolved_path: obj.path,
        kind: obj.kind,
        hint: 'хук вешается на функцию; список методов класса отдаёт ww_get_type',
      },
    })
  }

  if (!obj.hook_path || !isHookable(obj.kind)) {
    return renderAiText({
      reportType: 'hook_skeleton',
      fields: {
        ...echo,
        status: 'found_hook_path_unavailable',
        resolved_path: obj.path,
        hook_path_status: obj.hook_path_status,
        hint: 'ассетный путь BP не разрезолвлен: хукать нельзя, уточни через ww_verify_hook с live: true',
      },
    })
  }

  const params = ctx.db
    .query(
      `SELECT ordinal, name, prop_kind, type_name, inner_type, type_source, is_return, is_out
       FROM function_params WHERE function_path = ? ORDER BY ordinal`,
    )
    .all(obj.path) as ParamRow[]

  const inputs = params.filter((p) => p.is_return !== 1)
  const ret = params.find((p) => p.is_return === 1)
  const unknownTypes = params.filter((p) => p.type_source === 'none' || !p.type_name)

  const lines: string[] = []
  lines.push(`local log = require("ww.log").for_mod(MOD)`)
  lines.push('local register = WWRegisterHook or RegisterHook')
  lines.push('')
  lines.push(`register("${obj.hook_path}",`)
  const pre = kind === 'pre' || kind === 'both' ? callbackBody(inputs, `pre ${obj.name}`) : ['  function() end']
  const post = kind === 'post' || kind === 'both' ? callbackBody(inputs, `post ${obj.name}`) : null
  if (post) pre[pre.length - 1] += ','
  lines.push(...pre)
  if (post) lines.push(...post)
  lines.push(')')
  if (ret) {
    lines.push('')
    lines.push(`-- Функция возвращает ${ret.type_name ?? 'unknown'}. Чтение возвращаемого значения`)
    lines.push('-- в post-коллбэке на этом стенде не проверялось; надёжнее вызвать аксессор')
    lines.push(`-- на Context:get() и прочитать состояние явно.`)
  }

  return renderAiText({
    reportType: 'hook_skeleton',
    fields: {
      ...echo,
      status: 'ok',
      path: obj.path,
      hook_path: obj.hook_path,
      hook_kind: kind,
      signature: renderSignature(obj.name, params),
      param_count: inputs.length,
      returns: ret?.type_name ?? 'void',
      type_sources: [...new Set(params.map((p) => p.type_source))].join(',') || 'none',
      ...(unknownTypes.length > 0
        ? { warning: `типы не разрешены для: ${unknownTypes.map((p) => p.name).join(', ')} — проверь распаковку в живой игре через ww_game_eval` }
        : {}),
      note: 'MOD — имя мода, объявленное выше в main.lua; хук ставится один раз при загрузке скрипта',
    },
    results: [{ fields: { file: 'Scripts/main.lua' }, blocks: { lua: lines.join('\n') } }],
  })
}

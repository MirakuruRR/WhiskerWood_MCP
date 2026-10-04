import { ServerConfig } from '../config'
import { GameContext, versionEchoFields } from '../utils/game-context'
import { renderAiText } from '../utils/ai-text'
import { bpFunction, bpUnavailableHint } from '../utils/loom-types'
import { findObject, formatEnumFields, resolveEnumInfo, suggestSimilar } from './common'

export interface GetFunctionArgs {
  path: string
}

export function handleGetFunction(ctx: GameContext, config: ServerConfig, args: GetFunctionArgs): string {
  const obj = findObject(ctx, args.path)
  if (!obj) {
    const suggestions = suggestSimilar(ctx, args.path)
    return renderAiText({
      reportType: 'function_signature',
      fields: {
        ...versionEchoFields(ctx),
        status: 'not_found',
        query: args.path,
        suggestions: suggestions.length > 0 ? suggestions.join('; ') : 'нет',
      },
    })
  }

  if (obj.kind !== 'Function') {
    return renderAiText({
      reportType: 'function_signature',
      fields: {
        ...versionEchoFields(ctx),
        status: 'not_a_function',
        query: args.path,
        hint: 'это не функция; поля и методы отдаёт ww_get_type',
        resolved_path: obj.path,
      },
    })
  }

  const params = ctx.db
    .query(
      `SELECT ordinal, name, prop_kind, type_name, inner_type, type_source, is_return, is_out
       FROM function_params WHERE function_path = ? ORDER BY ordinal`,
    )
    .all(obj.path) as Array<{
    ordinal: number
    name: string
    prop_kind: string
    type_name: string | null
    inner_type: string | null
    type_source: string
    is_return: number
    is_out: number
  }>

  const ret = params.find((p) => p.is_return === 1)
  const argsOnly = params.filter((p) => p.is_return !== 1)
  const sources = [...new Set(params.map((p) => p.type_source))]

  const typeOf = (p: { type_name: string | null; inner_type: string | null; prop_kind: string }): string => {
    if (!p.type_name) return 'unknown'
    if ((p.type_name === 'TArray' || p.type_name === 'TSet' || p.type_name === 'TMap') && !p.inner_type) {
      return `${p.type_name}<unknown>`
    }
    if ((p.type_name === 'TArray' || p.type_name === 'TSet' || p.type_name === 'TMap') && p.inner_type) {
      return `${p.type_name}<${p.inner_type}>`
    }
    return p.type_name
  }

  const bp = bpFunction(ctx, config, obj.outer_path ?? '', obj.name)
  const hint = bp ? null : bpUnavailableHint(config)

  return renderAiText({
    reportType: 'function_signature',
    fields: {
      ...versionEchoFields(ctx),
      status: 'found',
      path: obj.path,
      class: obj.outer_path ?? '',
      ...(obj.hook_path ? { hook_path: obj.hook_path } : { hook_path_status: obj.hook_path_status }),
      ...(bp
        ? {
            bp: bp.status,
            ...(bp.loom_call ? { loom_call: bp.loom_call } : {}),
            ...(bp.loom_receiver ? { loom_receiver: bp.loom_receiver } : {}),
            ...(bp.loads_at_build ? { bp_loads_at_build: true } : {}),
            ...(bp.note ? { bp_note: bp.note } : {}),
          }
        : hint
          ? { bp_hint: hint }
          : {}),
      param_count: argsOnly.length,
      returns: ret ? typeOf(ret) : 'void',
      ...(bp?.returns ? { loom_returns: bp.returns } : {}),
      ...(ret ? { returns_type_source: ret.type_source } : {}),
      ...(ret
        ? Object.fromEntries(
            Object.entries(formatEnumFields(resolveEnumInfo(ctx, ret.prop_kind, ret.type_name))).map(([k, v]) => [`returns_${k}`, v]),
          )
        : {}),
      type_sources: sources.join(','),
    },
    results: argsOnly.map((p) => ({
      fields: {
        ordinal: p.ordinal,
        name: p.name,
        type: typeOf(p),
        type_source: p.type_source,
        dir: bp?.dirs[p.name] ?? (p.is_out === 1 ? 'out' : 'in'),
        ...(bp?.hidden_params.includes(p.name) ? { hidden: true } : {}),
        is_out: p.is_out === 1,
        ...formatEnumFields(resolveEnumInfo(ctx, p.prop_kind, p.type_name)),
      },
    })),
  })
}

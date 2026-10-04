import { ServerConfig } from '../config'
import { GameContext, versionEchoFields } from '../utils/game-context'
import { renderAiText } from '../utils/ai-text'
import { bpClass, bpField, bpFunction, bpUnavailableHint } from '../utils/loom-types'
import { findObject, formatEnumFields, pathFields, resolveEnumInfo, suggestSimilar } from './common'

export interface GetTypeArgs {
  path: string
}

const MAX_FIELDS = 120
const MAX_METHODS = 80
const MAX_SUBCLASSES = 50
const MAX_ENUM_VALUES = 200

export function handleGetType(ctx: GameContext, config: ServerConfig, args: GetTypeArgs): string {
  const obj = findObject(ctx, args.path)
  if (!obj) {
    const suggestions = suggestSimilar(ctx, args.path)
    return renderAiText({
      reportType: 'type_info',
      fields: {
        ...versionEchoFields(ctx),
        status: 'not_found',
        query: args.path,
        suggestions: suggestions.length > 0 ? suggestions.join('; ') : 'нет',
      },
    })
  }

  if (obj.kind === 'Function') {
    return renderAiText({
      reportType: 'type_info',
      fields: {
        ...versionEchoFields(ctx),
        status: 'not_a_type',
        query: args.path,
        hint: 'это функция; сигнатуру отдаёт ww_get_function',
        resolved_path: obj.path,
      },
    })
  }

  const info = bpClass(ctx, config, obj.path)
  const hint = info ? null : bpUnavailableHint(config)

  const base: Record<string, string | number | boolean> = {
    ...versionEchoFields(ctx),
    status: 'found',
    path: obj.path,
    kind: obj.kind,
    package: obj.package,
    is_blueprint: obj.is_blueprint === 1,
    ...(obj.super_path ? { super_path: obj.super_path } : {}),
    ...(obj.hook_path || obj.object_path ? pathFields(obj.hook_path, obj.object_path) : { hook_path_status: obj.hook_path_status }),
    ...(info
      ? {
          bp: info.in_types ? 'in_types' : 'not_in_types',
          ...(info.loom_path ? { loom_path: info.loom_path } : {}),
          ...(info.loads_at_build ? { bp_loads_at_build: true } : {}),
          ...(info.note ? { bp_note: info.note } : {}),
        }
      : hint
        ? { bp_hint: hint }
        : {}),
  }

  if (obj.kind === 'Enum') {
    const values = ctx.db
      .query('SELECT name, value FROM enum_values WHERE enum_path = ? ORDER BY ordinal LIMIT ?')
      .all(obj.path, MAX_ENUM_VALUES + 1) as Array<{ name: string; value: number }>
    const total = ctx.db.query('SELECT COUNT(*) c FROM enum_values WHERE enum_path = ?').get(obj.path) as { c: number }
    const truncated = total.c > MAX_ENUM_VALUES
    return renderAiText({
      reportType: 'type_info',
      fields: { ...base, value_count: total.c, truncated },
      results: values.slice(0, MAX_ENUM_VALUES).map((v) => ({ fields: { member: v.name, value: v.value } })),
    })
  }

  const fields = ctx.db
    .query(
      'SELECT name, offset, prop_kind, type_name, inner_type, type_source FROM properties WHERE owner_path = ? ORDER BY ordinal LIMIT ?',
    )
    .all(obj.path, MAX_FIELDS + 1) as Array<{
    name: string
    offset: number
    prop_kind: string
    type_name: string | null
    inner_type: string | null
    type_source: string
  }>

  const methods = ctx.db
    .query('SELECT name FROM objects WHERE outer_path = ? AND kind = ? ORDER BY name LIMIT ?')
    .all(obj.path, 'Function', MAX_METHODS + 1) as Array<{ name: string }>

  const subclasses = ctx.db
    .query('SELECT path, kind FROM objects WHERE super_path = ? ORDER BY path LIMIT ?')
    .all(obj.path, MAX_SUBCLASSES + 1) as Array<{ path: string; kind: string }>

  const totalFields = ctx.db.query('SELECT COUNT(*) c FROM properties WHERE owner_path = ?').get(obj.path) as { c: number }
  const totalMethods = ctx.db
    .query('SELECT COUNT(*) c FROM objects WHERE outer_path = ? AND kind = ?')
    .get(obj.path, 'Function') as { c: number }

  const typeOf = (r: { type_name: string | null; inner_type: string | null; prop_kind: string }): string => {
    if (!r.type_name) return r.prop_kind
    if ((r.type_name === 'TArray' || r.type_name === 'TSet' || r.type_name === 'TMap') && !r.inner_type) {
      return `${r.type_name}<unknown>`
    }
    if ((r.type_name === 'TArray' || r.type_name === 'TSet' || r.type_name === 'TMap') && r.inner_type) {
      return `${r.type_name}<${r.inner_type}>`
    }
    return r.type_name
  }

  return renderAiText({
    reportType: 'type_info',
    fields: {
      ...base,
      field_count: totalFields.c,
      method_count: totalMethods.c,
      fields_truncated: totalFields.c > MAX_FIELDS,
      methods_truncated: totalMethods.c > MAX_METHODS,
      subclass_count: subclasses.length > MAX_SUBCLASSES ? MAX_SUBCLASSES : subclasses.length,
    },
    results: [
      ...fields.slice(0, MAX_FIELDS).map((f) => {
        const bf = bpField(ctx, config, obj.path, f.name)
        return {
          fields: {
            section: 'field',
            name: f.name,
            offset: f.offset,
            type: typeOf(f),
            type_source: f.type_source,
            ...(bf ? { bp: bf.status } : {}),
            ...formatEnumFields(resolveEnumInfo(ctx, f.prop_kind, f.type_name)),
          },
        }
      }),
      ...methods.slice(0, MAX_METHODS).map((m) => {
        const bm = bpFunction(ctx, config, obj.path, m.name)
        return {
          fields: { section: 'method', name: m.name, ...(bm ? { bp: bm.status } : {}) },
        }
      }),
      ...subclasses.slice(0, MAX_SUBCLASSES).map((s) => ({
        fields: { section: 'subclass', name: s.path, kind: s.kind },
      })),
    ],
  })
}

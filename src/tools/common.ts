import { GameContext } from '../utils/game-context'
import { lastSegment, normalizeUserPath, outerOf } from '../scripts/parsers/path-forms'
import { buildFtsQuery } from '../utils/fts'

export interface ObjectHit {
  path: string
  kind: string
  package: string
  outer_path: string | null
  name: string
  super_path: string | null
  is_blueprint: number
  hook_path: string | null
  hook_path_status: string
  object_path: string | null
  is_cdo?: boolean
}

const HOOKABLE_KINDS = new Set(['Class', 'Function'])
const CDO_PREFIX = 'Default__'

export function isHookable(kind: string): boolean {
  return HOOKABLE_KINDS.has(kind) || kind.endsWith('BlueprintGeneratedClass')
}

function isClassLike(kind: string): boolean {
  return kind === 'Class' || kind.endsWith('BlueprintGeneratedClass')
}

/** Собирает каноническую CDO-форму (`/Script/UMG.Default__ScaleBox`) из object/hook-пути класса. */
function cdoPathOf(classPath: string): string {
  const dot = classPath.lastIndexOf('.')
  if (dot < 0) return `${classPath}.${CDO_PREFIX}${classPath}`
  return `${classPath.slice(0, dot + 1)}${CDO_PREFIX}${classPath.slice(dot + 1)}`
}

/** `StaticFindObject("/Script/Engine.Default__Prototype_Agent")` — рабочий путь к CDO, но его самого
 *  нет в индексе (парсер объект-дампа его намеренно пропускает). Резолвим синтетически через класс. */
function resolveCdo(ctx: GameContext, indexPath: string): ObjectHit | null {
  const last = lastSegment(indexPath)
  if (!last.startsWith(CDO_PREFIX)) return null
  const outer = outerOf(indexPath)
  if (!outer) return null
  const classPath = `${outer}.${last.slice(CDO_PREFIX.length)}`
  const classObj = ctx.db
    .query(`SELECT ${OBJECT_COLUMNS} FROM objects WHERE path = ?`)
    .get(classPath) as ObjectHit | null
  if (!classObj || !isClassLike(classObj.kind)) return null
  const canonical = classObj.object_path ?? classObj.hook_path
  return {
    ...classObj,
    path: indexPath,
    kind: 'CDO',
    name: last,
    hook_path: null,
    hook_path_status: 'not_hookable',
    object_path: canonical ? cdoPathOf(canonical) : null,
    is_cdo: true,
  }
}

export function pathFields(hookPath: string | null, objectPath: string | null): Record<string, string> {
  if (hookPath) return { hook_path: hookPath }
  if (objectPath) return { object_path: objectPath }
  return {}
}

const OBJECT_COLUMNS = 'path, kind, package, outer_path, name, super_path, is_blueprint, hook_path, hook_path_status, object_path'

export function findObject(ctx: GameContext, rawInput: string): ObjectHit | null {
  const norm = normalizeUserPath(rawInput)
  const byIndex = ctx.db
    .query(`SELECT ${OBJECT_COLUMNS} FROM objects WHERE path = ?`)
    .get(norm.indexPath) as ObjectHit | null
  if (byIndex) return byIndex

  if (norm.gameFullPath) {
    const byHook = ctx.db
      .query(`SELECT ${OBJECT_COLUMNS} FROM objects WHERE hook_path = ?`)
      .get(norm.gameFullPath) as ObjectHit | null
    if (byHook) return byHook
    const byObject = ctx.db
      .query(`SELECT ${OBJECT_COLUMNS} FROM objects WHERE object_path = ?`)
      .get(norm.gameFullPath) as ObjectHit | null
    if (byObject) return byObject
    const asClassPath = norm.gameFullPath.split(':')[0]
    const byHookClass = ctx.db
      .query(`SELECT ${OBJECT_COLUMNS} FROM objects WHERE hook_path = ?`)
      .get(asClassPath) as ObjectHit | null
    if (byHookClass) return byHookClass
    const byObjectClass = ctx.db
      .query(`SELECT ${OBJECT_COLUMNS} FROM objects WHERE object_path = ?`)
      .get(asClassPath) as ObjectHit | null
    if (byObjectClass) return byObjectClass
  }
  return resolveCdo(ctx, norm.indexPath)
}

export function suggestSimilar(ctx: GameContext, rawInput: string, limit = 5): string[] {
  const norm = normalizeUserPath(rawInput)
  const name = lastSegment(norm.indexPath)
  const fts = buildFtsQuery(name)
  const out: string[] = []
  if (fts) {
    try {
      const rows = ctx.db
        .query(
          `SELECT path FROM symbols_fts WHERE symbols_fts MATCH ? ORDER BY bm25(symbols_fts, 8.0, 4.0, 2.0, 1.0) LIMIT ?`,
        )
        .all(fts, limit) as Array<{ path: string }>
      for (const r of rows) out.push(r.path)
    } catch {
      // FTS-запрос мог не собраться — уходим в LIKE ниже
    }
  }
  if (out.length < limit && name.length >= 3) {
    const rows = ctx.db
      .query("SELECT path FROM objects WHERE kind != 'Package' AND name LIKE ? LIMIT ?")
      .all(`%${name}%`, limit - out.length) as Array<{ path: string }>
    for (const r of rows) if (!out.includes(r.path)) out.push(r.path)
  }
  return out.slice(0, limit)
}

export interface EnumInfo {
  path: string
  values: Array<{ name: string; value: number }>
  total: number
}

const MAX_INLINE_ENUM_VALUES = 16

export function resolveEnumInfo(ctx: GameContext, propKind: string, typeName: string | null): EnumInfo | null {
  if (!typeName) return null
  if (propKind !== 'ByteProperty' && propKind !== 'EnumProperty') return null
  const rows = ctx.db.query("SELECT path FROM objects WHERE kind = 'Enum' AND name = ? LIMIT 2").all(typeName) as Array<{
    path: string
  }>
  if (rows.length !== 1) return null
  const path = rows[0].path
  const values = ctx.db
    .query('SELECT name, value FROM enum_values WHERE enum_path = ? ORDER BY ordinal LIMIT ?')
    .all(path, MAX_INLINE_ENUM_VALUES + 1) as Array<{ name: string; value: number }>
  const total = ctx.db.query('SELECT COUNT(*) c FROM enum_values WHERE enum_path = ?').get(path) as { c: number }
  return { path, values: values.slice(0, MAX_INLINE_ENUM_VALUES), total: total.c }
}

export function formatEnumFields(info: EnumInfo | null): Record<string, string> {
  if (!info) return {}
  if (info.total <= MAX_INLINE_ENUM_VALUES) {
    return { enum_path: info.path, enum_values: info.values.map((v) => `${v.name}=${v.value}`).join(', ') }
  }
  return { enum_path: info.path, enum_hint: `ww_get_type ${info.path}` }
}

function enumPathByTypeName(ctx: GameContext, typeName: string | null): string | null {
  if (!typeName) return null
  const rows = ctx.db.query("SELECT path FROM objects WHERE kind = 'Enum' AND name = ? LIMIT 2").all(typeName) as Array<{
    path: string
  }>
  return rows.length === 1 ? rows[0].path : null
}

/** Точный поиск значения enum'а по имени члена — без обрезки списка, в отличие от resolveEnumInfo. */
export function resolveEnumMemberValue(ctx: GameContext, typeName: string | null, memberName: string): number | null {
  const path = enumPathByTypeName(ctx, typeName)
  if (!path) return null
  const row = ctx.db
    .query('SELECT value FROM enum_values WHERE enum_path = ? AND name = ? COLLATE NOCASE')
    .get(path, memberName) as { value: number } | null
  return row ? row.value : null
}

/** Обратный поиск: числовое значение enum'а -> имя члена. */
export function resolveEnumMemberName(ctx: GameContext, typeName: string | null, value: number): string | null {
  const path = enumPathByTypeName(ctx, typeName)
  if (!path) return null
  const row = ctx.db.query('SELECT name FROM enum_values WHERE enum_path = ? AND value = ?').get(path, value) as
    | { name: string }
    | null
  return row ? row.name : null
}

/** Длинная скобочная форма строкового литерала Lua — без экранирования кавычек/спецсимволов. */
export function luaStr(s: string): string {
  return `[[${s}]]`
}

/** Санитайзер имени поля/параметра рефлексии под Lua-идентификатор локальной переменной. */
export function luaLocal(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_]/g, '_')
  return /^[A-Za-z_]/.test(safe) ? safe : `p_${safe}`
}

export function renderSignature(
  name: string,
  params: Array<{ name: string; type_name: string | null; is_return: number; is_out: number }>,
): string {
  const args = params
    .filter((p) => !p.is_return)
    .map((p) => `${p.type_name ?? 'unknown'} ${p.name}${p.is_out ? ' [out]' : ''}`)
    .join(', ')
  const ret = params.find((p) => p.is_return)
  const retStr = ret ? ` -> ${ret.type_name ?? 'unknown'}` : ''
  return `${name}(${args})${retStr}`
}

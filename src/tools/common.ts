import { GameContext } from '../utils/game-context'
import { lastSegment, normalizeUserPath } from '../scripts/parsers/path-forms'
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
}

const HOOKABLE_KINDS = new Set(['Class', 'Function'])

export function isHookable(kind: string): boolean {
  return HOOKABLE_KINDS.has(kind) || kind.endsWith('BlueprintGeneratedClass')
}

export function pathFields(kind: string, path: string | null): Record<string, string> {
  if (!path) return {}
  return isHookable(kind) ? { hook_path: path } : { object_path: path }
}

export function findObject(ctx: GameContext, rawInput: string): ObjectHit | null {
  const norm = normalizeUserPath(rawInput)
  const byIndex = ctx.db
    .query('SELECT path, kind, package, outer_path, name, super_path, is_blueprint, hook_path, hook_path_status FROM objects WHERE path = ?')
    .get(norm.indexPath) as ObjectHit | null
  if (byIndex) return byIndex

  if (norm.gameFullPath) {
    const byHook = ctx.db
      .query('SELECT path, kind, package, outer_path, name, super_path, is_blueprint, hook_path, hook_path_status FROM objects WHERE hook_path = ?')
      .get(norm.gameFullPath) as ObjectHit | null
    if (byHook) return byHook
    const asClassPath = norm.gameFullPath.split(':')[0]
    const byHookClass = ctx.db
      .query('SELECT path, kind, package, outer_path, name, super_path, is_blueprint, hook_path, hook_path_status FROM objects WHERE hook_path = ?')
      .get(asClassPath) as ObjectHit | null
    if (byHookClass) return byHookClass
  }
  return null
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

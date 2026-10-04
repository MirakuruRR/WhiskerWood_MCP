import { ServerConfig } from '../config'
import { GameContext, versionEchoFields } from '../utils/game-context'
import { renderAiText, MAX_RESULTS, FTS_LIMIT } from '../utils/ai-text'
import { buildFtsQuery, tokenizePattern } from '../utils/fts'
import { bpClass, bpClassVisible, bpFunction, bpFunctionVisible, bpUnavailableHint } from '../utils/loom-types'
import { pathFields } from './common'

export interface FindSymbolArgs {
  pattern: string
  kind?: string
  package?: string
  limit?: number
  bp_only?: boolean
}

interface SymbolRow {
  path: string
  kind: string
  package: string
  name: string | null
  outer_path: string | null
  hook_path: string | null
  object_path: string | null
}

export function handleFindSymbol(ctx: GameContext, config: ServerConfig, args: FindSymbolArgs): string {
  const fts = buildFtsQuery(args.pattern)
  const tokens = tokenizePattern(args.pattern)
  if (!fts || tokens.length === 0) {
    return renderAiText({
      reportType: 'symbol_search',
      fields: { ...versionEchoFields(ctx), status: 'error', error: 'пустой запрос' },
    })
  }

  const limit = Math.min(Math.max(args.limit ?? FTS_LIMIT, 1), MAX_RESULTS)
  const fetchLimit = args.bp_only ? MAX_RESULTS : limit
  const bpKind = args.kind === 'bp' || args.kind === 'BlueprintGeneratedClass'
  const filters = (q: string): string => {
    const kindSql = args.kind ? (bpKind ? ` AND ${q}kind LIKE '%BlueprintGeneratedClass'` : ` AND ${q}kind = ?`) : ''
    const packageSql = args.package ? ` AND ${q}package = ?` : ''
    return kindSql + packageSql
  }
  const filterParams: string[] = []
  if (args.kind && !bpKind) filterParams.push(args.kind)
  if (args.package) filterParams.push(args.package)

  const likeWhere = (q: string): string => tokens.map(() => `(${q}name LIKE ? OR ${q}path LIKE ?)`).join(' AND ')
  const likeParams = tokens.flatMap((t) => [`%${t}%`, `%${t}%`])

  const total = (ctx.db
    .query(
      `SELECT COUNT(*) c FROM (
         SELECT s.path FROM symbols_fts s WHERE symbols_fts MATCH ?${filters('s.')}
         UNION
         SELECT o.path FROM objects o WHERE o.kind != 'Package' AND ${likeWhere('o.')}${filters('o.')}
       )`,
    )
    .get(...([fts, ...filterParams, ...likeParams, ...filterParams] as never[])) as { c: number }).c

  const columns = 's.path, s.kind, s.package, o.name, o.outer_path, o.hook_path, o.object_path'
  const ftsRows = ctx.db
    .query(
      `SELECT ${columns}
       FROM symbols_fts s
       LEFT JOIN objects o ON o.path = s.path
       WHERE symbols_fts MATCH ?${filters('s.')}
       ORDER BY bm25(symbols_fts, 8.0, 4.0, 2.0, 1.0)
       LIMIT ?`,
    )
    .all(...([fts, ...filterParams, fetchLimit] as never[])) as SymbolRow[]

  const seen = ftsRows.map((r) => r.path)
  const rest = fetchLimit - ftsRows.length
  let likeRows: SymbolRow[] = []
  if (rest > 0) {
    const notIn = seen.length > 0 ? ` AND path NOT IN (${seen.map(() => '?').join(', ')})` : ''
    likeRows = ctx.db
      .query(
        `SELECT path, kind, package, name, outer_path, hook_path, object_path FROM objects
         WHERE kind != 'Package' AND ${likeWhere('')}${filters('')}${notIn}
         ORDER BY length(path)
         LIMIT ?`,
      )
      .all(...([...likeParams, ...filterParams, ...seen, rest] as never[])) as SymbolRow[]
  }

  const hint = bpUnavailableHint(config)
  const nameOf = (r: SymbolRow): string => r.name ?? r.path.slice(r.path.lastIndexOf('.') + 1)
  const bpOf = (r: SymbolRow): { status: string | null; visible: boolean } => {
    if (hint) return { status: null, visible: true }
    if (r.kind === 'Function') {
      const owner = r.outer_path ?? r.path.slice(0, r.path.lastIndexOf('.'))
      const info = bpFunction(ctx, config, owner, nameOf(r))
      return info ? { status: info.status, visible: bpFunctionVisible(info.status) } : { status: null, visible: true }
    }
    if (r.kind === 'ScriptStruct' || r.kind === 'Enum' || r.kind === 'Class' || /GeneratedClass$/.test(r.kind)) {
      const info = bpClass(ctx, config, r.path)
      if (!info) return { status: null, visible: true }
      return { status: info.in_types ? 'in_types' : 'not_in_types', visible: bpClassVisible(info) }
    }
    return { status: null, visible: true }
  }

  const all = [...ftsRows, ...likeRows].map((r) => ({ row: r, bp: bpOf(r) }))
  const kept = args.bp_only ? all.filter((x) => x.bp.visible) : all
  const rows = kept.slice(0, limit)

  return renderAiText({
    reportType: 'symbol_search',
    fields: {
      ...versionEchoFields(ctx),
      query: args.pattern,
      prefix_matches: ftsRows.length,
      substring_matches: likeRows.length,
      truncated: total > rows.length,
      total_found: total,
      limit,
      ...(args.bp_only ? { bp_only: true, bp_filtered: all.length - kept.length } : {}),
      ...(hint ? { bp_hint: hint } : {}),
    },
    results: rows.map(({ row: r, bp }) => ({
      fields: {
        path: r.path,
        kind: r.kind,
        package: r.package,
        ...(bp.status ? { bp: bp.status } : {}),
        ...pathFields(r.hook_path, r.object_path),
      },
    })),
  })
}

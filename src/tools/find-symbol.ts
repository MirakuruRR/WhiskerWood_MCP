import { GameContext, versionEchoFields } from '../utils/game-context'
import { renderAiText, MAX_RESULTS, FTS_LIMIT } from '../utils/ai-text'
import { buildFtsQuery, tokenizePattern } from '../utils/fts'
import { pathFields } from './common'

export interface FindSymbolArgs {
  pattern: string
  kind?: string
  package?: string
  limit?: number
}

interface SymbolRow {
  path: string
  kind: string
  package: string
  hook_path: string | null
  object_path: string | null
}

export function handleFindSymbol(ctx: GameContext, args: FindSymbolArgs): string {
  const fts = buildFtsQuery(args.pattern)
  const tokens = tokenizePattern(args.pattern)
  if (!fts || tokens.length === 0) {
    return renderAiText({
      reportType: 'symbol_search',
      fields: { ...versionEchoFields(ctx), status: 'error', error: 'пустой запрос' },
    })
  }

  const limit = Math.min(Math.max(args.limit ?? FTS_LIMIT, 1), MAX_RESULTS)
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

  const ftsRows = ctx.db
    .query(
      `SELECT s.path, s.kind, s.package, o.hook_path, o.object_path
       FROM symbols_fts s
       LEFT JOIN objects o ON o.path = s.path
       WHERE symbols_fts MATCH ?${filters('s.')}
       ORDER BY bm25(symbols_fts, 8.0, 4.0, 2.0, 1.0)
       LIMIT ?`,
    )
    .all(...([fts, ...filterParams, limit] as never[])) as SymbolRow[]

  const seen = ftsRows.map((r) => r.path)
  const rest = limit - ftsRows.length
  let likeRows: SymbolRow[] = []
  if (rest > 0) {
    const notIn = seen.length > 0 ? ` AND path NOT IN (${seen.map(() => '?').join(', ')})` : ''
    likeRows = ctx.db
      .query(
        `SELECT path, kind, package, hook_path, object_path FROM objects
         WHERE kind != 'Package' AND ${likeWhere('')}${filters('')}${notIn}
         ORDER BY length(path)
         LIMIT ?`,
      )
      .all(...([...likeParams, ...filterParams, ...seen, rest] as never[])) as SymbolRow[]
  }

  const rows = [...ftsRows, ...likeRows]

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
    },
    results: rows.map((r) => ({
      fields: {
        path: r.path,
        kind: r.kind,
        package: r.package,
        ...pathFields(r.hook_path, r.object_path),
      },
    })),
  })
}

import { GameContext, versionEchoFields } from '../utils/game-context'
import { renderAiText, MAX_RESULTS, FTS_LIMIT } from '../utils/ai-text'
import { buildFtsQuery } from '../utils/fts'

export interface FindSymbolArgs {
  pattern: string
  kind?: string
  package?: string
  limit?: number
}

export function handleFindSymbol(ctx: GameContext, args: FindSymbolArgs): string {
  const fts = buildFtsQuery(args.pattern)
  if (!fts) {
    return renderAiText({
      reportType: 'symbol_search',
      fields: { ...versionEchoFields(ctx), status: 'error', error: 'пустой запрос' },
    })
  }

  const limit = Math.min(Math.max(args.limit ?? FTS_LIMIT, 1), MAX_RESULTS)
  const kindSql = args.kind
    ? args.kind === 'bp' || args.kind === 'BlueprintGeneratedClass'
      ? " AND kind LIKE '%BlueprintGeneratedClass'"
      : ' AND kind = ?'
    : ''
  const packageSql = args.package ? ' AND package = ?' : ''
  const params: Array<string | number> = [fts]
  if (args.kind && !(args.kind === 'bp' || args.kind === 'BlueprintGeneratedClass')) params.push(args.kind)
  if (args.package) params.push(args.package)

  const total = (ctx.db
    .query(`SELECT COUNT(*) c FROM symbols_fts WHERE symbols_fts MATCH ?${kindSql}${packageSql}`)
    .get(...(params as never[])) as { c: number }).c

  const rows = ctx.db
    .query(
      `SELECT s.path, s.kind, s.package, o.hook_path
       FROM symbols_fts s
       LEFT JOIN objects o ON o.path = s.path
       WHERE symbols_fts MATCH ?${kindSql}${packageSql}
       ORDER BY bm25(symbols_fts, 8.0, 4.0, 2.0, 1.0)
       LIMIT ?`,
    )
    .all(...(params as never[]), limit) as Array<{ path: string; kind: string; package: string; hook_path: string | null }>

  if (rows.length === 0 && total === 0) {
    const tokens = args.pattern.split(/\s+/).filter((t) => t.length > 0)
    if (tokens.length > 0) {
      const likeWhere = tokens.map(() => 'name LIKE ?').join(' AND ')
      const likeParams = tokens.map((t) => `%${t}%`)
      const fbRows = ctx.db
        .query(
          `SELECT path, kind, package, hook_path FROM objects
           WHERE kind != 'Package' AND ${likeWhere}${args.package ? ' AND package = ?' : ''}
           ORDER BY length(path)
           LIMIT ?`,
        )
        .all(...(likeParams as never[]), ...(args.package ? [args.package] : []), limit) as Array<{
        path: string
        kind: string
        package: string
        hook_path: string | null
      }>
      if (fbRows.length > 0) {
        return renderAiText({
          reportType: 'symbol_search',
          fields: {
            ...versionEchoFields(ctx),
            query: args.pattern,
            mode: 'like_fallback',
            truncated: fbRows.length >= limit,
            limit,
          },
          results: fbRows.map((r) => ({
            fields: {
              path: r.path,
              kind: r.kind,
              package: r.package,
              ...(r.hook_path ? { hook_path: r.hook_path } : {}),
            },
          })),
        })
      }
    }
  }

  return renderAiText({
    reportType: 'symbol_search',
    fields: {
      ...versionEchoFields(ctx),
      query: args.pattern,
      truncated: total > rows.length,
      total_found: total,
      limit,
    },
    results: rows.map((r) => ({
      fields: {
        path: r.path,
        kind: r.kind,
        package: r.package,
        ...(r.hook_path ? { hook_path: r.hook_path } : {}),
      },
    })),
  })
}

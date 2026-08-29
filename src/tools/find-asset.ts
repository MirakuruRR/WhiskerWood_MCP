import { GameContext, versionEchoFields } from '../utils/game-context'
import { renderAiText, MAX_RESULTS } from '../utils/ai-text'

export interface FindAssetArgs {
  pattern: string
  class?: string
  limit?: number
}

const DEFAULT_LIMIT = 25

export function handleFindAsset(ctx: GameContext, args: FindAssetArgs): string {
  const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_RESULTS)
  const like = args.pattern.includes('%') ? args.pattern : `%${args.pattern}%`
  const classWhere = args.class ? ' AND class_name = ? COLLATE NOCASE' : ''
  const params: string[] = args.class ? [like, like, args.class] : [like, like]

  const where = `(name LIKE ? OR asset_path LIKE ?)${classWhere}`
  const total = (ctx.db.query(`SELECT COUNT(*) c FROM assets WHERE ${where}`).get(...(params as never[])) as { c: number }).c
  const rows = ctx.db
    .query(
      `SELECT asset_path, name, class_name FROM assets WHERE ${where}
       ORDER BY CASE WHEN name = ? COLLATE NOCASE THEN 0 ELSE 1 END, length(asset_path), asset_path LIMIT ?`,
    )
    .all(...(params as never[]), args.pattern, limit) as Array<{ asset_path: string; name: string; class_name: string | null }>

  return renderAiText({
    reportType: 'asset_search',
    fields: {
      ...versionEchoFields(ctx),
      status: rows.length > 0 ? 'found' : 'not_found',
      query: args.pattern,
      ...(args.class ? { class: args.class } : {}),
    },
    truncated: total > rows.length,
    totalFound: total,
    limit,
    results: rows.map((r) => ({
      fields: {
        asset_path: r.asset_path,
        name: r.name,
        class_name: r.class_name ?? 'unknown',
      },
    })),
  })
}

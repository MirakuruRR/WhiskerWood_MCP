import { GameContext, versionEchoFields } from '../utils/game-context'
import { renderAiText, MAX_RESULTS } from '../utils/ai-text'
import { normalizeUserPath, lastSegment } from '../scripts/parsers/path-forms'
import { findObject, pathFields, suggestSimilar } from './common'

export interface FindCallersArgs {
  path: string
  kind?: string
  limit?: number
}

interface CallerRow {
  caller_path: string
  kind: string
  count: number
  callee_path: string | null
  hook_path: string | null
  object_path: string | null
}

export function handleFindCallers(ctx: GameContext, args: FindCallersArgs): string {
  const norm = normalizeUserPath(args.path)
  const name = lastSegment(norm.indexPath)
  const obj = findObject(ctx, args.path)
  const limit = Math.min(Math.max(args.limit ?? 50, 1), MAX_RESULTS)

  const kindSql = args.kind ? ' AND c.kind = ?' : ''
  const kindParams = args.kind ? [args.kind] : []

  const rows = ctx.db
    .query(
      `SELECT c.caller_path, c.kind, c.count, c.callee_path, o.hook_path, o.object_path
       FROM calls c
       LEFT JOIN objects o ON o.path = c.caller_path
       WHERE (c.callee_path = ? OR c.callee_name = ? COLLATE NOCASE)${kindSql}
       ORDER BY c.count DESC
       LIMIT ?`,
    )
    .all(...([obj?.path ?? norm.indexPath, name, ...kindParams, limit] as never[])) as CallerRow[]

  if (rows.length === 0) {
    const suggestions = suggestSimilar(ctx, args.path)
    return renderAiText({
      reportType: 'find_callers',
      fields: {
        ...versionEchoFields(ctx),
        status: 'not_found',
        query: args.path,
        hint: 'xref сайдкара покрывает только просканированный при сборке prefix; либо у функции нет вызовов в BP-байткоде (только C++/движок)',
        suggestions: suggestions.length > 0 ? suggestions.join('; ') : 'нет',
      },
    })
  }

  return renderAiText({
    reportType: 'find_callers',
    fields: {
      ...versionEchoFields(ctx),
      status: 'found',
      query: args.path,
      resolved_callee_path: obj?.path ?? rows.find((r) => r.callee_path)?.callee_path ?? norm.indexPath,
    },
    results: rows.map((r) => ({
      fields: {
        caller_path: r.caller_path,
        kind: r.kind,
        count: r.count,
        ...pathFields(r.hook_path, r.object_path),
      },
    })),
  })
}

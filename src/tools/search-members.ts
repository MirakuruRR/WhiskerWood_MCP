import { GameContext, versionEchoFields } from '../utils/game-context'
import { renderAiText, MAX_RESULTS } from '../utils/ai-text'

export interface SearchMembersArgs {
  pattern: string
  member_kind?: 'field' | 'method' | 'any'
  limit?: number
}

interface MemberHit {
  owner_path: string
  member_kind: string
  name: string
  detail: string | null
}

export function handleSearchMembers(ctx: GameContext, args: SearchMembersArgs): string {
  const memberKind = args.member_kind ?? 'any'
  const limit = Math.min(Math.max(args.limit ?? 20, 1), MAX_RESULTS)
  const like = args.pattern.includes('%') || args.pattern.includes('_') ? args.pattern : `%${args.pattern}%`

  const hits: MemberHit[] = []

  if (memberKind === 'field' || memberKind === 'any') {
    const rows = ctx.db
      .query(
        `SELECT owner_path, name, prop_kind, type_name
         FROM properties
         WHERE name LIKE ? ESCAPE '\\'
         ORDER BY owner_path
         LIMIT ?`,
      )
      .all(like, limit) as Array<{ owner_path: string; name: string; prop_kind: string; type_name: string | null }>
    for (const r of rows) {
      hits.push({ owner_path: r.owner_path, member_kind: 'field', name: r.name, detail: r.type_name ?? 'unknown' })
    }
  }

  if (hits.length < limit && (memberKind === 'method' || memberKind === 'any')) {
    const rows = ctx.db
      .query(
        `SELECT outer_path, name FROM objects
         WHERE kind = 'Function' AND name LIKE ? ESCAPE '\\'
         ORDER BY outer_path
         LIMIT ?`,
      )
      .all(like, limit - hits.length) as Array<{ outer_path: string | null; name: string }>
    for (const r of rows) {
      if (!r.outer_path) continue
      hits.push({ owner_path: r.outer_path, member_kind: 'method', name: r.name, detail: null })
    }
  }

  return renderAiText({
    reportType: 'member_search',
    fields: {
      ...versionEchoFields(ctx),
      query: args.pattern,
      member_kind: memberKind,
      truncated: hits.length >= limit,
      limit,
    },
    results: hits.map((h) => ({
      fields: {
        owner_path: h.owner_path,
        member_kind: h.member_kind,
        name: h.name,
        ...(h.detail ? { type: h.detail } : {}),
      },
    })),
  })
}

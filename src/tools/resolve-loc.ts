import { GameContext, versionEchoFields } from '../utils/game-context'
import { renderAiText, MAX_RESULTS } from '../utils/ai-text'
import { buildFtsQuery } from '../utils/fts'
import { ServerConfig } from '../config'

export interface ResolveLocArgs {
  key_or_pattern: string
  lang?: string
  limit?: number
}

const DEFAULT_LIMIT = 20

interface LocRow {
  key: string
  lang: string
  text: string
}

function requestedLangs(lang?: string): string[] | null {
  if (!lang || lang.toLowerCase() === 'all') return null
  return lang
    .split(',')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

function group(rows: LocRow[]): Map<string, LocRow[]> {
  const out = new Map<string, LocRow[]>()
  for (const r of rows) {
    const list = out.get(r.key) ?? []
    list.push(r)
    out.set(r.key, list)
  }
  return out
}

function render(ctx: GameContext, query: string, mode: string, status: string, grouped: Map<string, LocRow[]>, total: number, limit: number, langs: string[] | null): string {
  return renderAiText({
    reportType: 'loc_entry',
    fields: {
      ...versionEchoFields(ctx),
      status,
      query,
      mode,
      langs: langs ? langs.join(',') : 'all',
    },
    truncated: total > grouped.size,
    totalFound: total,
    limit,
    results: [...grouped.entries()].map(([key, rows]) => ({
      fields: { key, langs_found: rows.map((r) => r.lang).join(',') },
      blocks: Object.fromEntries(rows.map((r) => [`text_${r.lang}`, r.text])),
    })),
  })
}

export function handleResolveLoc(ctx: GameContext, config: ServerConfig, args: ResolveLocArgs): string {
  const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_RESULTS)
  const langs = args.lang ? requestedLangs(args.lang) : config.defaultLangs
  const langWhere = langs ? ` AND lang IN (${langs.map(() => '?').join(', ')})` : ''
  const langParams: string[] = langs ?? []

  const exact = ctx.db
    .query(`SELECT key, lang, text FROM loc_entries WHERE key = ? COLLATE NOCASE${langWhere} ORDER BY lang`)
    .all(args.key_or_pattern, ...(langParams as never[])) as LocRow[]
  if (exact.length > 0) {
    return render(ctx, args.key_or_pattern, 'exact_key', 'found', group(exact), 1, limit, langs)
  }

  const anyLang = ctx.db.query('SELECT COUNT(*) c FROM loc_entries WHERE key = ? COLLATE NOCASE').get(args.key_or_pattern) as { c: number }
  if (anyLang.c > 0) {
    const available = ctx.db
      .query('SELECT lang FROM loc_entries WHERE key = ? COLLATE NOCASE ORDER BY lang')
      .all(args.key_or_pattern) as Array<{ lang: string }>
    return renderAiText({
      reportType: 'loc_entry',
      fields: {
        ...versionEchoFields(ctx),
        status: 'lang_not_found',
        query: args.key_or_pattern,
        langs: langs ? langs.join(',') : 'all',
        available_langs: available.map((a) => a.lang).join(','),
      },
    })
  }

  const like = args.key_or_pattern.includes('%') ? args.key_or_pattern : `%${args.key_or_pattern}%`
  const keys = ctx.db
    .query('SELECT DISTINCT key FROM loc_entries WHERE key LIKE ? ORDER BY key LIMIT ?')
    .all(like, limit) as Array<{ key: string }>
  if (keys.length > 0) {
    const total = (ctx.db.query('SELECT COUNT(DISTINCT key) c FROM loc_entries WHERE key LIKE ?').get(like) as { c: number }).c
    const placeholders = keys.map(() => '?').join(', ')
    const rows = ctx.db
      .query(`SELECT key, lang, text FROM loc_entries WHERE key IN (${placeholders})${langWhere} ORDER BY key, lang`)
      .all(...(keys.map((k) => k.key) as never[]), ...(langParams as never[])) as LocRow[]
    return render(ctx, args.key_or_pattern, 'key_pattern', 'found', group(rows), total, limit, langs)
  }

  const fts = buildFtsQuery(args.key_or_pattern)
  if (fts) {
    try {
      const hits = ctx.db
        .query('SELECT DISTINCT key FROM loc_fts WHERE loc_fts MATCH ? ORDER BY rank LIMIT ?')
        .all(fts, limit) as Array<{ key: string }>
      if (hits.length > 0) {
        const placeholders = hits.map(() => '?').join(', ')
        const rows = ctx.db
          .query(`SELECT key, lang, text FROM loc_entries WHERE key IN (${placeholders})${langWhere} ORDER BY key, lang`)
          .all(...(hits.map((h) => h.key) as never[]), ...(langParams as never[])) as LocRow[]
        return render(ctx, args.key_or_pattern, 'text_search', 'found', group(rows), hits.length, limit, langs)
      }
    } catch {
      // FTS-запрос не собрался — отдаём not_found ниже
    }
  }

  return renderAiText({
    reportType: 'loc_entry',
    fields: {
      ...versionEchoFields(ctx),
      status: 'not_found',
      query: args.key_or_pattern,
      langs: langs ? langs.join(',') : 'all',
    },
  })
}

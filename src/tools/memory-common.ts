import { Database } from 'bun:sqlite'
import { ServerConfig } from '../config'
import { AiTextResult } from '../utils/ai-text'
import { buildFtsQuery } from '../utils/fts'
import { MEMORY_BM25, MEMORY_COLUMNS, MemoryRow, oneLine, openMemoryDb, splitTags } from '../utils/memory-db'

export const BODY_PREVIEW = 400

export function memoryResult(row: MemoryRow, opts: { fullBody?: boolean } = {}): AiTextResult {
  const fields: Record<string, string | number | boolean> = {
    public_id: row.public_id,
    category: row.category,
    importance: row.importance,
    status: row.status,
  }
  if (row.mod_name) fields.mod_name = row.mod_name
  // общая база сообщества против проверенного на этом стенде — разного веса знание
  if (row.origin === 'seed') fields.origin = 'seed'
  if (row.tags) fields.tags = row.tags
  fields.summary = oneLine(row.summary)
  fields.updated_at = row.updated_at
  if (row.status !== 'active') {
    fields.invalidated_at = row.invalidated_at ?? 'unknown'
    fields.invalidation_reason = oneLine(row.invalidation_reason ?? '')
  }
  const body = row.body.trim()
  if (body.length === 0) return { fields }
  const shown = opts.fullBody || body.length <= BODY_PREVIEW ? body : `${body.slice(0, BODY_PREVIEW)}…`
  return { fields, blocks: { body: shown } }
}

export interface MemoryFilter {
  mod_name?: string
  category?: string
  include_invalidated?: boolean
}

function filterSql(f: MemoryFilter, alias: string): { sql: string; params: string[] } {
  const parts: string[] = []
  const params: string[] = []
  if (!f.include_invalidated) parts.push(`${alias}.status = 'active'`)
  if (f.category) {
    parts.push(`${alias}.category = ?`)
    params.push(f.category)
  }
  if (f.mod_name) {
    // общие записи (mod_name IS NULL) относятся ко всем модам и остаются в выдаче
    parts.push(`(${alias}.mod_name = ? OR ${alias}.mod_name IS NULL)`)
    params.push(f.mod_name)
  }
  return { sql: parts.length > 0 ? ` AND ${parts.join(' AND ')}` : '', params }
}

export function searchMemories(db: Database, query: string, filter: MemoryFilter, limit: number): { rows: MemoryRow[]; via: string } {
  const f = filterSql(filter, 'm')
  const fts = buildFtsQuery(query)
  if (fts) {
    try {
      const rows = db
        .query(
          `SELECT ${MEMORY_COLUMNS.split(', ').map((c) => `m.${c}`).join(', ')}
           FROM project_memories_fts
           JOIN project_memories m ON m.id = project_memories_fts.rowid
           WHERE project_memories_fts MATCH ?${f.sql}
           ORDER BY ${MEMORY_BM25} ASC, m.importance DESC, m.updated_at DESC
           LIMIT ?`,
        )
        .all(fts, ...(f.params as never[]), limit) as MemoryRow[]
      if (rows.length > 0) return { rows, via: 'fts' }
    } catch {
      // запрос мог не собраться в валидный MATCH — уходим в LIKE
    }
  }
  const tokens = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
  if (tokens.length === 0) return { rows: [], via: 'empty_query' }
  const like = tokens.map(() => '(m.summary LIKE ? OR m.body LIKE ? OR m.tags LIKE ?)').join(' AND ')
  const likeParams: string[] = []
  for (const t of tokens) likeParams.push(`%${t}%`, `%${t}%`, `%${t}%`)
  const rows = db
    .query(
      `SELECT ${MEMORY_COLUMNS.split(', ').map((c) => `m.${c}`).join(', ')}
       FROM project_memories m
       WHERE ${like}${f.sql}
       ORDER BY m.importance DESC, m.updated_at DESC
       LIMIT ?`,
    )
    .all(...(likeParams as never[]), ...(f.params as never[]), limit) as MemoryRow[]
  return { rows, via: rows.length > 0 ? 'like' : 'none' }
}

export interface PitfallHint {
  public_id: string
  summary: string
  tokens: string[]
  tags: string[]
  mod_name: string | null
}

// Грабли из памяти попадают в линт ww_validate_mod: срабатывает тег, встреченный в коде мода.
export function activePitfalls(config: ServerConfig, modName: string | null): PitfallHint[] {
  let db: Database
  try {
    db = openMemoryDb(config)
  } catch {
    return []
  }
  const rows = db
    .query(
      `SELECT public_id, summary, tags, mod_name FROM project_memories
       WHERE status = 'active' AND category = 'pitfall' AND tags <> ''
       ORDER BY importance DESC, updated_at DESC LIMIT 200`,
    )
    .all() as Array<{ public_id: string; summary: string; tags: string; mod_name: string | null }>
  const out: PitfallHint[] = []
  for (const r of rows) {
    if (r.mod_name && modName && r.mod_name !== modName) continue
    const tags = splitTags(r.tags)
    const tokens = tags.filter((t) => t.length >= 4 && /^[A-Za-z_][\w.:]*$/.test(t))
    if (tokens.length === 0) continue
    out.push({ public_id: r.public_id, summary: oneLine(r.summary), tokens, tags, mod_name: r.mod_name })
  }
  return out
}

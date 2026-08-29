import { ServerConfig } from '../config'
import { renderAiText } from '../utils/ai-text'
import { MEMORY_COLUMNS, MemoryRow, nowIso, oneLine, openMemoryDb } from '../utils/memory-db'
import { memoryResult } from './memory-common'

export interface MemoryInvalidateArgs {
  public_id: string
  reason: string
}

export function handleMemoryInvalidate(config: ServerConfig, args: MemoryInvalidateArgs): string {
  const db = openMemoryDb(config)
  const row = db.query(`SELECT ${MEMORY_COLUMNS} FROM project_memories WHERE public_id = ?`).get(args.public_id) as MemoryRow | null

  if (!row) {
    const near = db
      .query("SELECT public_id, summary FROM project_memories WHERE status = 'active' ORDER BY updated_at DESC LIMIT 5")
      .all() as Array<{ public_id: string; summary: string }>
    return renderAiText({
      reportType: 'memory_invalidate',
      fields: {
        status: 'not_found',
        public_id: args.public_id,
        hint: 'public_id берётся из ww_memory_search или ww_memory_wakeup',
        recent: near.map((r) => `${r.public_id}: ${oneLine(r.summary).slice(0, 60)}`).join('; ') || 'память пуста',
      },
    })
  }

  if (row.status !== 'active') {
    return renderAiText({
      reportType: 'memory_invalidate',
      fields: {
        status: 'already_invalidated',
        public_id: row.public_id,
        invalidated_at: row.invalidated_at ?? 'unknown',
        invalidation_reason: oneLine(row.invalidation_reason ?? ''),
      },
      results: [memoryResult(row, { fullBody: true })],
    })
  }

  const now = nowIso()
  db.query(
    `UPDATE project_memories SET status = 'invalidated', invalidation_reason = ?, invalidated_at = ?, updated_at = ? WHERE id = ?`,
  ).run(oneLine(args.reason), now, now, row.id)

  const after = db.query(`SELECT ${MEMORY_COLUMNS} FROM project_memories WHERE id = ?`).get(row.id) as MemoryRow

  return renderAiText({
    reportType: 'memory_invalidate',
    fields: {
      status: 'ok',
      public_id: row.public_id,
      hint: 'запись погашена мягко: из поиска и линта уходит, история остаётся (include_invalidated: true в ww_memory_search)',
    },
    results: [memoryResult(after, { fullBody: true })],
  })
}

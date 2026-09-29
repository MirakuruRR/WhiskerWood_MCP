import { ServerConfig } from '../config'
import { AiTextResult, renderAiText } from '../utils/ai-text'
import { MemoryCategory, newPublicId, normalizeTags, nowIso, oneLine, openMemoryDb, splitTags } from '../utils/memory-db'

export interface MemoryEntry {
  category: MemoryCategory
  summary: string
  body?: string
  tags?: string[]
  mod_name?: string
  importance?: number
}

export interface MemoryAddArgs {
  entries: MemoryEntry[]
}

export function handleMemoryAdd(config: ServerConfig, args: MemoryAddArgs): string {
  const db = openMemoryDb(config)
  const now = nowIso()
  const results: AiTextResult[] = []
  let added = 0
  let updated = 0

  const insert = db.query(
    `INSERT INTO project_memories (public_id, category, summary, body, tags, mod_name, importance, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  )
  const update = db.query(
    `UPDATE project_memories
     SET body = ?, tags = ?, importance = ?, status = 'active', invalidation_reason = NULL, invalidated_at = NULL, updated_at = ?
     WHERE id = ?`,
  )
  const findExisting = db.query(
    `SELECT id, public_id, body, tags, importance FROM project_memories
     WHERE category = ? AND summary = ? COLLATE NOCASE AND COALESCE(mod_name, '') = COALESCE(?, '')`,
  )

  const tx = db.transaction((entries: MemoryEntry[]) => {
    for (const e of entries) {
      const summary = oneLine(e.summary)
      const body = (e.body ?? '').trim()
      const tags = normalizeTags(e.tags)
      const modName = e.mod_name?.trim() || null
      const existing = findExisting.get(e.category, summary, modName) as
        | { id: number; public_id: string; body: string; tags: string; importance: number }
        | null

      if (existing) {
        // повторная запись не должна молча понижать важность, стирать детали или гасить триггеры линта
        const mergedTags = normalizeTags([...splitTags(existing.tags), ...splitTags(tags)])
        const importance = e.importance !== undefined ? Math.min(Math.max(e.importance, 1), 5) : existing.importance
        update.run(body || existing.body, mergedTags, importance, now, existing.id)
        updated++
        results.push({
          fields: {
            action: 'updated',
            public_id: existing.public_id,
            category: e.category,
            importance,
            summary,
            ...(modName ? { mod_name: modName } : {}),
          },
        })
        continue
      }

      const importance = Math.min(Math.max(e.importance ?? 3, 1), 5)
      const publicId = newPublicId(db, e.category)
      insert.run(publicId, e.category, summary, body, tags, modName, importance, now, now)
      added++
      results.push({
        fields: { action: 'added', public_id: publicId, category: e.category, importance, summary, ...(modName ? { mod_name: modName } : {}) },
      })
    }
  })
  tx(args.entries)

  const active = (db.query("SELECT COUNT(*) AS n FROM project_memories WHERE status = 'active'").get() as { n: number }).n

  return renderAiText({
    reportType: 'memory_add',
    fields: {
      status: 'ok',
      added,
      updated,
      active_total: active,
      hint: 'запись с category=pitfall и тегами-символами попадёт в линт ww_validate_mod: тег, встреченный в коде мода, поднимет предупреждение',
    },
    results,
  })
}

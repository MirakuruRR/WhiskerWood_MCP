import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { ServerConfig } from '../config'

export const MEMORY_SCHEMA_VERSION = 1

export const MEMORY_CATEGORIES = ['decision', 'pitfall', 'preference', 'todo', 'note'] as const
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]

export const MEMORY_BM25 = 'bm25(project_memories_fts, 0.2, 1.0, 2.0, 1.0, 1.0, 0.5)'

const SCHEMA_SQL = `
CREATE TABLE project_memories (
  id                  INTEGER PRIMARY KEY,
  public_id           TEXT NOT NULL UNIQUE,
  category            TEXT NOT NULL,
  summary             TEXT NOT NULL,
  body                TEXT NOT NULL,
  tags                TEXT NOT NULL DEFAULT '',
  mod_name            TEXT,
  importance          INTEGER NOT NULL DEFAULT 3,
  status              TEXT NOT NULL DEFAULT 'active',
  invalidation_reason TEXT,
  invalidated_at      TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX pm_status_idx   ON project_memories(status, importance DESC, updated_at DESC);
CREATE INDEX pm_mod_idx      ON project_memories(mod_name, status);
CREATE INDEX pm_category_idx ON project_memories(category, status);

CREATE VIRTUAL TABLE project_memories_fts USING fts5(
  public_id, category, summary, body, tags, mod_name,
  content='project_memories', content_rowid='id'
);
CREATE TRIGGER pm_ai AFTER INSERT ON project_memories BEGIN
  INSERT INTO project_memories_fts(rowid, public_id, category, summary, body, tags, mod_name)
  VALUES (new.id, new.public_id, new.category, new.summary, new.body, new.tags, new.mod_name);
END;
CREATE TRIGGER pm_ad AFTER DELETE ON project_memories BEGIN
  INSERT INTO project_memories_fts(project_memories_fts, rowid, public_id, category, summary, body, tags, mod_name)
  VALUES ('delete', old.id, old.public_id, old.category, old.summary, old.body, old.tags, old.mod_name);
END;
CREATE TRIGGER pm_au AFTER UPDATE ON project_memories BEGIN
  INSERT INTO project_memories_fts(project_memories_fts, rowid, public_id, category, summary, body, tags, mod_name)
  VALUES ('delete', old.id, old.public_id, old.category, old.summary, old.body, old.tags, old.mod_name);
  INSERT INTO project_memories_fts(rowid, public_id, category, summary, body, tags, mod_name)
  VALUES (new.id, new.public_id, new.category, new.summary, new.body, new.tags, new.mod_name);
END;
`

export interface MemoryRow {
  id: number
  public_id: string
  category: string
  summary: string
  body: string
  tags: string
  mod_name: string | null
  importance: number
  status: string
  invalidation_reason: string | null
  invalidated_at: string | null
  created_at: string
  updated_at: string
}

export const MEMORY_COLUMNS =
  'id, public_id, category, summary, body, tags, mod_name, importance, status, invalidation_reason, invalidated_at, created_at, updated_at'

let cached: { path: string; db: Database } | null = null

export function memoryDbPath(config: ServerConfig): string {
  return `${config.distDir}/whiskerwood-memory.db`
}

export function openMemoryDb(config: ServerConfig): Database {
  const path = memoryDbPath(config)
  if (cached && cached.path === path) return cached.db
  cached?.db.close()
  cached = null
  mkdirSync(config.distDir, { recursive: true })
  const db = new Database(path, { create: true, readwrite: true })
  db.run('PRAGMA journal_mode = WAL')
  const existing = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_memories'")
    .get() as { name: string } | null
  if (!existing) {
    db.run('BEGIN')
    try {
      db.run(SCHEMA_SQL)
      db.run(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION}`)
      db.run('COMMIT')
    } catch (e) {
      db.run('ROLLBACK')
      db.close()
      throw e
    }
  }
  cached = { path, db }
  return db
}

export function closeMemoryDb(): void {
  cached?.db.close()
  cached = null
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z')
}

export function newPublicId(db: Database, category: string): string {
  const day = nowIso().slice(0, 10).replace(/-/g, '')
  const prefix = category.slice(0, 3)
  for (let attempt = 0; attempt < 20; attempt++) {
    const rnd = Math.random().toString(36).slice(2, 8)
    const id = `${prefix}-${day}-${rnd}`
    const clash = db.query('SELECT 1 FROM project_memories WHERE public_id = ?').get(id)
    if (!clash) return id
  }
  throw new Error('не удалось выделить уникальный public_id')
}

export function normalizeTags(tags: string[] | string | undefined): string {
  const raw = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(/[\s,;]+/) : []
  const seen: string[] = []
  for (const t of raw) {
    const v = t.trim()
    if (v.length === 0) continue
    if (!seen.includes(v)) seen.push(v)
  }
  return seen.join(', ')
}

export function splitTags(tags: string): string[] {
  return tags
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

export function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim()
}

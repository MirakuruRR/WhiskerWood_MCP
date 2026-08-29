import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'

const POOL_MAX = 4
const pool = new Map<string, Database>()

export function openIndexDb(path: string): Database {
  const cached = pool.get(path)
  if (cached) {
    pool.delete(path)
    pool.set(path, cached)
    return cached
  }
  if (!existsSync(path)) throw new Error(`база индекса не найдена: ${path}`)
  const db = new Database(path, { readonly: true, create: false })
  if (pool.size >= POOL_MAX) {
    const oldest = pool.keys().next().value as string
    pool.get(oldest)?.close()
    pool.delete(oldest)
  }
  pool.set(path, db)
  return db
}

export function closeIndexDbs(): void {
  for (const db of pool.values()) db.close()
  pool.clear()
}

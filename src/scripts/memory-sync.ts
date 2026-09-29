import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { repoRoot, requireConfig } from '../utils/cli-config'
import { ServerConfig } from '../config'
import { MemoryRow, closeMemoryDb, memoryContentHash, nowIso, openMemoryDb } from '../utils/memory-db'
import { parseSeed } from './memory-export'

export interface Outcome {
  seedPath: string
  seedRev: string
  total: number
  alreadyApplied: boolean
  added: string[]
  updated: string[]
  unchanged: number
  conflicts: Array<{ public_id: string; summary: string }>
  collisions: string[]
}

export interface SyncOptions {
  seedPath?: string
  preferSeed?: boolean
  dryRun?: boolean
}

export function defaultSeedPath(): string {
  return `${repoRoot()}/data/memory-seed.jsonl`
}

export function syncSeed(cfg: ServerConfig, opts: SyncOptions = {}): Outcome {
  const preferSeed = opts.preferSeed ?? false
  const dryRun = opts.dryRun ?? false
  const seedPath = resolve(opts.seedPath ?? defaultSeedPath())
  if (!existsSync(seedPath)) throw new Error(`общая база не найдена: ${seedPath}`)

  const raw = readFileSync(seedPath)
  const seedRev = createHash('sha256').update(raw).digest('hex').slice(0, 16)
  const records = parseSeed(seedPath)

  const db = openMemoryDb(cfg)
  const base = { seedPath, seedRev, total: records.length }
  const applied = db.query('SELECT seed_rev, applied_at FROM memory_seed_state WHERE id = 1').get() as
    | { seed_rev: string; applied_at: string }
    | null
  if (applied?.seed_rev === seedRev && !preferSeed) {
    return { ...base, alreadyApplied: true, added: [], updated: [], unchanged: records.length, conflicts: [], collisions: [] }
  }

  const now = nowIso()
  const res: Outcome = { ...base, alreadyApplied: false, added: [], updated: [], unchanged: 0, conflicts: [], collisions: [] }

  const findRow = db.query('SELECT * FROM project_memories WHERE public_id = ?')
  const insert = db.query(
    `INSERT INTO project_memories
       (public_id, category, summary, body, tags, mod_name, importance, status,
        invalidation_reason, invalidated_at, created_at, updated_at, origin, seed_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed', ?)`,
  )
  const update = db.query(
    `UPDATE project_memories
        SET category = ?, summary = ?, body = ?, tags = ?, mod_name = ?, importance = ?, status = ?,
            invalidation_reason = ?, invalidated_at = ?, updated_at = ?, origin = 'seed', seed_hash = ?
      WHERE public_id = ?`,
  )

  db.run('BEGIN')
  try {
    for (const rec of records) {
      const hash = memoryContentHash(rec as unknown as Record<string, unknown>)
      const local = findRow.get(rec.public_id) as MemoryRow | null

      if (!local) {
        if (!dryRun) {
          insert.run(
            rec.public_id,
            rec.category,
            rec.summary,
            rec.body,
            rec.tags ?? '',
            rec.mod_name,
            rec.importance,
            rec.status,
            rec.invalidation_reason,
            rec.invalidated_at,
            rec.created_at,
            rec.updated_at,
            hash,
          )
        }
        res.added.push(rec.public_id)
        continue
      }

      const localHash = memoryContentHash(local as unknown as Record<string, unknown>)

      // запись, совпадающая с общей базой дословно, — это она и есть, а не коллизия id:
      // так база автора, из которой сид и собран, принимается без единого конфликта
      if (local.origin !== 'seed') {
        if (localHash !== hash) {
          res.collisions.push(rec.public_id)
          continue
        }
        if (!dryRun) db.run("UPDATE project_memories SET origin = 'seed', seed_hash = ? WHERE public_id = ?", [hash, rec.public_id])
        res.unchanged++
        continue
      }
      if (local.seed_hash === hash) {
        res.unchanged++
        continue
      }

      const touchedLocally = localHash !== local.seed_hash
      if (touchedLocally && !preferSeed) {
        res.conflicts.push({ public_id: rec.public_id, summary: local.summary })
        continue
      }

      if (!dryRun) {
        update.run(
          rec.category,
          rec.summary,
          rec.body,
          rec.tags ?? '',
          rec.mod_name,
          rec.importance,
          rec.status,
          rec.invalidation_reason,
          rec.invalidated_at,
          now,
          hash,
          rec.public_id,
        )
      }
      res.updated.push(rec.public_id)
    }

    if (!dryRun && res.conflicts.length === 0) {
      db.run('INSERT INTO memory_seed_state (id, seed_rev, applied_at) VALUES (1, ?, ?) ' + 'ON CONFLICT(id) DO UPDATE SET seed_rev = excluded.seed_rev, applied_at = excluded.applied_at', [
        seedRev,
        now,
      ])
    }
    db.run(dryRun ? 'ROLLBACK' : 'COMMIT')
  } catch (e) {
    db.run('ROLLBACK')
    throw e
  }
  return res
}

function main(): void {
  const args = process.argv.slice(2)
  const fileArg = args.indexOf('--file')
  const cfg = requireConfig()
  const dryRun = args.includes('--dry-run')

  let res: Outcome
  try {
    res = syncSeed(cfg, {
      seedPath: fileArg >= 0 ? args[fileArg + 1] : undefined,
      preferSeed: args.includes('--prefer-seed'),
      dryRun,
    })
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }

  if (res.alreadyApplied) {
    console.log(`Общая база уже применена (ревизия ${res.seedRev}). Делать нечего.`)
    closeMemoryDb()
    return
  }

  console.log(`Общая база: ${res.seedPath} (ревизия ${res.seedRev}, записей ${res.total})`)
  console.log(`  +${res.added.length} новых, ~${res.updated.length} обновлено, ${res.unchanged} без изменений`)
  if (res.conflicts.length > 0) {
    console.log(`  !${res.conflicts.length} конфликтов — правлены и у вас, и в общей базе, оставлено ваше:`)
    for (const c of res.conflicts) console.log(`    ${c.public_id}  ${c.summary.slice(0, 80)}`)
    console.log('  взять версию из общей базы: bun run memory:sync --prefer-seed')
    console.log('  ревизия не отмечена применённой, пока конфликты не разобраны')
  }
  if (res.collisions.length > 0) {
    console.log(`  ${res.collisions.length} записей пропущено: id занят вашей собственной записью`)
    for (const id of res.collisions) console.log(`    ${id}`)
  }
  if (dryRun) console.log('  --dry-run: ничего не записано')
  closeMemoryDb()
}

if (import.meta.main) main()

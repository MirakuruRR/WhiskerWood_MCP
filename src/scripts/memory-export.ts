import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { ServerConfig } from '../config'
import { repoRoot, requireConfig } from '../utils/cli-config'
import { MemoryRow, closeMemoryDb, openMemoryDb } from '../utils/memory-db'

export const SEED_FIELDS = [
  'public_id',
  'category',
  'summary',
  'body',
  'tags',
  'mod_name',
  'importance',
  'status',
  'invalidation_reason',
  'invalidated_at',
  'created_at',
  'updated_at',
] as const

export interface SeedRecord {
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

// в общую базу не должны утечь личные пути: у автора записи они абсолютные,
// а читать их будут люди с другой раскладкой дисков
export function buildSanitizer(cfg: ServerConfig): (text: string) => string {
  const rules: Array<[RegExp, string]> = []
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const bothSlashes = (p: string) => new RegExp(esc(p).replace(/\//g, '[\\\\/]'), 'gi')

  for (const [path, token] of [
    [cfg.modsRepo, '{modsRepo}'],
    [repoRoot(), '{mcpRepo}'],
    [cfg.gameDir, '{gameDir}'],
    [process.env.USERPROFILE?.replace(/\\/g, '/') ?? '', '{home}'],
  ] as Array<[string, string]>) {
    if (path.length > 0) rules.push([bothSlashes(path), token])
  }
  rules.push([/([Cc]:[\\/]Users[\\/])[^\\/\s,;)"']+/g, '$1{user}'])

  return (text: string) => rules.reduce((acc, [re, to]) => acc.replace(re, to), text)
}

export function toSeedRecord(row: MemoryRow, clean: (t: string) => string = (t) => t): SeedRecord {
  const out: Record<string, unknown> = {}
  for (const f of SEED_FIELDS) {
    const v = row[f as keyof MemoryRow] ?? null
    out[f] = typeof v === 'string' ? clean(v) : v
  }
  return out as unknown as SeedRecord
}

export function readExcludeList(path: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!existsSync(path)) return out
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (t.length === 0 || t.startsWith('#')) continue
    const [id, ...reason] = t.split(/\s+/)
    out.set(id, reason.join(' ') || 'без причины')
  }
  return out
}

function main(): void {
  const args = process.argv.slice(2)
  const localOnly = args.includes('--local-only')
  const outArg = args.indexOf('--out')
  const cfg = requireConfig()
  const out = resolve(outArg >= 0 ? args[outArg + 1] : `${repoRoot()}/data/memory-seed.jsonl`)

  const db = openMemoryDb(cfg)
  const where = localOnly ? "WHERE origin = 'local'" : ''
  const all = db.query(`SELECT * FROM project_memories ${where} ORDER BY public_id`).all() as MemoryRow[]

  const excluded = readExcludeList(`${repoRoot()}/data/memory-seed.exclude.txt`)
  const rows = all.filter((r) => !excluded.has(r.public_id))
  const clean = buildSanitizer(cfg)
  const seeds = rows.map((r) => toSeedRecord(r, clean))
  const sanitized = seeds.filter((s, i) => JSON.stringify(s) !== JSON.stringify(toSeedRecord(rows[i])))

  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, seeds.length > 0 ? `${seeds.map((s) => JSON.stringify(s)).join('\n')}\n` : '', 'utf8')
  closeMemoryDb()

  const byCategory = new Map<string, number>()
  for (const r of rows) byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + 1)
  const active = rows.filter((r) => r.status === 'active').length

  console.log(`${out}`)
  console.log(`  записей: ${rows.length} (активных ${active}, погашенных ${rows.length - active})`)
  console.log(`  по категориям: ${[...byCategory].map(([k, v]) => `${k} ${v}`).join(', ')}`)
  if (excluded.size > 0) {
    const skipped = all.filter((r) => excluded.has(r.public_id))
    console.log(`  исключено по списку: ${skipped.length}`)
    for (const r of skipped) console.log(`    ${r.public_id} — ${excluded.get(r.public_id)}`)
  }
  if (sanitized.length > 0) {
    console.log(`  личные пути заменены плейсхолдерами в ${sanitized.length} записях:`)
    for (const s of sanitized) console.log(`    ${s.public_id}`)
  }
  if (localOnly) console.log('  только свои записи — этот файл можно приложить к пулл-реквесту')
}

if (import.meta.main) main()

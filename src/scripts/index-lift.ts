import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { ServerConfig } from '../config'
import { KitPaths, kitStatus } from '../utils/kit'
import { loomLift } from '../utils/loom'
import { buildSidecar, SidecarError } from './index-gamedata'
import { parseLm } from '../utils/lm-parser'
import { LIFT_SCHEMA_SQL } from '../schema'
import { classExport, findExportOfType, preprocessExports, propertiesOf } from '../utils/lift-json'
import {
  applyFallback,
  applyMarks,
  bytecodePath,
  classifyLoomRun,
  deadEnd,
  dropWidgetTree,
  firstLine,
  isInside,
  LiftMark,
  pushMark,
  refusalTail,
  splitFailures,
  stampOf,
  stubUnsupportedFunctions,
} from '../utils/lift-fallback'

export interface LiftInputs {
  profileDir: string
  gameVersion: string
  pakPath: string
  usmapPath: string
  limit?: number
  assets?: string[]
  scratchDir?: string
}

export interface LiftSummary {
  meta: Record<string, string | number>
  acceptance: {
    assets: number
    files: number
    functions: number
    stubs: number
    failed: number
  }
}

/** Экспорт пакета лежит в work/<file>.json и перечитывается с диска: 930 пакетов в памяти не держатся. */
interface Doc {
  asset: string
  file: string
  className: string
  size: number
  hasTree: boolean
  marks: LiftMark[]
  refusal: string | null
}

interface ManifestEntry {
  kind: string
  index: number
  asset: string
  file: string | null
  exports: number
  error: string | null
}

interface CodeRow {
  name: string
  kind: string
  from: number
  to: number
  text: string
}

const MAX_ITERATIONS = 60
/** Сколько раз пробуем снять дерево виджетов по одному, прежде чем валить четвертями. */
const SOLO_DROPS = 12
const EXPORT_TIMEOUT_MS = 900_000
const LOOM_TIMEOUT_MS = 900_000
const MAX_FAILURES_SHOWN = 12

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function writeMeta(db: Database, meta: Record<string, string | number>): void {
  const ins = db.prepare('INSERT OR REPLACE INTO profile_meta (key, value) VALUES (?, ?)')
  for (const [k, v] of Object.entries(meta)) ins.run(k, String(v))
}

function clearCode(db: Database): void {
  db.exec(LIFT_SCHEMA_SQL)
  db.exec("INSERT INTO code_fts (code_fts) VALUES ('delete-all')")
  db.exec('DELETE FROM code_functions')
}

/** Путь исходника, который напишет loom lift: Content/<путь ассета без /Game/>.lm. */
function lmRelFor(asset: string): string | null {
  return asset.startsWith('/Game/') ? `Content/${asset.slice('/Game/'.length)}.lm` : null
}

function docForAsset(docs: Doc[], asset: string): Doc | null {
  const exact = docs.find((d) => d.asset === asset)
  if (exact) return exact
  const name = asset.split('/').pop()
  const byName = docs.filter((d) => d.asset.split('/').pop() === name)
  return byName.length === 1 ? byName[0] : null
}

function requestedAssets(db: Database, inputs: LiftInputs): string[] {
  if (inputs.assets && inputs.assets.length > 0) return inputs.assets.slice()
  const limit = inputs.limit && inputs.limit > 0 ? ` LIMIT ${Math.floor(inputs.limit)}` : ''
  const rows = db
    .query(
      `SELECT asset_path FROM assets
       WHERE class_name IN ('Blueprint','WidgetBlueprint') AND asset_path LIKE '/Game/%'
       ORDER BY asset_path${limit}`,
    )
    .all() as Array<{ asset_path: string }>
  return rows.map((r) => r.asset_path)
}

function runSidecarBatch(
  config: ServerConfig,
  params: { paksDir: string; usmap: string; assetsFile: string; outDir: string; limit?: number },
): { entries: ManifestEntry[]; log: string; ms: number } {
  const args = [
    buildSidecar(config),
    'jsonbatch',
    '--paks',
    params.paksDir,
    '--usmap',
    params.usmap,
    '--assets',
    params.assetsFile,
    '--out-dir',
    params.outDir,
  ]
  if (params.limit && params.limit > 0) args.push('--limit', String(params.limit))

  const started = Date.now()
  let code: number | null = null
  let stderr = ''
  try {
    const proc = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe', timeout: EXPORT_TIMEOUT_MS })
    code = proc.exitCode
    stderr = new TextDecoder().decode(proc.stderr).trim()
  } catch (e) {
    throw new SidecarError(`WwParse jsonbatch не запустился: ${(e as Error).message}`)
  }
  const ms = Date.now() - started

  const manifest = `${params.outDir}/manifest.jsonl`
  if (!existsSync(manifest)) {
    throw new SidecarError(`WwParse jsonbatch не оставил манифест (код ${code ?? -1}):\n${stderr || 'без вывода'}`)
  }
  const entries: ManifestEntry[] = []
  for (const line of readFileSync(manifest, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    const parsed = JSON.parse(line) as ManifestEntry
    if (parsed.kind === 'asset') entries.push(parsed)
  }
  return { entries, log: stderr, ms }
}

function ensureScratchProject(scratch: string, kit: KitPaths): void {
  mkdirSync(`${scratch}/Intermediate/Loom`, { recursive: true })
  const uproject = `${scratch}/Lift.uproject`
  if (!existsSync(uproject)) writeFileSync(uproject, '{}')
  const types = `${scratch}/Intermediate/Loom/types.json`
  if (stampOf(kit.typesJson) !== stampOf(types)) copyFileSync(kit.typesJson, types)
}

function readExports(path: string): unknown[] {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown[]
}

/** Препроцессинг, стабы неподдерживаемого байткода и запись обратно: дальше в памяти только метаданные. */
function prepareDoc(entry: ManifestEntry, work: string): Doc {
  const path = `${work}/${entry.file}`
  const exports = readExports(path)
  const cls = classExport(exports)
  const doc: Doc = {
    asset: entry.asset,
    file: entry.file ?? '',
    className: typeof cls?.Name === 'string' ? cls.Name : `${entry.asset.split('/').pop() ?? 'Unknown'}_C`,
    size: statSync(path).size,
    hasTree: Boolean(propertiesOf(findExportOfType(exports, 'WidgetTree'))?.RootWidget),
    marks: [],
    refusal: null,
  }

  preprocessExports(exports)
  stubUnsupportedFunctions(exports, (m) => pushMark(doc.marks, m))
  writeFileSync(path, JSON.stringify(exports))
  return doc
}

function fallbackForDoc(doc: Doc, work: string, chunk: string): string | null {
  const path = `${work}/${doc.file}`
  const exports = readExports(path)
  const fix = applyFallback(exports, chunk, (m) => pushMark(doc.marks, m))
  if (fix) writeFileSync(path, JSON.stringify(exports))
  doc.refusal = fix ? null : (deadEnd(chunk) ?? refusalTail(chunk))
  return fix
}

/** Переполнение стека Loom умирает молча и роняет весь прогон, поэтому дерево виджетов приходится
 *  выбрасывать. Прогон стоит секунды, так что сначала снимается одно дерево — самое большое, оно и
 *  вероятнее всего переполняет стек, — и только потом, если это не помогло, четверть оставшихся. */
function dropWidgetTreesSlice(docs: Doc[], work: string, take: number): number {
  const candidates = docs.filter((d) => d.hasTree).sort((a, b) => b.size - a.size)
  if (candidates.length === 0) return 0
  let dropped = 0
  for (const doc of candidates.slice(0, Math.min(take, candidates.length))) {
    const path = `${work}/${doc.file}`
    const exports = readExports(path)
    doc.hasTree = false
    const reason = 'подъём пакетом упал без вывода (переполнение стека): виновника не назвать'
    if (!dropWidgetTree(exports, reason, (m) => pushMark(doc.marks, m))) continue
    dropped++
    writeFileSync(path, JSON.stringify(exports))
  }
  return dropped
}

function copyLm(from: string, to: string, files: string[]): void {
  rmSync(to, { recursive: true, force: true })
  for (const rel of files) {
    const parts = rel.split('/')
    if (parts.length > 1) mkdirSync(`${to}/${parts.slice(0, -1).join('/')}`, { recursive: true })
    else mkdirSync(to, { recursive: true })
    copyFileSync(`${from}/${rel}`, `${to}/${rel}`)
  }
}

/** Строки файла, разложенные по телам функций: у каждой строки ровно один владелец, поэтому поиск находит
 *  и заголовок с переменными, и хвост с пометками «не поднято». */
function rowsForLm(text: string, className: string): CodeRow[] {
  const src = parseLm('', '', text)
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const owner = new Array<number>(lines.length).fill(-1)
  const rows: CodeRow[] = []

  for (const body of src.bodies) {
    const from = Math.max(1, body.line)
    const to = Math.min(lines.length, body.endLine)
    const at = rows.length
    rows.push({ name: body.name, kind: body.kind, from, to, text: '' })
    for (let i = from; i <= to; i++) if (owner[i - 1] === -1) owner[i - 1] = at
  }

  const gaps = lines.map((_, i) => i + 1).filter((n) => owner[n - 1] === -1)
  if (gaps.length > 0) {
    const at = rows.length
    rows.push({
      name: src.header?.name ?? className.replace(/_C$/, ''),
      kind: 'file',
      from: gaps[0],
      to: gaps[gaps.length - 1],
      text: '',
    })
    for (const n of gaps) owner[n - 1] = at
  }

  const byRow: string[][] = rows.map(() => [])
  for (let i = 0; i < lines.length; i++) {
    const at = owner[i]
    if (at >= 0) byRow[at].push(lines[i])
  }
  for (let i = 0; i < rows.length; i++) rows[i].text = byRow[i].join('\n')
  return rows
}

function indexLifted(
  db: Database,
  liftDir: string,
  files: string[],
  classOf: Map<string, string>,
): { functions: number; files: number; stubs: number } {
  db.exec('BEGIN')
  try {
    clearCode(db)
    const insRow = db.prepare(
      `INSERT INTO code_functions (rowid, function_path, name, kind, asset_path, file, line_from, line_to, stub, text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insFts = db.prepare('INSERT INTO code_fts (rowid, name, path, text) VALUES (?, ?, ?, ?)')

    let rowid = 0
    let bodies = 0
    let stubs = 0
    for (const rel of files) {
      const text = readFileSync(`${liftDir}/${rel}`, 'utf8')
      const assetPath = rel.startsWith('Content/') ? `/Game/${rel.slice('Content/'.length).replace(/\.lm$/, '')}` : rel
      const className = classOf.get(assetPath) ?? `${assetPath.split('/').pop() ?? 'Unknown'}_C`
      const lines = text.replace(/\r\n?/g, '\n').split('\n')

      for (const row of rowsForLm(text, className)) {
        const stub = /^\/\/\s*not lifted:/.test((lines[row.from - 2] ?? '').trim()) ? 1 : 0
        if (stub) stubs++
        if (row.kind !== 'file') bodies++
        rowid++
        const path = row.kind === 'file' ? `${assetPath}.${className}` : `${assetPath}.${className}:${row.name}`
        insRow.run(rowid, path, row.name, row.kind, assetPath, rel, row.from, row.to, stub, row.text)
        insFts.run(rowid, row.name, path, row.text)
      }
    }
    db.exec('COMMIT')
    return { functions: bodies, files: files.length, stubs }
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

function skipSummary(db: Database, reason: string): LiftSummary {
  clearCode(db)
  const meta: Record<string, string | number> = {
    lift_status: 'skipped',
    lift_skip_reason: reason,
    lift_built_at: new Date().toISOString(),
    lift_assets_requested: 0,
    lift_assets_lifted: 0,
    lift_functions: 0,
  }
  writeMeta(db, meta)
  return { meta, acceptance: { assets: 0, files: 0, functions: 0, stubs: 0, failed: 0 } }
}

export async function buildLiftIndex(dbPath: string, cfg: ServerConfig, inputs: LiftInputs): Promise<LiftSummary> {
  const db = new Database(dbPath, { readwrite: true, create: false })
  try {
    clearCode(db)

    const kit = kitStatus(cfg)
    if (!kit.configured || !kit.kit) return skipSummary(db, `кит не настроен: ${kit.problem ?? 'kitDir не задан'}`)
    if (!existsSync(kit.kit.typesJson)) {
      return skipSummary(db, `нет ${kit.kit.typesJson}: кит ни разу не собирался, типы дампит LoomBuild`)
    }

    const scratch = resolve(inputs.scratchDir ?? `${cfg.stateDir}/lift-batch/${inputs.gameVersion}`)
    const profileDir = resolve(inputs.profileDir)
    if (isInside(scratch, kit.kit.kitDir) || isInside(profileDir, kit.kit.kitDir)) {
      return skipSummary(db, `подъём в <кит> запрещён: ${scratch} или ${profileDir} лежит внутри ${kit.kit.kitDir}`)
    }

    const assets = requestedAssets(db, inputs)
    if (assets.length === 0) return skipSummary(db, 'в индексе нет Blueprint-ассетов: реестр пуст')

    const work = `${scratch}/work`
    rmSync(work, { recursive: true, force: true })
    mkdirSync(work, { recursive: true })
    ensureScratchProject(scratch, kit.kit)
    const content = `${scratch}/Content`
    rmSync(content, { recursive: true, force: true })
    mkdirSync(content, { recursive: true })

    const typesSha = sha256OfFile(kit.kit.typesJson)
    const assetsFile = `${work}/assets.txt`
    writeFileSync(assetsFile, `${assets.join('\n')}\n`)

    const exported = runSidecarBatch(cfg, {
      paksDir: dirname(inputs.pakPath),
      usmap: inputs.usmapPath,
      assetsFile,
      outDir: work,
      limit: inputs.assets && inputs.assets.length > 0 ? undefined : inputs.limit,
    })

    const docs: Doc[] = []
    const failures: string[] = []
    for (const entry of exported.entries) {
      if (!entry.file) {
        failures.push(`${entry.asset}: ${entry.error ?? 'не выгружен'}`)
        continue
      }
      try {
        docs.push(prepareDoc(entry, work))
      } catch (e) {
        failures.push(`${entry.asset}: ${(e as Error).message}`)
      }
    }

    const classOf = new Map<string, string>()
    for (const doc of docs) classOf.set(doc.asset, doc.className)

    // Подъём идёт пакетом, но Loom бросает работу на первом отказе и часть пакетов не доходит:
    // поднятое складывается в keep, из следующего прогона пакет уходит, набор ужимается до тех, кому
    // нужен фолбэк. Прогресс монотонный, поэтому цикл сходится, а готовые исходники не перетираются.
    const keep = `${scratch}/keep`
    rmSync(keep, { recursive: true, force: true })
    const kept = new Map<string, string>()
    const pending = [...docs]
    const loomStart = Date.now()
    let iteration = 0
    let lastError = ''
    let droppedTrees = 0
    let soloDrops = 0

    for (iteration = 1; iteration <= MAX_ITERATIONS && pending.length > 0; iteration++) {
      const res = await loomLift(
        kit.kit,
        pending.map((d) => `work/${d.file}`),
        scratch,
        { cwd: scratch, timeoutMs: LOOM_TIMEOUT_MS },
      )

      let fresh = 0
      for (const doc of pending) {
        const rel = lmRelFor(doc.asset)
        if (!rel) continue
        const path = `${scratch}/${rel}`
        if (!existsSync(path) || statSync(path).size === 0) continue
        const parts = rel.split('/')
        mkdirSync(`${keep}/${parts.slice(0, -1).join('/')}`, { recursive: true })
        copyFileSync(path, `${keep}/${rel}`)
        kept.set(doc.asset, rel)
        fresh++
      }
      if (fresh > 0) {
        for (let i = pending.length - 1; i >= 0; i--) if (kept.has(pending[i].asset)) pending.splice(i, 1)
      }

      const run = classifyLoomRun(res)
      if (pending.length === 0 || run.kind === 'ok') break

      lastError = run.error
      if (run.kind === 'unavailable') break
      let changed = 0
      for (const failure of splitFailures(lastError)) {
        const doc = docForAsset(pending, failure.asset)
        if (!doc) continue
        if (fallbackForDoc(doc, work, failure.chunk)) {
          changed++
          continue
        }
        const dead = deadEnd(failure.chunk)
        if (dead === null) continue
        pending.splice(pending.indexOf(doc), 1)
        failures.push(`${doc.asset}: ${dead}`)
        changed++
      }
      if (changed === 0 && fresh === 0) {
        if (run.kind === 'overflow' || run.kind === 'silent') {
          const owners = pending.filter((d) => d.hasTree).length
          const take = soloDrops < SOLO_DROPS ? 1 : Math.max(1, Math.ceil(owners / 4))
          soloDrops++
          const dropped = dropWidgetTreesSlice(pending, work, take)
          if (dropped > 0) {
            droppedTrees += dropped
            changed = dropped
          }
        }
      }
      if (changed === 0 && fresh === 0) break
    }
    const loomMs = Date.now() - loomStart

    const lmFiles = [...kept.values()].sort()
    for (const rel of lmFiles) {
      const target = `${scratch}/${rel}`
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(`${keep}/${rel}`, target)
      const doc = docs.find((d) => lmRelFor(d.asset) === rel)
      if (doc && doc.marks.length > 0) {
        const marked = applyMarks(readFileSync(target, 'utf8'), doc.marks, (name) => bytecodePath(doc.asset, doc.className, name))
        writeFileSync(target, marked)
      }
    }

    const liftDir = `${profileDir}/lift`
    copyLm(scratch, liftDir, lmFiles)

    const indexed = indexLifted(db, liftDir, lmFiles, classOf)
    for (const doc of pending) failures.push(`${doc.asset}: ${doc.refusal ?? 'подъём отказал'}`)
    const lifted = pending.length === 0

    const meta: Record<string, string | number> = {
      lift_status: lifted && failures.length === 0 ? 'ok' : indexed.files > 0 ? 'partial' : 'failed',
      lift_built_at: new Date().toISOString(),
      lift_source: 'loom-lift-batch',
      lift_types_sha256: typesSha,
      lift_types_stamp: stampOf(kit.kit.typesJson),
      lift_types_path: kit.kit.typesJson,
      lift_dir: liftDir,
      lift_scratch: scratch,
      lift_assets_requested: assets.length,
      lift_assets_lifted: indexed.files,
      lift_assets_failed: failures.length,
      lift_functions: indexed.functions,
      lift_stubs: indexed.stubs,
      lift_iterations: Math.min(iteration, MAX_ITERATIONS),
      lift_widget_trees_dropped: droppedTrees,
      lift_export_ms: exported.ms,
      lift_loom_ms: loomMs,
      lift_ms: exported.ms + loomMs,
    }
    if (failures.length > 0) meta.lift_failures = failures.slice(0, MAX_FAILURES_SHOWN).join(' | ')
    if (!lifted && lastError.length > 0) meta.lift_last_error = firstLine(lastError)
    if (exported.log.length > 0) meta.lift_sidecar_log = firstLine(exported.log)
    writeMeta(db, meta)

    return {
      meta,
      acceptance: {
        assets: assets.length,
        files: indexed.files,
        functions: indexed.functions,
        stubs: indexed.stubs,
        failed: failures.length,
      },
    }
  } finally {
    db.close()
  }
}

async function main(): Promise<void> {
  const { loadConfig } = await import('../config')

  const arg = (name: string): string | null => {
    const at = process.argv.indexOf(`--${name}`)
    return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : null
  }

  const cfg = loadConfig()
  const explicitDb = arg('db')
  let dbPath = explicitDb
  let profileDir = arg('profile-dir')
  let gameVersion = arg('game') ?? ''
  if (!dbPath) {
    const { listProfiles, resolveProfile } = await import('../utils/game-registry')
    const profile = resolveProfile(listProfiles(cfg.distDir), arg('version') ?? undefined)
    dbPath = `${profile.dir}/index.db`
    profileDir = profileDir ?? profile.dir
    gameVersion = profile.contract?.gameVersion ?? profile.profileId
  }
  profileDir = profileDir ?? dirname(dbPath)
  if (gameVersion.length === 0) gameVersion = profileDir.split(/[\\/]/).pop() ?? 'unknown'

  const assetsArg = arg('assets')
  const assets = assetsArg
    ? readFileSync(assetsArg, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'))
    : undefined

  const usmap = existsSync(cfg.dumpsDir)
    ? readdirSync(cfg.dumpsDir)
        .filter((f) => f.toLowerCase().endsWith('.usmap'))
        .map((f) => ({ f, mtime: statSync(`${cfg.dumpsDir}/${f}`).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0]
    : undefined

  console.log(`профиль: ${gameVersion} (${profileDir})`)
  console.log(`база: ${dbPath}, исходники: ${profileDir}/lift`)

  const summary = await buildLiftIndex(dbPath, cfg, {
    profileDir,
    gameVersion,
    pakPath: cfg.pakPath,
    usmapPath: usmap ? `${cfg.dumpsDir}/${usmap.f}` : '',
    limit: arg('limit') ? Number(arg('limit')) : undefined,
    assets,
    scratchDir: arg('scratch') ?? undefined,
  })

  for (const [k, v] of Object.entries(summary.meta)) console.log(`  ${k}: ${v}`)
  console.log(
    `итог: ассетов ${summary.acceptance.assets}, исходников ${summary.acceptance.files}, функций ${summary.acceptance.functions}, стабов ${summary.acceptance.stubs}, отказов ${summary.acceptance.failed}`,
  )
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}

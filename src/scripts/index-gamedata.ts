import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { ServerConfig } from '../config'

export interface GameDataInputs {
  pakPath: string
  usmapPath: string
  jsonlPath: string
}

export interface GameDataSummary {
  meta: Record<string, string | number>
  acceptance: {
    techUnlocksRows: number
    techUnlocksSampleKey: string | null
    starvationRu: string | null
  }
}

export const LOC_ASSET_PREFIX = '/Game/Data/TextDB/'

interface SidecarTable {
  kind: 'table'
  name: string
  assetPath: string
  rowStruct: string | null
  rowCount: number
  rows: Record<string, unknown>
}

interface SidecarObject {
  kind: 'object'
  name: string
  assetPath: string
  rowStruct: string | null
  properties: unknown
}

interface SidecarSummary {
  kind: 'summary'
  scanned: number
  tables: number
  objects: number
  rows: number
  failed: number
  failures: Array<{ file: string; error: string }>
}

type SidecarLine = SidecarTable | SidecarObject | SidecarSummary

export class SidecarError extends Error {}

function sidecarDir(cfg: ServerConfig): string {
  return `${cfg.configDir}/sidecar/WwParse`
}

function run(cmd: string[], cwd?: string): { code: number; stderr: string } {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  return { code: proc.exitCode ?? -1, stderr: new TextDecoder().decode(proc.stderr) }
}

export function buildSidecar(cfg: ServerConfig): string {
  const dir = sidecarDir(cfg)
  if (!existsSync(`${dir}/WwParse.csproj`)) {
    throw new SidecarError(`сайдкар не найден: ${dir}/WwParse.csproj`)
  }
  const exe = `${dir}/bin/Release/net10.0/WwParse.exe`
  const build = run(['dotnet', 'build', dir, '-c', 'Release', '--nologo', '-v', 'quiet'])
  if (build.code !== 0) {
    throw new SidecarError(
      `не удалось собрать сайдкар WwParse (dotnet build → ${build.code}). Нужен .NET SDK 10.\n${build.stderr.trim()}`,
    )
  }
  if (!existsSync(exe)) throw new SidecarError(`сборка прошла, но исполняемого файла нет: ${exe}`)
  return exe
}

export function runSidecar(cfg: ServerConfig, inputs: GameDataInputs): string {
  const exe = buildSidecar(cfg)
  const paksDir = dirname(inputs.pakPath)
  const res = run([exe, '--paks', paksDir, '--usmap', inputs.usmapPath, '--out', inputs.jsonlPath])
  if (res.code !== 0) {
    throw new SidecarError(`WwParse завершился с кодом ${res.code}:\n${res.stderr.trim()}`)
  }
  return res.stderr.trim()
}

function locLangOf(name: string): string | null {
  return name.startsWith('Loc_') ? name.slice(4) : null
}

function textOf(row: unknown): string | null {
  if (typeof row !== 'object' || row === null) return null
  const r = row as Record<string, unknown>
  if (typeof r.Value === 'string') return r.Value
  for (const v of Object.values(r)) if (typeof v === 'string') return v
  return null
}

export async function buildGameDataIndex(
  dbPath: string,
  cfg: ServerConfig,
  inputs: GameDataInputs,
): Promise<GameDataSummary> {
  const sidecarLog = runSidecar(cfg, inputs)
  const text = await Bun.file(inputs.jsonlPath).text()
  const lines = text.split('\n').filter((l) => l.trim().length > 0)

  const meta: Record<string, string | number> = {}
  const db = new Database(dbPath, { readwrite: true, create: false })
  try {
    db.exec('BEGIN')
    db.exec('DELETE FROM datatable_rows')
    db.exec('DELETE FROM datatables')
    db.exec("INSERT INTO loc_fts (loc_fts) VALUES ('delete-all')")
    db.exec('DELETE FROM loc_entries')

    const insTable = db.prepare(
      'INSERT OR REPLACE INTO datatables (name, asset_path, row_struct, row_count, kind) VALUES (?, ?, ?, ?, ?)',
    )
    const insRow = db.prepare(
      'INSERT OR REPLACE INTO datatable_rows (table_name, row_name, row_json) VALUES (?, ?, ?)',
    )
    const insLoc = db.prepare('INSERT OR REPLACE INTO loc_entries (rowid, key, lang, text) VALUES (?, ?, ?, ?)')
    const insLocFts = db.prepare('INSERT INTO loc_fts (rowid, key, text) VALUES (?, ?, ?)')
    const insMeta = db.prepare('INSERT OR REPLACE INTO profile_meta (key, value) VALUES (?, ?)')

    let tables = 0
    let dataAssets = 0
    let rows = 0
    let locLangs = 0
    let locEntries = 0
    let locEmpty = 0
    let summary: SidecarSummary | null = null

    for (const line of lines) {
      const parsed = JSON.parse(line) as SidecarLine
      if (parsed.kind === 'summary') {
        summary = parsed
        continue
      }
      if (parsed.kind === 'object') {
        insTable.run(parsed.name, parsed.assetPath, parsed.rowStruct, 1, 'data_asset')
        insRow.run(parsed.name, parsed.name, JSON.stringify(parsed.properties))
        dataAssets++
        rows++
        continue
      }

      const lang = parsed.assetPath.startsWith(LOC_ASSET_PREFIX) ? locLangOf(parsed.name) : null
      insTable.run(parsed.name, parsed.assetPath, parsed.rowStruct, parsed.rowCount, lang ? 'loc' : 'datatable')
      tables++
      if (lang) {
        locLangs++
        for (const [key, row] of Object.entries(parsed.rows)) {
          const value = textOf(row)
          if (value === null) {
            locEmpty++
            continue
          }
          locEntries++
          insLoc.run(locEntries, key, lang, value)
          insLocFts.run(locEntries, key, value)
        }
      } else {
        for (const [key, row] of Object.entries(parsed.rows)) {
          insRow.run(parsed.name, key, JSON.stringify(row))
          rows++
        }
      }
    }

    meta.gamedata_built_at = new Date().toISOString()
    meta.gamedata_assets_scanned = summary?.scanned ?? 0
    meta.gamedata_tables = tables
    meta.gamedata_data_assets = dataAssets
    meta.gamedata_rows = rows
    meta.gamedata_failed_assets = summary?.failed ?? 0
    meta.loc_tables = locLangs
    meta.loc_entries = locEntries
    meta.loc_rows_without_text = locEmpty
    meta.gamedata_source = 'cue4parse-sidecar'
    if (summary && summary.failures.length > 0) {
      meta.gamedata_failures = summary.failures.map((f) => `${f.file}: ${f.error}`).join(' | ')
    }
    for (const [k, v] of Object.entries(meta)) insMeta.run(k, String(v))

    db.exec('COMMIT')

    const techRows = (db.query('SELECT COUNT(*) c FROM datatable_rows WHERE table_name = ?').get('TechUnlocksV2') as {
      c: number
    }).c
    const techSample = db
      .query('SELECT row_name FROM datatable_rows WHERE table_name = ? ORDER BY row_name LIMIT 1')
      .get('TechUnlocksV2') as { row_name: string } | null
    const starvation = db
      .query('SELECT text FROM loc_entries WHERE key = ? AND lang = ?')
      .get('mod.desc.starvation', 'Ru') as { text: string } | null

    return {
      meta: { ...meta, sidecar_log: sidecarLog },
      acceptance: {
        techUnlocksRows: techRows,
        techUnlocksSampleKey: techSample?.row_name ?? null,
        starvationRu: starvation?.text ?? null,
      },
    }
  } finally {
    db.close()
  }
}

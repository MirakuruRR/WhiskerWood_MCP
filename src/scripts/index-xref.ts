import { Database } from 'bun:sqlite'
import { dirname } from 'node:path'
import { ServerConfig } from '../config'
import { buildSidecar, SidecarError } from './index-gamedata'
import { normalizeDumpPath } from './parsers/path-forms'

export interface XrefInputs {
  pakPath: string
  usmapPath: string
  jsonlPath: string
  prefix?: string
}

export interface XrefSummary {
  meta: Record<string, string | number>
}

interface SidecarCall {
  kind: 'call'
  callerPath: string
  calleeName: string
  calleePath: string | null
  callKind: string
  count: number
}

interface SidecarBytecode {
  kind: 'bytecode'
  functionPath: string
  exprCount: number
  disasm: string
}

interface SidecarXrefSummary {
  kind: 'summary'
  scanned: number
  functionsScanned: number
  bytecodeLines: number
  edges: number
  failed: number
  failures: Array<{ file: string; error: string }>
}

type SidecarXrefLine = SidecarCall | SidecarBytecode | SidecarXrefSummary

function run(cmd: string[]): { code: number; stderr: string } {
  const proc = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' })
  return { code: proc.exitCode ?? -1, stderr: new TextDecoder().decode(proc.stderr) }
}

function runSidecarXref(exe: string, inputs: XrefInputs): string {
  const paksDir = dirname(inputs.pakPath)
  const cmd = [exe, 'xref', '--paks', paksDir, '--usmap', inputs.usmapPath, '--out', inputs.jsonlPath]
  if (inputs.prefix) cmd.push('--prefix', inputs.prefix)
  const res = run(cmd)
  if (res.code !== 0) {
    throw new SidecarError(`WwParse xref завершился с кодом ${res.code}:\n${res.stderr.trim()}`)
  }
  return res.stderr.trim()
}

export async function buildXrefIndex(dbPath: string, cfg: ServerConfig, inputs: XrefInputs): Promise<XrefSummary> {
  const exe = buildSidecar(cfg)
  const sidecarLog = runSidecarXref(exe, inputs)
  const text = await Bun.file(inputs.jsonlPath).text()
  const lines = text.split('\n').filter((l) => l.trim().length > 0)

  const meta: Record<string, string | number> = {}
  const db = new Database(dbPath, { readwrite: true, create: false })
  try {
    db.exec('BEGIN')
    db.exec('DELETE FROM calls')
    db.exec('DELETE FROM function_bytecode')

    const insCall = db.prepare(
      'INSERT OR REPLACE INTO calls (caller_path, callee_name, callee_path, kind, count) VALUES (?, ?, ?, ?, ?)',
    )
    const insBytecode = db.prepare(
      'INSERT OR REPLACE INTO function_bytecode (function_path, expr_count, disasm) VALUES (?, ?, ?)',
    )
    const insMeta = db.prepare('INSERT OR REPLACE INTO profile_meta (key, value) VALUES (?, ?)')

    let edges = 0
    let bytecodeFns = 0
    let summary: SidecarXrefSummary | null = null

    for (const line of lines) {
      const parsed = JSON.parse(line) as SidecarXrefLine
      if (parsed.kind === 'summary') {
        summary = parsed
        continue
      }
      if (parsed.kind === 'bytecode') {
        const functionPath = normalizeDumpPath(parsed.functionPath).indexPath
        insBytecode.run(functionPath, parsed.exprCount, parsed.disasm)
        bytecodeFns++
        continue
      }
      const callerPath = normalizeDumpPath(parsed.callerPath).indexPath
      const calleePath = parsed.calleePath ? normalizeDumpPath(parsed.calleePath).indexPath : null
      insCall.run(callerPath, parsed.calleeName, calleePath, parsed.callKind, parsed.count)
      edges++
    }

    meta.xref_built_at = new Date().toISOString()
    meta.xref_assets_scanned = summary?.scanned ?? 0
    meta.xref_functions_scanned = summary?.functionsScanned ?? bytecodeFns
    meta.xref_edges = edges
    meta.xref_failed_assets = summary?.failed ?? 0
    meta.xref_source = 'cue4parse-sidecar'
    if (summary && summary.failures.length > 0) {
      meta.xref_failures = summary.failures.map((f) => `${f.file}: ${f.error}`).join(' | ')
    }
    for (const [k, v] of Object.entries(meta)) insMeta.run(k, String(v))

    db.exec('COMMIT')

    return { meta: { ...meta, sidecar_log: sidecarLog } }
  } finally {
    db.close()
  }
}

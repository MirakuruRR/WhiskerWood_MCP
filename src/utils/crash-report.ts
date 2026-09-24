import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { ServerConfig } from '../config'
import { LogEntry, parseUe4ssLog, SESSION_MARKER } from './ue4ss-log'

export interface CrashSummary {
  name: string
  atMs: number
  at: string
  errorMessage: string
}

export interface CrashContextInfo {
  errorMessage: string
  kind: string
  exception: string
  address: string
  secondsSinceStart: string
  engineVersion: string
  build: string
}

export function crashesDir(config: ServerConfig): string {
  return `${dirname(config.saveDir)}/Crashes`
}

function unescapeXml(s: string): string {
  return s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

function tag(text: string, name: string): string {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)
  return m ? unescapeXml(m[1]).trim() : ''
}

export function parseCrashContext(path: string): CrashContextInfo | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const errorMessage = tag(text, 'ErrorMessage')
  const ensure = tag(text, 'IsEnsure') === 'true'
  const assert = tag(text, 'IsAssert') === 'true'
  const stall = tag(text, 'IsStall') === 'true'
  return {
    errorMessage,
    kind: ensure ? 'Ensure' : assert ? 'Assert' : stall ? 'Stall' : tag(text, 'CrashType') || 'Crash',
    exception:
      /EXCEPTION_[A-Z_]+/.exec(errorMessage)?.[0] ??
      (/^(Fatal error!|Assertion failed|Ensure condition failed)/.exec(errorMessage)?.[1] ?? ''),
    address: /address 0x([0-9a-fA-F]+)/.exec(errorMessage)?.[1] ?? '',
    secondsSinceStart: tag(text, 'SecondsSinceStart'),
    engineVersion: tag(text, 'EngineVersion'),
    build: `${tag(text, 'ExecutableName')} ${tag(text, 'BuildConfiguration')}`.trim(),
  }
}

export function listCrashes(config: ServerConfig): CrashSummary[] {
  let names: string[]
  try {
    names = readdirSync(crashesDir(config))
  } catch {
    return []
  }
  const out: CrashSummary[] = []
  for (const name of names) {
    const xml = `${crashesDir(config)}/${name}/CrashContext.runtime-xml`
    let atMs: number
    try {
      atMs = statSync(xml).mtimeMs
    } catch {
      continue
    }
    let errorMessage = ''
    try {
      errorMessage = tag(readFileSync(xml, 'utf8'), 'ErrorMessage')
    } catch {
      errorMessage = ''
    }
    out.push({ name, atMs, at: new Date(atMs).toISOString(), errorMessage })
  }
  return out.sort((a, b) => b.atMs - a.atMs)
}

// Метки времени UE4SS.log — локальные, сравнивать с mtime можно только так
export function tsLocalMs(ts: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(ts)
  if (!m) return Number.MAX_SAFE_INTEGER
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime()
}

export interface CrashLogTail {
  source: string
  entries: LogEntry[]
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

export function crashLogTail(config: ServerConfig, crashAtMs: number, limit: number): CrashLogTail {
  const cutoff = crashAtMs + 2000
  const cut = (entries: LogEntry[]): LogEntry[] => {
    const before = entries.filter((e) => tsLocalMs(e.ts) <= cutoff)
    let from = 0
    for (let i = before.length - 1; i >= 0; i--) {
      if (before[i].text.startsWith(SESSION_MARKER)) {
        from = i
        break
      }
    }
    return before.slice(from).slice(-limit)
  }

  const current = `${config.ue4ssDir}/UE4SS.log`
  if (existsSync(current)) {
    try {
      const entries = cut(parseUe4ssLog(current))
      if (entries.length > 0) return { source: current, entries }
    } catch {
      return { source: '', entries: [] }
    }
  }

  let best: { path: string; rotMs: number } | null = null
  const archiveDir = `${config.stateDir}/logs`
  for (const f of safeList(archiveDir)) {
    const m = /^UE4SS-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.log$/.exec(f)
    if (!m) continue
    const rotMs = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`)
    if (rotMs > crashAtMs && (!best || rotMs < best.rotMs)) best = { path: `${archiveDir}/${f}`, rotMs }
  }
  if (best) {
    try {
      const entries = cut(parseUe4ssLog(best.path))
      if (entries.length > 0) return { source: best.path, entries }
    } catch {
      return { source: '', entries: [] }
    }
  }
  return { source: '', entries: [] }
}

export interface GuardReport {
  name: string
  path: string
  id: string
  atMs: number
  at: string
}

export interface GuardVerdict {
  confidence: 'certain' | 'guess' | 'none'
  suspect: string
  header: Map<string, string>
}

export function guardDir(config: ServerConfig): string {
  return `${crashesDir(config)}/wwguard`
}

export function listGuardReports(config: ServerConfig): GuardReport[] {
  const dir = guardDir(config)
  const out: GuardReport[] = []
  for (const name of safeList(dir)) {
    const m = /^crash-([0-9a-f]+)-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.txt$/.exec(name)
    if (!m) continue
    const path = `${dir}/${name}`
    try {
      if (statSync(path).size === 0) continue
    } catch {
      continue
    }
    const atMs = Date.parse(`${m[2]}-${m[3]}-${m[4]}T${m[5]}:${m[6]}:${m[7]}Z`)
    out.push({ name, path, id: m[1], atMs, at: new Date(atMs).toISOString() })
  }
  return out.sort((a, b) => b.atMs - a.atMs)
}

export function parseGuardVerdict(text: string): GuardVerdict {
  const header = new Map<string, string>()
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (line.startsWith('----')) break
    const m = /^([A-Z][A-Za-z ]*?):\s+(.*)$/.exec(line)
    if (m) header.set(m[1], m[2].trim())
  }
  const culprit = header.get('Culprit')
  const likely = header.get('Likely')
  if (culprit && !/^(unknown|none)\b/i.test(culprit)) return { confidence: 'certain', suspect: culprit, header }
  if (likely) return { confidence: 'guess', suspect: likely, header }
  return { confidence: 'none', suspect: culprit ?? '', header }
}

// Timeline бывает на сотни строк повторяющихся ошибок — оставляем хвост
export function trimGuardTimeline(text: string, keep: number): string {
  const lines = text.replace(/\r/g, '').split('\n')
  const start = lines.findIndex((l) => l.startsWith('---- Timeline'))
  if (start < 0) return lines.join('\n')
  let end = lines.findIndex((l, i) => i > start && l.startsWith('----'))
  if (end < 0) end = lines.length
  while (end > start + 1 && lines[end - 1].trim() === '') end--
  const body = lines.slice(start + 1, end)
  if (body.length <= keep) return lines.join('\n')
  const kept = [`  ... ${body.length - keep} earlier line(s) omitted`, ...body.slice(-keep)]
  return [...lines.slice(0, start + 1), ...kept, ...lines.slice(end)].join('\n')
}

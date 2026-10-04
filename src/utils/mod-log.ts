import { closeSync, openSync, readSync, statSync } from 'node:fs'

export interface ModLogEntry {
  ts: string | null
  mod: string | null
  text: string
  loader: boolean
}

export interface ModLogRead {
  entries: ModLogEntry[]
  size: number
  offset: number
  clamped: boolean
}

export interface ModLogQuery {
  offset?: number
  since?: string
  mod?: string
  limit?: number
  loaderLimit?: number
}

export interface ModLogSelection {
  entries: ModLogEntry[]
  warnings: ModLogEntry[]
  total: number
  matched: number
  loaderTotal: number
  size: number
  offset: number
  clamped: boolean
  sinceResolved: string
  logMtime: string
}

export const LOADER_WARNINGS_LIMIT = 20

const TS_RE = /^\[(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2}):(\d{1,2})\]\s?(.*)$/
const MOD_RE = /^([A-Za-z0-9_.\-]{2,64}):\s(.*)$/
// строки загрузчика модов: он всегда ставит метку времени, моды — нет
const LOADER_RE = [
  /^Not loading mod\b/i,
  /^Loading mod\b/i,
  /^Ignoring (?:invalid )?pak file\b/i,
  /^Failed to mount pak file\b/i,
  /^Failed to (?:load|find|mount) mod\b/i,
  /^Every \.pak needs a matching \.uplugin\b/i,
  /^Corrupt(?:ed)? (?:pak index|index offset)/i,
  /mods must be made for engine\b/i,
  /\.uplugin file \(looked beside the pak\b/i,
]

function pad(v: string): string {
  return v.padStart(2, '0')
}

export function isLoaderLine(text: string): boolean {
  return LOADER_RE.some((re) => re.test(text))
}

function parseLine(line: string): ModLogEntry | null {
  const trimmed = line.replace(/\r$/, '')
  if (trimmed.trim().length === 0) return null
  const ts = TS_RE.exec(trimmed)
  const body = ts ? ts[7] : trimmed
  const stamp = ts ? `${ts[1]}-${pad(ts[2])}-${pad(ts[3])} ${pad(ts[4])}:${pad(ts[5])}:${pad(ts[6])}` : null
  const loader = isLoaderLine(body)
  const mod = loader ? null : MOD_RE.exec(body)
  return {
    ts: stamp,
    mod: mod ? mod[1] : null,
    text: mod ? mod[2] : body,
    loader,
  }
}

export function readModLog(path: string, offset = 0): ModLogRead {
  const size = statSync(path).size
  const from = Math.max(0, Math.min(offset, size))
  const entries: ModLogEntry[] = []
  if (size > from) {
    const start = from > 0 ? from - 1 : 0
    const buf = Buffer.alloc(size - start)
    const fd = openSync(path, 'r')
    try {
      readSync(fd, buf, 0, buf.length, start)
    } finally {
      closeSync(fd)
    }
    let text = buf.toString('utf8')
    if (from > 0) {
      const nl = text.indexOf('\n')
      text = nl >= 0 ? text.slice(nl + 1) : ''
    }
    for (const line of text.split('\n')) {
      const entry = parseLine(line)
      if (entry) entries.push(entry)
    }
  }
  return { entries, size, offset: from, clamped: from < offset }
}

export function selectModLog(path: string, q: ModLogQuery): ModLogSelection {
  const read = readModLog(path, q.offset ?? 0)
  const limit = q.limit ?? 100
  const since = q.since ?? 'session'

  let window = read.entries
  let sinceResolved: string
  if (since === 'session' || since === 'all') {
    sinceResolved = since === 'session' ? `session (с офсета ${read.offset})` : 'all'
  } else {
    const idx = window.findIndex((e) => e.ts !== null && e.ts >= since)
    window = idx >= 0 ? window.slice(idx) : []
    sinceResolved = `${since} (позиционно: строки мода без меток времени попадают по месту)`
  }

  const loaderLines = window.filter((e) => e.loader)
  const modNeedle = q.mod?.toLowerCase()
  const modLines = window.filter((e) => !e.loader && (!modNeedle || (e.mod ?? '').toLowerCase() === modNeedle))
  const warnings = modNeedle
    ? loaderLines.filter((e) => e.text.toLowerCase().includes(modNeedle))
    : loaderLines

  let mtime = ''
  try {
    mtime = new Date(statSync(path).mtimeMs).toISOString()
  } catch {
    mtime = 'unknown'
  }

  return {
    entries: modLines.slice(-limit),
    warnings: warnings.slice(-(q.loaderLimit ?? LOADER_WARNINGS_LIMIT)),
    total: window.length,
    matched: modLines.length,
    loaderTotal: loaderLines.length,
    size: read.size,
    offset: read.offset,
    clamped: read.clamped,
    sinceResolved,
    logMtime: mtime,
  }
}

export function formatModLogEntry(e: ModLogEntry): string {
  const head = e.ts ? `[${e.ts}] ` : ''
  return `${head}${e.mod ? `${e.mod}: ` : ''}${e.text}`
}

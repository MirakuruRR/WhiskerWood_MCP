import { readFileSync, statSync } from 'node:fs'

export type LogLevel = 'error' | 'warn' | 'info'

export interface LogEntry {
  ts: string
  level: LogLevel
  mod: string | null
  text: string
}

const HEAD_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\.\d+\]\s?(.*)$/
const LUA_RE = /^\[Lua\]\s*\[([^\]]+)\]\s?(.*)$/
const ERROR_RE = /^(ERROR|Error|error)\b|^\[Error\]|Lua Error|LuaError|error executing/
const WARN_RE = /^(WARNING|Warning|warning)\b|^\[Warning\]/
export const SESSION_MARKER = 'Console created'

function classify(text: string): LogLevel {
  if (ERROR_RE.test(text)) return 'error'
  if (WARN_RE.test(text)) return 'warn'
  return 'info'
}

export function parseUe4ssLog(path: string): LogEntry[] {
  const raw = readFileSync(path, 'utf8')
  const entries: LogEntry[] = []
  for (const line of raw.split(/\r?\n/)) {
    const head = HEAD_RE.exec(line)
    if (!head) {
      if (entries.length > 0 && line.trim().length > 0) {
        entries[entries.length - 1].text += `\n${line}`
      }
      continue
    }
    const body = head[2]
    const lua = LUA_RE.exec(body)
    const text = lua ? lua[2] : body
    entries.push({ ts: head[1], level: classify(text), mod: lua ? lua[1] : null, text })
  }
  return entries
}

export interface LogQuery {
  since?: string
  level?: LogLevel | 'all'
  mod?: string
  limit?: number
}

export interface LogSelection {
  entries: LogEntry[]
  totalEntries: number
  matched: number
  sinceResolved: string
  logMtime: string
}

export function selectLogEntries(path: string, q: LogQuery): LogSelection {
  const all = parseUe4ssLog(path)
  const limit = q.limit ?? 100

  let sinceTs = ''
  let sinceResolved = 'all'
  const since = q.since ?? 'session'
  if (since === 'session') {
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].text.startsWith(SESSION_MARKER)) {
        sinceTs = all[i].ts
        sinceResolved = `session_start ${sinceTs}`
        break
      }
    }
    if (!sinceTs) sinceResolved = 'all (метка старта сессии не найдена)'
  } else if (since !== 'all') {
    sinceTs = since
    sinceResolved = since
  }

  const level = q.level ?? 'all'
  const modNeedle = q.mod?.toLowerCase()

  const matched = all.filter((e) => {
    if (sinceTs && e.ts < sinceTs) return false
    if (level !== 'all' && e.level !== level) return false
    if (modNeedle && (e.mod ?? '').toLowerCase() !== modNeedle) return false
    return true
  })

  let mtime = ''
  try {
    mtime = new Date(statSync(path).mtimeMs).toISOString()
  } catch {
    mtime = 'unknown'
  }

  return {
    entries: matched.slice(-limit),
    totalEntries: all.length,
    matched: matched.length,
    sinceResolved,
    logMtime: mtime,
  }
}

export function lastError(path: string): LogEntry | null {
  let entries: LogEntry[]
  try {
    entries = parseUe4ssLog(path)
  } catch {
    return null
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].level === 'error') return entries[i]
  }
  return null
}

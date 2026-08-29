import { readFileSync, statSync } from 'node:fs'
import { ServerConfig } from '../config'

export interface LuaApiEntry {
  symbol: string
  category: string
  signature: string
  summary: string
  status: 'ok' | 'caution' | 'broken' | 'absent'
  verified: 'stand' | 'doc' | 'upstream'
  example?: string
  pitfalls?: string
}

export class LuaApiError extends Error {}

interface Cached {
  mtimeMs: number
  entries: LuaApiEntry[]
}

const cache = new Map<string, Cached>()

export function luaApiPath(config: ServerConfig): string {
  return `${config.configDir}/data/lua-api.yaml`
}

export function loadLuaApi(config: ServerConfig): LuaApiEntry[] {
  const path = luaApiPath(config)
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    throw new LuaApiError(`справочник Lua API не найден: ${path}`)
  }
  const hit = cache.get(path)
  if (hit && hit.mtimeMs === mtimeMs) return hit.entries

  let parsed: unknown
  try {
    parsed = Bun.YAML.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new LuaApiError(`${path}: не разбирается как YAML: ${(e as Error).message}`)
  }
  if (!Array.isArray(parsed)) throw new LuaApiError(`${path}: ожидается список записей`)

  const entries: LuaApiEntry[] = []
  for (const raw of parsed) {
    const e = raw as Partial<LuaApiEntry>
    if (!e || typeof e.symbol !== 'string' || typeof e.signature !== 'string' || typeof e.summary !== 'string') {
      throw new LuaApiError(`${path}: запись без symbol/signature/summary`)
    }
    entries.push({
      symbol: e.symbol,
      category: typeof e.category === 'string' ? e.category : 'other',
      signature: e.signature,
      summary: e.summary,
      status: (e.status ?? 'caution') as LuaApiEntry['status'],
      verified: (e.verified ?? 'upstream') as LuaApiEntry['verified'],
      example: typeof e.example === 'string' ? e.example.trimEnd() : undefined,
      pitfalls: typeof e.pitfalls === 'string' ? e.pitfalls.trimEnd() : undefined,
    })
  }
  cache.set(path, { mtimeMs, entries })
  return entries
}

export function findLuaApi(entries: LuaApiEntry[], symbol: string): LuaApiEntry[] {
  const needle = symbol.toLowerCase()
  const exact = entries.filter((e) => e.symbol.toLowerCase() === needle)
  if (exact.length > 0) return exact
  const tail = needle.split(/[.:]/).pop() ?? needle
  return entries.filter((e) => {
    const s = e.symbol.toLowerCase()
    return s.includes(needle) || s.split(/[.:]/).pop() === tail
  })
}

export function pitfallLines(entry: LuaApiEntry): string[] {
  if (!entry.pitfalls) return []
  return entry.pitfalls
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { ServerConfig } from '../config'
import { PathSandbox } from './path-sandbox'

export const MOD_MANIFEST = 'mod.json'
export const MOD_ENTRY = 'Scripts/main.lua'

export interface ModMeta {
  name: string
  template: string
  entry: string
  created_at: string
  game_version: string
  description?: string
  version?: string
}

export interface ModProject {
  root: string
  name: string
  entry: string
  meta: ModMeta | null
  luaFiles: string[]
}

function norm(p: string): string {
  return p.replace(/\\/g, '/')
}

export function modSandbox(config: ServerConfig): PathSandbox {
  return new PathSandbox(config.sandboxRoots)
}

export function resolveModRoot(config: ServerConfig, modRoot: string): string {
  return norm(modSandbox(config).validateAndResolve(modRoot, config.modsRepo))
}

export function readModMeta(root: string): ModMeta | null {
  const path = `${root}/${MOD_MANIFEST}`
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<ModMeta>
    if (typeof raw.name !== 'string') return null
    return {
      name: raw.name,
      template: typeof raw.template === 'string' ? raw.template : 'unknown',
      entry: typeof raw.entry === 'string' ? raw.entry : MOD_ENTRY,
      created_at: typeof raw.created_at === 'string' ? raw.created_at : 'unknown',
      game_version: typeof raw.game_version === 'string' ? raw.game_version : 'unknown',
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      ...(typeof raw.version === 'string' ? { version: raw.version } : {}),
    }
  } catch {
    return null
  }
}

export function listLuaFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (name === '.git' || name === 'node_modules') continue
      const full = `${dir}/${name}`
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(full, depth + 1)
      else if (name.endsWith('.lua')) out.push(norm(full))
    }
  }
  walk(root, 0)
  return out.sort()
}

export function loadModProject(config: ServerConfig, modRoot: string): ModProject {
  const root = resolveModRoot(config, modRoot)
  const meta = readModMeta(root)
  const entryRel = meta?.entry ?? MOD_ENTRY
  return {
    root,
    name: meta?.name ?? basename(root),
    entry: `${root}/${entryRel}`,
    meta,
    luaFiles: listLuaFiles(root),
  }
}

/** Соседние моды монорепо: нужны для детекта коллизий хуков. */
export function listSiblingMods(config: ServerConfig, exceptRoot: string): ModProject[] {
  const modsDir = `${config.modsRepo}/mods`
  let names: string[]
  try {
    names = readdirSync(modsDir)
  } catch {
    return []
  }
  const out: ModProject[] = []
  for (const name of names) {
    const root = norm(`${modsDir}/${name}`)
    if (root.toLowerCase() === exceptRoot.toLowerCase()) continue
    try {
      if (!statSync(root).isDirectory()) continue
    } catch {
      continue
    }
    const meta = readModMeta(root)
    out.push({
      root,
      name: meta?.name ?? name,
      entry: `${root}/${meta?.entry ?? MOD_ENTRY}`,
      meta,
      luaFiles: listLuaFiles(root),
    })
  }
  return out
}

export function relativeTo(root: string, file: string): string {
  const r = norm(root)
  const f = norm(file)
  return f.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? f.slice(r.length + 1) : f
}

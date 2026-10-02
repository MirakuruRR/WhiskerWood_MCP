import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { ServerConfig } from '../config'
import { listLuaFiles, MOD_ENTRY, ModProject, readModMeta } from './mod-project'

// Mods/shared — это lib/ репозитория; при отказе junction там лежит копия, а не мод
const SHARED_LIBS = 'shared'

export interface LoadSlot {
  index: number
  enabled: boolean
  name: string
}

export interface InstalledMod extends ModProject {
  dirName: string
}

function norm(p: string): string {
  return p.replace(/\\/g, '/')
}

function realKey(p: string): string {
  try {
    return norm(realpathSync(p)).toLowerCase()
  } catch {
    return norm(p).toLowerCase()
  }
}

export function modsTxtPath(config: ServerConfig): string {
  return `${config.ue4ssDir}/Mods/mods.txt`
}

/** Имя .usmap содержит версию движка, после апгрейда рядом лежит и старый — берём свежий. */
export function newestUsmap(ue4ssDir: string): { name: string; mtimeMs: number } | null {
  let files: string[]
  try {
    files = readdirSync(ue4ssDir)
  } catch {
    return null
  }
  let best: { name: string; mtimeMs: number } | null = null
  for (const name of files) {
    if (!name.endsWith('.usmap')) continue
    const mtimeMs = statSync(`${ue4ssDir}/${name}`).mtimeMs
    if (!best || mtimeMs > best.mtimeMs) best = { name, mtimeMs }
  }
  return best
}

/** Порядок загрузки UE4SS = порядок строк в mods.txt; отсутствие строки означает, что мод не грузится. */
export function readLoadOrder(config: ServerConfig): Map<string, LoadSlot> {
  const out = new Map<string, LoadSlot>()
  const file = modsTxtPath(config)
  if (!existsSync(file)) return out
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return out
  }
  let index = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith(';')) continue
    const at = line.indexOf(':')
    if (at < 0) continue
    const name = line.slice(0, at).trim()
    if (name.length === 0) continue
    out.set(name.toLowerCase(), { index: index++, enabled: /^1\b/.test(line.slice(at + 1).trim()), name })
  }
  return out
}

export function loadSlot(order: Map<string, LoadSlot>, modName: string): LoadSlot | null {
  return order.get(modName.toLowerCase()) ?? null
}

/**
 * Моды, установленные в ue4ss/Mods, кроме своего репозитория: junction-и на modsRepo
 * и Mods/shared указывают на уже просканированные исходники и дали бы ложные коллизии.
 */
export function listInstalledMods(config: ServerConfig, exceptRoots: string[]): InstalledMod[] {
  const modsDir = `${config.ue4ssDir}/Mods`
  let names: string[]
  try {
    names = readdirSync(modsDir)
  } catch {
    return []
  }

  const repo = realKey(config.modsRepo)
  const skip = new Set(exceptRoots.map(realKey))
  const out: InstalledMod[] = []

  for (const dirName of names) {
    if (dirName === SHARED_LIBS) continue
    const root = norm(`${modsDir}/${dirName}`)
    try {
      if (!statSync(root).isDirectory()) continue
    } catch {
      continue
    }
    const key = realKey(root)
    if (key === repo || key.startsWith(`${repo}/`) || skip.has(key)) continue

    const luaFiles = listLuaFiles(root)
    if (luaFiles.length === 0) continue
    const meta = readModMeta(root)
    out.push({
      dirName,
      root,
      name: meta?.name ?? dirName,
      entry: `${root}/${meta?.entry ?? MOD_ENTRY}`,
      meta,
      luaFiles,
    })
  }
  return out
}

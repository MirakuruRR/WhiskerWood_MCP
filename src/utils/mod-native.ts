import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { MOD_DLL, MOD_ENTRY, NATIVE_DIR } from './mod-project'
import { parsePe, PeError } from './pe'

export const DLL_DIR = 'dlls'
const STALE_SUFFIX = '.ww-old'
export const BUILD_JUNK = /\.(pdb|ilk|exp|lib|obj|iobj|ipdb|ww-old)$/i
const NATIVE_SKIP = new Set(['build', 'out', '.vs', 'cmake-build-debug', 'cmake-build-release'])

export interface ModParts {
  lua: boolean
  dll: boolean
  native: boolean
}

export function modParts(root: string, entryRel: string = MOD_ENTRY): ModParts {
  return {
    lua: existsSync(`${root}/${entryRel}`),
    dll: existsSync(`${root}/${MOD_DLL}`),
    native: existsSync(`${root}/${NATIVE_DIR}`),
  }
}

export function partsLabel(p: ModParts): string {
  if (p.lua && p.dll) return 'lua+dll'
  if (p.dll) return 'dll'
  if (p.lua) return 'lua'
  return 'нет'
}

export function gameModDir(ue4ssDir: string, name: string): string {
  return `${ue4ssDir}/Mods/${name}`
}

export function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

export interface DllInfo {
  size: number
  sha: string
  mtimeMs: number
  machine: string
}

const MACHINES: Record<number, string> = { 0x8664: 'x64', 0x14c: 'x86', 0xaa64: 'arm64' }

export function sha16(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 16)
}

export function inspectDll(path: string): DllInfo | null {
  let data: Buffer
  try {
    data = readFileSync(path)
  } catch {
    return null
  }
  let machine = 'не PE'
  if (data.length > 0x40 && data.readUInt16LE(0) === 0x5a4d) {
    const pe = data.readUInt32LE(0x3c)
    if (pe + 6 <= data.length && data.readUInt32LE(pe) === 0x4550) {
      const m = data.readUInt16LE(pe + 4)
      machine = MACHINES[m] ?? `0x${m.toString(16)}`
    }
  }
  return { size: data.length, sha: sha16(data), mtimeMs: statSync(path).mtimeMs, machine }
}

export function describeDll(info: DllInfo): string {
  return `${Math.round(info.size / 1024)} КБ sha256:${info.sha} ${info.machine}`
}

export function nativeNewestMtime(root: string): number {
  let newest = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const full = `${dir}/${name}`
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (!NATIVE_SKIP.has(name.toLowerCase())) walk(full, depth + 1)
      } else if (st.mtimeMs > newest) newest = st.mtimeMs
    }
  }
  walk(`${root}/${NATIVE_DIR}`, 0)
  return newest
}

export function listDllDir(root: string): string[] {
  try {
    return readdirSync(`${root}/${DLL_DIR}`, { withFileTypes: true })
      .filter((e) => e.isFile() && !BUILD_JUNK.test(e.name))
      .map((e) => `${DLL_DIR}/${e.name}`)
      .sort()
  } catch {
    return []
  }
}

export type PlaceResult = 'unchanged' | 'installed' | 'replaced' | 'swapped'

export class FileLockedError extends Error {
  constructor(public readonly path: string) {
    super(`${path}: файл занят и не переименовывается`)
  }
}

function staleName(path: string): string {
  return `${path}.${Date.now()}${STALE_SUFFIX}`
}

// загруженную DLL Windows не даёт удалить или перезаписать, но переименовать даёт
function setAside(path: string): 'removed' | 'swapped' {
  try {
    unlinkSync(path)
    return 'removed'
  } catch {
    try {
      renameSync(path, staleName(path))
      return 'swapped'
    } catch {
      throw new FileLockedError(path)
    }
  }
}

export function placeFile(data: Buffer, dst: string): PlaceResult {
  mkdirSync(dirname(dst), { recursive: true })
  if (!existsSync(dst)) {
    writeFileSync(dst, data)
    return 'installed'
  }
  let same = false
  try {
    same = readFileSync(dst).equals(data)
  } catch {}
  if (same) return 'unchanged'
  const how = setAside(dst)
  writeFileSync(dst, data)
  return how === 'swapped' ? 'swapped' : 'replaced'
}

export function removeFile(path: string): 'removed' | 'swapped' {
  return setAside(path)
}

export function isStale(path: string): boolean {
  return path.endsWith(STALE_SUFFIX)
}

export function purgeStale(dir: string): void {
  const walk = (d: string, depth: number): void => {
    if (depth > 8) return
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = `${d}/${e.name}`
      if (e.isDirectory()) walk(full, depth + 1)
      else if (isStale(e.name)) {
        try {
          unlinkSync(full)
        } catch {}
      }
    }
  }
  walk(dir, 0)
}

export function ue4ssDllPath(ue4ssDir: string): string | null {
  for (const p of [`${ue4ssDir}/UE4SS.dll`, `${dirname(ue4ssDir)}/UE4SS.dll`]) if (existsSync(p)) return p
  return null
}

let exportCache: { key: string; names: Set<string> } | null = null

export function ue4ssExports(path: string): Set<string> {
  const st = statSync(path)
  const key = `${path}|${st.size}|${st.mtimeMs}`
  if (exportCache?.key !== key) exportCache = { key, names: new Set(parsePe(readFileSync(path)).exports) }
  return exportCache.names
}

export interface Ue4ssLink {
  ue4ss: string
  imported: number
  missing: string[]
}

// UE4SS грузит C++-мод через LoadLibrary: хоть один неразрешённый импорт — и мод молча не стартует
export function checkUe4ssImports(dllPath: string, ue4ssDir: string): Ue4ssLink | null {
  const ue4ss = ue4ssDllPath(ue4ssDir)
  if (!ue4ss) return null
  let wanted: string[]
  try {
    wanted = parsePe(readFileSync(dllPath)).imports.get('ue4ss.dll') ?? []
  } catch (e) {
    if (e instanceof PeError) return null
    throw e
  }
  const have = ue4ssExports(ue4ss)
  return { ue4ss, imported: wanted.length, missing: wanted.filter((n) => !have.has(n)) }
}

export function readableSymbol(mangled: string): string {
  const m = /^\?(\?[01])?([^@?]+)@(.*?)@@/.exec(mangled)
  if (!m) return mangled
  const scope = m[3].split('@').filter(Boolean).reverse()
  const name = m[1] === '?0' ? m[2] : m[1] === '?1' ? `~${m[2]}` : m[2]
  return [...scope, ...(m[1] ? [m[2]] : []), name].join('::')
}

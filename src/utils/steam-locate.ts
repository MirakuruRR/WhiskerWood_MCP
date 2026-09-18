import { existsSync, readFileSync, readdirSync } from 'node:fs'

export const WHISKERWOOD_APP_ID = '2489330'

export interface SteamGame {
  appId: string
  name: string
  gameDir: string
  library: string
}

function norm(p: string): string {
  return p.replace(/\\\\/g, '/').replace(/\\/g, '/').replace(/\/+$/, '')
}

function steamRoot(): string | null {
  for (const key of ['HKCU\\Software\\Valve\\Steam', 'HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam']) {
    const value = key.startsWith('HKCU') ? 'SteamPath' : 'InstallPath'
    const proc = Bun.spawnSync(['reg', 'query', key, '/v', value], { stdout: 'pipe', stderr: 'pipe' })
    if (proc.exitCode !== 0) continue
    const out = new TextDecoder().decode(proc.stdout)
    const m = new RegExp(`${value}\\s+REG_SZ\\s+(.+)`).exec(out)
    if (m) {
      const path = norm(m[1].trim())
      if (existsSync(path)) return path
    }
  }
  for (const guess of ['C:/Program Files (x86)/Steam', 'C:/Steam']) {
    if (existsSync(guess)) return guess
  }
  return null
}

// libraryfolders.vdf — не JSON: пары "ключ" "значение" и вложенные блоки в фигурных скобках
function libraryPaths(root: string): string[] {
  const out = [root]
  for (const vdf of [`${root}/steamapps/libraryfolders.vdf`, `${root}/config/libraryfolders.vdf`]) {
    if (!existsSync(vdf)) continue
    const text = readFileSync(vdf, 'utf8')
    for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) {
      const p = norm(m[1])
      if (!out.includes(p)) out.push(p)
    }
  }
  return out.filter((p) => existsSync(`${p}/steamapps`))
}

function readManifest(path: string): { appId: string; name: string; installDir: string } | null {
  try {
    const text = readFileSync(path, 'utf8')
    const pick = (key: string) => new RegExp(`"${key}"\\s+"([^"]*)"`).exec(text)?.[1]
    const appId = pick('appid')
    const name = pick('name')
    const installDir = pick('installdir')
    if (!appId || !installDir) return null
    return { appId, name: name ?? installDir, installDir }
  } catch {
    return null
  }
}

export function findSteamGame(appId = WHISKERWOOD_APP_ID): SteamGame | null {
  const root = steamRoot()
  if (!root) return null
  for (const lib of libraryPaths(root)) {
    const manifest = `${lib}/steamapps/appmanifest_${appId}.acf`
    if (!existsSync(manifest)) continue
    const parsed = readManifest(manifest)
    if (!parsed) continue
    const gameDir = `${lib}/steamapps/common/${parsed.installDir}`
    if (!existsSync(gameDir)) continue
    return { appId, name: parsed.name, gameDir, library: lib }
  }
  return null
}

// запасной путь для не-Steam копий: ищем exe по характерному имени каталога
export function findGameByName(roots: string[], folder = 'Whiskerwood'): string | null {
  for (const root of roots) {
    const candidate = `${root}/${folder}`
    if (existsSync(`${candidate}/${folder}/Binaries/Win64`)) return norm(candidate)
    try {
      for (const e of readdirSync(root, { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        const p = `${root}/${e.name}/${folder}/Binaries/Win64`
        if (existsSync(p)) return norm(`${root}/${e.name}`)
      }
    } catch {}
  }
  return null
}

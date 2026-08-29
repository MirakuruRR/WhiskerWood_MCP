import { existsSync, mkdirSync, realpathSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

export interface ServerConfig {
  gameDir: string
  exePath: string
  pakPath: string
  ue4ssDir: string
  stateDir: string
  distDir: string
  dumpsDir: string
  modsRepo: string
  sandboxRoots: string[]
  extractRoot: string
  defaultLangs: string[]
  bridgePollMs: number
  bridgeTimeoutMs: number
  configDir: string
}

const TEMPLATE = `{
  "gameDir":   "D:/Steam/steamapps/common/Whiskerwood",
  "exePath":   "{gameDir}/Whiskerwood/Binaries/Win64/Whiskerwood-Win64-Shipping.exe",
  "pakPath":   "{gameDir}/Whiskerwood/Content/Paks/Whiskerwood-Windows.pak",
  "ue4ssDir":  "{gameDir}/Whiskerwood/Binaries/Win64/ue4ss",
  "stateDir":  "./state",
  "distDir":   "./dist/games",
  "dumpsDir":  "./dumps",
  "modsRepo":  "D:/Whiskerwood_IO/WhiskerWood_Mods",
  "sandboxRoots": ["{modsRepo}", "{stateDir}", "{distDir}"],
  "extractRoot":  "{stateDir}/extracted",
  "defaultLangs": ["En", "Ru"],
  "bridgePollMs": 120,
  "bridgeTimeoutMs": 5000
}`

export class ConfigError extends Error {}

function norm(p: string): string {
  return p.replace(/\\/g, '/')
}

export function findConfigPath(): string {
  const fromEnv = process.env.WWMCP_CONFIG
  if (fromEnv) {
    const p = resolve(fromEnv)
    if (!existsSync(p)) throw new ConfigError(`WWMCP_CONFIG указывает на несуществующий файл: ${p}`)
    return p
  }
  const local = resolve('wwmcp.config.json')
  if (existsSync(local)) return local
  throw new ConfigError(
    'Конфигурация не найдена. Создайте wwmcp.config.json (или задайте WWMCP_CONFIG). Шаблон:\n' + TEMPLATE,
  )
}

export function loadConfig(): ServerConfig {
  const configPath = findConfigPath()
  const configDir = dirname(configPath)
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (e) {
    throw new ConfigError(`Не удалось прочитать ${configPath}: ${(e as Error).message}`)
  }

  const str = (key: string): string => {
    const v = raw[key]
    if (typeof v !== 'string' || v.length === 0) throw new ConfigError(`В конфиге отсутствует ключ "${key}" (строка)`)
    return v
  }

  const gameDir = norm(isAbsolute(str('gameDir')) ? str('gameDir') : resolve(configDir, str('gameDir')))
  const expand = (value: string): string => {
    let out = value
      .replaceAll('{gameDir}', gameDir)
      .replaceAll('{modsRepo}', modsRepoRaw)
      .replaceAll('{stateDir}', stateDirRaw)
      .replaceAll('{distDir}', distDirRaw)
    out = norm(isAbsolute(out) ? out : resolve(configDir, out))
    return out
  }

  const fixRel = (value: string): string => norm(isAbsolute(value) ? value : resolve(configDir, value))

  const stateDirRaw = fixRel(str('stateDir'))
  const distDirRaw = fixRel(str('distDir'))
  const modsRepoRaw = fixRel(str('modsRepo'))

  const exePath = expand(str('exePath'))
  const pakPath = expand(str('pakPath'))
  const ue4ssDir = expand(str('ue4ssDir'))
  const dumpsDir = fixRel(str('dumpsDir'))
  const extractRoot = expand(str('extractRoot'))

  const rootsRaw = raw.sandboxRoots
  const sandboxRoots = (Array.isArray(rootsRaw) && rootsRaw.length > 0 ? (rootsRaw as string[]) : []).map((r) =>
    expand(String(r)),
  )
  if (sandboxRoots.length === 0) {
    sandboxRoots.push(modsRepoRaw, stateDirRaw, distDirRaw)
  }

  const langsRaw = raw.defaultLangs
  const defaultLangs = Array.isArray(langsRaw) && langsRaw.length > 0 ? langsRaw.map(String) : ['En', 'Ru']

  return {
    gameDir,
    exePath,
    pakPath,
    ue4ssDir,
    stateDir: stateDirRaw,
    distDir: distDirRaw,
    dumpsDir,
    modsRepo: modsRepoRaw,
    sandboxRoots,
    extractRoot,
    defaultLangs,
    bridgePollMs: typeof raw.bridgePollMs === 'number' ? raw.bridgePollMs : 120,
    bridgeTimeoutMs: typeof raw.bridgeTimeoutMs === 'number' ? raw.bridgeTimeoutMs : 5000,
    configDir: norm(configDir),
  }
}

export function validateConfig(cfg: ServerConfig): string[] {
  const problems: string[] = []
  const dir = (key: string, p: string) => {
    if (!existsSync(p)) problems.push(`${key}: каталог не существует: ${p}`)
    else if (!statSync(p).isDirectory()) problems.push(`${key}: не каталог: ${p}`)
  }
  const file = (key: string, p: string) => {
    if (!existsSync(p)) problems.push(`${key}: файл не существует: ${p}`)
    else if (!statSync(p).isFile()) problems.push(`${key}: не файл: ${p}`)
  }

  dir('gameDir', cfg.gameDir)
  file('exePath', cfg.exePath)
  file('pakPath', cfg.pakPath)
  dir('ue4ssDir', cfg.ue4ssDir)
  file('ue4ssDir/UE4SS.log', `${cfg.ue4ssDir}/UE4SS.log`)
  dir('dumpsDir', cfg.dumpsDir)
  dir('modsRepo', cfg.modsRepo)

  for (const p of [cfg.stateDir, cfg.distDir, cfg.extractRoot]) {
    try {
      mkdirSync(p, { recursive: true })
    } catch {
      problems.push(`не удалось создать каталог: ${p}`)
    }
  }
  dir('stateDir', cfg.stateDir)
  dir('distDir', cfg.distDir)
  dir('extractRoot', cfg.extractRoot)

  cfg.sandboxRoots = cfg.sandboxRoots.map((r) => {
    try {
      return norm(realpathSync(r))
    } catch {
      problems.push(`sandboxRoots: не удалось резолвить realpath: ${r}`)
      return r
    }
  })

  return problems
}

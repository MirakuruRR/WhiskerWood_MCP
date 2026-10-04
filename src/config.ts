import { existsSync, mkdirSync, readdirSync, realpathSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

export const TOOLSETS = ['recon', 'live', 'lua', 'memory', 'loom'] as const
export type Toolset = (typeof TOOLSETS)[number]

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
  saveDir: string
  savedDir: string
  liftDir: string
  jobsDir: string
  kitDir: string | null
  engineDir: string | null
  toolsets: Toolset[]
  steamAppId: string
  defaultLangs: string[]
  bridgePollMs: number
  bridgeTimeoutMs: number
  configDir: string
}

const TEMPLATE = `{
  "gameDir":   "C:/Program Files (x86)/Steam/steamapps/common/Whiskerwood",
  "exePath":   "{gameDir}/Whiskerwood/Binaries/Win64/Whiskerwood-Win64-Shipping.exe",
  "pakPath":   "{gameDir}/Whiskerwood/Content/Paks/Whiskerwood-Windows.pak",
  "ue4ssDir":  "{gameDir}/Whiskerwood/Binaries/Win64/ue4ss",
  "stateDir":  "./state",
  "distDir":   "./dist/games",
  "dumpsDir":  "./dumps",
  "modsRepo":  "../WhiskerWood_Mods",
  "sandboxRoots": ["{modsRepo}", "{stateDir}", "{distDir}"],
  "extractRoot":  "{stateDir}/extracted",
  "saveDir":      "%LOCALAPPDATA%/Whiskerwood/Saved/saves_player",
  "kitDir":       "",
  "engineDir":    "",
  "toolsets":     ["recon", "live", "lua", "memory", "loom"],
  "steamAppId":   "",
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
      .replaceAll('%LOCALAPPDATA%', norm(process.env.LOCALAPPDATA ?? ''))
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

  const saveDirRaw = raw.saveDir
  const saveDir =
    typeof saveDirRaw === 'string' && saveDirRaw.length > 0
      ? expand(saveDirRaw)
      : norm(`${process.env.LOCALAPPDATA ?? ''}/${basename(gameDir)}/Saved/saves_player`)
  const savedDir = norm(`${dirname(saveDir)}`)
  const steamAppId = typeof raw.steamAppId === 'string' ? raw.steamAppId.trim() : ''

  const optPath = (key: string): string | null => {
    const v = raw[key]
    if (typeof v !== 'string' || v.trim().length === 0) return null
    return expand(v)
  }
  const kitDir = optPath('kitDir')
  const engineDir = optPath('engineDir')

  const toolsetsRaw = raw.toolsets
  const toolsets: Toolset[] = Array.isArray(toolsetsRaw)
    ? (toolsetsRaw.map(String).filter((t) => (TOOLSETS as readonly string[]).includes(t)) as Toolset[])
    : [...TOOLSETS]

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
    saveDir,
    savedDir,
    liftDir: norm(`${stateDirRaw}/lift`),
    jobsDir: norm(`${stateDirRaw}/jobs`),
    kitDir,
    engineDir,
    toolsets,
    steamAppId,
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

  // dumpsDir и modsRepo заводятся сами: на свежей установке дампов ещё нет,
  // а репозиторий модов может быть и просто пустым каталогом
  for (const p of [cfg.stateDir, cfg.distDir, cfg.extractRoot, cfg.dumpsDir, cfg.modsRepo, cfg.liftDir, cfg.jobsDir]) {
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

// не ошибки конфига, а состояние стенда: лог появляется только после первого
// запуска игры с UE4SS, и валить на этом setup новичку бессмысленно
export function configWarnings(cfg: ServerConfig): string[] {
  const warnings: string[] = []
  if (!existsSync(`${cfg.ue4ssDir}/UE4SS.log`)) {
    warnings.push(`нет ${cfg.ue4ssDir}/UE4SS.log — игра ещё ни разу не запускалась с UE4SS`)
  }
  if (!existsSync(`${cfg.ue4ssDir}/UE4SS.dll`) && !existsSync(`${cfg.ue4ssDir}/../dwmapi.dll`)) {
    warnings.push(`в ${cfg.ue4ssDir} не видно UE4SS.dll, а рядом с exe — dwmapi.dll: UE4SS, похоже, не установлен`)
  }
  if (cfg.kitDir && !existsSync(cfg.kitDir)) warnings.push(`kitDir: каталог не существует: ${cfg.kitDir}`)
  else if (cfg.kitDir && !existsSync(`${cfg.kitDir}/${basename(cfg.kitDir)}.uproject`)) {
    const found = readdirSync(cfg.kitDir).filter((f) => f.endsWith('.uproject'))
    if (found.length === 0) warnings.push(`kitDir: в ${cfg.kitDir} нет .uproject — это не мод-кит`)
  }
  if (cfg.engineDir && !existsSync(cfg.engineDir)) warnings.push(`engineDir: каталог не существует: ${cfg.engineDir}`)
  return warnings
}

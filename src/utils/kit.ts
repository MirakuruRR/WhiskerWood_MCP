import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { ServerConfig } from '../config'
import { PathSandbox, PathSandboxError } from './path-sandbox'

export type EngineSource = 'config' | 'registry'

export interface KitPaths {
  kitDir: string
  uproject: string
  projectName: string
  engineDir: string | null
  engineRoot: string | null
  engineSource: EngineSource | null
  engineAssociation: string | null
  loomExe: string
  loomMcp: string
  typesJson: string
  reportJson: string
  opsDir: string
  editorLog: string
  gameInstallTxt: string
  contentMods: string
  pakOutputDir: string
}

export interface KitStatus {
  configured: boolean
  problem: string | null
  kit: KitPaths | null
  missing: string[]
}

function norm(p: string): string {
  return p.replace(/\\/g, '/')
}

export function savedModsDir(config: ServerConfig): string {
  return `${config.savedDir}/mods`
}

export function modlogPath(config: ServerConfig): string {
  return `${config.savedDir}/Logs/modlog.txt`
}

export function readUproject(kitDir: string): { path: string; json: Record<string, unknown> } | null {
  let files: string[]
  try {
    files = readdirSync(kitDir).filter((f) => f.endsWith('.uproject'))
  } catch {
    return null
  }
  const preferred = `${basename(kitDir)}.uproject`
  const name = files.includes(preferred) ? preferred : files[0]
  if (!name) return null
  const path = `${kitDir}/${name}`
  try {
    return { path, json: JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown> }
  } catch {
    return { path, json: {} }
  }
}

/** GUID из EngineAssociation -> корень сборки движка (значение в реестре Epic Games Builds). */
export function findEngineRootByGuid(guid: string): { root: string; source: EngineSource } | null {
  if (process.platform !== 'win32' || guid.length === 0) return null
  try {
    const p = Bun.spawnSync(['reg', 'query', 'HKCU\\Software\\Epic Games\\Unreal Engine\\Builds', '/v', guid], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = new TextDecoder().decode(p.stdout)
    const m = /REG_SZ\s+(.+)$/m.exec(out)
    if (!m) return null
    const root = norm(m[1].trim())
    return existsSync(root) ? { root, source: 'registry' } : null
  } catch {
    return null
  }
}

let cachedKit: { key: string; value: KitStatus } | null = null

export function kitStatus(config: ServerConfig): KitStatus {
  const key = `${config.kitDir ?? ''}|${config.engineDir ?? ''}`
  if (cachedKit && cachedKit.key === key) return cachedKit.value

  const value = computeKitStatus(config)
  cachedKit = { key, value }
  return value
}

function computeKitStatus(config: ServerConfig): KitStatus {
  if (!config.kitDir) {
    return { configured: false, problem: 'kitDir не задан в конфиге', kit: null, missing: [] }
  }
  const kitDir = norm(config.kitDir)
  if (!existsSync(kitDir)) {
    return { configured: false, problem: `каталог кита не существует: ${kitDir}`, kit: null, missing: [] }
  }
  const uproject = readUproject(kitDir)
  if (!uproject) {
    return { configured: false, problem: `в ${kitDir} нет .uproject — это не мод-кит`, kit: null, missing: [] }
  }

  const association = typeof uproject.json.EngineAssociation === 'string' ? (uproject.json.EngineAssociation as string) : null
  let engineRoot: string | null = null
  let engineSource: EngineSource | null = null
  if (config.engineDir) {
    engineRoot = norm(config.engineDir).replace(/\/Engine$/, '')
    engineSource = 'config'
  } else if (association) {
    const found = findEngineRootByGuid(association)
    if (found) {
      engineRoot = found.root
      engineSource = found.source
    }
  }
  const engineDir = engineRoot ? (existsSync(`${engineRoot}/Engine`) ? `${engineRoot}/Engine` : engineRoot) : null

  const loomBin = `${kitDir}/Plugins/LoomEditor/Binaries/ThirdParty/Loom/Win64`
  const intermediate = `${kitDir}/Intermediate/Loom`
  const kit: KitPaths = {
    kitDir,
    uproject: norm(uproject.path),
    projectName: basename(uproject.path).replace(/\.uproject$/i, ''),
    engineDir: engineDir ? norm(engineDir) : null,
    engineRoot,
    engineSource,
    engineAssociation: association,
    loomExe: `${loomBin}/loom.exe`,
    loomMcp: `${loomBin}/loom-mcp.exe`,
    typesJson: `${intermediate}/types.json`,
    reportJson: `${intermediate}/report.json`,
    opsDir: `${intermediate}/ops`,
    editorLog: `${kitDir}/Saved/Logs/Whiskerwood.log`,
    gameInstallTxt: `${kitDir}/GameInstallDirectory.txt`,
    contentMods: `${kitDir}/Content/Mods`,
    pakOutputDir: `${kitDir}/Windows/${basename(uproject.path).replace(/\.uproject$/i, '')}/Content/Paks`,
  }

  const missing: string[] = []
  if (!existsSync(kit.loomExe)) missing.push('loom.exe')
  if (!existsSync(kit.typesJson)) missing.push('types.json')
  if (!engineDir) missing.push('движок (EngineAssociation/engineDir)')
  else {
    if (!existsSync(unrealEditorCmd(kit)!)) missing.push('UnrealEditor-Cmd.exe')
    if (!existsSync(unrealPakExe(kit)!)) missing.push('UnrealPak.exe')
    if (!existsSync(runUatBat(kit)!)) missing.push('RunUAT.bat')
  }

  return { configured: true, problem: null, kit, missing }
}

export function requireKit(config: ServerConfig): KitPaths {
  const st = kitStatus(config)
  if (!st.configured || !st.kit) {
    throw new KitNotConfigured(st.problem ?? 'кит не настроен', st.problem ?? '')
  }
  return st.kit
}

export class KitNotConfigured extends Error {
  readonly hint: string
  constructor(message: string, hint: string) {
    super(message)
    this.hint = hint
  }
}

export function unrealEditorCmd(kit: KitPaths): string | null {
  return kit.engineDir ? `${kit.engineDir}/Binaries/Win64/UnrealEditor-Cmd.exe` : null
}

export function unrealPakExe(kit: KitPaths): string | null {
  return kit.engineDir ? `${kit.engineDir}/Binaries/Win64/UnrealPak.exe` : null
}

export function runUatBat(kit: KitPaths): string | null {
  return kit.engineDir ? `${kit.engineDir}/Build/BatchFiles/RunUAT.bat` : null
}

export const NEW_MOD_SCRIPT = norm(resolve(import.meta.dir, '../../data/loom/new_mod.py'))

const DEFAULT_ENGINE_VERSION = '5.8'

/** Major.Minor из Build.version движка кита: это EngineVersion в .uplugin мода. */
export function kitEngineVersion(kit: KitPaths): string {
  if (kit.engineDir) {
    try {
      const v = JSON.parse(readFileSync(`${kit.engineDir}/Build/Build.version`, 'utf8').trimStart()) as {
        MajorVersion?: number
        MinorVersion?: number
      }
      if (typeof v.MajorVersion === 'number' && typeof v.MinorVersion === 'number') {
        return `${v.MajorVersion}.${v.MinorVersion}`
      }
    } catch {}
  }
  return DEFAULT_ENGINE_VERSION
}

export function editorPluginPaths(kit: KitPaths): { python: string; scripting: string } | null {
  if (!kit.engineDir) return null
  return {
    python: `${kit.engineDir}/Plugins/Experimental/PythonScriptPlugin/PythonScriptPlugin.uplugin`,
    scripting: `${kit.engineDir}/Plugins/Editor/EditorScriptingUtilities/EditorScriptingUtilities.uplugin`,
  }
}

/** Единственная зона записи сервера в <kit>/Content: новая папка мода в Content/Mods. */
export function newModSandbox(kit: KitPaths): PathSandbox {
  return new PathSandbox([kit.contentMods])
}

/** Путь папки мода, если она ровно <kit>/Content/Mods/<Мод>; mustBeAbsent — папки ещё нет. */
export function newModDir(kit: KitPaths, modName: string, mustBeAbsent: boolean): string {
  const dir = newModSandbox(kit).validateAndResolve(`${kit.contentMods}/${modName}`)
  const root = realpathSync(kit.contentMods)
  const sameParent = process.platform === 'win32' ? dirname(dir).toLowerCase() === root.toLowerCase() : dirname(dir) === root
  if (!sameParent) throw new PathSandboxError(`папка мода не лежит прямо в ${kit.contentMods}: ${dir}`)
  if (basename(dir) !== modName) throw new PathSandboxError(`имя папки ${basename(dir)} не совпадает с модом ${modName}`)
  if (mustBeAbsent && existsSync(dir)) throw new PathSandboxError(`папка мода уже есть: ${dir}`)
  return norm(dir)
}

/** Песочница для записи в каталог модов игры: только <saved>/mods, и внутри — только папка самого мода. */
export function savedModsSandbox(config: ServerConfig): PathSandbox {
  return new PathSandbox([savedModsDir(config)])
}

export interface EditorProc {
  pid: number
  commandLine: string
}

/** Редактор с открытым этим .uproject: две сборки одного проекта одновременно недопустимы. */
export function findEditorProcess(uproject: string): EditorProc | null {
  if (process.platform !== 'win32') return null
  const script =
    "$p = Get-CimInstance Win32_Process -Filter \"Name like 'UnrealEditor%'\" -ErrorAction SilentlyContinue | " +
    `Where-Object { $_.CommandLine -like '*${basename(uproject)}*' } | Select-Object -First 1; ` +
    'if ($p) { [Console]::Out.Write(($p.ProcessId.ToString() + "|" + $p.Name + "|" + $p.CommandLine)) }'
  try {
    const p = Bun.spawnSync(['powershell', '-NoProfile', '-NonInteractive', '-Command', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = new TextDecoder().decode(p.stdout).trim()
    if (!out) return null
    const [pid, , ...rest] = out.split('|')
    const id = Number(pid)
    return Number.isFinite(id) && id > 0 ? { pid: id, commandLine: rest.join('|') } : null
  } catch {
    return null
  }
}


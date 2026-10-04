import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { ServerConfig } from '../config'
import { buildSidecar, SidecarError } from '../scripts/index-gamedata'
import { normalizeUserPath } from '../scripts/parsers/path-forms'
import { pakReaderFor } from './asset-extract'
import { BridgeResult, getBridge } from './bridge-client'
import { kitStatus } from './kit'
import { findSteamGame, WHISKERWOOD_APP_ID } from './steam-locate'

export const MOD_ASSET_PREFIX = '/Game/Mods/'

/** У каждого мода свой BP_MapLoad_C: короткое имя неоднозначно, годится только полный путь. */
export function modPathHint(): string {
  return 'у каждого мода свой BP_MapLoad_C, поэтому короткое имя неоднозначно: путь мода указывай целиком — /Game/Mods/<Мод>/<Ассет>.<Класс>_C:<Функция>'
}

export interface ModAssetRef {
  mod: string
  assetPath: string
  assetName: string
  className: string
  classPath: string
  functionName: string | null
  functionPath: string | null
}

export function parseModAssetPath(raw: string): ModAssetRef | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith(MOD_ASSET_PREFIX)) return null
  const colon = trimmed.lastIndexOf(':')
  const classPart = colon >= 0 ? trimmed.slice(0, colon) : trimmed
  const functionName = colon >= 0 ? trimmed.slice(colon + 1).trim() : null
  if (functionName !== null && !/^[A-Za-z_]\w*$/.test(functionName)) return null
  if (classPart.includes(':')) return null
  const rest = classPart.slice(MOD_ASSET_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const mod = rest.slice(0, slash)
  const tail = rest.slice(slash + 1)
  const lastSlash = tail.lastIndexOf('/')
  const fileTail = lastSlash >= 0 ? tail.slice(lastSlash + 1) : tail
  const dirPart = lastSlash >= 0 ? tail.slice(0, lastSlash + 1) : ''
  const dot = fileTail.indexOf('.')
  const assetName = dot > 0 ? fileTail.slice(0, dot) : fileTail
  const className = dot > 0 ? fileTail.slice(dot + 1) : `${assetName}_C`
  if (assetName.length === 0 || className.length === 0) return null
  const assetPath = `${MOD_ASSET_PREFIX}${mod}/${dirPart}${assetName}`
  return {
    mod,
    assetPath,
    assetName,
    className,
    classPath: `${assetPath}.${className}`,
    functionName,
    functionPath: functionName ? `${assetPath}.${className}:${functionName}` : null,
  }
}

export function isModAssetInput(raw: string): boolean {
  return raw.trim().startsWith(MOD_ASSET_PREFIX) || normalizeUserPath(raw).isModPath
}

export interface ModParam {
  ordinal: number
  name: string
  prop_kind: string
  type_name: string | null
  inner_type: string | null
  is_return: number
  is_out: number
  dir: 'in' | 'ref' | 'out' | 'return'
}

export interface ModFunctionSignature {
  functionName: string
  functionPath: string
  classPath: string
  classKind: string | null
  superPath: string | null
  params: ModParam[]
  flags: string[]
  source: string
}

export interface ModClassFunctions {
  classPath: string
  className: string
  classKind: string | null
  superPath: string | null
  functions: string[]
  source: string
}

export type ModSignatureResult =
  | { ok: true; signature: ModFunctionSignature }
  | { ok: false; status: string; detail: string; searched: string; error?: string }

export type ModClassResult = { ok: true; info: ModClassFunctions } | { ok: false; status: string; detail: string; searched: string; error?: string }

interface PakRef {
  ObjectName?: string
  ObjectPath?: string
}

interface PakProp {
  Type?: string
  Name?: string
  PropertyFlags?: string
  PropertyClass?: PakRef
  MetaClass?: PakRef
  InterfaceClass?: PakRef
  Enum?: PakRef
  Struct?: unknown
  Inner?: PakProp
  Element?: PakProp
  Key?: PakProp
  Value?: PakProp
  ValueType?: PakProp
}

interface PakExport {
  Type?: string
  Name?: string
  FunctionFlags?: string
  ChildProperties?: PakProp[]
  SuperStruct?: PakRef
}

interface PakTarget {
  dir: string
  pakPath: string
  uplugin: string | null
}

const SCALAR_TYPES: Record<string, string> = {
  BoolProperty: 'bool',
  ByteProperty: 'byte',
  Int8Property: 'int8',
  Int16Property: 'int16',
  IntProperty: 'int32',
  Int64Property: 'int64',
  UInt16Property: 'uint16',
  UInt32Property: 'uint32',
  UInt64Property: 'uint64',
  FloatProperty: 'float',
  DoubleProperty: 'double',
  NameProperty: 'FName',
  StrProperty: 'FString',
  TextProperty: 'FText',
  Utf8StrProperty: 'Utf8String',
  AnsiStrProperty: 'AnsiString',
  FieldPathProperty: 'FieldPath',
}

const OBJECT_KINDS = new Set([
  'ObjectProperty',
  'WeakObjectProperty',
  'LazyObjectProperty',
  'SoftObjectProperty',
  'AssetObjectProperty',
  'ObjectPtrProperty',
  'ClassProperty',
  'SoftClassProperty',
  'InterfaceProperty',
])

function quotedName(value: unknown): string | null {
  if (typeof value === 'string') {
    const q = /'([^']+)'/.exec(value)
    if (q) return q[1]
    const tail = value.slice(value.lastIndexOf('.') + 1)
    return tail.length > 0 ? tail : null
  }
  if (typeof value !== 'object' || value === null) return null
  const ref = value as PakRef
  if (typeof ref.ObjectName !== 'string') return null
  const q = /'([^']+)'/.exec(ref.ObjectName)
  return q ? q[1] : ref.ObjectName
}

function elementTypeName(p: PakProp | undefined): string | null {
  if (!p) return null
  const t = String(p.Type ?? '')
  if (OBJECT_KINDS.has(t) || t === 'StructProperty' || t === 'EnumProperty') {
    return quotedName(p.PropertyClass ?? p.MetaClass ?? p.InterfaceClass ?? p.Struct ?? p.Enum)
  }
  return SCALAR_TYPES[t] ?? null
}

function kindAndType(p: PakProp): { prop_kind: string; type_name: string | null; inner_type: string | null } {
  const t = String(p.Type ?? 'unknown')
  if (t === 'ArrayProperty') return { prop_kind: t, type_name: 'TArray', inner_type: elementTypeName(p.Inner) }
  if (t === 'SetProperty') return { prop_kind: t, type_name: 'TSet', inner_type: elementTypeName(p.Element ?? p.Inner) }
  if (t === 'MapProperty') {
    const key = elementTypeName(p.Key)
    const value = elementTypeName(p.Value)
    return { prop_kind: t, type_name: 'TMap', inner_type: key && value ? `${key}, ${value}` : (key ?? value) }
  }
  if (t === 'OptionalProperty') {
    return { prop_kind: t, type_name: 'TOptional', inner_type: elementTypeName(p.ValueType ?? p.Value) }
  }
  if (t === 'StructProperty') return { prop_kind: t, type_name: quotedName(p.Struct), inner_type: null }
  if (t === 'EnumProperty') return { prop_kind: t, type_name: quotedName(p.Enum), inner_type: null }
  if (t === 'ByteProperty' && p.Enum) return { prop_kind: 'EnumProperty', type_name: quotedName(p.Enum), inner_type: null }
  if (OBJECT_KINDS.has(t)) {
    return { prop_kind: t, type_name: quotedName(p.PropertyClass ?? p.MetaClass ?? p.InterfaceClass), inner_type: null }
  }
  return { prop_kind: t, type_name: SCALAR_TYPES[t] ?? quotedName(p.Struct ?? p.Enum), inner_type: null }
}

function flagList(text: string | undefined): string[] {
  if (!text) return []
  return text
    .split('|')
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
}

/** Параметры UFunction из пака: настоящие параметры несут CPF_Parm, тела функций — нет. */
function parmParams(fn: PakExport): ModParam[] {
  const out: ModParam[] = []
  let ordinal = 0
  for (const p of fn.ChildProperties ?? []) {
    const flags = flagList(p.PropertyFlags)
    if (!flags.includes('Parm')) continue
    const { prop_kind, type_name, inner_type } = kindAndType(p)
    const isReturn = flags.includes('ReturnParm')
    const constRef = flags.includes('ReferenceParm') && flags.includes('ConstParm') && !isReturn
    const dir: ModParam['dir'] = isReturn
      ? 'return'
      : constRef
        ? 'in'
        : flags.includes('ReferenceParm')
          ? 'ref'
          : flags.includes('OutParm')
            ? 'out'
            : 'in'
    out.push({
      ordinal: ordinal++,
      name: String(p.Name ?? ''),
      prop_kind,
      type_name,
      inner_type,
      is_return: isReturn ? 1 : 0,
      is_out: !isReturn && flags.includes('OutParm') ? 1 : 0,
      dir,
    })
  }
  return out
}

export interface PakFunctionSignature {
  params: ModParam[]
  flags: string[]
}

/** Параметры и флаги UFunction из JSON пакета — тем же разбором, что и для функций мода. */
export function pakFunctionSignature(exports: unknown, functionName: string): PakFunctionSignature | null {
  if (!Array.isArray(exports)) return null
  const fn = (exports as PakExport[]).find((e) => e.Type === 'Function' && e.Name === functionName)
  if (!fn) return null
  return { params: parmParams(fn), flags: flagList(fn.FunctionFlags) }
}

/** Как Loom видит функцию мода: FUNC_BlueprintCallable/Pure зовётся, FUNC_BlueprintEvent — только переопределяется. */
export function modBlueprintStatus(flags: string[]): { status: 'callable' | 'pure' | 'event' | 'not_callable'; note: string } {
  if (flags.includes('FUNC_BlueprintPure')) {
    return { status: 'pure', note: 'pure: Blueprint зовёт её чистым узлом' }
  }
  if (flags.includes('FUNC_BlueprintCallable')) {
    return { status: 'callable', note: 'BlueprintCallable: узел вызова в графе есть' }
  }
  if (flags.includes('FUNC_BlueprintEvent')) {
    return { status: 'event', note: 'событие Blueprint: в Loom его переопределяют по имени, а не зовут как функцию' }
  }
  return { status: 'not_callable', note: 'не BlueprintCallable/Pure/Event: узла вызова в Blueprint нет' }
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => statSync(`${dir}/${f}`).isFile())
  } catch {
    return []
  }
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => statSync(`${dir}/${f}`).isDirectory())
      .map((f) => `${dir}/${f}`)
  } catch {
    return []
  }
}

function pakDirs(config: ServerConfig, mod: string): string[] {
  const out: string[] = []
  const saved = `${config.savedDir}/mods/${mod}`
  if (existsSync(saved)) out.push(saved)
  const steam = findSteamGame(config.steamAppId || WHISKERWOOD_APP_ID)
  if (steam) {
    const workshop = `${steam.library}/steamapps/workshop/content/${steam.appId}`
    for (const dir of listDirs(workshop)) {
      if (listFiles(dir).some((f) => f.toLowerCase() === `${mod.toLowerCase()}.pak`)) out.push(dir)
    }
  }
  const kit = kitStatus(config).kit
  if (kit && existsSync(kit.pakOutputDir) && !out.includes(kit.pakOutputDir)) out.push(kit.pakOutputDir)
  return out
}

/** Путь внутри пака = точка монтирования минус относительные `../` плюс путь записи. */
function pakInternalPath(mountPoint: string, entry: string): string {
  const mount = mountPoint
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p.length > 0 && p !== '..' && p !== '.')
    .join('/')
  return `${mount}/${entry.replace(/^\/+/, '')}`
}

function pakHasAsset(dir: string, ref: ModAssetRef): string | null {
  const suffix = `${ref.assetPath.slice('/Game'.length).toLowerCase()}.uasset`
  for (const file of listFiles(dir)) {
    if (!file.toLowerCase().endsWith('.pak')) continue
    const pakPath = `${dir}/${file}`
    try {
      const reader = pakReaderFor(pakPath)
      if (reader.list().some((entry) => pakInternalPath(reader.mountPoint, entry).toLowerCase().endsWith(suffix))) {
        return pakPath
      }
    } catch {
      continue
    }
  }
  return null
}

function upluginOf(dir: string, mod: string): string | null {
  const own = `${dir}/${mod}.uplugin`
  if (existsSync(own)) return own
  const any = listFiles(dir).find((f) => f.toLowerCase().endsWith('.uplugin'))
  return any ? `${dir}/${any}` : null
}

/** Отключённый мод лежит рядом как `<Мод>.pak.wwoff` — игра его не монтирует, и функция в памяти не появится. */
function disabledMarker(config: ServerConfig, mod: string): string | null {
  const saved = `${config.savedDir}/mods/${mod}`
  const local = listFiles(saved).find((f) => f.toLowerCase().endsWith('.pak.wwoff'))
  if (local) return `${saved}/${local}`
  const steam = findSteamGame(config.steamAppId || WHISKERWOOD_APP_ID)
  if (steam) {
    const workshop = `${steam.library}/steamapps/workshop/content/${steam.appId}`
    for (const dir of listDirs(workshop)) {
      const off = listFiles(dir).find((f) => f.toLowerCase() === `${mod.toLowerCase()}.pak.wwoff`)
      if (off) return `${dir}/${off}`
    }
  }
  return null
}

function findPakTarget(config: ServerConfig, ref: ModAssetRef): { target: PakTarget | null; searched: string; disabled: string | null } {
  const dirs = pakDirs(config, ref.mod)
  for (const dir of dirs) {
    const pakPath = pakHasAsset(dir, ref)
    if (pakPath) return { target: { dir, pakPath, uplugin: upluginOf(dir, ref.mod) }, searched: dirs.join('; '), disabled: null }
  }
  return { target: null, searched: dirs.join('; ') || 'нет каталогов', disabled: disabledMarker(config, ref.mod) }
}

function newestUsmap(dir: string): string | null {
  try {
    const maps = readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.usmap'))
      .map((f) => ({ f, mtime: statSync(`${dir}/${f}`).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    return maps.length > 0 ? `${dir}/${maps[0].f}` : null
  } catch {
    return null
  }
}

let cachedSidecar: string | null = null

function sidecarExe(config: ServerConfig): string {
  if (!cachedSidecar) cachedSidecar = buildSidecar(config)
  return cachedSidecar
}

const exportCache = new Map<string, PakExport[]>()

function runSidecarJson(config: ServerConfig, target: PakTarget, assetPath: string): PakExport[] {
  let mtime = 0
  try {
    mtime = statSync(target.pakPath).mtimeMs
  } catch {
    mtime = 0
  }
  const key = `${target.pakPath}|${mtime}|${assetPath}`
  const hit = exportCache.get(key)
  if (hit) return hit

  const usmap = newestUsmap(config.dumpsDir)
  if (!usmap) throw new SidecarError(`нет .usmap в ${config.dumpsDir}: сними дампы (ww_capture_dumps), затем bun run dumps:pull`)
  const dir = `${config.stateDir}/tmp/mod-asset`
  mkdirSync(dir, { recursive: true })
  const out = `${dir}/${createHash('sha1').update(key).digest('hex').slice(0, 12)}.json`
  const args = [sidecarExe(config), 'json', '--paks', target.dir, '--usmap', usmap, '--asset', assetPath, '--out', out]
  if (target.uplugin) args.push('--uplugin', target.uplugin)
  let code: number | null = null
  let stderr = ''
  try {
    const proc = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe', timeout: 180_000 })
    code = proc.exitCode
    stderr = new TextDecoder().decode(proc.stderr).trim()
  } catch (e) {
    throw new SidecarError(`WwParse json не запустился: ${(e as Error).message}`)
  }
  if (code !== 0 || !existsSync(out)) {
    throw new SidecarError(`WwParse json завершился с кодом ${code ?? -1} (${assetPath}): ${stderr || 'без вывода'}`)
  }
  const exports = JSON.parse(readFileSync(out, 'utf8')) as PakExport[]
  exportCache.set(key, exports)
  return exports
}

function superStructName(ref: PakRef): string | null {
  const name = quotedName(ref)
  if (!name) return null
  const outer = typeof ref.ObjectPath === 'string' ? ref.ObjectPath : ''
  return outer.startsWith('/') ? `${outer}.${name}` : name
}

function classExportOf(exports: PakExport[]): PakExport | null {
  return (
    exports.find(
      (e) =>
        typeof e.Name === 'string' &&
        !e.Name.startsWith('Default__') &&
        /Class$/.test(String(e.Type ?? '')) &&
        e.SuperStruct !== undefined,
    ) ?? null
  )
}

export function modClassInfo(config: ServerConfig, ref: ModAssetRef): ModClassResult {
  const { target, searched, disabled } = findPakTarget(config, ref)
  if (!target) {
    return {
      ok: false,
      status: 'mod_pak_not_found',
      detail: `пак мода ${ref.mod} с ассетом ${ref.assetName} не найден`,
      searched,
      error: disabled ? `мод отключён: ${disabled}` : undefined,
    }
  }
  let exports: PakExport[]
  try {
    exports = runSidecarJson(config, target, ref.assetPath)
  } catch (e) {
    return {
      ok: false,
      status: 'mod_pak_unreadable',
      detail: `пак ${target.pakPath} не разобран`,
      searched,
      error: e instanceof Error ? e.message : String(e),
    }
  }
  const cls = classExportOf(exports)
  if (!cls || !cls.Name) {
    return { ok: false, status: 'mod_class_not_found', detail: `в паке ${target.pakPath} нет Blueprint-класса ассета ${ref.assetPath}`, searched }
  }
  return {
    ok: true,
    info: {
      classPath: `${ref.assetPath}.${cls.Name}`,
      className: String(cls.Name),
      classKind: cls.Type ? String(cls.Type) : null,
      superPath: cls.SuperStruct ? superStructName(cls.SuperStruct) : null,
      functions: exports.filter((e) => e.Type === 'Function' && typeof e.Name === 'string').map((e) => String(e.Name)),
      source: `пак мода: ${target.pakPath}`,
    },
  }
}

export function modSignature(config: ServerConfig, ref: ModAssetRef): ModSignatureResult {
  if (!ref.functionName) {
    return { ok: false, status: 'function_required', detail: 'в пути мода не указана функция', searched: '' }
  }
  const info = modClassInfo(config, ref)
  if (!info.ok) return info
  const { target, searched, disabled } = findPakTarget(config, ref)
  if (!target) {
    return {
      ok: false,
      status: 'mod_pak_not_found',
      detail: `пак мода ${ref.mod} не найден`,
      searched,
      error: disabled ? `мод отключён: ${disabled}` : undefined,
    }
  }
  let exports: PakExport[]
  try {
    exports = runSidecarJson(config, target, ref.assetPath)
  } catch (e) {
    return {
      ok: false,
      status: 'mod_pak_unreadable',
      detail: `пак ${target.pakPath} не разобран`,
      searched,
      error: e instanceof Error ? e.message : String(e),
    }
  }
  const fn = pakFunctionSignature(exports, ref.functionName)
  if (!fn) {
    const similar = exports
      .filter((e) => e.Type === 'Function' && typeof e.Name === 'string' && e.Name.toLowerCase().includes(ref.functionName!.toLowerCase()))
      .map((e) => String(e.Name))
      .slice(0, 5)
    return {
      ok: false,
      status: 'mod_function_not_found',
      detail: `в ${info.info.classPath} нет функции ${ref.functionName}`,
      searched,
      error: similar.length > 0 ? `похожие: ${similar.join(', ')}` : undefined,
    }
  }
  return {
    ok: true,
    signature: {
      functionName: ref.functionName,
      functionPath: `${info.info.classPath}:${ref.functionName}`,
      classPath: info.info.classPath,
      classKind: info.info.classKind,
      superPath: info.info.superPath,
      params: fn.params,
      flags: fn.flags,
      source: info.info.source,
    },
  }
}

export interface ModLiveProbe {
  found: boolean
  via: string
}

export type ModProbeResult =
  | { ok: true; probes: Map<string, ModLiveProbe> }
  | { ok: false; result: Exclude<BridgeResult, { status: 'ok' }> }

/** Живая проверка путей мода: probe пробует и объектную, и хуковую форму пути. */
export async function probeModPaths(config: ServerConfig, paths: string[]): Promise<ModProbeResult> {
  if (paths.length === 0) return { ok: true, probes: new Map() }
  const res = await getBridge(config).call('probe', paths.join('\n'), 15_000)
  if (res.status !== 'ok') return { ok: false, result: res }
  const probes = new Map<string, ModLiveProbe>()
  for (const line of res.body.split('\n')) {
    const m = /^(.*) = (found|not_found) via=(\S+)$/.exec(line.trim())
    if (!m) continue
    probes.set(m[1], { found: m[2] === 'found', via: m[3] })
  }
  return { ok: true, probes }
}

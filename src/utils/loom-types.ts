import { existsSync, readFileSync, statSync } from 'node:fs'
import { ServerConfig } from '../config'
import type { GameContext } from './game-context'
import { kitStatus } from './kit'

export type BpFunctionStatus =
  | 'callable'
  | 'pure'
  | 'latent'
  | 'world_context'
  | 'internal'
  | 'deprecated'
  | 'editor_only'
  | 'not_callable'
  | 'not_in_types'

export type BpFieldStatus = 'read' | 'read_only' | 'edit_only' | 'hidden' | 'not_in_types'

export type BpParamDir = 'in' | 'ref' | 'out'

export interface BpParam {
  name: string
  dir: BpParamDir
  type: string
  loom_type: string
  optional: boolean
}

export interface BpFunctionInfo {
  status: BpFunctionStatus
  loom_class: string
  loom_function: string
  owner: string
  static: boolean
  pure: boolean
  latent: boolean
  world_context: boolean
  editor_only: boolean
  deprecated: boolean
  access: string | null
  params: BpParam[]
  dirs: Record<string, BpParamDir>
  hidden_params: string[]
  returns: string | null
  outputs: string[]
  loom_call: string | null
  loom_receiver: string | null
  loads_at_build: boolean
  note: string | null
}

export interface BpFieldInfo {
  status: BpFieldStatus
  owner: string
  loom_type: string | null
  delegate_signature: BpDelegateParam[] | null
  loads_at_build: boolean
  note: string | null
}

export interface BpDelegateParam {
  name: string
  type: string
  loom_type: string
}

export interface BpDelegate {
  name: string
  owner: string
  signature: BpDelegateParam[]
}

export interface BpClassInfo {
  in_types: boolean
  loom_path: string | null
  short_name: string | null
  super: string | null
  interface: boolean
  abstract: boolean
  editor_only: boolean
  is_game_blueprint: boolean
  loads_at_build: boolean
  method_count: number | null
  field_count: number | null
  note: string | null
}

interface RawSignatureParam {
  name?: string
  type?: string
  dir?: string
}

interface RawParam extends RawSignatureParam {
  default?: unknown
}

interface RawFunction {
  flags?: string[]
  params?: RawParam[]
  world_context?: string
  default_to_self?: string
  hide_pin?: string
}

interface RawProperty {
  type?: string
  read_only?: boolean
  edit_only?: boolean
  signature?: RawSignatureParam[]
}

interface RawClass {
  super?: string
  editor_only?: boolean
  interface?: boolean
  abstract?: boolean
  properties?: Record<string, RawProperty>
  functions?: Record<string, RawFunction>
}

interface RawStruct {
  fields?: Record<string, RawProperty>
}

interface Dump {
  classes?: Record<string, RawClass>
  structs?: Record<string, RawStruct>
  enums?: Record<string, unknown>
}

interface LoomIndex {
  dump: Dump
  short_classes: Map<string, string[]> | null
}

const RESERVED = new Set([
  'break',
  'continue',
  'else',
  'for',
  'if',
  'let',
  'match',
  'return',
  'while',
  'false',
  'none',
  'true',
  'self',
  'super',
])

const BUILTIN_FUNCTIONS = new Set([
  'float',
  'int',
  'string',
  'name',
  'text',
  'cast',
  'implements',
  'create_widget',
  'construct',
  'include',
])

const LATENT_ACTION_INFO = 'struct:/Script/Engine.LatentActionInfo'

let cached: { key: string; index: LoomIndex } | null = null
const LOOM_TYPES = new Map<string, string>()

/** Подсказка вместо полей bp, когда types.json недоступен: кит не настроен или сборки ещё не было. */
export function bpUnavailableHint(config: ServerConfig | null | undefined): string | null {
  if (!config) return 'types.json не читался: инструмент не получил конфиг сервера'
  const st = kitStatus(config)
  if (!st.configured || !st.kit) {
    return `types.json кита недоступен: ${st.problem ?? 'кит не настроен'} — поля bp пропущены`
  }
  if (!existsSync(st.kit.typesJson)) {
    return `нет ${st.kit.typesJson}: кит ещё не собирался (LoomBuild) — поля bp пропущены`
  }
  return null
}

function loadIndex(config: ServerConfig | null | undefined): LoomIndex | null {
  if (!config) return null
  const st = kitStatus(config)
  if (!st.configured || !st.kit) return null
  const path = st.kit.typesJson
  let mtimeMs = 0
  let size = 0
  try {
    const s = statSync(path)
    mtimeMs = s.mtimeMs
    size = s.size
  } catch {
    return null
  }
  const key = `${path}|${mtimeMs}|${size}`
  if (cached && cached.key === key) return cached.index
  let dump: Dump
  try {
    dump = JSON.parse(readFileSync(path, 'utf8')) as Dump
  } catch {
    return null
  }
  const index: LoomIndex = { dump, short_classes: null }
  cached = { key, index }
  return index
}

function classOf(index: LoomIndex, path: string): RawClass | null {
  return index.dump.classes?.[path] ?? null
}

function lineage(index: LoomIndex, classPath: string): Array<{ path: string; cls: RawClass }> {
  const out: Array<{ path: string; cls: RawClass }> = []
  const seen = new Set<string>()
  let current: string | undefined = classPath
  while (current && !seen.has(current) && out.length < 64) {
    seen.add(current)
    const cls = classOf(index, current)
    if (!cls) break
    out.push({ path: current, cls })
    current = cls.super
  }
  return out
}

function functionOf(index: LoomIndex, classPath: string, name: string): { owner: string; cls: RawClass; fn: RawFunction } | null {
  for (const link of lineage(index, classPath)) {
    const fn = link.cls.functions?.[name]
    if (fn) return { owner: link.path, cls: link.cls, fn }
  }
  return null
}

function flagsOf(fn: RawFunction): string[] {
  return Array.isArray(fn.flags) ? fn.flags : []
}

function shortClassName(path: string): string | null {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return null
  const name = path.slice(dot + 1)
  const asset = path.slice(path.lastIndexOf('/') + 1, dot)
  const stripped = name.endsWith('_C') ? name.slice(0, -2) : name
  if (stripped === asset) return stripped
  return name
}

function lastSegment(path: string): string {
  const dot = path.lastIndexOf('.')
  const tail = dot >= 0 ? path.slice(dot + 1) : path
  return tail.slice(tail.lastIndexOf('/') + 1)
}

/** Тип из дампа в том виде, как его пишет исходник Loom: bool, array<int>, ModAPI, soft<Texture2D>. */
export function loomType(raw: string): string {
  const known = LOOM_TYPES.get(raw)
  if (known !== undefined) return known
  const converted = convertType(raw)
  LOOM_TYPES.set(raw, converted)
  return converted
}

function convertType(raw: string): string {
  if (raw === 'float32') return 'float'
  if (raw === 'bool' || raw === 'byte' || raw === 'int' || raw === 'int64' || raw === 'float' || raw === 'string' || raw === 'name' || raw === 'text') {
    return raw
  }
  const generic = /^(array|set)<(.+)>$/.exec(raw)
  if (generic) return `${generic[1]}<${loomType(generic[2])}>`
  const map = /^map<(.+)>$/.exec(raw)
  if (map) {
    const comma = map[1].indexOf(',')
    if (comma > 0) return `map<${loomType(map[1].slice(0, comma))}, ${loomType(map[1].slice(comma + 1))}>`
  }
  const kinded = /^(object|class|struct|enum|interface|softobject|softclass|delegate):(.+)$/.exec(raw)
  if (kinded) {
    const kind = kinded[1]
    const path = kinded[2]
    const name = kind === 'object' || kind === 'class' || kind === 'interface' ? (shortClassName(path) ?? lastSegment(path)) : lastSegment(path)
    if (kind === 'class') return `class<${name}>`
    if (kind === 'softobject') return `soft<${name}>`
    if (kind === 'softclass') return `soft<class<${name}>>`
    return name
  }
  return raw
}

function writtenName(name: string): string {
  if (name.startsWith('/')) return name
  const plain = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
  return plain && !RESERVED.has(name) && !BUILTIN_FUNCTIONS.has(name) ? name : `\`${name}\``
}

interface IndexObjectRow {
  hook_path: string | null
  object_path: string | null
  is_blueprint: number
  kind: string
}

function indexObject(ctx: GameContext, indexPath: string): IndexObjectRow | null {
  if (indexPath.startsWith('/')) return null
  return ctx.db
    .query('SELECT hook_path, object_path, is_blueprint, kind FROM objects WHERE path = ?')
    .get(indexPath) as IndexObjectRow | null
}

/** Индексный путь (`SystemCore.ModAPI`, `BP_PlayHud.BP_PlayHud_C`) -> путь Loom (`/Script/SystemCore.ModAPI`, `/Game/..._C`). */
export function loomPathOf(ctx: GameContext, indexPath: string): string | null {
  if (indexPath.startsWith('/')) return indexPath.split(':')[0]
  const row = indexObject(ctx, indexPath)
  const path = row?.hook_path ?? row?.object_path ?? null
  if (path) return path.split(':')[0]
  if (!indexPath.includes('.')) return null
  const name = indexPath.slice(indexPath.lastIndexOf('.') + 1)
  const pkg = indexPath.slice(0, indexPath.indexOf('.'))
  const stripped = name.endsWith('_C') ? name.slice(0, -2) : name
  if (stripped === pkg) return null
  return `/Script/${indexPath}`
}

function isBlueprintPath(indexPath: string, row: IndexObjectRow | null): boolean {
  if (row && (row.is_blueprint === 1 || /BlueprintGeneratedClass$/.test(row.kind))) return true
  const dot = indexPath.lastIndexOf('.')
  if (dot < 0) return false
  const name = indexPath.slice(dot + 1)
  const pkg = indexPath.slice(0, indexPath.indexOf('.'))
  return name.endsWith('_C') && name.slice(0, -2) === pkg
}

function signatureOf(params: RawSignatureParam[] | undefined): BpDelegateParam[] | null {
  if (!Array.isArray(params)) return null
  return params.map((p) => ({ name: String(p.name ?? ''), type: String(p.type ?? ''), loom_type: loomType(String(p.type ?? '')) }))
}

function statusOf(fn: RawFunction, classEditorOnly: boolean, ownerPath: string): { status: BpFunctionStatus; note: string | null; access: string | null } {
  const flags = flagsOf(fn)
  const has = (f: string): boolean => flags.includes(f)
  const access = has('private') ? 'private' : has('protected') ? 'protected' : null
  const accessBlocks = access !== null && !ownerPath.startsWith('/Script/')
  if (has('not_callable')) return { status: 'not_callable', note: 'это событие, а не вызов (флаг not_callable)', access }
  if (has('internal')) return { status: 'internal', note: 'internal: Loom откажет — «is internal to the engine»', access }
  if (has('editor_only') || classEditorOnly) {
    return { status: 'editor_only', note: 'editor_only: работает только в редакторе, не в игре', access }
  }
  if (accessBlocks) {
    return {
      status: 'not_callable',
      note: `${access}: Loom откажет — функция видна только ${access === 'private' ? 'своему классу' : 'классу и его наследникам'}`,
      access,
    }
  }
  if (has('deprecated')) return { status: 'deprecated', note: 'deprecated: Blueprint не привязывает такие функции, Loom откажет', access }
  if (has('latent')) return { status: 'latent', note: 'latent: вызов только там, где Blueprint может ждать, — в графе событий', access }
  if (has('world_context')) return { status: 'world_context', note: 'world_context: пин мира узел заполняет сам, в вызове его нет', access }
  if (has('pure')) return { status: 'pure', note: null, access }
  return { status: 'callable', note: null, access }
}

function staticGetter(index: LoomIndex, classPath: string): { ownerPath: string; name: string; outputs: number } | null {
  const short = shortClassName(classPath)
  let best: { ownerPath: string; name: string; outputs: number; rank: number } | null = null
  for (const link of lineage(index, classPath)) {
    for (const [name, fn] of Object.entries(link.cls.functions ?? {})) {
      if (!flagsOf(fn).includes('static')) continue
      const ret = (fn.params ?? []).find((p) => p.dir === 'return')
      if (String(ret?.type ?? '') !== `object:${classPath}`) continue
      const visible = (fn.params ?? []).filter((p) => p.dir === 'in' || p.dir === 'ref')
      if (visible.some((p) => p.name !== fn.world_context && p.name !== fn.hide_pin && p.name !== fn.default_to_self && p.default === undefined)) {
        continue
      }
      const rank = short && name === `Get${short}` ? 0 : name.startsWith('Get') ? 1 : 2
      if (!best || rank < best.rank || (rank === best.rank && name < best.name)) {
        best = { ownerPath: link.path, name, outputs: (fn.params ?? []).filter((p) => p.dir === 'out').length, rank }
      }
    }
  }
  return best ? { ownerPath: best.ownerPath, name: best.name, outputs: best.outputs } : null
}

function receiverFor(index: LoomIndex, classPath: string, fn: RawFunction, ownerPath: string): { receiver: string; note: string | null } {
  const classShort = shortClassName(classPath) ?? lastSegment(classPath)
  if (flagsOf(fn).includes('static')) return { receiver: writtenName(classShort), note: null }
  const getter = staticGetter(index, classPath)
  if (getter) {
    const head = writtenName(shortClassName(getter.ownerPath) ?? lastSegment(getter.ownerPath))
    const call = `${head}.${writtenName(getter.name)}()`
    return { receiver: getter.outputs > 0 ? `${call}.ReturnValue` : call, note: null }
  }
  const ownerShort = shortClassName(ownerPath) ?? lastSegment(ownerPath)
  return {
    receiver: `<объект: ${classShort}>`,
    note: `статического геттера у ${ownerShort} нет — подставь свою переменную типа ${classShort}`,
  }
}

function nameIsAmbiguous(index: LoomIndex, classPath: string): string | null {
  const short = shortClassName(classPath)
  if (!short) return null
  if (!index.short_classes) {
    const map = new Map<string, string[]>()
    for (const path of Object.keys(index.dump.classes ?? {})) {
      const name = shortClassName(path)
      if (!name) continue
      const list = map.get(name)
      if (list) list.push(path)
      else map.set(name, [path])
    }
    index.short_classes = map
  }
  const list = index.short_classes.get(short)
  return list && list.length > 1 ? `короткое имя ${short} носят ${list.length} класса — Loom выберет по scope` : null
}

function missingFunctionNote(isBp: boolean): string {
  if (isBp) return 'функции нет в types.json: игровой BP LoomBuild подгружает при сборке, проверь loom check'
  return 'функции нет в types.json: либо не BlueprintCallable, либо её нет в стабах кита — проверь loom check'
}

function notInTypesFunction(loomClass: string, functionName: string, loadsAtBuild: boolean, note: string): BpFunctionInfo {
  return {
    status: 'not_in_types',
    loom_class: loomClass,
    loom_function: functionName,
    owner: loomClass,
    static: false,
    pure: false,
    latent: false,
    world_context: false,
    editor_only: false,
    deprecated: false,
    access: null,
    params: [],
    dirs: {},
    hidden_params: [],
    returns: null,
    outputs: [],
    loom_call: null,
    loom_receiver: null,
    loads_at_build: loadsAtBuild,
    note,
  }
}

export function bpFunction(
  ctx: GameContext,
  config: ServerConfig | null | undefined,
  classIndexPath: string,
  functionName: string,
): BpFunctionInfo | null {
  const index = loadIndex(config)
  if (!index) return null
  const loomClass = loomPathOf(ctx, classIndexPath)
  const isBp = isBlueprintPath(classIndexPath, indexObject(ctx, classIndexPath))
  if (!loomClass) {
    return notInTypesFunction(classIndexPath, functionName, isBp, 'класса нет в types.json, и путь Loom для него неизвестен')
  }
  const cls = classOf(index, loomClass)
  if (!cls) {
    const note = isBp
      ? 'игрового BP нет в types.json — LoomBuild подгрузит его при сборке'
      : 'класса нет в types.json: в стабах кита его нет, вызов из Loom, скорее всего, не соберётся'
    return notInTypesFunction(loomClass, functionName, isBp, note)
  }
  const found = functionOf(index, loomClass, functionName)
  if (!found) {
    const info = notInTypesFunction(loomClass, functionName, isBp, missingFunctionNote(isBp))
    if (cls.interface) {
      info.status = 'not_callable'
      info.note =
        'функции нет в types.json, а у интерфейсов дамп полный: она не BlueprintCallable/Pure/Event — Blueprint её не вызовет'
    }
    return info
  }

  const classEditorOnly = lineage(index, loomClass).some((l) => l.cls.editor_only === true)
  const { status, note, access } = statusOf(found.fn, classEditorOnly, found.owner)
  const flags = flagsOf(found.fn)
  const worldContext = found.fn.world_context
  const hidePin = found.fn.hide_pin
  const latent = flags.includes('latent')

  const params: BpParam[] = []
  const dirs: Record<string, BpParamDir> = {}
  const hiddenParams: string[] = []
  const outputs: string[] = []
  let returns: string | null = null
  for (const p of found.fn.params ?? []) {
    const name = String(p.name ?? '')
    const type = String(p.type ?? '')
    const dir = String(p.dir ?? 'in')
    if (dir === 'return') {
      returns = loomType(type)
      continue
    }
    if (dir === 'out') {
      dirs[name] = 'out'
      outputs.push(`${name}: ${loomType(type)}`)
      continue
    }
    const hidden = name === worldContext || name === hidePin || (latent && dir === 'in' && type === LATENT_ACTION_INFO)
    dirs[name] = dir === 'ref' ? 'ref' : 'in'
    if (hidden) {
      hiddenParams.push(name)
      continue
    }
    params.push({
      name,
      dir: dir === 'ref' ? 'ref' : 'in',
      type,
      loom_type: loomType(type),
      optional: p.default !== undefined || name === found.fn.default_to_self,
    })
  }

  const callable = status === 'callable' || status === 'pure' || status === 'world_context' || status === 'latent'
  let loomCall: string | null = null
  let loomReceiver: string | null = null
  let notes: string[] = note ? [note] : []
  if (callable) {
    const { receiver, note: receiverNote } = receiverFor(index, loomClass, found.fn, found.owner)
    loomReceiver = receiver
    const args = params.map((p) => writtenName(p.name)).join(', ')
    let result = ''
    if (returns && outputs.length > 0) {
      result = ` -> { ${[`ReturnValue: ${returns}`].concat(outputs.map((o) => `${writtenName(o.slice(0, o.indexOf(': ')))}: ${o.slice(o.indexOf(': ') + 2)}`)).join(', ')} }`
    } else if (returns) {
      result = ` -> ${returns}`
    } else if (outputs.length > 0) {
      result = ` -> { ${outputs.map((o) => `${writtenName(o.slice(0, o.indexOf(': ')))}: ${o.slice(o.indexOf(': ') + 2)}`).join(', ')} }`
    }
    loomCall = `${receiver}.${writtenName(functionName)}(${args})${result}`
    if (receiverNote) notes.push(receiverNote)
  }
  const ambiguous = nameIsAmbiguous(index, loomClass)
  if (ambiguous) notes.push(ambiguous)

  return {
    status,
    loom_class: loomClass,
    loom_function: functionName,
    owner: found.owner,
    static: flags.includes('static'),
    pure: flags.includes('pure'),
    latent,
    world_context: flags.includes('world_context'),
    editor_only: classEditorOnly || flags.includes('editor_only'),
    deprecated: flags.includes('deprecated'),
    access,
    params,
    dirs,
    hidden_params: hiddenParams,
    returns,
    outputs,
    loom_call: loomCall,
    loom_receiver: loomReceiver,
    loads_at_build: false,
    note: notes.length > 0 ? notes.join('; ') : null,
  }
}

export function bpField(
  ctx: GameContext,
  config: ServerConfig | null | undefined,
  ownerIndexPath: string,
  fieldName: string,
): BpFieldInfo | null {
  const index = loadIndex(config)
  if (!index) return null
  const loomOwner = loomPathOf(ctx, ownerIndexPath)
  const isBp = isBlueprintPath(ownerIndexPath, indexObject(ctx, ownerIndexPath))
  if (!loomOwner) {
    return {
      status: 'not_in_types',
      owner: ownerIndexPath,
      loom_type: null,
      delegate_signature: null,
      loads_at_build: isBp,
      note: 'путь Loom для владельца неизвестен',
    }
  }
  if (classOf(index, loomOwner)) {
    for (const link of lineage(index, loomOwner)) {
      const prop = link.cls.properties?.[fieldName]
      if (!prop) continue
      const status: BpFieldStatus = prop.edit_only === true ? 'edit_only' : prop.read_only === true ? 'read_only' : 'read'
      const note =
        status === 'edit_only'
          ? 'edit_only: значение ставится только в Details, код до поля не достаёт'
          : status === 'read_only'
            ? 'read_only: BlueprintReadOnly — читать можно, писать нет'
            : null
      return {
        status,
        owner: link.path,
        loom_type: loomType(String(prop.type ?? '')),
        delegate_signature: signatureOf(prop.signature),
        loads_at_build: false,
        note,
      }
    }
    return {
      status: 'hidden',
      owner: loomOwner,
      loom_type: null,
      delegate_signature: null,
      loads_at_build: false,
      note: 'поля нет в types.json: Blueprint его не видит (ни BlueprintVisible, ни Edit)',
    }
  }
  const struct = index.dump.structs?.[loomOwner]
  if (struct) {
    const field = struct.fields?.[fieldName]
    if (!field) {
      return { status: 'hidden', owner: loomOwner, loom_type: null, delegate_signature: null, loads_at_build: false, note: 'поля нет в types.json' }
    }
    const status: BpFieldStatus = field.edit_only === true ? 'edit_only' : field.read_only === true ? 'read_only' : 'read'
    return { status, owner: loomOwner, loom_type: loomType(String(field.type ?? '')), delegate_signature: null, loads_at_build: false, note: null }
  }
  const note = isBp
    ? 'игрового BP нет в types.json — LoomBuild подгрузит его при сборке'
    : 'класса нет в types.json: в стабах кита его нет'
  return { status: 'not_in_types', owner: loomOwner, loom_type: null, delegate_signature: null, loads_at_build: isBp, note }
}

export function bpClass(ctx: GameContext, config: ServerConfig | null | undefined, indexPath: string): BpClassInfo | null {
  const index = loadIndex(config)
  if (!index) return null
  const loomPath = loomPathOf(ctx, indexPath)
  const isBp = isBlueprintPath(indexPath, indexObject(ctx, indexPath))
  if (!loomPath) {
    return {
      in_types: false,
      loom_path: null,
      short_name: null,
      super: null,
      interface: false,
      abstract: false,
      editor_only: false,
      is_game_blueprint: isBp,
      loads_at_build: isBp,
      method_count: null,
      field_count: null,
      note: 'путь Loom для этого объекта неизвестен',
    }
  }
  const cls = classOf(index, loomPath)
  if (cls) {
    return {
      in_types: true,
      loom_path: loomPath,
      short_name: shortClassName(loomPath),
      super: cls.super ?? null,
      interface: cls.interface === true,
      abstract: cls.abstract === true,
      editor_only: cls.editor_only === true,
      is_game_blueprint: isBp,
      loads_at_build: false,
      method_count: Object.keys(cls.functions ?? {}).length,
      field_count: Object.keys(cls.properties ?? {}).length,
      note: null,
    }
  }
  const struct = index.dump.structs?.[loomPath]
  if (struct) {
    return {
      in_types: true,
      loom_path: loomPath,
      short_name: lastSegment(loomPath),
      super: null,
      interface: false,
      abstract: false,
      editor_only: false,
      is_game_blueprint: isBp,
      loads_at_build: false,
      method_count: 0,
      field_count: Object.keys(struct.fields ?? {}).length,
      note: 'структура из types.json',
    }
  }
  if (index.dump.enums?.[loomPath] !== undefined) {
    return {
      in_types: true,
      loom_path: loomPath,
      short_name: lastSegment(loomPath),
      super: null,
      interface: false,
      abstract: false,
      editor_only: false,
      is_game_blueprint: isBp,
      loads_at_build: false,
      method_count: null,
      field_count: null,
      note: 'enum из types.json',
    }
  }
  const note = isBp
    ? 'игрового BP нет в types.json — LoomBuild подгрузит его при сборке'
    : 'класса нет в types.json: в стабах кита его нет, вызовы его функций из Loom, скорее всего, не соберутся'
  return {
    in_types: false,
    loom_path: loomPath,
    short_name: shortClassName(loomPath),
    super: null,
    interface: false,
    abstract: false,
    editor_only: false,
    is_game_blueprint: isBp,
    loads_at_build: isBp,
    method_count: null,
    field_count: null,
    note,
  }
}

/** Делегаты класса (свои и унаследованные) с сигнатурой — для подписки в Loom. */
export function bpDelegates(ctx: GameContext, config: ServerConfig | null | undefined, indexPath: string): BpDelegate[] | null {
  const index = loadIndex(config)
  if (!index) return null
  const loomPath = loomPathOf(ctx, indexPath)
  if (!loomPath) return []
  const out: BpDelegate[] = []
  const seen = new Set<string>()
  for (const link of lineage(index, loomPath)) {
    for (const [name, prop] of Object.entries(link.cls.properties ?? {})) {
      if (prop.type !== 'multicast_delegate' || seen.has(name)) continue
      seen.add(name)
      out.push({ name, owner: link.path, signature: signatureOf(prop.signature) ?? [] })
    }
  }
  return out
}

/** Статус, при котором Loom соберёт вызов: not_in_types оставлен, потому что для игровых BP это «проверь на сборке», а не «нельзя». */
export function bpFunctionVisible(status: BpFunctionStatus): boolean {
  return status === 'callable' || status === 'pure' || status === 'world_context' || status === 'latent' || status === 'not_in_types'
}

/** Поле, до которого Blueprint дотягивается: read и read_only; edit_only и hidden — только редактор. */
export function bpFieldVisible(status: BpFieldStatus): boolean {
  return status === 'read' || status === 'read_only' || status === 'not_in_types'
}

export function bpClassVisible(info: BpClassInfo): boolean {
  return (info.in_types || info.loads_at_build) && !info.editor_only
}

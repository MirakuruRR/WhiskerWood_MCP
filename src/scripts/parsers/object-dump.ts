import { lastSegment } from './path-forms'

export interface DumpCounters {
  linesTotal: number
  objectsTotal: number
  objectsIndexed: number
  objectsSkippedByKind: number
  cdoSkipped: number
  propertyLines: number
  innerNoAddr: number
  enumValueLines: number
  unparsed: number
  unresolvedSps: number
  unresolvedOwr: number
  unresolvedPc: number
  unresolvedSs: number
  unresolvedAi: number
  unresolvedEm: number
  unresolvedMc: number
  unresolvedIc: number
  unresolvedDf: number
  unresolvedKv: number
}

interface AddrRow {
  kind: string
  rawPath: string
  offset: number
  sps: string | null
  owr: string | null
  pc: string | null
  ss: string | null
  ai: string | null
  em: string | null
  mc: string | null
  ic: string | null
  df: string | null
  kp: string | null
  vp: string | null
  isInnerForm: boolean
}

export interface ResolvedType {
  typeName: string | null
  innerType: string | null
}

export interface MemberParsed {
  ownerAddr: string
  name: string
  propKind: string
  offset: number
  ordinal: number
  resolved: ResolvedType
}

export interface ObjectParsed {
  addr: string
  kind: string
  rawPath: string
  isBlueprint: boolean
}

export interface ParsedObjectDump {
  objects: ObjectParsed[]
  members: MemberParsed[]
  enumValues: Map<string, Array<{ name: string; value: number }>>
  addrRows: Map<string, AddrRow>
  counters: DumpCounters
}

const ADDR_RE = /^\[([0-9A-F]{16})\] (.*)$/
const TAG_RE = /\[([a-z]+): ([^\]]*)\]/g
const ENUM_VALUE_RE = /^\[0{16}\] (\S+?)::(\S+) \[n: [0-9A-F]+\] \[v: (-?\d+)\]$/

const CORE_KINDS = new Set(['Package', 'Class', 'ScriptStruct', 'Enum', 'Function'])

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

function isPropertyKind(kind: string): boolean {
  return kind.endsWith('Property')
}

function isIndexable(kind: string, name: string): boolean {
  if (name.startsWith('Default__')) return false
  return CORE_KINDS.has(kind) || kind.endsWith('BlueprintGeneratedClass')
}

export async function parseObjectDump(path: string): Promise<ParsedObjectDump> {
  const text = await Bun.file(path).text()
  const lines = text.split('\n')

  const addrRows = new Map<string, AddrRow>()
  const objectAddrs: string[] = []
  const memberAddrs: string[] = []
  const enumValues = new Map<string, Array<{ name: string; value: number }>>()
  const seq: Array<{ addr: string | null; row: AddrRow }> = []

  const counters: DumpCounters = {
    linesTotal: 0,
    objectsTotal: 0,
    objectsIndexed: 0,
    objectsSkippedByKind: 0,
    cdoSkipped: 0,
    propertyLines: 0,
    innerNoAddr: 0,
    enumValueLines: 0,
    unparsed: 0,
    unresolvedSps: 0,
    unresolvedOwr: 0,
    unresolvedPc: 0,
    unresolvedSs: 0,
    unresolvedAi: 0,
    unresolvedEm: 0,
    unresolvedMc: 0,
    unresolvedIc: 0,
    unresolvedDf: 0,
    unresolvedKv: 0,
  }

  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.length === 0) continue
    counters.linesTotal++

    const ev = ENUM_VALUE_RE.exec(line)
    if (ev) {
      counters.enumValueLines++
      const key = ev[1]
      let arr = enumValues.get(key)
      if (!arr) {
        arr = []
        enumValues.set(key, arr)
      }
      arr.push({ name: ev[2], value: parseInt(ev[3], 10) })
      continue
    }

    const m = ADDR_RE.exec(line)
    let addr: string | null = null
    let rest: string
    if (m) {
      addr = m[1]
      rest = m[2]
    } else {
      rest = line
    }

    const tagStart = rest.indexOf(' [')
    const head = tagStart >= 0 ? rest.slice(0, tagStart) : rest
    const tagPart = tagStart >= 0 ? rest.slice(tagStart) : ''

    const space = head.indexOf(' ')
    if (space < 0) {
      counters.unparsed++
      continue
    }
    const kind = head.slice(0, space)
    const rawPath = head.slice(space + 1)

    const tags: Record<string, string> = {}
    for (const t of tagPart.matchAll(TAG_RE)) tags[t[1]] = t[2]

    const isInnerForm = !rawPath.startsWith('/')

    const row: AddrRow = {
      kind,
      rawPath,
      offset: tags['o'] !== undefined ? parseInt(tags['o'], 16) : -1,
      sps: tags['sps'] ?? null,
      owr: tags['owr'] ?? null,
      pc: tags['pc'] ?? null,
      ss: tags['ss'] ?? null,
      ai: tags['ai'] ?? null,
      em: tags['em'] ?? null,
      mc: tags['mc'] ?? null,
      ic: tags['ic'] ?? null,
      df: tags['df'] ?? null,
      kp: tags['kp'] ?? null,
      vp: tags['vp'] ?? null,
      isInnerForm,
    }

    if (addr) {
      addrRows.set(addr, row)
      seq.push({ addr, row })
      if (isPropertyKind(kind)) {
        if (!isInnerForm && row.owr) {
          counters.propertyLines++
          memberAddrs.push(addr)
        }
      } else {
        counters.objectsTotal++
        objectAddrs.push(addr)
      }
    } else {
      if (isPropertyKind(kind) && isInnerForm) {
        counters.innerNoAddr++
        seq.push({ addr: null, row })
      } else {
        counters.unparsed++
      }
    }
  }

  const recent: Array<{ addr: string; row: AddrRow }> = []
  for (const e of seq) {
    if (e.addr) {
      recent.push({ addr: e.addr, row: e.row })
      if (recent.length > 8) recent.shift()
      continue
    }
    for (let i = recent.length - 1; i >= 0; i--) {
      let assigned = false
      for (const tag of ['ai', 'kp', 'vp'] as const) {
        const ref = recent[i].row[tag]
        if (ref && !addrRows.has(ref)) {
          addrRows.set(ref, e.row)
          assigned = true
          break
        }
      }
      if (assigned) break
    }
  }

  const resolveAddr = (hex: string | null): AddrRow | null => (hex ? (addrRows.get(hex) ?? null) : null)
  const classNameOf = (row: AddrRow | null): string | null => {
    if (!row) return null
    const p = row.rawPath
    const dot = p.lastIndexOf('.')
    return dot < 0 ? p : p.slice(dot + 1)
  }

  const resolveInner = (row: AddrRow | null, depth: number): string | null => {
    if (!row || depth > 8) return null
    const k = row.kind
    if (SCALAR_TYPES[k]) return SCALAR_TYPES[k]
    switch (k) {
      case 'ObjectProperty':
      case 'ClassProperty':
      case 'SoftObjectProperty':
      case 'SoftClassProperty':
      case 'WeakObjectProperty':
      case 'LazyObjectProperty':
      case 'AssetObjectProperty':
      case 'ObjectPtrProperty': {
        const target = resolveAddr(row.pc ?? row.mc)
        if (!target) {
          counters.unresolvedPc++
          return null
        }
        return classNameOf(target)
      }
      case 'InterfaceProperty': {
        const target = resolveAddr(row.ic)
        if (!target) {
          counters.unresolvedIc++
          return null
        }
        return classNameOf(target)
      }
      case 'StructProperty': {
        const target = resolveAddr(row.ss)
        if (!target) {
          counters.unresolvedSs++
          return null
        }
        return classNameOf(target)
      }
      case 'EnumProperty': {
        const target = resolveAddr(row.em)
        if (!target) {
          counters.unresolvedEm++
          return null
        }
        return classNameOf(target)
      }
      case 'ByteProperty': {
        const target = resolveAddr(row.em)
        if (target) return classNameOf(target)
        return 'byte'
      }
      case 'ArrayProperty': {
        const inner = resolveAddr(row.ai)
        if (!inner) {
          counters.unresolvedAi++
          return null
        }
        const innerName = resolveInner(inner, depth + 1)
        return innerName ? `TArray<${innerName}>` : null
      }
      case 'SetProperty': {
        const inner = resolveAddr(row.ai)
        if (!inner) return null
        const innerName = resolveInner(inner, depth + 1)
        return innerName ? `TSet<${innerName}>` : null
      }
      case 'MapProperty': {
        const keyRow = resolveAddr(row.kp)
        const valRow = resolveAddr(row.vp)
        if (!keyRow || !valRow) {
          counters.unresolvedKv++
          return null
        }
        const kn = resolveInner(keyRow, depth + 1)
        const vn = resolveInner(valRow, depth + 1)
        return kn && vn ? `TMap<${kn}, ${vn}>` : null
      }
      case 'DelegateProperty':
      case 'MulticastDelegateProperty':
      case 'MulticastInlineDelegateProperty':
      case 'MulticastSparseDelegateProperty': {
        const target = resolveAddr(row.df)
        if (!target) {
          counters.unresolvedDf++
          return null
        }
        return classNameOf(target)
      }
      default:
        return null
    }
  }

  const resolveMemberType = (row: AddrRow): ResolvedType => {
    const k = row.kind
    if (SCALAR_TYPES[k]) return { typeName: SCALAR_TYPES[k], innerType: null }

    if (k === 'ArrayProperty' || k === 'SetProperty') {
      const inner = resolveAddr(row.ai)
      if (!inner) {
        if (k === 'ArrayProperty') counters.unresolvedAi++
        return { typeName: k === 'ArrayProperty' ? 'TArray' : 'TSet', innerType: null }
      }
      const innerName = resolveInner(inner, 1)
      return { typeName: k === 'ArrayProperty' ? 'TArray' : 'TSet', innerType: innerName }
    }
    if (k === 'MapProperty') {
      const keyRow = resolveAddr(row.kp)
      const valRow = resolveAddr(row.vp)
      if (!keyRow || !valRow) {
        counters.unresolvedKv++
        return { typeName: 'TMap', innerType: null }
      }
      const kn = resolveInner(keyRow, 1)
      const vn = resolveInner(valRow, 1)
      return { typeName: 'TMap', innerType: kn && vn ? `${kn}, ${vn}` : null }
    }

    const single = resolveInner(row, 0)
    return { typeName: single, innerType: null }
  }

  const objects: ObjectParsed[] = []
  for (const addr of objectAddrs) {
    const row = addrRows.get(addr)!
    const name = lastSegment(row.rawPath)
    if (name.startsWith('Default__')) {
      counters.cdoSkipped++
      continue
    }
    if (!isIndexable(row.kind, name)) {
      counters.objectsSkippedByKind++
      continue
    }
    counters.objectsIndexed++
    objects.push({
      addr,
      kind: row.kind,
      rawPath: row.rawPath,
      isBlueprint: row.kind.endsWith('BlueprintGeneratedClass'),
    })
  }

  const ordinals = new Map<string, number>()
  const members: MemberParsed[] = []
  for (const addr of memberAddrs) {
    const row = addrRows.get(addr)!
    const owner = resolveAddr(row.owr)
    if (!owner) {
      counters.unresolvedOwr++
      continue
    }
    const ownerPath = owner.rawPath
    const nameColon = row.rawPath.lastIndexOf(':')
    const nameDot = row.rawPath.lastIndexOf('.')
    const cut = Math.max(nameColon, nameDot)
    const name = cut < 0 ? row.rawPath : row.rawPath.slice(cut + 1)
    const ordKey = ownerPath
    const ordinal = ordinals.get(ordKey) ?? 0
    ordinals.set(ordKey, ordinal + 1)
    members.push({
      ownerAddr: row.owr!,
      name,
      propKind: row.kind,
      offset: row.offset,
      ordinal,
      resolved: resolveMemberType(row),
    })
  }

  return { objects, members, enumValues, addrRows, counters }
}

export type DumpMember = {
  offset: number
  propKind: string
  name: string
  ordinal: number
}

export type DumpObject = {
  dumpIndex: number
  addr: string
  kind: string
  path: string
  package: string
  name: string
  outerPath: string | null
  members: DumpMember[]
}

const OBJECT_RE = /^\[([0-9A-F]{8})\] \{(0x[0-9a-f]+)\} (\w+) (.+)$/
const MEMBER_RE = /^\[([0-9A-F]{8})\] \{(0x[0-9a-f]+)\}     (\w+) (.+)$/

export async function* parseGObjectsDump(path: string): AsyncGenerator<DumpObject> {
  const text = await Bun.file(path).text()
  let current: DumpObject | null = null
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.length === 0) continue

    const m = MEMBER_RE.exec(line)
    if (m && current) {
      current.members.push({
        offset: parseInt(m[1], 16),
        propKind: m[3],
        name: m[4],
        ordinal: current.members.length,
      })
      continue
    }
    const o = OBJECT_RE.exec(line)
    if (!o) continue
    if (current) yield current
    const path = o[4]
    const firstDot = path.indexOf('.')
    const lastDot = path.lastIndexOf('.')
    current = {
      dumpIndex: parseInt(o[1], 16),
      addr: o[2],
      kind: o[3],
      path,
      package: firstDot === -1 ? path : path.slice(0, firstDot),
      name: path.slice(lastDot + 1),
      outerPath: lastDot === -1 ? null : path.slice(0, lastDot),
      members: [],
    }
  }
  if (current) yield current
}

export const BP_KINDS = new Set([
  'BlueprintGeneratedClass',
  'WidgetBlueprintGeneratedClass',
  'AnimBlueprintGeneratedClass',
])

export const OLD_SCALAR_TYPES: Record<string, string> = {
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
  ArrayProperty: 'TArray',
  SetProperty: 'TSet',
  MapProperty: 'TMap',
}

export const USMAP_T = {
  Byte: 0,
  Bool: 1,
  Int: 2,
  Float: 3,
  Object: 4,
  Name: 5,
  Delegate: 6,
  Double: 7,
  Array: 8,
  Struct: 9,
  Str: 10,
  Text: 11,
  Interface: 12,
  MulticastDelegate: 13,
  WeakObject: 14,
  LazyObject: 15,
  AssetObject: 16,
  SoftObject: 17,
  UInt64: 18,
  UInt32: 19,
  UInt16: 20,
  Int64: 21,
  Int16: 22,
  Int8: 23,
  Map: 24,
  Set: 25,
  Enum: 26,
  FieldPath: 27,
  Optional: 28,
  Utf8Str: 29,
  AnsiStr: 30,
} as const

export interface UsmapType {
  t: number
  structNameIdx?: number
  enumNameIdx?: number
  inner?: UsmapType
  key?: UsmapType
  value?: UsmapType
}

export interface UsmapProp {
  index: number
  arrayDim: number
  nameIdx: number
  type: UsmapType
}

export interface UsmapEnum {
  nameIdx: number
  values: Array<{ value: number; nameIdx: number }>
  pathIdx: number | null
}

export interface UsmapSchema {
  nameIdx: number
  superNameIdx: number | null
  props: UsmapProp[]
  pathIdx: number | null
}

export interface UsmapData {
  version: number
  names: string[]
  enums: UsmapEnum[]
  schemas: UsmapSchema[]
}

export class UsmapError extends Error {}

class Reader {
  pos = 0
  view: DataView
  constructor(private readonly buf: Buffer) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  }
  u8(): number {
    return this.buf[this.pos++]
  }
  u16(): number {
    const v = this.view.getUint16(this.pos, true)
    this.pos += 2
    return v
  }
  i32(): number {
    const v = this.view.getInt32(this.pos, true)
    this.pos += 4
    return v
  }
  u32(): number {
    const v = this.view.getUint32(this.pos, true)
    this.pos += 4
    return v
  }
  i64AsNumber(): number {
    const v = this.view.getBigInt64(this.pos, true)
    this.pos += 8
    return Number(v)
  }
  bytes(n: number): Buffer {
    const v = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return v
  }
  get remaining(): number {
    return this.buf.length - this.pos
  }
}

function readType(r: Reader, depth: number): UsmapType {
  if (depth > 12) throw new UsmapError('слишком глубокий вложенный тип')
  const t = r.u8()
  const out: UsmapType = { t }
  switch (t) {
    case USMAP_T.Enum: {
      out.inner = readType(r, depth + 1)
      out.enumNameIdx = r.i32()
      break
    }
    case USMAP_T.Struct: {
      out.structNameIdx = r.i32()
      break
    }
    case USMAP_T.Set: {
      out.inner = readType(r, depth + 1)
      break
    }
    case USMAP_T.Array: {
      out.inner = readType(r, depth + 1)
      break
    }
    case USMAP_T.Map: {
      out.key = readType(r, depth + 1)
      out.value = readType(r, depth + 1)
      break
    }
    case USMAP_T.Optional: {
      out.inner = readType(r, depth + 1)
      break
    }
    default:
      break
  }
  return out
}

export function usmapTypeToString(t: UsmapType, names: string[]): string {
  const nameOf = (idx?: number) => (idx !== undefined ? names[idx] : 'unknown')
  switch (t.t) {
    case USMAP_T.Byte:
      return 'byte'
    case USMAP_T.Bool:
      return 'bool'
    case USMAP_T.Int:
      return 'int32'
    case USMAP_T.Float:
      return 'float'
    case USMAP_T.Double:
      return 'double'
    case USMAP_T.Object:
      return 'UObject'
    case USMAP_T.Name:
      return 'FName'
    case USMAP_T.Delegate:
    case USMAP_T.MulticastDelegate:
      return 'delegate'
    case USMAP_T.Array:
      return `TArray<${t.inner ? usmapTypeToString(t.inner, names) : 'unknown'}>`
    case USMAP_T.Struct:
      return nameOf(t.structNameIdx)
    case USMAP_T.Str:
      return 'FString'
    case USMAP_T.Text:
      return 'FText'
    case USMAP_T.Interface:
      return 'TScriptInterface'
    case USMAP_T.WeakObject:
    case USMAP_T.LazyObject:
    case USMAP_T.AssetObject:
    case USMAP_T.SoftObject:
      return 'UObject'
    case USMAP_T.UInt64:
      return 'uint64'
    case USMAP_T.UInt32:
      return 'uint32'
    case USMAP_T.UInt16:
      return 'uint16'
    case USMAP_T.Int64:
      return 'int64'
    case USMAP_T.Int16:
      return 'int16'
    case USMAP_T.Int8:
      return 'int8'
    case USMAP_T.Map:
      return `TMap<${t.key ? usmapTypeToString(t.key, names) : 'unknown'}, ${t.value ? usmapTypeToString(t.value, names) : 'unknown'}>`
    case USMAP_T.Set:
      return `TSet<${t.inner ? usmapTypeToString(t.inner, names) : 'unknown'}>`
    case USMAP_T.Enum:
      return nameOf(t.enumNameIdx)
    case USMAP_T.FieldPath:
      return 'FieldPath'
    case USMAP_T.Optional:
      return `TOptional<${t.inner ? usmapTypeToString(t.inner, names) : 'unknown'}>`
    case USMAP_T.Utf8Str:
      return 'Utf8String'
    case USMAP_T.AnsiStr:
      return 'AnsiString'
    default:
      return 'unknown'
  }
}

const CEXT_MAGIC = 0x54584543
const PPTH_ID = 0x48545050

export async function parseUsmap(path: string): Promise<UsmapData> {
  const buf = Buffer.from(await Bun.file(path).arrayBuffer())
  const r = new Reader(buf)

  const magic = r.u16()
  if (magic !== 0x30c4) throw new UsmapError(`не usmap: magic=0x${magic.toString(16)}`)
  const version = r.u8()
  r.i32()
  const compression = r.u8()
  r.u32()
  r.u32()
  if (compression !== 0) throw new UsmapError(`сжатие ${compression} не поддерживается`)
  if (version < 4) throw new UsmapError(`версия ${version} < 4 (ExplicitEnumValues)`)

  const nameCount = r.u32()
  const names: string[] = new Array(nameCount)
  for (let i = 0; i < nameCount; i++) {
    const len = r.u16()
    names[i] = r.bytes(len).toString('utf8')
  }

  const enumCount = r.u32()
  const enums: UsmapEnum[] = []
  for (let i = 0; i < enumCount; i++) {
    const nameIdx = r.i32()
    const valueCount = r.u16()
    const values: Array<{ value: number; nameIdx: number }> = []
    for (let v = 0; v < valueCount; v++) {
      const value = r.i64AsNumber()
      const vnIdx = r.i32()
      values.push({ value, nameIdx: vnIdx })
    }
    enums.push({ nameIdx, values, pathIdx: null })
  }

  const schemaCount = r.u32()
  const schemas: UsmapSchema[] = []
  for (let i = 0; i < schemaCount; i++) {
    const nameIdx = r.i32()
    const superRaw = r.i32()
    const superNameIdx = superRaw === -1 ? null : superRaw
    r.u16()
    const serializableCount = r.u16()
    const props: UsmapProp[] = []
    for (let p = 0; p < serializableCount; p++) {
      const index = r.u16()
      const arrayDim = r.u8()
      const propNameIdx = r.i32()
      const type = readType(r, 0)
      props.push({ index, arrayDim, nameIdx: propNameIdx, type })
    }
    schemas.push({ nameIdx, superNameIdx, props, pathIdx: null })
  }

  if (r.remaining >= 9) {
    const extMagic = r.u32()
    if (extMagic === CEXT_MAGIC) {
      r.u8()
      const extCount = r.u32()
      for (let e = 0; e < extCount; e++) {
        const id = r.u32()
        const size = r.u32()
        const end = r.pos + size
        if (id === PPTH_ID) {
          r.u8()
          const enumPaths = r.u32()
          for (let i = 0; i < enumPaths && i < enums.length; i++) enums[i].pathIdx = r.i32()
          for (let i = enumPaths; i < enumPaths; i++) r.i32()
          const schemaPaths = r.u32()
          for (let i = 0; i < schemaPaths && i < schemas.length; i++) schemas[i].pathIdx = r.i32()
        }
        r.pos = end
      }
    }
  }

  return { version, names, enums, schemas }
}

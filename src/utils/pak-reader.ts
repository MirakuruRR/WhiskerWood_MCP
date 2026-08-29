import { closeSync, openSync, readSync, statSync } from 'node:fs'

const FOOTER_SIZE = 221
const PAK_MAGIC = 0x5a6f12e1
const ENTRY_HEADER_SIZE = 53

class Reader {
  pos = 0
  constructor(private readonly buf: Buffer) {}

  u32(): number {
    const v = this.buf.readUInt32LE(this.pos)
    this.pos += 4
    return v
  }

  i32(): number {
    const v = this.buf.readInt32LE(this.pos)
    this.pos += 4
    return v
  }

  u64(): bigint {
    const v = this.buf.readBigUInt64LE(this.pos)
    this.pos += 8
    return v
  }

  i64(): bigint {
    const v = this.buf.readBigInt64LE(this.pos)
    this.pos += 8
    return v
  }

  raw(n: number): Buffer {
    const v = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return v
  }

  fstring(): string {
    const n = this.i32()
    if (n === 0) return ''
    if (n < 0) {
      const s = this.buf.toString('utf16le', this.pos, this.pos - 2 * n)
      this.pos += -2 * n
      return s.replace(/\0+$/, '')
    }
    const s = this.buf.toString('utf8', this.pos, this.pos + n)
    this.pos += n
    return s.replace(/\0+$/, '')
  }
}

interface PakEntry {
  method: number
  encrypted: boolean
  offset: bigint
  usize: bigint
  size: bigint
}

function decodeEntry(blob: Buffer, offset: number): PakEntry {
  const r = new Reader(blob.subarray(offset))
  const v = r.u32()
  const method = (v >>> 23) & 0x3f
  const entry: PakEntry = {
    method,
    encrypted: (v & (1 << 22)) !== 0,
    offset: v & (1 << 31) ? BigInt(r.u32()) : r.u64(),
    usize: v & (1 << 30) ? BigInt(r.u32()) : r.u64(),
    size: 0n,
  }
  entry.size = method !== 0 ? (v & (1 << 29) ? BigInt(r.u32()) : r.u64()) : entry.usize
  return entry
}

export class PakError extends Error {}

export class PakReader {
  private readonly fd: number
  private readonly files = new Map<string, number>()
  private encoded: Buffer = Buffer.alloc(0)
  readonly mountPoint: string
  readonly version: number
  readonly count: number

  constructor(private readonly path: string) {
    const size = statSync(path).size
    this.fd = openSync(path, 'r')
    const footer = Buffer.alloc(FOOTER_SIZE)
    readSync(this.fd, footer, 0, FOOTER_SIZE, size - FOOTER_SIZE)

    const encryptedIndex = footer[16] !== 0
    const magic = footer.readUInt32LE(17)
    this.version = footer.readUInt32LE(21)
    if (magic !== PAK_MAGIC) throw new PakError(`${path}: не UE pak (magic=0x${magic.toString(16)})`)
    if (encryptedIndex) throw new PakError(`${path}: индекс зашифрован AES`)

    const indexOffset = Number(footer.readBigUInt64LE(25))
    const indexSize = Number(footer.readBigUInt64LE(33))

    const index = Buffer.alloc(indexSize)
    readSync(this.fd, index, 0, indexSize, indexOffset)
    const r = new Reader(index)
    this.mountPoint = r.fstring()
    this.count = r.i32()
    r.u64()
    if (r.i32()) {
      r.i64()
      r.i64()
      r.raw(20)
    }
    let fullDirOffset = 0
    let fullDirSize = 0
    if (r.i32()) {
      fullDirOffset = Number(r.i64())
      fullDirSize = Number(r.i64())
      r.raw(20)
    }
    this.encoded = Buffer.from(r.raw(r.i32()))

    if (!fullDirOffset) throw new PakError(`${path}: нет полного каталога имён`)
    const dir = Buffer.alloc(fullDirSize)
    readSync(this.fd, dir, 0, fullDirSize, fullDirOffset)
    const d = new Reader(dir)
    const dirCount = d.i32()
    for (let i = 0; i < dirCount; i++) {
      const directory = d.fstring()
      const fileCount = d.i32()
      for (let j = 0; j < fileCount; j++) {
        const name = d.fstring()
        this.files.set(directory + name, d.u32())
      }
    }
  }

  has(pakPath: string): boolean {
    return this.files.has(pakPath)
  }

  list(pattern?: RegExp): string[] {
    const all = [...this.files.keys()].sort()
    if (!pattern) return all
    return all.filter((p) => pattern.test(p))
  }

  read(pakPath: string): Buffer {
    const off = this.files.get(pakPath)
    if (off === undefined) throw new PakError(`в паке нет: ${pakPath}`)
    const e = decodeEntry(this.encoded, off)
    if (e.encrypted) throw new PakError(`${pakPath}: запись зашифрована`)
    if (e.method !== 0) throw new PakError(`${pakPath}: запись сжата`)
    const payload = Buffer.alloc(Number(e.size))
    readSync(this.fd, payload, 0, payload.length, Number(e.offset) + ENTRY_HEADER_SIZE)
    return payload
  }

  readText(pakPath: string): string {
    return this.read(pakPath).toString('utf8')
  }

  close(): void {
    closeSync(this.fd)
  }
}

import { deflateRawSync, inflateRawSync } from 'node:zlib'

export interface ZipEntry {
  path: string
  data: Buffer
}

const CRC_TABLE = new Int32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[i] = c
}

function crc32(buf: Buffer): number {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function dosStamp(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

const UTF8_NAMES = 0x0800

export function createZip(entries: ZipEntry[], mtime: Date = new Date()): Buffer {
  const { time, date } = dosStamp(mtime)
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.path.replace(/\\/g, '/'), 'utf8')
    const crc = crc32(entry.data)
    const deflated = deflateRawSync(entry.data, { level: 9 })
    const stored = deflated.length >= entry.data.length
    const body = stored ? entry.data : deflated
    const method = stored ? 0 : 8

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(UTF8_NAMES, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, body)

    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(UTF8_NAMES, 8)
    dir.writeUInt16LE(method, 10)
    dir.writeUInt16LE(time, 12)
    dir.writeUInt16LE(date, 14)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(body.length, 20)
    dir.writeUInt32LE(entry.data.length, 24)
    dir.writeUInt16LE(name.length, 28)
    dir.writeUInt16LE(0, 30)
    dir.writeUInt16LE(0, 32)
    dir.writeUInt16LE(0, 34)
    dir.writeUInt16LE(0, 36)
    dir.writeUInt32LE(0, 38)
    dir.writeUInt32LE(offset, 42)
    central.push(dir, name)

    offset += 30 + name.length + body.length
  }

  const directory = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, directory, eocd])
}

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50

export class ZipReadError extends Error {}

/** Достаточно для наших релизных архивов: store/deflate, без zip64, без шифрования. */
export function extractZip(buf: Buffer): ZipEntry[] {
  const minPos = Math.max(0, buf.length - 22 - 0xffff)
  let eocdPos = -1
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocdPos = i
      break
    }
  }
  if (eocdPos < 0) throw new ZipReadError('не ZIP-архив: End Of Central Directory не найден')

  const totalEntries = buf.readUInt16LE(eocdPos + 10)
  let pos = buf.readUInt32LE(eocdPos + 16)

  const entries: ZipEntry[] = []
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CENTRAL_SIG) {
      throw new ZipReadError(`битая центральная директория: запись ${i}`)
    }
    const method = buf.readUInt16LE(pos + 10)
    const compressedSize = buf.readUInt32LE(pos + 20)
    const uncompressedSize = buf.readUInt32LE(pos + 24)
    const nameLen = buf.readUInt16LE(pos + 28)
    const extraLen = buf.readUInt16LE(pos + 30)
    const commentLen = buf.readUInt16LE(pos + 32)
    const localOffset = buf.readUInt32LE(pos + 42)
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen).replace(/\\/g, '/')
    pos += 46 + nameLen + extraLen + commentLen

    if (name.endsWith('/')) continue // запись каталога — сами каталоги создаём по путям файлов
    if (method !== 0 && method !== 8) throw new ZipReadError(`неподдержанный метод сжатия ${method} в ${name}`)

    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const compressed = buf.subarray(dataStart, dataStart + compressedSize)
    const data = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed)
    if (data.length !== uncompressedSize) throw new ZipReadError(`размер после распаковки не совпадает: ${name}`)
    entries.push({ path: name, data })
  }
  return entries
}

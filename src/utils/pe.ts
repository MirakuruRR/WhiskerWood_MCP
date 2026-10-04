export class PeError extends Error {}

interface Section {
  va: number
  size: number
  raw: number
}

export interface PeImage {
  machine: number
  is64: boolean
  exports: string[]
  imports: Map<string, string[]>
}

function cstr(buf: Buffer, off: number): string {
  const end = buf.indexOf(0, off)
  return buf.toString('latin1', off, end < 0 ? buf.length : end)
}

export function parsePe(buf: Buffer): PeImage {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) throw new PeError('нет сигнатуры MZ')
  const pe = buf.readUInt32LE(0x3c)
  if (pe + 24 > buf.length || buf.readUInt32LE(pe) !== 0x4550) throw new PeError('нет сигнатуры PE')
  const machine = buf.readUInt16LE(pe + 4)
  const nSections = buf.readUInt16LE(pe + 6)
  const optSize = buf.readUInt16LE(pe + 20)
  const opt = pe + 24
  const magic = buf.readUInt16LE(opt)
  if (magic !== 0x10b && magic !== 0x20b) throw new PeError(`неизвестный optional header 0x${magic.toString(16)}`)
  const is64 = magic === 0x20b
  const nDirs = buf.readUInt32LE(opt + (is64 ? 108 : 92))
  const dirs = opt + (is64 ? 112 : 96)
  const dir = (i: number): { rva: number; size: number } =>
    i < nDirs ? { rva: buf.readUInt32LE(dirs + i * 8), size: buf.readUInt32LE(dirs + i * 8 + 4) } : { rva: 0, size: 0 }

  const sections: Section[] = []
  const secTable = opt + optSize
  for (let i = 0; i < nSections; i++) {
    const s = secTable + i * 40
    sections.push({ va: buf.readUInt32LE(s + 12), size: Math.max(buf.readUInt32LE(s + 8), buf.readUInt32LE(s + 16)), raw: buf.readUInt32LE(s + 20) })
  }
  const off = (rva: number): number => {
    const s = sections.find((x) => rva >= x.va && rva < x.va + x.size)
    if (!s) throw new PeError(`RVA 0x${rva.toString(16)} вне секций`)
    return rva - s.va + s.raw
  }

  const exports: string[] = []
  const ex = dir(0)
  if (ex.rva !== 0) {
    const e = off(ex.rva)
    const nNames = buf.readUInt32LE(e + 24)
    const names = off(buf.readUInt32LE(e + 32))
    for (let i = 0; i < nNames; i++) exports.push(cstr(buf, off(buf.readUInt32LE(names + i * 4))))
  }

  const imports = new Map<string, string[]>()
  const im = dir(1)
  if (im.rva !== 0) {
    for (let d = off(im.rva); d + 20 <= buf.length; d += 20) {
      const lookup = buf.readUInt32LE(d) || buf.readUInt32LE(d + 16)
      const nameRva = buf.readUInt32LE(d + 12)
      if (lookup === 0 && nameRva === 0) break
      const names: string[] = []
      const step = is64 ? 8 : 4
      for (let t = off(lookup); ; t += step) {
        const lo = buf.readUInt32LE(t)
        const hi = is64 ? buf.readUInt32LE(t + 4) : 0
        if (lo === 0 && hi === 0) break
        const byOrdinal = is64 ? (hi & 0x80000000) !== 0 : (lo & 0x80000000) !== 0
        names.push(byOrdinal ? `#${lo & 0xffff}` : cstr(buf, off(lo & 0x7fffffff) + 2))
      }
      const dll = cstr(buf, off(nameRva)).toLowerCase()
      imports.set(dll, [...(imports.get(dll) ?? []), ...names])
    }
  }
  return { machine, is64, exports, imports }
}

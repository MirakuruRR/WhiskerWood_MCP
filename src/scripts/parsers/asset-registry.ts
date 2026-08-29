export interface RegistryAsset {
  parentPath: string
  classPackage: string
  className: string
  pkgPath: string
  assetName: string
}

export interface ParsedAssetRegistry {
  names: string[]
  assets: RegistryAsset[]
  recordsSkippedByResync: number
}

export class AssetRegistryError extends Error {}

export async function parseAssetRegistry(path: string): Promise<ParsedAssetRegistry> {
  const buf = Buffer.from(await Bun.file(path).arrayBuffer())
  if (buf.length < 64) throw new AssetRegistryError('файл слишком мал')

  const nameCount = buf.readUInt32LE(24)
  const blobSize = buf.readUInt32LE(28)
  if (nameCount === 0 || nameCount > 1_000_000) throw new AssetRegistryError(`подозрительный nameCount=${nameCount}`)

  const hashStart = 40
  const headerStart = hashStart + nameCount * 8
  const blobStart = headerStart + nameCount * 2
  if (blobStart + blobSize > buf.length) throw new AssetRegistryError('блом имён выходит за пределы файла')

  const names: string[] = new Array(nameCount)
  let off = blobStart
  for (let i = 0; i < nameCount; i++) {
    const b0 = buf[headerStart + i * 2]
    const b1 = buf[headerStart + i * 2 + 1]
    const wide = (b0 & 0x80) !== 0
    const len = ((b0 & 0x7f) << 8) | b1
    names[i] = wide ? buf.toString('utf16le', off, off + len * 2) : buf.toString('utf8', off, off + len)
    off += wide ? len * 2 : len
  }
  const blobEnd = blobStart + blobSize
  if (Math.abs(off - blobEnd) > 1) {
    throw new AssetRegistryError(`расхождение размера блоба имён: вычислено ${off}, заявлено ${blobEnd}`)
  }

  const validAt = (o: number): boolean => {
    if (o + 20 > buf.length) return false
    const v1 = buf.readUInt32LE(o + 4)
    const v2 = buf.readUInt32LE(o + 8)
    const v3 = buf.readUInt32LE(o + 12) & 0x7fffffff
    const v4 = buf.readUInt32LE(o + 16)
    if (v1 >= nameCount || v2 >= nameCount || v3 >= nameCount || v4 >= nameCount) return false
    const n1 = names[v1]
    const n2 = names[v2]
    const n3 = names[v3]
    const n4 = names[v4]
    return n1.startsWith('/') && !n2.includes('/') && n3.startsWith('/') && !n4.includes('/')
  }

  let start = -1
  for (let o = blobEnd; o <= buf.length - 44 * 8; o++) {
    if (!validAt(o)) continue
    let ok = true
    for (let k = 1; k < 8; k++) {
      if (!validAt(o + 44 * k)) {
        ok = false
        break
      }
    }
    if (ok) {
      start = o
      break
    }
  }
  if (start < 0) throw new AssetRegistryError('массив записей ассетов не найден')

  const assets: RegistryAsset[] = []
  let skipped = 0
  let o = start
  while (o + 20 <= buf.length) {
    if (validAt(o)) {
      const parentPath = names[buf.readUInt32LE(o)]
      const classPackage = names[buf.readUInt32LE(o + 4)]
      const className = names[buf.readUInt32LE(o + 8)]
      const pkgPath = names[buf.readUInt32LE(o + 12) & 0x7fffffff]
      const assetName = names[buf.readUInt32LE(o + 16)]
      assets.push({ parentPath, classPackage, className, pkgPath, assetName })
      o += 44
      continue
    }
    let next = -1
    for (let t = o + 44; t <= Math.min(o + 8192, buf.length - 20); t += 4) {
      if (validAt(t)) {
        next = t
        break
      }
    }
    if (next < 0) break
    skipped += Math.round((next - o) / 4)
    o = next
  }

  if (assets.length < 100) {
    throw new AssetRegistryError(`подозрительно мало записей ассетов: ${assets.length}`)
  }
  return { names, assets, recordsSkippedByResync: skipped }
}

import { PakReader } from './pak-reader'

const readers = new Map<string, PakReader>()

export function pakReaderFor(pakPath: string): PakReader {
  const cached = readers.get(pakPath)
  if (cached) return cached
  const reader = new PakReader(pakPath)
  readers.set(pakPath, reader)
  return reader
}

export function closePakReaders(): void {
  for (const r of readers.values()) r.close()
  readers.clear()
}

const KNOWN_EXTENSIONS = ['.uasset', '.umap', '.uexp', '.ubulk', '.uptnl', '.ini', '.bin']

function stripExtension(p: string): { base: string; ext: string | null } {
  for (const ext of KNOWN_EXTENSIONS) {
    if (p.toLowerCase().endsWith(ext)) return { base: p.slice(0, -ext.length), ext }
  }
  return { base: p, ext: null }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface ResolvedAsset {
  status: 'ok' | 'not_found' | 'ambiguous'
  base?: string
  files?: string[]
  candidates?: string[]
}

// /Game/UI/Foo → Whiskerwood/Content/UI/Foo; вне /Game и /Engine ищем по имени в паке
export function resolveAssetInPak(reader: PakReader, input: string): ResolvedAsset {
  const cleaned = input.replace(/\\/g, '/').trim()
  const withoutObject = cleaned.includes('.') && !stripExtension(cleaned).ext ? cleaned.split('.')[0] : cleaned
  const { base, ext } = stripExtension(withoutObject)

  const candidates: string[] = []
  if (base.startsWith('/Game/')) candidates.push(`Whiskerwood/Content/${base.slice('/Game/'.length)}`)
  else if (base.startsWith('/Engine/')) candidates.push(`Engine/Content/${base.slice('/Engine/'.length)}`)
  else if (base.startsWith('/')) candidates.push(base.slice(1))
  else candidates.push(base)

  for (const candidate of candidates) {
    const files = ext
      ? reader.has(candidate + ext)
        ? [candidate + ext]
        : []
      : reader.list(new RegExp(`^${escapeRegex(candidate)}\\.[A-Za-z0-9]+$`))
    if (files.length > 0) return { status: 'ok', base: candidate, files }
  }

  const name = base.split('/').pop() ?? base
  const byName = reader.list(new RegExp(`(^|/)${escapeRegex(name)}\\.uasset$`, 'i'))
  if (byName.length === 1) {
    const found = stripExtension(byName[0]).base
    return { status: 'ok', base: found, files: reader.list(new RegExp(`^${escapeRegex(found)}\\.[A-Za-z0-9]+$`)) }
  }
  if (byName.length > 1) return { status: 'ambiguous', candidates: byName.slice(0, 10) }
  return { status: 'not_found' }
}

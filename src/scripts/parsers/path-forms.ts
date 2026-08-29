export interface NormalizedPath {
  indexPath: string
  gameFullPath: string | null
  hadColon: boolean
  fromMount: boolean
}

function splitClassFunc(s: string): [string, string | null] {
  const i = s.lastIndexOf(':')
  if (i < 0) return [s, null]
  return [s.slice(0, i), s.slice(i + 1)]
}

export function normalizeDumpPath(rawPath: string): NormalizedPath {
  const [classPart, func] = splitClassFunc(rawPath)

  if (classPart.startsWith('/Script/')) {
    const dotted = classPart.slice('/Script/'.length).replace(/\//g, '.')
    return {
      indexPath: func ? `${dotted}.${func}` : dotted,
      gameFullPath: null,
      hadColon: func !== null,
      fromMount: false,
    }
  }

  if (classPart.startsWith('/')) {
    const lastSlash = classPart.lastIndexOf('/')
    const tail = classPart.slice(lastSlash + 1)
    const indexPath = func ? `${tail}.${func}` : tail
    const fullClass = classPart
    return {
      indexPath,
      gameFullPath: func ? `${fullClass}:${func}` : fullClass,
      hadColon: func !== null,
      fromMount: true,
    }
  }

  return { indexPath: classPart, gameFullPath: null, hadColon: func !== null, fromMount: false }
}

export function normalizeUserPath(input: string): NormalizedPath {
  const s = input.trim()
  if (s.startsWith('/')) return normalizeDumpPath(s)
  return { indexPath: s, gameFullPath: null, hadColon: false, fromMount: false }
}

export function lastSegment(indexPath: string): string {
  const i = indexPath.lastIndexOf('.')
  return i < 0 ? indexPath : indexPath.slice(i + 1)
}

export function outerOf(indexPath: string): string | null {
  const i = indexPath.lastIndexOf('.')
  return i < 0 ? null : indexPath.slice(0, i)
}

export function packageOf(indexPath: string): string {
  const i = indexPath.indexOf('.')
  return i < 0 ? indexPath : indexPath.slice(0, i)
}

export function toHookForm(indexPath: string, isFunction: boolean): string {
  if (!isFunction) return `/Script/${indexPath}`
  const i = indexPath.lastIndexOf('.')
  if (i < 0) return `/Script/${indexPath}`
  return `/Script/${indexPath.slice(0, i)}:${indexPath.slice(i + 1)}`
}

export function bpHookForm(assetPath: string, className: string, funcName: string | null): string {
  const classPath = `${assetPath}.${className}`
  return funcName ? `${classPath}:${funcName}` : classPath
}

export interface NormalizedPath {
  indexPath: string
  gameFullPath: string | null
  hadColon: boolean
  fromMount: boolean
  assetPath: string | null
  isModPath: boolean
}

function splitClassFunc(s: string): [string, string | null] {
  const i = s.lastIndexOf(':')
  if (i < 0) return [s, null]
  return [s.slice(0, i), s.slice(i + 1)]
}

/** `/Game/UI/BP_PlayHud.BP_PlayHud_C` + опциональная функция → путь ассета `/Game/UI/BP_PlayHud`. */
export function assetPathOf(gameFullPath: string): string | null {
  const [classPart] = splitClassFunc(gameFullPath)
  if (!classPart.startsWith('/')) return null
  const dot = classPart.lastIndexOf('.')
  return dot < 0 ? classPart : classPart.slice(0, dot)
}

export function isModAssetPath(path: string): boolean {
  return path.startsWith('/Game/Mods/') || path.startsWith('/Game/Mods\\')
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
      assetPath: null,
      isModPath: false,
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
      assetPath: assetPathOf(fullClass),
      isModPath: isModAssetPath(fullClass),
    }
  }

  return {
    indexPath: classPart,
    gameFullPath: null,
    hadColon: func !== null,
    fromMount: false,
    assetPath: null,
    isModPath: false,
  }
}

export function normalizeUserPath(input: string): NormalizedPath {
  const s = input.trim()
  if (s.startsWith('/')) return normalizeDumpPath(s)
  const [classPart, func] = splitClassFunc(s)
  return {
    indexPath: func ? `${classPart}.${func}` : classPart,
    gameFullPath: null,
    hadColon: func !== null,
    fromMount: false,
    assetPath: null,
    isModPath: false,
  }
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

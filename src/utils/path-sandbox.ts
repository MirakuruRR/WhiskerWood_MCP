import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'

const IS_WINDOWS = process.platform === 'win32'

function sameSegment(a: string, b: string): boolean {
  return IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b
}

function segments(p: string): string[] {
  return p.split(sep).filter((s) => s.length > 0 && s !== '.')
}

function isWithin(rootSegs: string[], candidateSegs: string[]): boolean {
  if (candidateSegs.length < rootSegs.length) return false
  for (let i = 0; i < rootSegs.length; i++) {
    if (!sameSegment(rootSegs[i], candidateSegs[i])) return false
  }
  return true
}

export class PathSandboxError extends Error {}

export class PathSandbox {
  private readonly rootSegs: string[][]

  constructor(roots: string[]) {
    if (roots.length === 0) throw new PathSandboxError('PathSandbox: список корней пуст')
    this.rootSegs = roots.map((r) => {
      const real = realpathSync(r)
      return segments(real)
    })
  }

  validateAndResolve(candidate: string, cwd?: string): string {
    const abs = isAbsolute(candidate) ? candidate : resolve(cwd ?? process.cwd(), candidate)
    const resolved = resolve(abs)

    let real: string
    try {
      real = realpathSync(resolved)
    } catch {
      real = this.resolveMissing(resolved)
    }

    const candSegs = segments(real)
    for (const root of this.rootSegs) {
      if (isWithin(root, candSegs)) return real
    }
    throw new PathSandboxError(`путь вне песочницы: ${candidate}`)
  }

  private resolveMissing(p: string): string {
    // Не собираем родительский путь из сегментов: на Windows первый сегмент —
    // "D:", и добавление sep превращает его в недопустимый "\\D:\...".
    // Идём вверх готовыми абсолютными путями, пока не найдём существующий
    // каталог, чтобы realpathSync раскрыл junction/symlink и для нового потомка.
    const suffix: string[] = []
    let probe = resolve(p)
    while (true) {
      try {
        const realPrefix = realpathSync(probe)
        return suffix.length === 0 ? realPrefix : resolve(realPrefix, ...suffix)
      } catch {
        const parent = dirname(probe)
        if (parent === probe) return resolve(p)
        suffix.unshift(basename(probe))
        probe = parent
      }
    }
  }
}

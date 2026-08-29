import { realpathSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'

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
    const segs = segments(resolve(p))
    for (let cut = segs.length; cut > 0; cut--) {
      const prefix = sep + segs.slice(0, cut).join(sep)
      try {
        const realPrefix = realpathSync(prefix)
        return resolve(realPrefix, segs.slice(cut).join(sep))
      } catch {
        continue
      }
    }
    return resolve(p)
  }
}

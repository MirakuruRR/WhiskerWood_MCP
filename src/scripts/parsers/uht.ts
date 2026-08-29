import { readdirSync, readFileSync } from 'node:fs'

export interface UhtParam {
  name: string
  type: string
  isOut: boolean
}

export interface UhtFunction {
  className: string
  funcName: string
  isStatic: boolean
  isConst: boolean
  returnType: string
  params: UhtParam[]
}

const CLASS_RE = /^\s*class\s+(?:[A-Z0-9]+_API\s+)?([A-Za-z_]\w*)\s*(?::\s*public\s+([A-Za-z_]\w*))?\s*\{/
const FUNC_RE = /^(?:static\s+)?([\s\S]+?)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(const)?\s*;\s*$/

function stripClassPrefix(name: string): string {
  if ((name.startsWith('U') || name.startsWith('A') || name.startsWith('F')) && name.length > 1 && /[A-Z]/.test(name[1])) {
    return name.slice(1)
  }
  return name
}

function cleanType(t: string): string {
  return t.replace(/\bconst\b/g, '').replace(/[&*]/g, '').replace(/\s+/g, ' ').trim()
}

function parseParams(argStr: string): UhtParam[] {
  const out: UhtParam[] = []
  const parts = argStr.split(',')
  for (const raw of parts) {
    const p = raw.trim()
    if (p.length === 0 || p === 'void') continue
    const m = /^(.*?)([A-Za-z_]\w*)$/.exec(p)
    if (!m) continue
    const typePart = m[1].trim()
    const name = m[2]
    const isOut = typePart.includes('&') && !typePart.includes('const')
    out.push({ name, type: cleanType(typePart), isOut })
  }
  return out
}

export function parseUhtHeader(text: string, into: Map<string, UhtFunction>): void {
  const lines = text.split('\n')
  let currentClass: string | null = null
  let pending = false
  let buffer = ''

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    const cm = CLASS_RE.exec(line)
    if (cm) {
      currentClass = stripClassPrefix(cm[1])
      pending = false
      buffer = ''
      continue
    }
    if (line.trimStart().startsWith('UFUNCTION(')) {
      pending = true
      buffer = ''
      continue
    }
    if (!pending) continue
    buffer += line.trim() + ' '
    if (!line.trimEnd().endsWith(';')) continue
    pending = false
    const decl = buffer.trim()
    buffer = ''
    if (!currentClass) continue
    const fm = FUNC_RE.exec(decl)
    if (!fm) continue
    const returnType = cleanType(fm[1])
    const funcName = fm[2]
    const isStatic = /^static\s/.test(decl)
    const isConst = fm[4] !== undefined
    const params = parseParams(fm[3])
    const key = `${currentClass}.${funcName}`
    if (!into.has(key)) {
      into.set(key, { className: currentClass, funcName, isStatic, isConst, returnType, params })
    }
  }
}

export function parseUhtModules(dumpRoot: string, modules: string[]): Map<string, UhtFunction> {
  const into = new Map<string, UhtFunction>()
  for (const module of modules) {
    const publicDir = `${dumpRoot}/${module}/Public`
    let files: string[]
    try {
      files = readdirSync(publicDir)
    } catch {
      continue
    }
    const local = new Map<string, UhtFunction>()
    for (const f of files) {
      if (!f.endsWith('.h')) continue
      const text = readFileSync(`${publicDir}/${f}`, 'utf8')
      parseUhtHeader(text, local)
    }
    for (const [key, fn] of local) into.set(`${module}:${key}`, fn)
  }
  return into
}

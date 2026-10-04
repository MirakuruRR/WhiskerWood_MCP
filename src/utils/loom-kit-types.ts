import { readFileSync, statSync } from 'node:fs'

export interface KitFunction {
  flags: string[]
  params: Array<{ name: string; type: string; dir: string }>
}

export interface KitClass {
  super?: string
  abstract?: boolean
  interface?: boolean
  not_implementable?: boolean
  interfaces?: string[]
  properties?: Record<string, { type: string; edit_only?: boolean }>
  functions?: Record<string, KitFunction>
}

export interface KitStruct {
  fields?: Record<string, { type: string }>
}

export interface KitEvent {
  owner: string
  isInterface: boolean
  returns: boolean
  outputs: boolean
  isConst: boolean
}

export interface KitSymbol {
  name: string
  path: string
  kind: 'class' | 'struct' | 'enum'
}

export class KitTypes {
  readonly path: string
  private readonly classes: Record<string, KitClass>
  private readonly structs: Record<string, KitStruct>
  private readonly enums: Record<string, string[]>
  private readonly shortClasses = new Map<string, string[]>()
  private readonly shortStructs = new Map<string, string[]>()
  private readonly shortEnums = new Map<string, string[]>()

  constructor(path: string, raw: string) {
    this.path = path
    const dump = JSON.parse(raw) as {
      classes?: Record<string, KitClass>
      structs?: Record<string, KitStruct>
      enums?: Record<string, string[]>
    }
    this.classes = dump.classes ?? {}
    this.structs = dump.structs ?? {}
    this.enums = dump.enums ?? {}
    for (const p of Object.keys(this.classes)) {
      const name = tailName(p)
      push(this.shortClasses, name, p)
      if (name.endsWith('_C')) push(this.shortClasses, name.slice(0, -2), p)
    }
    for (const p of Object.keys(this.structs)) push(this.shortStructs, tailName(p), p)
    for (const p of Object.keys(this.enums)) push(this.shortEnums, tailName(p), p)
  }

  get classCount(): number {
    return Object.keys(this.classes).length
  }

  resolveClass(nameOrPath: string): string | null {
    const raw = (this.typePath(nameOrPath) ?? nameOrPath).trim()
    if (raw.length === 0) return null
    if (raw.startsWith('/')) {
      if (this.classes[raw]) return raw
      const stem = tailName(raw).replace(/_C$/, '')
      const candidates = this.shortClasses.get(stem) ?? []
      return candidates.length === 1 ? candidates[0] : null
    }
    const candidates = this.shortClasses.get(raw) ?? this.shortClasses.get(`${raw}_C`) ?? []
    return candidates.length === 1 ? candidates[0] : null
  }

  resolve(nameOrPath: string): KitSymbol | null {
    const cls = this.resolveClass(nameOrPath)
    if (cls) return { name: tailName(cls).replace(/_C$/, ''), path: cls, kind: 'class' }
    const raw = nameOrPath.trim()
    const struct = (this.shortStructs.get(raw) ?? []).length === 1 ? (this.shortStructs.get(raw) ?? [])[0] : null
    if (struct) return { name: tailName(struct), path: struct, kind: 'struct' }
    const en = (this.shortEnums.get(raw) ?? []).length === 1 ? (this.shortEnums.get(raw) ?? [])[0] : null
    if (en) return { name: tailName(en), path: en, kind: 'enum' }
    return null
  }

  superChain(path: string): string[] {
    const out: string[] = []
    let cur: string | undefined = path
    const seen = new Set<string>()
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      out.push(cur)
      cur = this.classes[cur]?.super
    }
    return out
  }

  isSubclassOf(path: string, ancestor: string): boolean {
    return this.superChain(path).includes(ancestor)
  }

  isWidget(path: string): boolean {
    return this.isSubclassOf(path, '/Script/UMG.UserWidget') || path === '/Script/UMG.UserWidget'
  }

  isInterface(path: string): boolean {
    return this.classes[path]?.interface === true
  }

  interfacesOf(path: string): string[] {
    const out = new Set<string>()
    for (const p of this.superChain(path)) for (const i of this.classes[p]?.interfaces ?? []) out.add(i)
    return [...out]
  }

  /** Функция родителя (или его интерфейса) с этим именем: что обработчик `on` переопределяет. */
  parentFunction(path: string, name: string): KitEvent | null {
    for (const p of [...this.superChain(path), ...this.interfacesOf(path)]) {
      const fn = this.classes[p]?.functions?.[name]
      if (!fn) continue
      return {
        owner: p,
        isInterface: this.isInterface(p),
        returns: fn.params.some((x) => x.dir === 'return'),
        outputs: fn.params.some((x) => x.dir === 'out'),
        isConst: fn.flags.includes('const'),
      }
    }
    return null
  }

  /** Есть ли функция в цепочке родителя — так же, как её видит `loom check`. */
  declaresFunction(path: string, name: string): boolean {
    for (const p of this.superChain(path)) if (this.classes[p]?.functions?.[name]) return true
    return false
  }

  hasFunction(path: string, name: string): boolean {
    for (const p of this.superChain(path)) if (this.classes[p]?.functions?.[name]) return true
    return false
  }

  hasProperty(path: string, name: string): boolean {
    for (const p of this.superChain(path)) if (this.classes[p]?.properties?.[name]) return true
    return false
  }

  hasEnumValue(path: string, name: string): boolean {
    return (this.enums[path] ?? []).includes(name)
  }

  propertyType(ownerPath: string, name: string): string | null {
    for (const p of this.superChain(ownerPath)) {
      const prop = this.classes[p]?.properties?.[name]
      if (prop) return prop.type
    }
    const struct = this.structs[ownerPath]
    if (struct?.fields?.[name]) return struct.fields[name].type
    return null
  }

  typePath(type: string | null): string | null {
    if (!type) return null
    let t = type.trim()
    while (true) {
      const wrapper = /^(?:array|set|map|soft|class)\s*<([\s\S]*)>$/.exec(t)
      if (wrapper) {
        t = wrapper[1].split(',')[0].trim()
        continue
      }
      const prefixed = /^(?:object|struct|enum|class|soft):([\s\S]+)$/.exec(t)
      if (prefixed) {
        t = prefixed[1].trim()
        continue
      }
      break
    }
    return t.startsWith('/') ? t : null
  }

  /** Цепочка полей от объявленного типа: возвращает тип последнего поля или null, если цепочка не разобрана. */
  fieldChainType(declaredType: string | null, members: string[]): string | null {
    const first = this.typePath(declaredType) ?? (declaredType ? this.resolveClass(declaredType) : null)
    if (!first || members.length === 0) return null
    let path = first
    let last: string | null = null
    for (let i = 0; i < members.length; i++) {
      const type = this.propertyType(path, members[i])
      if (!type) return null
      last = type
      const next = this.typePath(type) ?? this.resolveClass(type)
      if (next) path = next
      else if (i !== members.length - 1) return null
    }
    return last
  }
}

function tailName(path: string): string {
  const afterPackage = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1) : path
  return afterPackage
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

let cache: { key: string; value: KitTypes | null } | null = null

export function loadKitTypes(file: string): KitTypes | null {
  let key = file
  try {
    const st = statSync(file)
    key = `${file}|${st.mtimeMs}|${st.size}`
  } catch {
    return null
  }
  if (cache && cache.key === key) return cache.value
  let value: KitTypes | null = null
  try {
    value = new KitTypes(file, readFileSync(file, 'utf8'))
  } catch {
    value = null
  }
  cache = { key, value }
  return value
}

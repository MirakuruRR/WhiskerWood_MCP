import { parse } from 'luaparse'

export const VERIFIABLE = new Set([
  'RegisterHook',
  'WWRegisterHook',
  'StaticFindObject',
  'FindFirstOf',
  'FindAllOf',
  'NotifyOnNewObject',
  'StaticConstructObject',
])

const HOOK_REGISTER = new Set(['RegisterHook', 'WWRegisterHook'])
const CLASS_NAME_ARG = new Set(['FindFirstOf', 'FindAllOf'])
const GAME_THREAD_CALLBACK = new Set([
  'RegisterHook',
  'WWRegisterHook',
  'NotifyOnNewObject',
  'RegisterInitGameStatePostHook',
  'RegisterLoadMapPostHook',
  'RegisterBeginPlayPostHook',
])
const ASYNC_CALLBACK = new Set([
  'ExecuteWithDelay',
  'ExecuteAsync',
  'LoopAsync',
  'RegisterKeyBind',
  'RegisterKeyBindAsync',
])
const MUTATING_NAMES = new Set([
  'AddToViewport',
  'RemoveFromParent',
  'StaticConstructObject',
  'ExecuteConsoleCommand',
])
const MUTATING_PREFIX = /^(Set|K2_Set|Add|Remove|Destroy|Spawn|Play|Stop|Apply|Enable|Disable)[A-Z_]/
const LOAD_TIME_LOOKUP = new Set(['FindFirstOf', 'FindAllOf'])
const DEFERRED_CALLBACK = new Set(['ExecuteWithDelay', 'ExecuteAsync', 'LoopAsync'])
const CLASS_SOURCE = new Set(['FindFirstOf', 'FindAllOf', 'StaticFindObject', 'StaticConstructObject'])
const SETTER = /^(?:K2_)?Set([A-Z_]\w*)$/

export interface Callback {
  slot: 'pre' | 'post'
  params: number
  hasVararg: boolean
  line: number
}

export interface Reference {
  fn: string
  /** null = путь собран динамически, верификации не подлежит */
  arg: string | null
  line: number
  column: number
  callbacks: Callback[]
}

export type LintSeverity = 'error' | 'warn' | 'info'

export interface Lint {
  code: string
  severity: LintSeverity
  line: number
  column: number
  message: string
}

export interface CommentSpan {
  line: number
  from: number
  to: number
}

export interface ObjectWrite {
  /** имя класса или путь источника объекта; null — переменную к классу привязать не удалось */
  cls: string | null
  property: string
  via: 'field' | 'setter'
  /** запись отложена через ExecuteWithDelay и подобные: порядок между модами не определён */
  deferred: boolean
  line: number
  column: number
}

export interface Analysis {
  syntaxError?: { message: string; line: number; column: number }
  comments: CommentSpan[]
  refs: Reference[]
  lints: Lint[]
  writes: ObjectWrite[]
  requires: string[]
  usesDirectRegisterHook: boolean
  usesWWRegisterHook: boolean
}

interface Ctx {
  topLevel: boolean
  asyncOrigin: string | null
  inGameThread: boolean
  deferred: boolean
}

const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  a: '\x07',
  b: '\b',
  f: '\f',
  v: '\v',
  '\\': '\\',
  '"': '"',
  "'": "'",
  '\n': '\n',
}

/** luaparse без encodingMode не заполняет value (иначе он падает на кириллице в исходнике). */
export function luaStringValue(raw: string): string {
  const long = /^\[(=*)\[([\s\S]*)\]\1\]$/.exec(raw)
  if (long) return long[2].replace(/^\r?\n/, '')
  const quote = raw[0]
  if (quote !== '"' && quote !== "'") return raw
  const body = raw.slice(1, -1)
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c !== '\\') {
      out += c
      continue
    }
    const next = body[++i]
    if (next === undefined) break
    if (next === 'x') {
      out += String.fromCharCode(parseInt(body.slice(i + 1, i + 3), 16) || 0)
      i += 2
    } else if (next === 'z') {
      while (i + 1 < body.length && /\s/.test(body[i + 1])) i++
    } else if (next === 'u' && body[i + 1] === '{') {
      const end = body.indexOf('}', i)
      out += String.fromCodePoint(parseInt(body.slice(i + 2, end), 16) || 0)
      i = end
    } else if (/[0-9]/.test(next)) {
      let digits = next
      while (digits.length < 3 && /[0-9]/.test(body[i + 1] ?? '')) digits += body[++i]
      out += String.fromCharCode(Number(digits))
    } else {
      out += ESCAPES[next] ?? next
    }
  }
  return out
}

function callName(node: any): { name: string; method: boolean; owner: string | null } | null {
  const base = node.base
  if (!base) return null
  if (base.type === 'Identifier') return { name: base.name, method: false, owner: null }
  if (base.type === 'MemberExpression' && base.identifier?.type === 'Identifier') {
    return {
      name: base.identifier.name,
      method: base.indexer === ':',
      owner: base.base?.type === 'Identifier' ? base.base.name : null,
    }
  }
  return null
}

function isCall(node: any): boolean {
  return (
    node.type === 'CallExpression' || node.type === 'StringCallExpression' || node.type === 'TableCallExpression'
  )
}

function callArguments(node: any): any[] {
  if (node.type === 'CallExpression') return node.arguments ?? []
  if (node.type === 'StringCallExpression') return node.argument ? [node.argument] : []
  if (node.type === 'TableCallExpression') return node.arguments ? [node.arguments] : []
  return []
}

function loc(node: any): { line: number; column: number } {
  const start = node?.loc?.start
  return { line: start?.line ?? 0, column: (start?.column ?? 0) + 1 }
}

const ALIASABLE = new Set([...VERIFIABLE, 'ExecuteInGameThread', 'ExecuteWithDelay'])

function resolveAlias(node: any): string | null {
  if (!node) return null
  if (node.type === 'Identifier') return ALIASABLE.has(node.name) ? node.name : null
  if (node.type === 'LogicalExpression' && node.operator === 'or') {
    const left = resolveAlias(node.left)
    const right = resolveAlias(node.right)
    if (left === 'WWRegisterHook' || right === 'WWRegisterHook') return 'WWRegisterHook'
    return left ?? right
  }
  return null
}

/** Обёртки lib/ww/obj.lua: без них литеральные имена классов уходят из-под проверки. */
export const WW_OBJ_WRAPPERS: Record<string, string> = {
  first_of: 'FindFirstOf',
  all_of: 'FindAllOf',
  find: 'StaticFindObject',
  first_of_cached: 'FindFirstOf',
  all_of_cached: 'FindAllOf',
  find_cached: 'StaticFindObject',
}

function requiredModule(node: any): string | null {
  if (
    node?.type === 'CallExpression' &&
    node.base?.type === 'Identifier' &&
    node.base.name === 'require' &&
    node.arguments?.[0]?.type === 'StringLiteral'
  ) {
    return luaStringValue(node.arguments[0].raw)
  }
  return null
}

/** `local register = WWRegisterHook or RegisterHook` — идиома из шаблонов; без этого
 *  прохода все хуки мода уходят из-под проверки путей. */
function collectAliases(ast: any): { aliases: Map<string, string>; modules: Map<string, string> } {
  const aliases = new Map<string, string>()
  const modules = new Map<string, string>()
  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'LocalStatement' || node.type === 'AssignmentStatement') {
      const vars: any[] = node.variables ?? []
      const inits: any[] = node.init ?? []
      for (let i = 0; i < vars.length; i++) {
        if (vars[i]?.type !== 'Identifier') continue
        const target = resolveAlias(inits[i])
        if (target) aliases.set(vars[i].name, target)
        const module = requiredModule(inits[i])
        if (module) modules.set(vars[i].name, module)
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'range') continue
      const v = node[key]
      if (Array.isArray(v)) v.forEach(visit)
      else visit(v)
    }
  }
  visit(ast)
  return { aliases, modules }
}

export function analyzeLua(source: string): Analysis {
  let ast: any
  try {
    ast = parse(source, { locations: true, luaVersion: '5.3', comments: true })
  } catch (e: any) {
    return {
      syntaxError: { message: String(e.message ?? e), line: e.line ?? 0, column: (e.column ?? 0) + 1 },
      comments: [],
      refs: [],
      lints: [],
      writes: [],
      requires: [],
      usesDirectRegisterHook: false,
      usesWWRegisterHook: false,
    }
  }

  const { aliases, modules } = collectAliases(ast)
  const refs: Reference[] = []
  const lints: Lint[] = []
  const writes: ObjectWrite[] = []
  const classOfVar = new Map<string, { root: string; path: string[] }>()
  const requires: string[] = []
  let usesDirectRegisterHook = false
  let usesWWRegisterHook = false
  const seenLints = new Set<string>()

  const lint = (code: string, severity: LintSeverity, node: any, message: string): void => {
    const at = loc(node)
    const key = `${code}:${at.line}:${at.column}`
    if (seenLints.has(key)) return
    seenLints.add(key)
    lints.push({ code, severity, line: at.line, column: at.column, message })
  }

  const collectCallbacks = (args: any[]): Callback[] => {
    const out: Callback[] = []
    const slots: Array<'pre' | 'post'> = ['pre', 'post']
    for (let i = 1; i <= 2; i++) {
      const a = args[i]
      if (!a || a.type !== 'FunctionDeclaration') continue
      const params: any[] = a.parameters ?? []
      out.push({
        slot: slots[i - 1],
        params: params.filter((p) => p.type === 'Identifier').length,
        hasVararg: params.some((p) => p.type === 'VarargLiteral'),
        line: loc(a).line,
      })
    }
    return out
  }

  const resolvedName = (node: any): { name: string; method: boolean } | null => {
    const called = callName(node)
    if (!called) return null
    const wrapped = called.owner && modules.get(called.owner) === 'ww.obj' ? WW_OBJ_WRAPPERS[called.name] : undefined
    if (wrapped) return { name: wrapped, method: false }
    return { name: called.method ? called.name : (aliases.get(called.name) ?? called.name), method: called.method }
  }

  /**
   * Цепочка доступа от опознаваемого корня: value.Icon.Brush -> { root: класс value, path: [Icon, Brush] }.
   * Через вызовы методов не идём (кроме :get() у RemoteUnrealParam) — иначе ключ перестаёт быть точным.
   */
  const accessPath = (node: any): { root: string; path: string[] } | null => {
    if (!node || typeof node !== 'object') return null
    if (node.type === 'Identifier') {
      const bound = classOfVar.get(node.name)
      return bound ? { root: bound.root, path: [...bound.path] } : null
    }
    if (node.type === 'MemberExpression' && node.indexer === '.' && node.identifier?.type === 'Identifier') {
      const base = accessPath(node.base)
      return base ? { root: base.root, path: [...base.path, node.identifier.name] } : null
    }
    if (node.type === 'IndexExpression') {
      const base = accessPath(node.base)
      if (!base) return null
      if (node.index?.type !== 'StringLiteral') return base
      return { root: base.root, path: [...base.path, luaStringValue(node.index.raw)] }
    }
    if (!isCall(node)) return null
    const called = resolvedName(node)
    if (!called) return null
    if (called.method) return called.name === 'get' ? accessPath(node.base?.base) : null
    if (CLASS_SOURCE.has(called.name)) {
      const first = callArguments(node)[0]
      return first?.type === 'StringLiteral' ? { root: luaStringValue(first.raw), path: [] } : null
    }
    return null
  }

  const bindCallbackParam = (fn: any, root: string): void => {
    const first = fn?.type === 'FunctionDeclaration' ? fn.parameters?.[0] : null
    if (first?.type === 'Identifier') classOfVar.set(first.name, { root, path: [] })
  }

  const recordFieldWrites = (targets: any[], ctx: Ctx): void => {
    for (const t of targets) {
      if (t?.type !== 'MemberExpression' && t?.type !== 'IndexExpression') continue
      const ap = accessPath(t)
      if (!ap || ap.path.length === 0) continue
      writes.push({
        cls: ap.root,
        property: ap.path.join('.'),
        via: 'field',
        deferred: ctx.deferred,
        ...loc(t),
      })
    }
  }

  const walk = (node: any, ctx: Ctx): void => {
    if (!node || typeof node !== 'object') return

    if (node.type === 'Identifier' && node.name === 'WWRegisterHook') usesWWRegisterHook = true

    if (node.type === 'Identifier' && node.name === 'Utf8String') {
      lint('utf8string', 'error', node, 'Utf8String не поддержан UE4SS на UE 5.6; текст резолви через ww_resolve_loc и передавай готовой строкой')
    }

    if (isCall(node)) {
      const called = callName(node)
      const args = callArguments(node)
      if (called) {
        const { method, owner } = called
        const wrapped =
          owner && modules.get(owner) === 'ww.obj' ? WW_OBJ_WRAPPERS[called.name] : undefined
        const name = wrapped ?? (method ? called.name : (aliases.get(called.name) ?? called.name))
        const viaWrapper = wrapped !== undefined

        if ((!method || viaWrapper) && VERIFIABLE.has(name)) {
          const first = args[0]
          refs.push({
            fn: name,
            arg: first?.type === 'StringLiteral' ? luaStringValue(first.raw) : null,
            ...loc(node),
            callbacks: HOOK_REGISTER.has(name) ? collectCallbacks(args) : [],
          })
        }

        if (!method && args[0]?.type === 'StringLiteral') {
          if (HOOK_REGISTER.has(name)) {
            const owning = luaStringValue(args[0].raw).split(':')[0]
            bindCallbackParam(args[1], owning)
            bindCallbackParam(args[2], owning)
          } else if (name === 'NotifyOnNewObject') {
            bindCallbackParam(args[1], luaStringValue(args[0].raw))
          }
        }

        if (method) {
          const setter = SETTER.exec(called.name)
          const ap = setter ? accessPath(node.base?.base) : null
          if (setter && ap) {
            writes.push({
              cls: ap.root,
              property: [...ap.path, setter[1]].join('.'),
              via: 'setter',
              deferred: ctx.deferred,
              ...loc(node),
            })
          }
        }

        if (!method && name === 'require') {
          const first = args[0]
          if (first?.type === 'StringLiteral') requires.push(luaStringValue(first.raw))
        }

        if (!method && name === 'RegisterHook') usesDirectRegisterHook = true
        if (!method && name === 'WWRegisterHook') usesWWRegisterHook = true

        if (!method && name === 'print') {
          const first = args[0]
          const literal =
            first?.type === 'StringLiteral'
              ? luaStringValue(first.raw)
              : first?.type === 'BinaryExpression' && first.operator === '..' && first.right?.type === 'StringLiteral'
                ? luaStringValue(first.right.raw)
                : null
          if (literal !== null && !literal.endsWith('\n')) {
            lint('print_without_newline', 'warn', node, 'print в UE4SS не добавляет перевод строки: без "\\n" записи лога склеиваются')
          }
        }

        if (!method && ctx.topLevel && LOAD_TIME_LOOKUP.has(name)) {
          lint(
            'lookup_at_load_time',
            'warn',
            node,
            `${name} в теле скрипта: на момент загрузки мода объектов ещё нет. Перенеси в хук, RegisterInitGameStatePostHook или периодическую проверку`,
          )
        }

        if (ctx.asyncOrigin && !ctx.inGameThread && (MUTATING_NAMES.has(name) || MUTATING_PREFIX.test(name))) {
          lint(
            'mutation_outside_game_thread',
            'warn',
            node,
            `${name} внутри коллбэка ${ctx.asyncOrigin} исполняется вне игрового потока; оберни в ExecuteInGameThread`,
          )
        }

        const childCtx: Ctx = {
          topLevel: ctx.topLevel,
          asyncOrigin: ctx.asyncOrigin,
          inGameThread: ctx.inGameThread,
          deferred: ctx.deferred || (!method && DEFERRED_CALLBACK.has(name)),
        }
        if (!method && name === 'ExecuteInGameThread') childCtx.inGameThread = true
        else if (!method && GAME_THREAD_CALLBACK.has(name)) {
          childCtx.inGameThread = true
          childCtx.asyncOrigin = null
        } else if (!method && ASYNC_CALLBACK.has(name)) {
          childCtx.inGameThread = false
          childCtx.asyncOrigin = name
        }

        walk(node.base, ctx)
        for (const a of args) walk(a, childCtx)
        return
      }
    }

    if (node.type === 'LocalStatement' || node.type === 'AssignmentStatement') {
      const vars: any[] = node.variables ?? []
      const inits: any[] = node.init ?? []
      for (let i = 0; i < vars.length; i++) {
        if (vars[i]?.type !== 'Identifier') continue
        const ap = accessPath(inits[i])
        if (ap) classOfVar.set(vars[i].name, ap)
      }
      if (node.type === 'AssignmentStatement') recordFieldWrites(vars, ctx)
    }

    if (node.type === 'ForGenericStatement') {
      const iter = node.iterators?.[0]
      const inner =
        iter && isCall(iter) && ['ipairs', 'pairs'].includes(resolvedName(iter)?.name ?? '')
          ? callArguments(iter)[0]
          : iter
      const ap = accessPath(inner)
      const last = (node.variables ?? []).at(-1)
      if (ap && last?.type === 'Identifier') classOfVar.set(last.name, ap)
    }

    if (node.type === 'FunctionDeclaration') {
      const inner: Ctx = {
        topLevel: false,
        asyncOrigin: ctx.asyncOrigin,
        inGameThread: ctx.inGameThread,
        deferred: ctx.deferred,
      }
      for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'range') continue
        const v = node[key]
        if (Array.isArray(v)) v.forEach((n) => walk(n, inner))
        else walk(v, inner)
      }
      return
    }

    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'range') continue
      const v = node[key]
      if (Array.isArray(v)) v.forEach((n) => walk(n, ctx))
      else walk(v, ctx)
    }
  }

  const rootCtx: Ctx = { topLevel: true, asyncOrigin: null, inGameThread: false, deferred: false }
  for (const stmt of ast.body ?? []) walk(stmt, rootCtx)

  const comments: CommentSpan[] = []
  for (const c of (ast.comments ?? []) as any[]) {
    const start = c.loc?.start
    const end = c.loc?.end
    if (!start || !end) continue
    for (let ln = start.line; ln <= end.line; ln++) {
      comments.push({
        line: ln,
        from: ln === start.line ? start.column + 1 : 1,
        to: ln === end.line ? end.column : Number.MAX_SAFE_INTEGER,
      })
    }
  }

  return { comments, refs, lints, writes, requires, usesDirectRegisterHook, usesWWRegisterHook }
}

export function isClassNameArgument(fn: string): boolean {
  return CLASS_NAME_ARG.has(fn)
}

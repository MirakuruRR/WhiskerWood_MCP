export interface LmComment {
  line: number
  from: number
  to: number
}

export interface LmParam {
  name: string
  type: string
  out: boolean
  byRef: boolean
}

export type LmHeaderKind = 'blueprint' | 'editor_blueprint' | 'enum' | 'struct' | 'interface'

export interface LmHeader {
  kind: LmHeaderKind
  name: string
  parent: string | null
  assetPath: string | null
  line: number
  raw: string
}

export interface LmVar {
  name: string
  type: string
  value: string | null
  line: number
  editable: boolean
  isPrivate: boolean
}

export interface LmDefault {
  target: string
  members: string[]
  value: string
  line: number
}

export interface LmBody {
  kind: 'fn' | 'on' | 'event'
  name: string
  component: string | null
  params: LmParam[]
  returnType: string | null
  line: number
  endLine: number
  text: string
}

export interface LmWidget {
  name: string
  cls: string
  line: number
}

export interface LmComponent {
  name: string
  cls: string
  line: number
}

export interface LmCall {
  name: string
  receiver: string
  args: string[]
  line: number
  column: number
  body: string | null
}

export interface LmWrite {
  target: string
  members: string[]
  op: string
  value: string
  line: number
  column: number
  body: string | null
}

export interface LmTypeRef {
  name: string
  via: string
  line: number
  column: number
}

export interface LmMemberUse {
  receiver: string
  member: string
  line: number
}

export interface LmSource {
  file: string
  rel: string
  text: string
  bom: boolean
  lines: number
  header: LmHeader | null
  headers: LmHeader[]
  uses: string[]
  implements: string[]
  vars: LmVar[]
  defaults: LmDefault[]
  bodies: LmBody[]
  widgets: LmWidget[]
  components: LmComponent[]
  enumValues: string[]
  calls: LmCall[]
  writes: LmWrite[]
  typeRefs: LmTypeRef[]
  memberUses: LmMemberUse[]
  comments: LmComment[]
  unknown: Array<{ line: number; text: string }>
}

const RESERVED = new Set([
  'break',
  'continue',
  'else',
  'for',
  'if',
  'let',
  'match',
  'return',
  'while',
  'true',
  'false',
  'none',
  'self',
  'super',
])

const ITEM_WORDS = new Set([
  'use',
  'implements',
  'var',
  'editable',
  'private',
  'protected',
  'pure',
  'fn',
  'event',
  'on',
  'default',
  'dispatcher',
  'component',
  'category',
  'widget',
  'enum',
  'struct',
  'interface',
  'blueprint',
  'editor',
])

const STATEMENT_STARTERS = new Set([
  'let',
  'if',
  'while',
  'for',
  'match',
  'else',
  'return',
  'var',
  'default',
  'use',
  'on',
  'fn',
  'event',
  'category',
  'dispatcher',
  'component',
  'widget',
  'blueprint',
  'enum',
  'struct',
  'interface',
  'implements',
  'editable',
  'private',
  'protected',
  'pure',
  'break',
  'continue',
])

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch)
}

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch)
}

interface CodeLine {
  num: number
  raw: string
  code: string
  comment: LmComment | null
  indent: number
}

function stripComment(raw: string, num: number): { code: string; comment: LmComment | null } {
  let inString = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '/' && raw[i + 1] === '/') {
      return { code: raw.slice(0, i), comment: { line: num, from: i + 1, to: raw.length } }
    }
  }
  return { code: raw, comment: null }
}

function countOutsideStrings(code: string, open: string, close: string): number {
  let n = 0
  let inString = false
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === open) n++
    else if (ch === close) n--
  }
  return n
}

/** Разбор .lm по строкам и скобкам. Замена tree-sitter-loom: грамматики в системе нет, а WASM собирать нечем. */
export function parseLm(file: string, rel: string, text: string): LmSource {
  const bom = text.charCodeAt(0) === 0xfeff
  const body = bom ? text.slice(1) : text
  const rawLines = body.replace(/\r\n?/g, '\n').split('\n')
  const lines: CodeLine[] = rawLines.map((raw, i) => {
    const { code, comment } = stripComment(raw, i + 1)
    const indent = code.length - code.trimStart().length
    return { num: i + 1, raw, code, comment, indent }
  })

  const comments: LmComment[] = []
  for (const l of lines) if (l.comment) comments.push(l.comment)

  const paren: number[] = []
  const bracket: number[] = []
  const brace: number[] = []
  let p = 0
  let b = 0
  let c = 0
  for (const l of lines) {
    p += countOutsideStrings(l.code, '(', ')')
    b += countOutsideStrings(l.code, '[', ']')
    c += countOutsideStrings(l.code, '{', '}')
    paren.push(p)
    bracket.push(b)
    brace.push(c)
  }

  // конец элемента: строка, на которой все скобки, открытые внутри элемента, снова закрыты
  const itemEnd = (start: number): number => {
    let p = 0
    let b = 0
    let c = 0
    for (let i = start; i < lines.length; i++) {
      p += countOutsideStrings(lines[i].code, '(', ')')
      b += countOutsideStrings(lines[i].code, '[', ']')
      c += countOutsideStrings(lines[i].code, '{', '}')
      if (p <= 0 && b <= 0 && c <= 0) return i
    }
    return lines.length - 1
  }

  const headerAt = (list: CodeLine[], start: number, end: number): LmHeader | null => {
    const joined = list
      .slice(start, end + 1)
      .map((l) => l.code)
      .join(' ')
      .trim()
    const m =
      /^(editor\s+blueprint|blueprint|enum|struct|interface)\s+([^\s:]+)\s*(?::\s*([^\s]+))?\s*at\s+(\S+)/.exec(joined)
    if (!m) return null
    const word = m[1].replace(/\s+/g, '_')
    const kind: LmHeaderKind =
      word === 'blueprint' ? 'blueprint' : word === 'editor_blueprint' ? 'editor_blueprint' : (word as LmHeaderKind)
    const isBlueprint = kind === 'blueprint' || kind === 'editor_blueprint'
    return {
      kind,
      name: m[2],
      parent: isBlueprint ? (m[3] ?? null) : null,
      assetPath: m[4] ?? null,
      line: list[start].num,
      raw: list[start].code.trim(),
    }
  }

  const src: LmSource = {
    file,
    rel,
    text: body,
    bom,
    lines: rawLines.length,
    header: null,
    headers: [],
    uses: [],
    implements: [],
    vars: [],
    defaults: [],
    bodies: [],
    widgets: [],
    components: [],
    enumValues: [],
    calls: [],
    writes: [],
    typeRefs: [],
    memberUses: [],
    comments,
    unknown: [],
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const code = line.code.trim()
    if (code.length === 0) continue
    if (/^[)}\]]+$/.test(code)) continue
    if (line.indent === 0 && brace[i] - countOutsideStrings(code, '{', '}') > 0) continue
    if (brace[i] > 0 && !ITEM_WORDS.has(code.split(/[\s(:]/)[0])) continue

    const end = itemEnd(i)
    const first = code.split(/\s+/)[0]

    if (line.indent === 0) {
      if (first === 'blueprint' || first === 'editor' || first === 'enum' || first === 'struct' || first === 'interface') {
        const header = headerAt(lines, i, i)
        if (header) {
          src.headers.push(header)
          if (!src.header) src.header = header
        } else src.unknown.push({ line: line.num, text: code })
        continue
      }
      if (first === 'use') {
        src.uses.push(code.replace(/^use\s+/, '').trim())
        i = end
        continue
      }
      if (first === 'implements') {
        const impl = code.replace(/^implements\s+/, '').trim()
        src.implements.push(impl)
        src.typeRefs.push({ name: impl, via: 'implements', line: line.num, column: 1 })
        i = end
        continue
      }
      if (first === 'category') {
        i = end
        continue
      }
      const varMatch = /^(?:(editable|private)\s+)?var\s+(`[^`]+`|[^\s:]+)\s*:\s*([^=]+?)(?:\s*=\s*([\s\S]*))?$/.exec(code)
      if (varMatch) {
        src.vars.push({
          name: unquote(varMatch[2]),
          type: varMatch[3].trim(),
          value: varMatch[4] === undefined ? null : varMatch[4].trim(),
          line: line.num,
          editable: varMatch[1] === 'editable',
          isPrivate: varMatch[1] === 'private',
        })
        i = end
        continue
      }
      const defMatch = /^default\s+((?:`[^`]+`|[^\s=.]+)(?:\s*\.\s*(?:`[^`]+`|[^\s=.]+))*)\s*=\s*([\s\S]*)$/.exec(code)
      if (defMatch) {
        const target = defMatch[1].replace(/\s+/g, '')
        const members = splitMembers(target)
        src.defaults.push({
          target,
          members,
          value: defMatch[2].trim(),
          line: line.num,
        })
        if (members.length > 1) {
          src.writes.push({
            target,
            members: members.slice(1),
            op: '=',
            value: defMatch[2].trim(),
            line: line.num,
            column: line.raw.indexOf('=') + 1,
            body: null,
          })
        }
        i = end
        continue
      }
      const dispMatch = /^dispatcher\s+(`[^`]+`|[^\s(]+)\s*\(/.exec(code)
      if (dispMatch) {
        i = end
        continue
      }
      const compMatch = /^component\s+(`[^`]+`|[^\s:]+)\s*:\s*([^\s(]+)/.exec(code)
      if (compMatch) {
        src.components.push({ name: unquote(compMatch[1]), cls: compMatch[2], line: line.num })
        i = end
        continue
      }
      const widgetMatch = /^widget\s+(`[^`]+`|[^\s:]+)\s*:\s*([^\s(]+)/.exec(code)
      if (widgetMatch) {
        src.widgets.push({ name: unquote(widgetMatch[1]), cls: widgetMatch[2], line: line.num })
        src.typeRefs.push({ name: widgetMatch[2], via: 'widget', line: line.num, column: 1 })
        i = end
        continue
      }
      const bodyMatch = /^(?:(private|protected)\s+)?(?:(pure)(?:\s+(mut))?\s+)?(fn|event|on)\s+([\s\S]+)$/.exec(code)
      if (bodyMatch) {
        const kind = bodyMatch[4] as 'fn' | 'on' | 'event'
        const rest = bodyMatch[5]
        const sigMatch =
          kind === 'on'
            ? /^(?:([^\s.(]+)\s*\.\s*)?(`[^`]+`|[^\s(]+)\s*(\([\s\S]*?\))?\s*(?:->\s*([\s\S]+?))?\s*\{/.exec(rest)
            : kind === 'event'
              ? /^(`[^`]+`|[^\s(]+)\s*(\([\s\S]*?\))?\s*\{/.exec(rest)
              : /^(`[^`]+`|[^\s(]+)\s*(\([\s\S]*?\))?\s*(?:->\s*([\s\S]+?))?\s*\{/.exec(rest)
        if (sigMatch) {
          const component = kind === 'on' ? (sigMatch[1] ?? null) : null
          const name = unquote(kind === 'on' ? sigMatch[2] : sigMatch[1])
          const paramsText = (kind === 'on' ? sigMatch[3] : sigMatch[2]) ?? ''
          const returnType = (kind === 'on' ? sigMatch[4] : kind === 'fn' ? sigMatch[3] : undefined) ?? null
          const params = parseParams(paramsText)
          src.bodies.push({
            kind,
            name,
            component,
            params: params.list,
            returnType: returnType ? returnType.trim() : null,
            line: line.num,
            endLine: lines[end].num,
            text: lines
              .slice(i, end + 1)
              .map((l) => l.code)
              .join('\n'),
          })
          if (returnType) src.typeRefs.push({ name: returnType.trim(), via: 'return', line: line.num, column: 1 })
          for (const prm of params.list) src.typeRefs.push({ name: prm.type, via: 'param', line: line.num, column: 1 })
        } else src.unknown.push({ line: line.num, text: code })
        i = end
        continue
      }
      src.unknown.push({ line: line.num, text: code })
      i = end
      continue
    }

    if (first === 'widget') {
      const widgetMatch = /^widget\s+(`[^`]+`|[^\s:]+)\s*:\s*([^\s(]+)/.exec(code)
      if (widgetMatch) {
        src.widgets.push({ name: unquote(widgetMatch[1]), cls: widgetMatch[2], line: line.num })
        src.typeRefs.push({ name: widgetMatch[2], via: 'widget', line: line.num, column: 1 })
      } else src.unknown.push({ line: line.num, text: code })
      i = end
      continue
    }
    if (first === 'fn' && src.header && (src.header.kind === 'interface' || src.header.kind === 'enum' || src.header.kind === 'struct')) {
      const sigMatch = /^fn\s+(`[^`]+`|[^\s(]+)\s*(\([\s\S]*?\))?\s*(?:->\s*([\s\S]+?))?$/.exec(code)
      if (sigMatch) {
        const params = parseParams(sigMatch[2] ?? '')
        src.bodies.push({
          kind: 'fn',
          name: unquote(sigMatch[1]),
          component: null,
          params: params.list,
          returnType: sigMatch[3] ? sigMatch[3].trim() : null,
          line: line.num,
          endLine: line.num,
          text: code,
        })
        if (sigMatch[3]) src.typeRefs.push({ name: sigMatch[3].trim(), via: 'return', line: line.num, column: 1 })
        for (const prm of params.list) src.typeRefs.push({ name: prm.type, via: 'param', line: line.num, column: 1 })
        i = end
        continue
      }
    }
    if (src.header && src.header.kind === 'enum') {
      const valueMatch = /^(`[^`]+`|[^\s(]+)(?:\s+"[^"]*")?$/.exec(code)
      if (valueMatch) src.enumValues.push(unquote(valueMatch[1]))
    }
    if (src.header && src.header.kind === 'struct') {
      const fieldMatch = /^(`[^`]+`|[^\s:]+)\s*:\s*([^=]+?)(?:\s*=\s*([\s\S]*))?$/.exec(code)
      if (fieldMatch) src.typeRefs.push({ name: fieldMatch[2].trim(), via: 'field', line: line.num, column: 1 })
    }
  }

  for (const v of src.vars) src.typeRefs.push({ name: v.type, via: 'var', line: v.line, column: 1 })
  for (const h of src.headers) if (h.parent) src.typeRefs.push({ name: h.parent, via: 'parent', line: h.line, column: 1 })

  src.calls = scanCalls(lines, src.bodies)
  src.writes.push(...scanWrites(lines, src.bodies))
  for (const call of src.calls) {
    if (call.receiver.length === 0) continue
    const chain = splitMembers(call.receiver)
    if (chain.length < 2) continue
    const owner = chain[chain.length - 2]
    if (!/^[A-Z][\w`]*$/.test(owner)) continue
    src.memberUses.push({ receiver: owner, member: chain[chain.length - 1], line: call.line })
  }

  return src
}

function unquote(name: string): string {
  const t = name.trim()
  return t.startsWith('`') && t.endsWith('`') ? t.slice(1, -1) : t
}

function splitMembers(target: string): string[] {
  return target
    .replace(/\s+/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\([^()]*\)/g, '')
    .split('.')
    .filter((s) => s.length > 0)
}

function parseParams(text: string): { list: LmParam[] } {
  const inner = text.trim().replace(/^\(/, '').replace(/\)$/, '')
  const list: LmParam[] = []
  for (const part of splitTop(inner, ',')) {
    const t = part.trim()
    if (t.length === 0) continue
    const m = /^(out\s+)?(`[^`]+`|[^\s:]+)\s*:\s*(ref\s+)?([\s\S]+?)(?:\s*=\s*[\s\S]*)?$/.exec(t)
    if (!m) continue
    list.push({ name: unquote(m[2]), out: Boolean(m[1]), byRef: Boolean(m[3]), type: m[4].trim() })
  }
  return { list }
}

function splitTop(text: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let inString = false
  let cur = ''
  let angle = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      cur += ch
      if (ch === '\\') {
        cur += text[i + 1] ?? ''
        i++
      } else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      cur += ch
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    if (ch === ')' || ch === ']' || ch === '}') depth--
    if (ch === '<') angle++
    if (ch === '>') angle = Math.max(0, angle - 1)
    if (ch === sep && depth === 0 && angle === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out
}

function bodyAt(bodies: LmBody[], line: number): string | null {
  for (const b of bodies) if (line >= b.line && line <= b.endLine) return b.name
  return null
}

interface Scan {
  name: string
  receiver: string
  args: string[]
  line: number
  column: number
  body: string | null
}

function receiverBefore(text: string, start: number): string {
  let i = start - 1
  const skipBack = (): void => {
    while (i >= 0 && /\s/.test(text[i])) i--
  }
  skipBack()
  if (i < 0) return ''
  const isChainChar = (ch: string): boolean => isIdentChar(ch) || ch === '.' || ch === '`' || ch === ')' || ch === ']'
  if (!isChainChar(text[i])) return ''
  const end = i
  while (i >= 0) {
    const ch = text[i]
    if (ch === ')' || ch === ']') {
      const open = ch === ')' ? '(' : '['
      const close = ch
      let depth = 0
      while (i >= 0) {
        if (text[i] === close) depth++
        else if (text[i] === open) {
          depth--
          if (depth === 0) break
        }
        i--
      }
      if (i < 0) return ''
      i--
      continue
    }
    if (isIdentChar(ch) || ch === '.' || ch === '`') {
      i--
      continue
    }
    break
  }
  return text.slice(i + 1, end + 1).trim()
}

function scanCalls(lines: CodeLine[], bodies: LmBody[]): LmCall[] {
  const text = lines.map((l) => l.code).join('\n')
  const lineOf = (offset: number): { line: number; column: number } => {
    let line = 1
    let last = -1
    for (let i = 0; i < offset; i++) {
      if (text[i] === '\n') {
        line++
        last = i
      }
    }
    return { line, column: offset - last }
  }
  const out: LmCall[] = []
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (!isIdentStart(ch)) continue
    if (i > 0 && (isIdentChar(text[i - 1]) || text[i - 1] === '`')) continue
    let j = i
    while (j < text.length && isIdentChar(text[j])) j++
    const name = text.slice(i, j)
    let k = j
    while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++
    if (text[k] !== '(') {
      i = j - 1
      continue
    }
    const close = matchParen(text, k)
    if (close < 0) {
      i = j - 1
      continue
    }
    const argsText = text.slice(k + 1, close)
    const at = lineOf(i)
    if (!RESERVED.has(name) && !ITEM_WORDS.has(name)) {
      out.push({
        name,
        receiver: receiverBefore(text, i),
        args: splitTop(argsText, ',')
          .map((a) => a.trim())
          .filter((a) => a.length > 0),
        line: at.line,
        column: at.column,
        body: bodyAt(bodies, at.line),
      })
    }
    i = j - 1
  }
  return out
}

function matchParen(text: string, open: number): number {
  let depth = 0
  let inString = false
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

const ASSIGN_RE = /^((?:`[^`]+`|[A-Za-z_][\w]*)(?:\s*\.\s*(?:`[^`]+`|[A-Za-z_][\w]*))*)\s*(\+=|-=|\*=|\/=|%=|&=|\|=|=)(?!=)([\s\S]*)$/

function scanWrites(lines: CodeLine[], bodies: LmBody[]): LmWrite[] {
  const out: LmWrite[] = []
  for (const l of lines) {
    const code = l.code.trim()
    if (code.length === 0) continue
    const first = code.split(/[\s(:.]/)[0]
    if (STATEMENT_STARTERS.has(first)) continue
    const m = ASSIGN_RE.exec(code)
    if (!m) continue
    const target = m[1].replace(/\s+/g, '')
    const members = splitMembers(target)
    if (members.length < 2) continue
    out.push({
      target,
      members: members.slice(1),
      op: m[2],
      value: m[3].trim(),
      line: l.num,
      column: l.raw.indexOf(target) + 1,
      body: bodyAt(bodies, l.num),
    })
  }
  return out
}

/** Имя типа без обёрток array<>/set<>/map<>/soft<>/class<> и без пути к ассету. */
export function bareTypeName(type: string): string {
  let t = type.trim()
  while (true) {
    const m = /^(?:array|set|soft|class)\s*<\s*([\s\S]*)\s*>$/.exec(t)
    if (m) {
      t = m[1].trim()
      continue
    }
    const map = /^map\s*<\s*([\s\S]*?),[\s\S]*>$/.exec(t)
    if (map) {
      t = map[1].trim()
      continue
    }
    break
  }
  return t
}

export function shortTypeName(type: string): string | null {
  const bare = bareTypeName(type)
  if (bare.length === 0) return null
  if (bare.startsWith('/')) {
    const last = bare.split(/[./]/).filter((s) => s.length > 0).pop()
    return last ? unquote(last) : null
  }
  if (!/^[A-Za-z_`]/.test(bare)) return null
  if (!/^[`\w]+$/.test(bare)) return null
  return unquote(bare)
}

/** Строка файла, если она лежит внутри тела, и имя этого тела. */
export function locateToken(source: string, token: string, comments: LmComment[]): { line: number; column: number } | null {
  const lines = source.replace(/\r/g, '').split('\n')
  const inComment = (line: number, column: number): boolean =>
    comments.some((c) => c.line === line && column >= c.from && column <= c.to)
  for (let i = 0; i < lines.length; i++) {
    let at = lines[i].indexOf(token)
    while (at !== -1) {
      const before = at === 0 ? '' : lines[i][at - 1]
      const after = lines[i][at + token.length] ?? ''
      if (!/\w/.test(before) && !/\w/.test(after) && !inComment(i + 1, at + 1)) {
        return { line: i + 1, column: at + 1 }
      }
      at = lines[i].indexOf(token, at + 1)
    }
  }
  return null
}

import { ServerConfig } from '../config'
import { GameContext } from './game-context'
import { bpClass, bpField, bpFunction, bpUnavailableHint } from './loom-types'

const MAX_CHECK = 24
const MAX_REPORT = 6
const MAX_OWNERS_SHOWN = 2
const MIN_NAME_LENGTH = 3

const LUA_RESERVED = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in', 'local', 'nil',
  'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while', 'self', 'type',
  'print', 'require', 'pcall', 'xpcall', 'ipairs', 'pairs', 'next', 'select', 'error', 'assert', 'tostring',
  'tonumber', 'setmetatable', 'getmetatable', 'rawget', 'rawset', 'unpack', 'pack',
  'concat', 'insert', 'remove', 'sort', 'rep', 'sub', 'find', 'gsub', 'gmatch', 'match', 'format', 'len',
  'floor', 'ceil', 'abs', 'max', 'min', 'random', 'randomseed', 'clock', 'time', 'date', 'huge',
  'open', 'close', 'read', 'write', 'lines', 'flush', 'seek',
  'table', 'string', 'math', 'os', 'io', 'ww', 'dump', 'serialize', 'inline', 'log',
])

export interface LuaMember {
  name: string
  kind: 'method' | 'field'
  write: boolean
}

/** Комментарии и строковые литералы вырезаются: имя члена внутри текста — не обращение к члену. */
function stripLuaNoise(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const longComment = /^--\[(=*)\[/.exec(text.slice(i))
    if (longComment) {
      const close = `]${longComment[1]}]`
      const end = text.indexOf(close, i + longComment[0].length)
      i = end < 0 ? text.length : end + close.length
      continue
    }
    if (text[i] === '-' && text[i + 1] === '-') {
      const nl = text.indexOf('\n', i)
      i = nl < 0 ? text.length : nl
      continue
    }
    const longString = /^\[(=*)\[/.exec(text.slice(i))
    if (longString) {
      const close = `]${longString[1]}]`
      const end = text.indexOf(close, i + longString[0].length)
      i = end < 0 ? text.length : end + close.length
      out += ' '
      continue
    }
    const c = text[i]
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2
          continue
        }
        if (text[j] === c || text[j] === '\n') break
        j++
      }
      i = j + 1
      out += ' '
      continue
    }
    out += c
    i++
  }
  return out
}

const MEMBER_RE = /(?:[A-Za-z_]\w*|\]|\))\s*([.:])\s*([A-Za-z_]\w*)/g

export function extractLuaMembers(chunk: string): LuaMember[] {
  const text = stripLuaNoise(chunk)
  const seen = new Map<string, LuaMember>()
  let m: RegExpExecArray | null
  MEMBER_RE.lastIndex = 0
  while ((m = MEMBER_RE.exec(text)) !== null) {
    const name = m[2]
    if (name.length < MIN_NAME_LENGTH || LUA_RESERVED.has(name)) continue
    let k = m.index + m[0].length
    while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++
    const isCall = text[k] === '('
    const isWrite = !isCall && text[k] === '=' && text[k + 1] !== '=' && text[k - 1] !== '~' && text[k - 1] !== '<' && text[k - 1] !== '>'
    const kind: LuaMember['kind'] = isCall ? 'method' : 'field'
    const key = `${kind}|${name}`
    const prev = seen.get(key)
    if (prev) {
      if (isWrite) prev.write = true
      continue
    }
    seen.set(key, { name, kind, write: isWrite })
  }
  return [...seen.values()]
}

function apiSkipSet(ctx: GameContext): Set<string> {
  const out = new Set(LUA_RESERVED)
  try {
    const rows = ctx.db.query('SELECT symbol FROM lua_api').all() as Array<{ symbol: string }>
    for (const r of rows) {
      const symbol = String(r.symbol ?? '')
      const sep = Math.max(symbol.lastIndexOf(':'), symbol.lastIndexOf('.'))
      out.add(sep >= 0 ? symbol.slice(sep + 1) : symbol)
    }
  } catch {
    return out
  }
  return out
}

type Verdict = 'ok' | 'hard' | 'soft' | 'unknown'

interface OwnerVerdict {
  owner: string
  verdict: Verdict
  reason: string
}

function knownOwner(ctx: GameContext, config: ServerConfig, owner: string): boolean {
  const cls = bpClass(ctx, config, owner)
  if (!cls || !cls.in_types || cls.is_game_blueprint) return false
  return true
}

function methodVerdict(ctx: GameContext, config: ServerConfig, owner: string, name: string): OwnerVerdict {
  if (!knownOwner(ctx, config, owner)) return { owner, verdict: 'unknown', reason: '' }
  const info = bpFunction(ctx, config, owner, name)
  if (!info) return { owner, verdict: 'unknown', reason: '' }
  switch (info.status) {
    case 'callable':
    case 'pure':
    case 'world_context':
    case 'latent':
      return { owner, verdict: 'ok', reason: '' }
    case 'not_in_types':
      return { owner, verdict: 'soft', reason: `нет в types.json кита (${info.owner})` }
    default:
      return { owner, verdict: 'hard', reason: info.note ?? info.status }
  }
}

function fieldVerdict(ctx: GameContext, config: ServerConfig, owner: string, name: string, write: boolean): OwnerVerdict {
  if (!knownOwner(ctx, config, owner)) return { owner, verdict: 'unknown', reason: '' }
  const info = bpField(ctx, config, owner, name)
  if (!info) return { owner, verdict: 'unknown', reason: '' }
  if (info.status === 'edit_only') return { owner, verdict: 'hard', reason: 'edit_only: значение ставится только в Details, код до поля не достаёт' }
  if (info.status === 'hidden') return { owner, verdict: 'soft', reason: 'поля нет в types.json: Blueprint его не видит' }
  if (write && info.status === 'read_only') return { owner, verdict: 'hard', reason: 'read_only: BlueprintReadOnly — читать можно, писать нет' }
  return { owner, verdict: 'ok', reason: '' }
}

function ownersOf(ctx: GameContext, member: LuaMember): string[] {
  if (member.kind === 'method') {
    const rows = ctx.db
      .query("SELECT outer_path FROM objects WHERE kind = 'Function' AND name = ? COLLATE NOCASE AND outer_path IS NOT NULL LIMIT 4")
      .all(member.name) as Array<{ outer_path: string }>
    return rows.map((r) => r.outer_path)
  }
  const rows = ctx.db.query('SELECT owner_path FROM properties WHERE name = ? COLLATE NOCASE LIMIT 4').all(member.name) as Array<{ owner_path: string }>
  return rows.map((r) => r.owner_path)
}

export interface BpReachReport {
  checked: number
  extracted: number
  warnings: Array<{ member: LuaMember; reason: string; owners: string[]; hard: boolean }>
  total: number
}

/** Члены из текста чанка, до которых Blueprint не дотягивается: сверка имён с типами кита. */
export function bpReach(ctx: GameContext, config: ServerConfig, chunk: string): BpReachReport | null {
  if (bpUnavailableHint(config)) return null
  const skip = apiSkipSet(ctx)
  const members = extractLuaMembers(chunk).filter((m) => !skip.has(m.name))
  const warnings: BpReachReport['warnings'] = []
  let checked = 0
  for (const member of members) {
    if (checked >= MAX_CHECK) break
    checked++
    const owners = ownersOf(ctx, member)
    if (owners.length === 0) continue
    const verdicts = owners.map((o) =>
      member.kind === 'method' ? methodVerdict(ctx, config, o, member.name) : fieldVerdict(ctx, config, o, member.name, member.write),
    )
    const known = verdicts.filter((v) => v.verdict !== 'unknown')
    if (known.length === 0) continue
    if (known.some((v) => v.verdict === 'ok')) continue
    const hard = known.every((v) => v.verdict === 'hard')
    const first = known.find((v) => v.verdict === 'hard') ?? known[0]
    warnings.push({ member, reason: first.reason, owners: known.map((v) => v.owner), hard })
  }
  warnings.sort((a, b) => Number(b.hard) - Number(a.hard))
  return { checked, extracted: members.length, warnings, total: warnings.length }
}

export function bpReachLine(report: BpReachReport | null): string | null {
  if (!report || report.warnings.length === 0) return null
  const shown = report.warnings.slice(0, MAX_REPORT)
  const parts = shown.map((w) => {
    const owners = w.owners.slice(0, MAX_OWNERS_SHOWN).join(', ')
    const more = w.owners.length > MAX_OWNERS_SHOWN ? ' и др.' : ''
    return `${w.member.name} [${w.member.kind === 'method' ? 'вызов' : 'поле'} в ${owners}${more}]: ${w.reason}`
  })
  const extra = report.total > shown.length ? `; ещё ${report.total - shown.length}` : ''
  const checkedNote = report.extracted > report.checked ? ` (проверено ${report.checked} имён из ${report.extracted})` : ''
  return `недоступно Blueprint: ${report.total}${checkedNote} — ${parts.join('; ')}${extra}`
}

import { GameContext, versionEchoFields } from '../utils/game-context'
import { renderAiText, Scalar } from '../utils/ai-text'
import { findObject, suggestSimilar } from './common'

export interface GetBytecodeArgs {
  function_path: string
  offset?: number
  max_chars?: number
  entry?: number
}

interface BytecodeRow {
  function_path: string
  expr_count: number
  disasm: string
}

const DEFAULT_CHARS = 8000
const MAX_CHARS = 40000
const STUB_RE = /StackNode=(\S+:ExecuteUbergraph_\w+)[^\n]*\n\s+EX_IntConst Value=(\d+)/
const TOP_LINE_RE = /^\[\d+\] (\w+)[^\n]*StatementIndex=(\d+)/

function bytecodeRow(ctx: GameContext, path: string): BytecodeRow | null {
  return ctx.db
    .query('SELECT function_path, expr_count, disasm FROM function_bytecode WHERE function_path = ?')
    .get(path) as BytecodeRow | null
}

/** Кусок ubergraph от точки входа события до первого верхнеуровневого выхода из потока. */
function entrySlice(disasm: string, entry: number): string | null {
  const lines = disasm.split('\n')
  const start = lines.findIndex((l) => {
    const m = TOP_LINE_RE.exec(l)
    return m !== null && Number(m[2]) === entry
  })
  if (start < 0) return null
  let end = lines.length
  for (let i = start; i < lines.length; i++) {
    const m = TOP_LINE_RE.exec(lines[i])
    if (m && (m[1] === 'EX_PopExecutionFlow' || m[1] === 'EX_Return' || m[1] === 'EX_EndOfScript')) {
      end = i + 1
      while (end < lines.length && !TOP_LINE_RE.test(lines[end])) end++
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

export function handleGetBytecode(ctx: GameContext, args: GetBytecodeArgs): string {
  const obj = findObject(ctx, args.function_path)
  const row = bytecodeRow(ctx, obj?.path ?? args.function_path)

  if (!row) {
    const suggestions = suggestSimilar(ctx, args.function_path)
    return renderAiText({
      reportType: 'function_bytecode',
      fields: {
        ...versionEchoFields(ctx),
        status: obj ? 'no_bytecode' : 'not_found',
        query: args.function_path,
        hint: obj
          ? 'функция найдена в индексе, но байткода для неё нет: либо это нативная C++/движковая функция, либо её ассет не попал в prefix xref-скана'
          : 'путь не найден в индексе',
        suggestions: suggestions.length > 0 ? suggestions.join('; ') : 'нет',
      },
    })
  }

  const fields: Record<string, Scalar> = {
    ...versionEchoFields(ctx),
    status: 'found',
    path: row.function_path,
    expr_count: row.expr_count,
  }
  const blocks: Record<string, string> = {}
  let text = row.disasm

  const stub = args.entry === undefined && row.disasm.length < 1000 ? STUB_RE.exec(row.disasm) : null
  const uberObj = stub ? findObject(ctx, stub[1]) : null
  const uber = uberObj ? bytecodeRow(ctx, uberObj.path) : null
  if (stub && uber) {
    const entry = Number(stub[2])
    const slice = entrySlice(uber.disasm, entry)
    fields.ubergraph = uber.function_path
    fields.entry = entry
    if (slice) {
      blocks.stub = row.disasm
      text = slice
      fields.shows = 'тело события в ubergraph от точки входа до выхода из потока; переходы (EX_Jump, PushingAddress) ведут в другие места ubergraph — их читай с entry=<StatementIndex>'
    }
  } else if (args.entry !== undefined) {
    const slice = entrySlice(row.disasm, args.entry)
    if (!slice) {
      return renderAiText({
        reportType: 'function_bytecode',
        fields: { ...fields, status: 'entry_not_found', entry: args.entry, hint: 'entry — StatementIndex строки верхнего уровня ([N] EX_...) этой функции' },
      })
    }
    fields.entry = args.entry
    text = slice
  }

  const maxChars = Math.min(Math.max(args.max_chars ?? DEFAULT_CHARS, 500), MAX_CHARS)
  let offset = Math.min(Math.max(args.offset ?? 0, 0), text.length)
  if (offset > 0 && text[offset - 1] !== '\n') {
    const nl = text.indexOf('\n', offset)
    offset = nl < 0 ? text.length : nl + 1
  }
  let end = Math.min(offset + maxChars, text.length)
  if (end < text.length) {
    const nl = text.lastIndexOf('\n', end)
    if (nl > offset) end = nl + 1
  }
  const truncated = end < text.length
  fields.total_chars = text.length
  if (offset > 0) fields.offset = offset
  fields.shown_chars = end - offset
  fields.truncated_output = truncated
  if (truncated) fields.next_offset = end
  blocks.disasm = text.slice(offset, end)

  return renderAiText({ reportType: 'function_bytecode', fields, results: [{ fields: {}, blocks }] })
}

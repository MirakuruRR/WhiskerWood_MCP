import { GameContext, versionEchoFields } from '../utils/game-context'
import { renderAiText } from '../utils/ai-text'
import { findObject, suggestSimilar } from './common'

export interface GetBytecodeArgs {
  function_path: string
}

const MAX_DISASM_CHARS = 8000

export function handleGetBytecode(ctx: GameContext, args: GetBytecodeArgs): string {
  const obj = findObject(ctx, args.function_path)
  const lookupPath = obj?.path ?? args.function_path

  const row = ctx.db
    .query('SELECT function_path, expr_count, disasm FROM function_bytecode WHERE function_path = ?')
    .get(lookupPath) as { function_path: string; expr_count: number; disasm: string } | null

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

  const truncated = row.disasm.length > MAX_DISASM_CHARS
  const disasm = truncated ? row.disasm.slice(0, MAX_DISASM_CHARS) : row.disasm

  return renderAiText({
    reportType: 'function_bytecode',
    fields: {
      ...versionEchoFields(ctx),
      status: 'found',
      path: row.function_path,
      expr_count: row.expr_count,
      shown_chars: disasm.length,
      truncated_output: truncated,
    },
    results: [{ fields: {}, blocks: { disasm } }],
  })
}

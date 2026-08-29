import { ServerConfig } from '../config'
import { renderAiText } from '../utils/ai-text'
import { MEMORY_COLUMNS, MemoryRow, openMemoryDb } from '../utils/memory-db'
import { memoryResult } from './memory-common'

export interface MemoryWakeupArgs {
  mod_name?: string
  limit?: number
}

export function handleMemoryWakeup(config: ServerConfig, args: MemoryWakeupArgs): string {
  const db = openMemoryDb(config)
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100)

  const totals = db
    .query(
      `SELECT
         SUM(status = 'active') AS active,
         SUM(status <> 'active') AS invalidated
       FROM project_memories`,
    )
    .get() as { active: number | null; invalidated: number | null }

  if ((totals.active ?? 0) === 0 && (totals.invalidated ?? 0) === 0) {
    return renderAiText({
      reportType: 'memory_wakeup',
      fields: {
        status: 'empty',
        hint: 'память пуста. Записывай решения и грабли через ww_memory_add по ходу работы — они переживут сессию и попадут в линт ww_validate_mod',
      },
    })
  }

  const modFilter = args.mod_name ? ' AND (mod_name = ? OR mod_name IS NULL)' : ''
  const modParams = args.mod_name ? [args.mod_name] : []

  const byCategory = db
    .query(`SELECT category, COUNT(*) AS n FROM project_memories WHERE status = 'active'${modFilter} GROUP BY category ORDER BY n DESC`)
    .all(...(modParams as never[])) as Array<{ category: string; n: number }>

  const byMod = db
    .query(
      `SELECT COALESCE(mod_name, '(общие)') AS m, COUNT(*) AS n FROM project_memories
       WHERE status = 'active' GROUP BY m ORDER BY n DESC LIMIT 20`,
    )
    .all() as Array<{ m: string; n: number }>

  const openTodos = (db
    .query(`SELECT COUNT(*) AS n FROM project_memories WHERE status = 'active' AND category = 'todo'${modFilter}`)
    .get(...(modParams as never[])) as { n: number }).n

  const rows = db
    .query(
      `SELECT ${MEMORY_COLUMNS} FROM project_memories
       WHERE status = 'active'${modFilter}
       ORDER BY importance DESC, updated_at DESC
       LIMIT ?`,
    )
    .all(...(modParams as never[]), limit) as MemoryRow[]

  return renderAiText({
    reportType: 'memory_wakeup',
    fields: {
      status: 'ok',
      ...(args.mod_name ? { mod_name: args.mod_name } : {}),
      active: totals.active ?? 0,
      invalidated: totals.invalidated ?? 0,
      open_todos: openTodos,
      by_category: byCategory.map((r) => `${r.category}=${r.n}`).join('; ') || 'нет',
      by_mod: byMod.map((r) => `${r.m}=${r.n}`).join('; ') || 'нет',
      hint: 'детали по теме ищи через ww_memory_search; устаревшее гаси через ww_memory_invalidate, а не переписывай молча',
    },
    results: rows.map((r) => memoryResult(r)),
    totalFound: totals.active ?? 0,
    truncated: (totals.active ?? 0) > rows.length,
    limit,
  })
}

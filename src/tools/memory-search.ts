import { ServerConfig } from '../config'
import { renderAiText } from '../utils/ai-text'
import { openMemoryDb } from '../utils/memory-db'
import { memoryResult, searchMemories } from './memory-common'

export interface MemorySearchArgs {
  query: string
  mod_name?: string
  category?: string
  include_invalidated?: boolean
  limit?: number
}

export function handleMemorySearch(config: ServerConfig, args: MemorySearchArgs): string {
  const db = openMemoryDb(config)
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 100)
  const { rows, via } = searchMemories(
    db,
    args.query,
    { mod_name: args.mod_name, category: args.category, include_invalidated: args.include_invalidated },
    limit,
  )

  if (rows.length === 0) {
    const active = (db.query("SELECT COUNT(*) AS n FROM project_memories WHERE status = 'active'").get() as { n: number }).n
    return renderAiText({
      reportType: 'memory_search',
      fields: {
        status: 'not_found',
        query: args.query,
        via,
        active_total: active,
        hint:
          active === 0
            ? 'память пуста — записывать нечего было'
            : 'по этому запросу записей нет. Общий обзор даёт ww_memory_wakeup; решение, принятое сейчас, стоит записать через ww_memory_add',
      },
    })
  }

  return renderAiText({
    reportType: 'memory_search',
    fields: {
      status: 'ok',
      query: args.query,
      via,
      ...(args.mod_name ? { mod_name: args.mod_name } : {}),
      ...(args.category ? { category: args.category } : {}),
    },
    results: rows.map((r) => memoryResult(r, { fullBody: true })),
    limit,
  })
}

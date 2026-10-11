import { ServerConfig } from '../config'
import { renderAiText } from '../utils/ai-text'
import { openMemoryDb } from '../utils/memory-db'
import { memoriesByIds, memoryResult, searchMemories } from './memory-common'

export interface MemorySearchArgs {
  query?: string
  ids?: string[]
  full?: boolean
  mod_name?: string
  category?: string
  include_invalidated?: boolean
  limit?: number
  offset?: number
}

export function handleMemorySearch(config: ServerConfig, args: MemorySearchArgs): string {
  const db = openMemoryDb(config)
  const ids = (args.ids ?? []).map((id) => id.trim()).filter((id) => id.length > 0)
  const query = (args.query ?? '').trim()

  if (ids.length > 0) {
    const rows = memoriesByIds(db, ids)
    const found = new Set(rows.map((r) => r.public_id))
    const missing = ids.filter((id) => !found.has(id))
    return renderAiText({
      reportType: 'memory_search',
      fields: {
        status: rows.length > 0 ? 'ok' : 'not_found',
        ids: ids.join(', '),
        ...(missing.length > 0 ? { missing: missing.join(', ') } : {}),
      },
      results: rows.map((r) => memoryResult(r, { body: 'full' })),
    })
  }

  if (query.length === 0) {
    return renderAiText({
      reportType: 'memory_search',
      fields: { status: 'bad_args', hint: 'задай query (слова по теме) или ids (public_id из прошлой выдачи)' },
    })
  }

  const limit = Math.min(Math.max(args.limit ?? 10, 1), 100)
  const offset = Math.max(args.offset ?? 0, 0)
  const { rows: all, via } = searchMemories(
    db,
    query,
    { mod_name: args.mod_name, category: args.category, include_invalidated: args.include_invalidated },
    offset + limit + 1,
  )
  const rows = all.slice(offset, offset + limit)
  const more = all.length > offset + limit

  if (rows.length === 0) {
    const active = (db.query("SELECT COUNT(*) AS n FROM project_memories WHERE status = 'active'").get() as { n: number }).n
    return renderAiText({
      reportType: 'memory_search',
      fields: {
        status: 'not_found',
        query,
        via,
        ...(offset > 0 ? { offset, matched: all.length } : {}),
        active_total: active,
        hint:
          active === 0
            ? 'память пуста — записывать нечего было'
            : offset > 0
              ? `совпадений всего ${all.length}, offset дальше конца`
              : 'по этому запросу записей нет. Общий обзор даёт ww_memory_wakeup; решение, принятое сейчас, стоит записать через ww_memory_add',
      },
    })
  }

  const full = args.full === true
  return renderAiText({
    reportType: 'memory_search',
    fields: {
      status: 'ok',
      query,
      via,
      ...(args.mod_name ? { mod_name: args.mod_name } : {}),
      ...(args.category ? { category: args.category } : {}),
      ...(offset > 0 ? { offset } : {}),
      ...(more ? { next_offset: offset + limit } : {}),
      ...(full ? {} : { hint: 'это заголовки: тела нужных записей — тот же инструмент с ids=[public_id, ...]' }),
    },
    results: rows.map((r) => memoryResult(r, { body: full ? 'full' : 'none' })),
    truncated: more,
    limit,
  })
}

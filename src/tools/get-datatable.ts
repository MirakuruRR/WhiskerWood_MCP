import { GameContext, versionEchoFields } from '../utils/game-context'
import { renderAiText, MAX_RESULTS } from '../utils/ai-text'

export interface GetDataTableArgs {
  name?: string
  row?: string
  row_pattern?: string
  limit?: number
}

interface TableRow {
  name: string
  asset_path: string
  row_struct: string | null
  row_count: number
  kind: string
}

const DEFAULT_LIMIT = 25
const JSON_LIMIT_LIST = 1500
const JSON_LIMIT_SINGLE = 20000

function likePattern(pattern: string): string {
  return pattern.includes('%') ? pattern : `%${pattern}%`
}

function jsonBlock(json: string, limit: number): { body: string; truncated: boolean } {
  if (json.length <= limit) return { body: json, truncated: false }
  return { body: `${json.slice(0, limit)}…`, truncated: true }
}

function findTable(ctx: GameContext, name: string): TableRow | null {
  return (ctx.db
    .query('SELECT name, asset_path, row_struct, row_count, kind FROM datatables WHERE name = ? COLLATE NOCASE')
    .get(name) as TableRow | null)
}

export function handleGetDataTable(ctx: GameContext, args: GetDataTableArgs): string {
  const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_RESULTS)
  const echo = versionEchoFields(ctx)

  if (!args.name && !args.row_pattern && !args.row) {
    const tables = ctx.db
      .query('SELECT name, asset_path, row_struct, row_count, kind FROM datatables ORDER BY name')
      .all() as TableRow[]
    return renderAiText({
      reportType: 'datatable_list',
      fields: { ...echo, status: 'ok', total_found: tables.length },
      results: tables.map((t) => ({
        fields: {
          name: t.name,
          asset_path: t.asset_path,
          row_struct: t.row_struct ?? 'unknown',
          row_count: t.row_count,
          kind: t.kind,
        },
      })),
    })
  }

  if (args.name) {
    const table = findTable(ctx, args.name)
    if (!table) {
      const near = ctx.db
        .query('SELECT name FROM datatables WHERE name LIKE ? ORDER BY name LIMIT 8')
        .all(likePattern(args.name)) as Array<{ name: string }>
      return renderAiText({
        reportType: 'datatable',
        fields: {
          ...echo,
          status: 'not_found',
          query: args.name,
          suggestions: near.length > 0 ? near.map((n) => n.name).join('; ') : 'нет',
        },
      })
    }

    if (table.kind === 'loc') {
      return renderAiText({
        reportType: 'datatable',
        fields: {
          ...echo,
          status: 'loc_table',
          name: table.name,
          asset_path: table.asset_path,
          row_struct: table.row_struct ?? 'unknown',
          row_count: table.row_count,
          hint: 'строки локализации лежат в loc_entries; читай их через ww_resolve_loc',
        },
      })
    }

    const base = { ...echo, name: table.name, asset_path: table.asset_path, row_struct: table.row_struct ?? 'unknown', row_count: table.row_count }

    if (args.row) {
      const row = ctx.db
        .query('SELECT row_name, row_json FROM datatable_rows WHERE table_name = ? AND row_name = ? COLLATE NOCASE')
        .get(table.name, args.row) as { row_name: string; row_json: string } | null
      if (!row) {
        const near = ctx.db
          .query('SELECT row_name FROM datatable_rows WHERE table_name = ? AND row_name LIKE ? ORDER BY row_name LIMIT 8')
          .all(table.name, likePattern(args.row)) as Array<{ row_name: string }>
        return renderAiText({
          reportType: 'datatable',
          fields: {
            ...base,
            status: 'row_not_found',
            query_row: args.row,
            suggestions: near.length > 0 ? near.map((n) => n.row_name).join('; ') : 'нет',
          },
        })
      }
      const block = jsonBlock(row.row_json, JSON_LIMIT_SINGLE)
      return renderAiText({
        reportType: 'datatable',
        fields: { ...base, status: 'found' },
        results: [
          {
            fields: { row_name: row.row_name, json_truncated: block.truncated },
            blocks: { row_json: block.body },
          },
        ],
      })
    }

    const where = args.row_pattern ? 'table_name = ? AND row_name LIKE ?' : 'table_name = ?'
    const params: string[] = args.row_pattern ? [table.name, likePattern(args.row_pattern)] : [table.name]
    const total = (ctx.db.query(`SELECT COUNT(*) c FROM datatable_rows WHERE ${where}`).get(...(params as never[])) as { c: number }).c
    const rows = ctx.db
      .query(`SELECT row_name, row_json FROM datatable_rows WHERE ${where} ORDER BY row_name LIMIT ?`)
      .all(...(params as never[]), limit) as Array<{ row_name: string; row_json: string }>

    return renderAiText({
      reportType: 'datatable',
      fields: { ...base, status: rows.length > 0 ? 'found' : 'no_rows' },
      truncated: total > rows.length,
      totalFound: total,
      limit,
      results: rows.map((r) => {
        const block = jsonBlock(r.row_json, JSON_LIMIT_LIST)
        return {
          fields: { row_name: r.row_name, json_truncated: block.truncated },
          blocks: { row_json: block.body },
        }
      }),
    })
  }

  const pattern = likePattern(args.row_pattern!)
  const total = (ctx.db
    .query('SELECT COUNT(*) c FROM datatable_rows WHERE row_name LIKE ?')
    .get(pattern) as { c: number }).c
  const rows = ctx.db
    .query('SELECT table_name, row_name FROM datatable_rows WHERE row_name LIKE ? ORDER BY table_name, row_name LIMIT ?')
    .all(pattern, limit) as Array<{ table_name: string; row_name: string }>

  return renderAiText({
    reportType: 'datatable_row_search',
    fields: { ...echo, status: rows.length > 0 ? 'found' : 'not_found', query: args.row_pattern! },
    truncated: total > rows.length,
    totalFound: total,
    limit,
    results: rows.map((r) => ({ fields: { table: r.table_name, row_name: r.row_name } })),
  })
}

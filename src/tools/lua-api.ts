import { ServerConfig } from '../config'
import { GameContext } from '../utils/game-context'
import { AiTextResult, renderAiText } from '../utils/ai-text'
import { findLuaApi, loadLuaApi, LuaApiEntry, LuaApiError } from '../utils/lua-api'
import { echoFields } from './bridge-common'

export interface LuaApiArgs {
  symbol?: string
  category?: string
}

function entryResult(e: LuaApiEntry): AiTextResult {
  const blocks: Record<string, string> = {}
  if (e.example) blocks.example = e.example
  if (e.pitfalls) blocks.pitfalls = e.pitfalls
  return {
    fields: {
      symbol: e.symbol,
      category: e.category,
      signature: e.signature,
      summary: e.summary,
      status: e.status,
      verified: e.verified,
    },
    ...(Object.keys(blocks).length > 0 ? { blocks } : {}),
  }
}

export function handleLuaApi(ctx: GameContext | null, config: ServerConfig, args: LuaApiArgs): string {
  let entries: LuaApiEntry[]
  try {
    entries = loadLuaApi(config)
  } catch (e) {
    if (e instanceof LuaApiError) {
      return renderAiText({ reportType: 'lua_api', fields: { ...echoFields(ctx), status: 'unavailable', error: e.message } })
    }
    throw e
  }

  if (args.category) {
    const cat = args.category.toLowerCase()
    const hits = entries.filter((e) => e.category.toLowerCase() === cat)
    if (hits.length === 0) {
      return renderAiText({
        reportType: 'lua_api',
        fields: {
          ...echoFields(ctx),
          status: 'category_not_found',
          category: args.category,
          categories: [...new Set(entries.map((e) => e.category))].join(', '),
        },
      })
    }
    const filtered = args.symbol ? findLuaApi(hits, args.symbol) : hits
    return renderAiText({
      reportType: 'lua_api',
      fields: { ...echoFields(ctx), status: 'ok', category: args.category },
      results: filtered.map(entryResult),
    })
  }

  if (args.symbol) {
    const hits = findLuaApi(entries, args.symbol)
    if (hits.length === 0) {
      return renderAiText({
        reportType: 'lua_api',
        fields: {
          ...echoFields(ctx),
          status: 'not_found',
          query: args.symbol,
          hint: 'справочник описывает API UE4SS, а не классы игры; функции и классы игры ищи через ww_find_symbol',
          categories: [...new Set(entries.map((e) => e.category))].join(', '),
        },
      })
    }
    return renderAiText({
      reportType: 'lua_api',
      fields: { ...echoFields(ctx), status: 'ok', query: args.symbol },
      results: hits.map(entryResult),
    })
  }

  const byCategory = new Map<string, LuaApiEntry[]>()
  for (const e of entries) {
    const list = byCategory.get(e.category) ?? []
    list.push(e)
    byCategory.set(e.category, list)
  }
  return renderAiText({
    reportType: 'lua_api_index',
    fields: { ...echoFields(ctx), status: 'ok', symbols_total: entries.length },
    results: [...byCategory.entries()].map(([category, list]) => ({
      fields: {
        category,
        count: list.length,
        symbols: list.map((e) => (e.status === 'ok' ? e.symbol : `${e.symbol}(${e.status})`)).join(', '),
      },
    })),
  })
}

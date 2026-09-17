import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { rmSync } from 'node:fs'
import { loadConfig, validateConfig } from '../config'
import { createServer } from '../server'
import { closeMemoryDb, openMemoryDb } from '../utils/memory-db'

const cfg = loadConfig()
const problems = validateConfig(cfg)
if (problems.length > 0) {
  console.error('Конфигурация не прошла проверку:')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

const server = createServer(cfg)
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
await server.connect(serverTransport)

const client = new Client({ name: 'smoke-client', version: '0.0.1' })
await client.connect(clientTransport)

const tools = await client.listTools()
console.log(`инструментов зарегистрировано: ${tools.tools.length}`)
for (const t of tools.tools) console.log(`  - ${t.name}`)

const call = async (name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args })
  const text = (res.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n')
  console.log(`\n===== ${name} =====`)
  console.log(text)
  return text
}

await call('ww_index_status', {})
await call('ww_find_symbol', { pattern: 'research topic' })
await call('ww_find_symbol', { pattern: 'NotificationBoard' })
await call('ww_search_members', { pattern: 'researchUnlockId' })
await call('ww_get_type', { path: '/Script/SystemCore.UnlockResearchComponent' })
await call('ww_get_function', { path: 'SystemCore.UnlockResearchComponent.SetResearchTopic' })
await call('ww_get_function', { path: 'MouseMessageBlip.MouseMessageBlip_C.Construct' })
await call('ww_verify_hook', {
  paths: [
    'SystemCore.UnlockResearchComponent.startResearch',
    'SystemCore.UnlockResearchComponent.SetResearchTopic',
    '/Script/SystemCore.UnlockResearchComponent:IsResearched',
    '/Game/UI/DebugUI_Components/MouseMessageBlip.MouseMessageBlip_C:Construct',
    'SystemCore.NotificationBoard',
  ],
})
await call('ww_get_type', { path: 'CoreUObject.EAutomationEventType' })
await call('ww_find_symbol', { pattern: 'NotificationBoard', version: '9.9.9' })
await call('ww_find_symbol', { pattern: 'ProblemIndicator' })

await call('ww_get_datatable', {})
await call('ww_get_datatable', { name: 'TechUnlocksV2', limit: 2 })
await call('ww_get_datatable', { name: 'TechUnlocksV2', row: 'unlock.lumbermill' })
await call('ww_get_datatable', { name: 'Loc_Ru' })
await call('ww_get_datatable', { name: 'GameTuning' })
await call('ww_get_datatable', { row_pattern: 'lumbermill', limit: 10 })
await call('ww_get_datatable', { name: 'НетТакойТаблицы' })
await call('ww_resolve_loc', { key_or_pattern: 'mod.desc.starvation' })
await call('ww_resolve_loc', { key_or_pattern: 'mod.desc.starvation', lang: 'all' })
await call('ww_resolve_loc', { key_or_pattern: 'action.doubletime', lang: 'Ja' })
await call('ww_resolve_loc', { key_or_pattern: 'unlock.lumbermill' })
await call('ww_resolve_loc', { key_or_pattern: 'Скоро умрет', lang: 'Ru' })
await call('ww_resolve_loc', { key_or_pattern: 'нет.такого.ключа' })
await call('ww_find_asset', { pattern: 'TechUnlocksV2' })
await call('ww_find_asset', { pattern: 'MouseMessageBlip' })
await call('ww_find_asset', { pattern: 'Loc_', class: 'DataTable', limit: 5 })
await call('ww_extract_asset', { asset_path: '/Game/Data/AssetLookups/TechUnlocksV2', dest_dir: './state/extracted/tech' })
await call('ww_extract_asset', { asset_path: 'MouseMessageBlip', dest_dir: './state/extracted/blip' })
await call('ww_extract_asset', { asset_path: '/Game/Data/AssetLookups/TechUnlocksV2', dest_dir: './dist/hack' })
await call('ww_extract_asset', { asset_path: '/Game/Nope/DoesNotExist', dest_dir: './state/extracted/nope' })

await call('ww_game_status', {})
await call('ww_game_log', { level: 'error', limit: 10 })
await call('ww_game_log', { mod: 'AutoDump', limit: 8 })
await call('ww_game_eval', { lua: "return #FindAllOf('Actor')" })
await call('ww_game_console', { command: 'stat fps' })
await call('ww_verify_hook', {
  live: true,
  paths: [
    'SystemCore.UnlockResearchComponent.SetResearchTopic',
    'SystemCore.UnlockResearchComponent.startResearch',
    '/Game/UI/DebugUI_Components/MouseMessageBlip.MouseMessageBlip_C:Construct',
    '/Game/UI/Nope/DoesNotExist.DoesNotExist_C:Construct',
  ],
})

await call('ww_lua_api', {})
await call('ww_lua_api', { symbol: 'RegisterHook' })
await call('ww_lua_api', { symbol: 'FindAllOf' })
await call('ww_lua_api', { category: 'threading' })
await call('ww_lua_api', { symbol: 'НетТакогоСимвола' })

await call('ww_generate_hook', { function_path: 'SystemCore.UnlockResearchComponent.SetResearchTopic', kind: 'both' })
await call('ww_generate_hook', { function_path: 'MouseMessageBlip.MouseMessageBlip_C.Construct' })
await call('ww_generate_hook', { function_path: 'SystemCore.UnlockResearchComponent.startResearch' })
await call('ww_generate_hook', { function_path: 'SystemCore.UnlockResearchComponent' })

const scaffoldRoot = `${cfg.modsRepo}/mods/smoke-probe`
await call('ww_scaffold_mod', { mod_root: scaffoldRoot, template: 'hook' })
await call('ww_scaffold_mod', { mod_root: scaffoldRoot, template: 'hook' })
await call('ww_scaffold_mod', { mod_root: 'D:/Windows/hack', template: 'hook' })
await call('ww_validate_mod', { mod_root: scaffoldRoot })
await call('ww_validate_mod', { mod_root: `${cfg.modsRepo}/mods/research-notifier` })
await call('ww_validate_mod', { mod_root: `${cfg.modsRepo}/mods/research-notifier`, live: true })
await call('ww_deploy_mod', { mod_root: `${cfg.modsRepo}/mods/research-notifier` })

await call('ww_memory_wakeup', {})
const added = await call('ww_memory_add', {
  mod_name: 'smoke-probe',
  entries: [
    {
      category: 'pitfall',
      summary: 'Utf8String на UE 5.6 не работает: кириллица уходит в мусор',
      body: 'Проверено на стенде 0.6.190.0. Текст брать через ww_resolve_loc, в Lua передавать готовую строку.',
      tags: ['Utf8String'],
      importance: 5,
    },
    {
      category: 'decision',
      summary: 'Хук вешаем на GetResearchInfo, а не на startResearch',
      body: 'startResearch есть в строках бинарника, но отсутствует в рефлексии.',
      tags: ['GetResearchInfo', 'startResearch'],
    },
  ],
})
await call('ww_memory_add', {
  mod_name: 'smoke-probe',
  entries: [{ category: 'pitfall', summary: 'Utf8String на UE 5.6 не работает: кириллица уходит в мусор', body: 'Повтор — должен обновить, а не задвоить.', tags: ['Utf8String'] }],
})
await call('ww_memory_search', { query: 'Utf8String' })
await call('ww_memory_search', { query: 'research', mod_name: 'smoke-probe' })
await call('ww_memory_search', { query: 'такогонетвпамяти' })
const pid = /public_id: (\S+)/.exec(added)?.[1] ?? 'нет'
await call('ww_memory_invalidate', { public_id: pid, reason: 'смоук-прогон, запись тестовая' })
await call('ww_memory_invalidate', { public_id: pid, reason: 'повтор' })
await call('ww_memory_invalidate', { public_id: 'нет-такого-id', reason: 'проверка ветки not_found' })

await call('ww_diff_versions', { from: '0.6.190.0', to: '0.6.190.0' })
await call('ww_diff_versions', { from: '0.6.190.0', to: '9.9.9.9' })

const prompts = await client.listPrompts()
console.log(`
промптов зарегистрировано: ${prompts.prompts.length}`)
for (const p of prompts.prompts) console.log(`  - ${p.name}`)
const newMod = await client.getPrompt({ name: 'ww:new-mod', arguments: { goal: 'уведомление о простое исследований', mod_name: 'research-notifier' } })
console.log((newMod.messages[0].content as { text: string }).text.slice(0, 400))


rmSync(scaffoldRoot, { recursive: true, force: true })
openMemoryDb(cfg).run("DELETE FROM project_memories WHERE mod_name = 'smoke-probe'")
closeMemoryDb()

await client.close()
await server.close()
process.exit(0)

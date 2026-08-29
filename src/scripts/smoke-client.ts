import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { loadConfig, validateConfig } from '../config'
import { createServer } from '../server'

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

await client.close()
await server.close()
process.exit(0)

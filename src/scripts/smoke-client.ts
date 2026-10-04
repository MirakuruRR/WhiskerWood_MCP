import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { readdirSync, rmSync } from 'node:fs'
import { loadConfig, Toolset, TOOLSETS, validateConfig } from '../config'
import { PROMPT_GROUPS } from '../prompts'
import { createServer } from '../server'
import { TOOL_GROUPS } from '../toolsets'
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
const byGroup: Record<string, number> = {}
for (const t of tools.tools) {
  const g = TOOL_GROUPS[t.name] ?? '?'
  byGroup[g] = (byGroup[g] ?? 0) + 1
}
console.log(`по группам: ${Object.entries(byGroup).map(([g, n]) => `${g}=${n}`).join(' ')}`)
const unmapped = tools.tools.filter((t) => !TOOL_GROUPS[t.name]).map((t) => t.name)
if (unmapped.length > 0) console.log(`без группы: ${unmapped.join(', ')}`)
for (const t of tools.tools) console.log(`  - ${t.name}`)

const registered = new Set(tools.tools.map((t) => t.name))
const call = async (name: string, args: Record<string, unknown>) => {
  if (!registered.has(name)) {
    console.log(`\n===== ${name} ===== пропущен: группа ${TOOL_GROUPS[name] ?? '?'} выключена`)
    return ''
  }
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
await call('ww_game_log', { source: 'modlog', limit: 5 })
await call('ww_game_log', { source: 'modlog', mod: 'research_notifier', limit: 5 })
await call('ww_game_log', { source: 'modlog', since: 'session', limit: 5 })
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
  entries: [
    {
      mod_name: 'smoke-probe',
      category: 'pitfall',
      summary: 'Utf8String на UE 5.6 не работает: кириллица уходит в мусор',
      body: 'Проверено на стенде 0.6.190.0. Текст брать через ww_resolve_loc, в Lua передавать готовую строку.',
      tags: ['Utf8String'],
      importance: 5,
    },
    {
      mod_name: 'smoke-probe',
      category: 'decision',
      summary: 'Хук вешаем на GetResearchInfo, а не на startResearch',
      body: 'startResearch есть в строках бинарника, но отсутствует в рефлексии.',
      tags: ['GetResearchInfo', 'startResearch'],
    },
  ],
})
await call('ww_memory_add', {
  entries: [{ mod_name: 'smoke-probe', category: 'pitfall', summary: 'Utf8String на UE 5.6 не работает: кириллица уходит в мусор', body: 'Повтор — должен обновить, а не задвоить.', tags: ['Utf8String'] }],
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

await call('ww_loom_status', {})
await call('ww_event_surface', { class_path: 'SystemCore.ModAPI', limit: 6 })
await call('ww_event_surface', { class_path: 'BP_PlayHud', depth: 0, limit: 4 })
await call('ww_event_surface', { class_path: 'НетТакогоКласса' })
await call('ww_find_symbol', { pattern: 'WriteDataTableValue', bp_only: true })
await call('ww_get_function', { path: 'SystemCore.ModAPI.WriteDataTableValue' })
await call('ww_get_function', { path: 'ProjectArco.AgentEnterable.AssignWorkerToSlot' })
await call('ww_get_type', { path: 'BP_PlayHud' })
await call('ww_lift', { asset_path: 'MouseMessageBlip' })
await call('ww_lift', { asset_path: 'MouseMessageBlip' })
await call('ww_lift', { asset_path: '/Game/UI/НетТакого' })
await call('ww_lift', { pattern: 'SetWorkFilter', limit: 5 })
await call('ww_lift', {})
await call('ww_loom_validate', { mod_name: 'research_notifier' })
await call('ww_loom_validate', {})
await call('ww_loom_build', { action: 'status' })
await call('ww_loom_install', { action: 'status' })

const prompts = await client.listPrompts()
console.log(`
промптов зарегистрировано: ${prompts.prompts.length}`)
for (const p of prompts.prompts) console.log(`  - ${p.name}`)
const promptNames = new Set(prompts.prompts.map((p) => p.name))
const promptText = async (name: string, args: Record<string, string>) => {
  if (!promptNames.has(name)) return null
  const p = await client.getPrompt({ name, arguments: args })
  return (p.messages[0].content as { text: string }).text
}
const newMod = await promptText('ww:new-mod', { goal: 'уведомление о простое исследований', mod_name: 'research-notifier' })
if (newMod !== null) console.log(newMod.slice(0, 400))

const loomMod = await promptText('ww:new-loom-mod', { goal: 'уведомление о простое исследований', mod_name: 'ResearchNotifier' })
if (loomMod !== null) console.log(`\nww:new-loom-mod: ${loomMod.length} символов`)
const portPrompt = await promptText('ww:port-to-loom', { lua_mod: 'research-notifier' })
if (portPrompt !== null) console.log(`ww:port-to-loom: ${portPrompt.length} символов`)

const failures: string[] = []

const resourcesOf = async (c: Client) => {
  try {
    return (await c.listResources()).resources
  } catch {
    return []
  }
}

const resources = await resourcesOf(client)
console.log(`\nресурсов зарегистрировано: ${resources.length}`)
for (const r of resources) console.log(`  - ${r.uri}  ${r.mimeType ?? ''}`)
if (cfg.toolsets.includes('loom')) {
  if (resources.length === 0) failures.push('группа loom включена, а ресурсов-шаблонов нет')
  else {
    const read = await client.readResource({ uri: resources[0].uri })
    const text = (read.contents[0] as { text?: string }).text ?? ''
    console.log(`${resources[0].uri}: ${text.length} символов`)
    if (text.length === 0) failures.push(`${resources[0].uri} читается пустым`)
  }
} else if (resources.length > 0) failures.push('группа loom выключена, а ресурсы зарегистрированы')

if (loomMod !== null) {
  const uris = new Set(resources.map((r) => r.uri))
  const cited = [...new Set(loomMod.match(/ww:\/\/templates\/loom\/[A-Za-z0-9_]+/g) ?? [])]
  const lost = cited.filter((u) => !uris.has(u))
  if (lost.length > 0) failures.push(`промпт ww:new-loom-mod ссылается на незарегистрированные шаблоны: ${lost.join(', ')}`)
}

const promptsOf = async (c: Client) => {
  try {
    return (await c.listPrompts()).prompts
  } catch {
    return []
  }
}

const surface = async (toolsets: Toolset[]) => {
  const s = createServer({ ...cfg, toolsets })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await s.connect(st)
  const c = new Client({ name: 'smoke-client-surface', version: '0.0.1' })
  await c.connect(ct)
  const out = {
    tools: (await c.listTools()).tools.map((t) => t.name),
    prompts: (await promptsOf(c)).length,
    resources: (await resourcesOf(c)).length,
  }
  await c.close()
  await s.close()
  return out
}

const templateCount = readdirSync(`${import.meta.dir}/../../data/templates/loom`).filter((f) => f.endsWith('.lm.tpl')).length

const checkSurface = async (label: string, toolsets: Toolset[]) => {
  const got = await surface(toolsets)
  const want = Object.entries(TOOL_GROUPS)
    .filter(([, g]) => toolsets.includes(g))
    .map(([n]) => n)
  const wantPrompts = Object.values(PROMPT_GROUPS).filter((g) => toolsets.includes(g)).length
  const wantResources = toolsets.includes('loom') ? templateCount : 0
  console.log(
    `${label}: инструментов ${got.tools.length}/${want.length}, промптов ${got.prompts}/${wantPrompts}, ресурсов ${got.resources}/${wantResources}`,
  )
  const missing = want.filter((n) => !got.tools.includes(n))
  const extra = got.tools.filter((n) => !want.includes(n))
  if (got.tools.length !== want.length || missing.length > 0 || extra.length > 0) {
    failures.push(
      `${label}: инструментов ${got.tools.length}, ожидалось ${want.length}` +
        (missing.length > 0 ? `; не зарегистрированы: ${missing.join(', ')}` : '') +
        (extra.length > 0 ? `; лишние: ${extra.join(', ')}` : ''),
    )
  }
  if (got.prompts !== wantPrompts) failures.push(`${label}: промптов ${got.prompts}, ожидалось ${wantPrompts}`)
  if (got.resources !== wantResources) failures.push(`${label}: ресурсов ${got.resources}, ожидалось ${wantResources}`)
}

console.log('')
await checkSurface('все группы', [...TOOLSETS])
await checkSurface('без lua', TOOLSETS.filter((t) => t !== 'lua'))
await checkSurface('без loom', TOOLSETS.filter((t) => t !== 'loom'))
await checkSurface('конфиг', cfg.toolsets)


rmSync(scaffoldRoot, { recursive: true, force: true })
openMemoryDb(cfg).run("DELETE FROM project_memories WHERE mod_name = 'smoke-probe'")
closeMemoryDb()

await client.close()
await server.close()
if (failures.length > 0) {
  console.error(`\nсмоук не прошёл:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
  process.exit(1)
}
process.exit(0)

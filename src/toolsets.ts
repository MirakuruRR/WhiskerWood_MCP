import { ServerConfig, Toolset } from './config'

export const TOOL_GROUPS: Record<string, Toolset> = {
  ww_find_symbol: 'recon',
  ww_search_members: 'recon',
  ww_get_type: 'recon',
  ww_get_function: 'recon',
  ww_find_callers: 'recon',
  ww_get_bytecode: 'recon',
  ww_verify_hook: 'recon',
  ww_index_status: 'recon',
  ww_index_release: 'recon',
  ww_get_datatable: 'recon',
  ww_resolve_loc: 'recon',
  ww_find_asset: 'recon',
  ww_extract_asset: 'recon',
  ww_lua_api: 'recon',
  ww_diff_versions: 'recon',

  ww_game_status: 'live',
  ww_game_process: 'live',
  ww_capture_dumps: 'live',
  ww_game_eval: 'live',
  ww_ui_tree: 'live',
  ww_trace_calls: 'live',
  ww_call: 'live',
  ww_game_console: 'live',
  ww_game_log: 'live',
  ww_crash_report: 'live',
  ww_screenshot: 'live',

  ww_scaffold_mod: 'lua',
  ww_generate_hook: 'lua',
  ww_validate_mod: 'lua',
  ww_deploy_mod: 'lua',
  ww_package_mod: 'lua',
  ww_install_mod: 'lua',

  ww_memory_wakeup: 'memory',
  ww_memory_search: 'memory',
  ww_memory_add: 'memory',
  ww_memory_invalidate: 'memory',

  ww_lift: 'loom',
  ww_event_surface: 'loom',
  ww_loom_validate: 'loom',
  ww_loom_build: 'loom',
  ww_loom_install: 'loom',
  ww_loom_status: 'loom',
}

export function toolsetEnabled(config: ServerConfig, group: Toolset): boolean {
  return config.toolsets.includes(group)
}

export function toolEnabled(config: ServerConfig, name: string): boolean {
  const group = TOOL_GROUPS[name]
  return !group || toolsetEnabled(config, group)
}

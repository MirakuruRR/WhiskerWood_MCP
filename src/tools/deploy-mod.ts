import { existsSync, readFileSync } from 'node:fs'
import { ServerConfig } from '../config'
import { GameContext } from '../utils/game-context'
import { renderAiText, Scalar } from '../utils/ai-text'
import { PathSandboxError } from '../utils/path-sandbox'
import { loadModProject, ModProject } from '../utils/mod-project'
import { analyzeLua } from '../utils/lua-analyzer'
import { loadSlot, readLoadOrder } from '../utils/ue4ss-mods'
import { getBridge } from '../utils/bridge-client'
import { bridgeFailureFields, echoFields } from './bridge-common'

export interface DeployModArgs {
  mod_root: string
}

function report(ctx: GameContext | null, fields: Record<string, Scalar>): string {
  return renderAiText({ reportType: 'mod_deploy', fields: { ...echoFields(ctx), ...fields } })
}

function usesDirectHooks(mod: ModProject): boolean {
  for (const file of mod.luaFiles) {
    try {
      const a = analyzeLua(readFileSync(file, 'utf8'))
      if (a.usesDirectRegisterHook && !a.usesWWRegisterHook) return true
    } catch {
      continue
    }
  }
  return false
}

export async function handleDeployMod(ctx: GameContext | null, config: ServerConfig, args: DeployModArgs): Promise<string> {
  let mod: ModProject
  try {
    mod = loadModProject(config, args.mod_root)
  } catch (e) {
    if (e instanceof PathSandboxError) {
      return report(ctx, {
        status: 'mod_root_rejected',
        mod_root: args.mod_root,
        sandbox_roots: config.sandboxRoots.join('; '),
      })
    }
    throw e
  }

  if (!existsSync(mod.entry)) {
    return report(ctx, {
      status: 'entry_missing',
      mod_root: mod.root,
      entry: mod.entry,
      hint: 'нет Scripts/main.lua — создай мод через ww_scaffold_mod',
    })
  }

  const bridge = getBridge(config)
  const st = await bridge.readStatusStable()
  if (!bridge.isAlive(st)) {
    return report(ctx, {
      status: 'game_not_running',
      mod: mod.name,
      hint: 'dev-загрузка идёт через мост в живую игру. Запусти игру',
    })
  }
  const res = await bridge.call('load_mod', mod.entry, Math.max(config.bridgeTimeoutMs, 10000))
  if (res.status === 'ok') {
    const slot = loadSlot(readLoadOrder(config), mod.name)
    return report(ctx, {
      status: 'ok',
      mod: mod.name,
      entry: mod.entry,
      result: res.body.trim().replace(/\s+/g, ' '),
      elapsed_ms: res.elapsedMs,
      ...(usesDirectHooks(mod)
        ? {
            warning:
              'мод вызывает RegisterHook напрямую: мост не сможет снять эти хуки при следующей загрузке, и коллбэки начнут срабатывать по нескольку раз. Перейди на WWRegisterHook',
          }
        : {}),
      ...(slot?.enabled
        ? {
            warning_double_load:
              'мод дополнительно включён в mods.txt: вместе с копией моста после старта игры будут работать два экземпляра, хуки задвоятся. Убери строку из mods.txt или не перезапускай игру с этим модом',
          }
        : {}),
      next: 'проверь работу через ww_game_log и ww_game_eval; повторный вызов перезагрузит мод',
    })
  }
  if (res.status === 'error') {
    return report(ctx, {
      status: 'load_failed',
      mod: mod.name,
      entry: mod.entry,
      error: res.body.trim().replace(/\s+/g, ' ').slice(0, 400),
      hint: 'ошибка исполнения чанка мода; прогони ww_validate_mod и смотри ww_game_log',
    })
  }
  return report(ctx, { mod: mod.name, ...bridgeFailureFields(res) })
}

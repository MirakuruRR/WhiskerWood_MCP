import { existsSync, readFileSync } from 'node:fs'
import { ServerConfig } from '../config'
import { GameContext } from '../utils/game-context'
import { renderAiText, Scalar } from '../utils/ai-text'
import { PathSandboxError } from '../utils/path-sandbox'
import { loadModProject, ModProject } from '../utils/mod-project'
import { analyzeLua } from '../utils/lua-analyzer'
import { enableInModsTxt, linkModDir } from '../utils/ue4ss-deploy'
import { getBridge } from '../utils/bridge-client'
import { bridgeFailureFields, echoFields } from './bridge-common'

export interface DeployModArgs {
  mod_root: string
  mode?: 'dev' | 'release'
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
  const mode = args.mode ?? 'dev'

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

  if (mode === 'dev') {
    const bridge = getBridge(config)
    const st = await bridge.readStatusStable()
    if (!bridge.isAlive(st)) {
      return report(ctx, {
        status: 'game_not_running',
        mode,
        mod: mod.name,
        hint: 'dev-загрузка идёт через мост в живую игру. Запусти игру либо разверни мод как release',
      })
    }
    const res = await bridge.call('load_mod', mod.entry, Math.max(config.bridgeTimeoutMs, 10000))
    if (res.status === 'ok') {
      return report(ctx, {
        status: 'ok',
        mode,
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
        next: 'проверь работу через ww_game_log и ww_game_eval; повторный вызов перезагрузит мод',
      })
    }
    if (res.status === 'error') {
      return report(ctx, {
        status: 'load_failed',
        mode,
        mod: mod.name,
        entry: mod.entry,
        error: res.body.trim().replace(/\s+/g, ' ').slice(0, 400),
        hint: 'ошибка исполнения чанка мода; прогони ww_validate_mod и смотри ww_game_log',
      })
    }
    return report(ctx, { mode, mod: mod.name, ...bridgeFailureFields(res) })
  }

  const targetDir = `${config.ue4ssDir}/Mods/${mod.name}`
  const linkMode = linkModDir(mod.root, targetDir)
  const modsTxtState = enableInModsTxt(`${config.ue4ssDir}/Mods/mods.txt`, mod.name)

  return report(ctx, {
    status: 'ok',
    mode,
    mod: mod.name,
    target: targetDir,
    link: linkMode,
    mods_txt: modsTxtState,
    hint:
      linkMode === 'junction'
        ? 'junction: правки в репозитории видны игре сразу, но UE4SS читает Lua при старте — перезапусти игру'
        : 'создать junction не удалось, сделана копия: после каждой правки вызывай ww_deploy_mod заново',
  })
}

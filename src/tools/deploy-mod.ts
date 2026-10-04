import { existsSync, readFileSync, statSync } from 'node:fs'
import { ServerConfig } from '../config'
import { GameContext } from '../utils/game-context'
import { renderAiText, Scalar } from '../utils/ai-text'
import { PathSandboxError } from '../utils/path-sandbox'
import { loadModProject, MOD_DLL, MOD_ENTRY, ModProject, NATIVE_DIR } from '../utils/mod-project'
import {
  checkUe4ssImports,
  describeDll,
  FileLockedError,
  gameModDir,
  inspectDll,
  isLink,
  listDllDir,
  modParts,
  nativeNewestMtime,
  partsLabel,
  placeFile,
  purgeStale,
  readableSymbol,
} from '../utils/mod-native'
import { findGameProcess } from '../utils/game-process'
import { enableInModsTxt } from '../utils/ue4ss-deploy'
import { analyzeLua } from '../utils/lua-analyzer'
import { loadSlot, modsTxtPath, readLoadOrder } from '../utils/ue4ss-mods'
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

interface DllStage {
  fields: Record<string, Scalar>
  pendingRestart: boolean
}

// DLL нельзя перезагрузить в живом процессе: её только кладут в каталог игры, а UE4SS
// подхватывает её при следующем старте
function stageDll(config: ServerConfig, mod: ModProject, gameDir: string, gameHasLua: boolean): DllStage | FileLockedError {
  const proc = findGameProcess(config)
  const fields: Record<string, Scalar> = {}
  const changed: string[] = []
  let swapped = false

  if (isLink(gameDir)) {
    fields.dll_target = 'каталог мода в игре — ссылка, DLL не копировалась'
  } else {
    purgeStale(`${gameDir}/dlls`)
    try {
      for (const rel of listDllDir(mod.root)) {
        const how = placeFile(readFileSync(`${mod.root}/${rel}`), `${gameDir}/${rel}`)
        if (how === 'unchanged') continue
        changed.push(rel)
        if (how === 'swapped') swapped = true
      }
    } catch (e) {
      if (e instanceof FileLockedError) return e
      throw e
    }
  }

  const info = inspectDll(`${mod.root}/${MOD_DLL}`)
  if (info) fields.dll = `${describeDll(info)}; в игре ${changed.length > 0 ? `обновлено: ${changed.join(', ')}` : 'уже эта версия'}`
  if (swapped) fields.dll_swapped = 'прежнюю DLL держит игра: она переименована в *.ww-old и удалится при следующем деплое'
  if (info && existsSync(`${mod.root}/${NATIVE_DIR}`) && nativeNewestMtime(mod.root) > info.mtimeMs) {
    fields.warning_dll_stale = `исходники ${NATIVE_DIR}/ новее ${MOD_DLL}: в игру ушла старая сборка — пересобери нативную часть`
  }

  const link = checkUe4ssImports(`${mod.root}/${MOD_DLL}`, config.ue4ssDir)
  if (link && link.missing.length > 0) {
    fields.warning_dll_unloadable = `${link.missing.length} из ${link.imported} импортов из UE4SS.dll установленная UE4SS не экспортирует (${link.missing.slice(0, 3).map(readableSymbol).join('; ')}): C++-часть не загрузится — пересобери под установленную UE4SS, подробности в ww_validate_mod`
  }

  let enabledNow = false
  if (!gameHasLua) {
    const state = enableInModsTxt(modsTxtPath(config), mod.name)
    fields.mods_txt = state
    enabledNow = state === 'включён' || state === 'добавлен'
  }

  let installedAfterStart = false
  if (proc && proc.startedAt > 0) {
    try {
      installedAfterStart = statSync(`${gameDir}/${MOD_DLL}`).mtimeMs > proc.startedAt
    } catch {}
  }
  return { fields, pendingRestart: proc !== null && (swapped || changed.length > 0 || installedAfterStart || enabledNow) }
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

  const entryRel = mod.meta?.entry ?? MOD_ENTRY
  const parts = modParts(mod.root, entryRel)
  if (!parts.lua && !parts.dll) {
    return report(ctx, {
      status: 'entry_missing',
      mod_root: mod.root,
      entry: mod.entry,
      hint: parts.native
        ? `нет ни Scripts/main.lua, ни ${MOD_DLL}: собери нативную часть из ${NATIVE_DIR}/`
        : 'нет Scripts/main.lua — создай мод через ww_scaffold_mod',
    })
  }

  const gameDir = gameModDir(config.ue4ssDir, mod.name)
  const gameHasLua = existsSync(`${gameDir}/${entryRel}`)
  let dll: DllStage | null = null
  if (parts.dll) {
    const staged = stageDll(config, mod, gameDir, gameHasLua)
    if (staged instanceof FileLockedError) {
      return report(ctx, {
        status: 'dll_locked',
        mod: mod.name,
        file: staged.path,
        hint: 'DLL держит игра и не даёт даже переименовать: ww_game_process action=stop, затем ww_deploy_mod и запуск игры',
      })
    }
    dll = staged
  }
  const dllFields = { parts: partsLabel(parts), ...(dll?.fields ?? {}) }

  const bridge = getBridge(config)
  const st = await bridge.readStatusStable()
  if (!bridge.isAlive(st)) {
    return report(ctx, {
      status: 'game_not_running',
      mod: mod.name,
      ...dllFields,
      hint: parts.dll
        ? `DLL уже в ${gameDir} и загрузится при старте игры${parts.lua ? '; Lua-часть загрузит повторный ww_deploy_mod после запуска' : ''}`
        : 'dev-загрузка идёт через мост в живую игру. Запусти игру',
      next: 'ww_game_process action=start wait_for=world',
    })
  }

  if (dll?.pendingRestart) {
    return report(ctx, {
      status: 'restart_required',
      mod: mod.name,
      ...dllFields,
      hint: `в запущенной игре старая DLL или её нет вовсе: нативная часть подхватывается только при старте${parts.lua ? ', поэтому Lua-часть не загружалась — она могла бы звать функции, которых в старой DLL нет' : ''}`,
      next: `ww_game_process action=restart wait_for=world${parts.lua ? ', затем снова ww_deploy_mod' : ''}`,
    })
  }

  if (!parts.lua) {
    return report(ctx, {
      status: 'ok',
      mod: mod.name,
      ...dllFields,
      result: 'в игре загружена текущая DLL; Lua-части нет, горячей загрузки нечего делать',
      next: 'правки в DLL подхватываются только перезапуском: пересобери, ww_deploy_mod, ww_game_process action=restart',
    })
  }

  const res = await bridge.call('load_mod', mod.entry, Math.max(config.bridgeTimeoutMs, 10000))
  if (res.status === 'ok') {
    const slot = loadSlot(readLoadOrder(config), mod.name)
    return report(ctx, {
      status: 'ok',
      mod: mod.name,
      entry: mod.entry,
      ...dllFields,
      result: res.body.trim().replace(/\s+/g, ' '),
      elapsed_ms: res.elapsedMs,
      ...(usesDirectHooks(mod)
        ? {
            warning:
              'мод вызывает RegisterHook напрямую: мост не сможет снять эти хуки при следующей загрузке, и коллбэки начнут срабатывать по нескольку раз. Перейди на WWRegisterHook',
          }
        : {}),
      ...(slot?.enabled && gameHasLua
        ? {
            warning_double_load: `в ${gameDir} лежит Lua-часть мода, и он включён в mods.txt: вместе с копией моста работают два экземпляра, хуки задвоятся. Для dev-цикла поставь в игру только DLL (ww_install_mod dll_only: true) или выключи строку в mods.txt`,
          }
        : {}),
      next: parts.dll
        ? 'проверь работу через ww_game_log и ww_game_eval; повторный вызов перезагрузит Lua, а новая DLL потребует перезапуска игры'
        : 'проверь работу через ww_game_log и ww_game_eval; повторный вызов перезагрузит мод',
    })
  }
  if (res.status === 'error') {
    return report(ctx, {
      status: 'load_failed',
      mod: mod.name,
      entry: mod.entry,
      ...dllFields,
      error: res.body.trim().replace(/\s+/g, ' ').slice(0, 400),
      hint: 'ошибка исполнения чанка мода; прогони ww_validate_mod и смотри ww_game_log',
    })
  }
  return report(ctx, { mod: mod.name, ...bridgeFailureFields(res) })
}

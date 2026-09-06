import { ServerConfig } from '../config'
import { GameContext } from '../utils/game-context'
import { getBridge } from '../utils/bridge-client'
import { lastError } from '../utils/ue4ss-log'
import { renderAiText, AiTextResult, Scalar } from '../utils/ai-text'
import { echoFields, statusFields } from './bridge-common'
import {
  enterPlayChunk,
  findGameProcess,
  findSave,
  isSteamRunning,
  killGame,
  lastCrashDump,
  launchViaSteam,
  listSaves,
  ProcessState,
  ProcInfo,
  readState,
  resolveAppId,
  rotateLog,
  waitFor,
  waitProcessGone,
  WaitTarget,
  writeState,
} from '../utils/game-process'

export interface GameProcessArgs {
  action?: 'status' | 'start' | 'stop' | 'restart' | 'load_save' | 'list_saves'
  save?: string
  args?: string[]
  wait_for?: WaitTarget
  timeout_ms?: number
}

const DEFAULT_TIMEOUT_MS = 180_000
const MAX_TIMEOUT_MS = 600_000
const ENTER_PLAY_TIMEOUT_MS = 10_000
const RELAUNCH_PAUSE_MS = 2000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function procFields(proc: ProcInfo): Record<string, Scalar> {
  return {
    pid: proc.pid,
    process_uptime_s: proc.startedAt > 0 ? Math.round((Date.now() - proc.startedAt) / 1000) : 0,
    mem_mb: proc.memMb,
    responding: proc.responding,
  }
}

function exitFields(config: ServerConfig, state: ProcessState): Record<string, Scalar> {
  const f: Record<string, Scalar> = {}
  if (!state.launchedAt) return f
  f.last_launch_at = new Date(state.launchedAt).toISOString()
  const stopped = (state.stopRequestedAt ?? 0) >= state.launchedAt
  f.exit_kind = stopped ? 'stopped_by_mcp' : 'unexpected'
  const dump = lastCrashDump(config, state.launchedAt)
  if (dump) {
    f.crash_dump = dump.path
    f.crash_dump_at = dump.at
  }
  if (!stopped) {
    const err = lastError(`${config.ue4ssDir}/UE4SS.log`)
    if (err) {
      f.last_log_error_at = err.ts
      f.last_log_error = err.text.split('\n')[0].slice(0, 200)
    }
    f.hint = dump
      ? 'игра завершилась не по нашей команде и оставила крашдамп; разбор — ww_crash_report: дамп, хвост лога до краша и включённые моды в одном отчёте'
      : 'игра завершилась не по нашей команде: краш либо закрыта вручную'
  }
  return f
}

async function bridgeFields(config: ServerConfig): Promise<Record<string, Scalar>> {
  const bridge = getBridge(config)
  const st = await bridge.readStatusStable()
  if (!bridge.isAlive(st)) return { bridge: 'not_responding' }
  return { bridge: 'alive', ...statusFields(st!) }
}

async function loadSaveFields(config: ServerConfig, save: string): Promise<Record<string, Scalar>> {
  const bridge = getBridge(config)
  const res = await bridge.call('eval', enterPlayChunk(save), ENTER_PLAY_TIMEOUT_MS)
  if (res.status === 'ok') {
    const body = res.body.replace(/^exec=\w+\n/, '').trim()
    if (body.includes('no_game_instance')) {
      return { load_save: 'failed', load_error: 'ArcoGameInstance не найден в живой игре' }
    }
    return { load_save: 'sent' }
  }
  if (res.status === 'error') return { load_save: 'failed', load_error: res.body.split('\n')[0].slice(0, 200) }
  if (res.status === 'timeout') {
    // EnterPlay стартует загрузку карты и подвешивает тик моста: ответа не будет, судим по world
    return { load_save: 'sent_no_ack' }
  }
  return { load_save: 'failed', load_error: res.status }
}

async function doStop(config: ServerConfig, fields: Record<string, Scalar>): Promise<boolean> {
  const proc = findGameProcess(config)
  writeState(config, { stopRequestedAt: Date.now() })
  if (!proc) {
    fields.stop = 'not_running'
    Object.assign(fields, exitFields(config, readState(config)))
    return true
  }
  Object.assign(fields, procFields(proc))
  killGame(config)
  const gone = await waitProcessGone(config)
  fields.stop = gone ? 'stopped' : 'kill_failed'
  if (!gone) fields.hint = 'процесс не исчез после taskkill /F; возможно, окно краш-репортера или права'
  return gone
}

async function doStart(
  config: ServerConfig,
  args: GameProcessArgs,
  fields: Record<string, Scalar>,
): Promise<void> {
  const save = args.save?.trim()
  if (save) {
    const entry = findSave(config, save)
    if (!entry) {
      fields.status = 'save_not_found'
      fields.saves_dir = config.saveDir
      fields.hint = 'имя сейва не найдено; список — action=list_saves'
      return
    }
    fields.save = entry.name
    fields.save_saved_at = entry.savedAt
  }

  const running = findGameProcess(config)
  if (running) {
    fields.status = 'already_running'
    Object.assign(fields, procFields(running), await bridgeFields(config))
    fields.hint = 'игра уже запущена: для чистого перезапуска используй action=restart, для сейва — action=load_save'
    return
  }

  const archive = rotateLog(config)
  fields.log_rotated = archive.length > 0
  if (archive) fields.log_archive = archive
  fields.steam_running = isSteamRunning()
  fields.steam_app_id = resolveAppId(config) || 'unknown'

  const launchArgs = args.args ?? []
  const launch = launchViaSteam(config, launchArgs)
  if (!launch.ok) {
    fields.status = 'launch_failed'
    fields.error = launch.error ?? 'не удалось открыть steam-ссылку'
    return
  }
  fields.launch_url = launch.url
  if (launchArgs.length > 0) fields.launch_args = launchArgs.join(' ')
  writeState(config, { launchedAt: Date.now(), stopRequestedAt: undefined, save: save ?? undefined, logArchive: archive })
  if (!fields.steam_running) fields.hint = 'Steam не был запущен: старт займёт дольше, возможен экран логина'

  const timeout = Math.min(args.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const deadline = Date.now() + timeout
  const target: WaitTarget = args.wait_for ?? (save ? 'world' : 'bridge')
  const bridge = getBridge(config)

  if (target === 'none' && !save) {
    fields.status = 'launched'
    fields.hint = 'ожидание отключено: готовность проверяй через ww_game_process action=status'
    return
  }

  const first = await waitFor(config, bridge, save ? 'menu' : target, timeout)
  fields.waited_ms = first.waitedMs
  if (!first.reached) {
    fields.status = first.status === 'process_gone' ? 'process_gone' : 'wait_timeout'
    Object.assign(fields, await bridgeFields(config))
    fields.hint =
      first.status === 'process_gone'
        ? 'процесс игры исчез во время ожидания: краш на старте, смотри ww_game_log'
        : 'игра не дошла до ожидаемого состояния за отведённое время; увеличь timeout_ms либо проверь, включён ли WWBridge в mods.txt'
    return
  }

  if (!save) {
    fields.status = 'running'
    const proc = findGameProcess(config)
    if (proc) Object.assign(fields, procFields(proc))
    Object.assign(fields, await bridgeFields(config))
    return
  }

  Object.assign(fields, await loadSaveFields(config, fields.save as string))
  if (fields.load_save === 'failed') {
    fields.status = 'started_load_failed'
    return
  }

  if (target === 'none' || target === 'process' || target === 'bridge' || target === 'menu') {
    fields.status = 'save_load_sent'
    return
  }

  const rest = Math.max(15_000, deadline - Date.now())
  const second = await waitFor(config, bridge, 'world', rest)
  fields.load_waited_ms = second.waitedMs
  fields.status = second.reached ? 'save_loaded' : second.status === 'process_gone' ? 'process_gone' : 'load_timeout'
  Object.assign(fields, await bridgeFields(config))
  if (!second.reached && second.status !== 'process_gone') {
    fields.hint = 'уровень не поднялся за отведённое время: большая карта грузится дольше, повтори action=status'
  }
}

export async function handleGameProcess(
  ctx: GameContext | null,
  config: ServerConfig,
  args: GameProcessArgs,
): Promise<string> {
  const action = args.action ?? 'status'
  const fields: Record<string, Scalar> = { ...echoFields(ctx), action }
  let results: AiTextResult[] | undefined

  if (action === 'list_saves') {
    const saves = listSaves(config)
    fields.status = saves.length > 0 ? 'ok' : 'no_saves'
    fields.saves_dir = config.saveDir
    results = saves.map((s) => ({
      fields: { name: s.name, saved_at: s.savedAt, size_mb: s.sizeMb, autosave: s.autosave },
    }))
    if (saves.length === 0) fields.hint = `в ${config.saveDir} нет файлов .whisker`
    return renderAiText({ reportType: 'game_process', fields, results })
  }

  if (action === 'status') {
    const proc = findGameProcess(config)
    const state = readState(config)
    if (proc) {
      fields.status = 'running'
      Object.assign(fields, procFields(proc), await bridgeFields(config))
      if (fields.bridge === 'not_responding') {
        fields.hint = 'процесс жив, но мост молчит: UE4SS ещё грузится, либо WWBridge не включён в mods.txt'
      }
      if (state.save) fields.launched_save = state.save
    } else {
      fields.status = 'not_running'
      Object.assign(fields, exitFields(config, state))
    }
    const latest = listSaves(config)[0]
    if (latest) {
      fields.latest_save = latest.name
      fields.latest_save_at = latest.savedAt
    }
    return renderAiText({ reportType: 'game_process', fields })
  }

  if (action === 'stop') {
    await doStop(config, fields)
    fields.status = fields.stop === 'stopped' ? 'stopped' : (fields.stop as string)
    return renderAiText({ reportType: 'game_process', fields })
  }

  if (action === 'restart') {
    const gone = await doStop(config, fields)
    if (!gone) {
      fields.status = 'kill_failed'
      return renderAiText({ reportType: 'game_process', fields })
    }
    await sleep(RELAUNCH_PAUSE_MS)
    await doStart(config, args, fields)
    return renderAiText({ reportType: 'game_process', fields })
  }

  if (action === 'load_save') {
    const save = args.save?.trim()
    if (!save) {
      fields.status = 'bad_args'
      fields.hint = 'action=load_save требует save; список — action=list_saves'
      return renderAiText({ reportType: 'game_process', fields })
    }
    const entry = findSave(config, save)
    if (!entry) {
      fields.status = 'save_not_found'
      fields.saves_dir = config.saveDir
      fields.hint = 'имя сейва не найдено; список — action=list_saves'
      return renderAiText({ reportType: 'game_process', fields })
    }
    fields.save = entry.name
    fields.save_saved_at = entry.savedAt

    const bridge = getBridge(config)
    const st = await bridge.readStatusStable()
    if (!bridge.isAlive(st)) {
      fields.status = 'game_not_running'
      fields.hint = 'загрузка сейва идёт через мост в живой игре: сначала action=start (можно сразу с save)'
      return renderAiText({ reportType: 'game_process', fields })
    }

    Object.assign(fields, await loadSaveFields(config, entry.name))
    if (fields.load_save === 'failed') {
      fields.status = 'load_failed'
      return renderAiText({ reportType: 'game_process', fields })
    }

    const target: WaitTarget = args.wait_for ?? 'world'
    if (target !== 'world') {
      fields.status = 'save_load_sent'
      return renderAiText({ reportType: 'game_process', fields })
    }
    const timeout = Math.min(args.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const wait = await waitFor(config, bridge, 'world', timeout)
    fields.load_waited_ms = wait.waitedMs
    fields.status = wait.reached ? 'save_loaded' : wait.status === 'process_gone' ? 'process_gone' : 'load_timeout'
    Object.assign(fields, await bridgeFields(config))
    return renderAiText({ reportType: 'game_process', fields })
  }

  await doStart(config, args, fields)
  return renderAiText({ reportType: 'game_process', fields })
}

import { existsSync, readFileSync, statSync } from 'node:fs'
import { ServerConfig } from '../config'
import { GameContext } from '../utils/game-context'
import { getBridge } from '../utils/bridge-client'
import { findGameProcess, lastCrashDump } from '../utils/game-process'
import { renderAiText, Scalar } from '../utils/ai-text'
import { echoFields, isLevelLoaded, statusFields } from './bridge-common'
import { newestUsmap } from '../utils/ue4ss-mods'

export interface CaptureDumpsArgs {
  settle_ms?: number
  timeout_ms?: number
  allow_main_menu?: boolean
}

const DEFAULT_SETTLE_MS = 60_000
const MAX_SETTLE_MS = 180_000
const MAX_TIMEOUT_MS = 600_000
const SCHEDULE_TIMEOUT_MS = 10_000
const POLL_MS = 1000
const MARKER_RE = /ALL DONE captured_at=(\w+)/

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function luaString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// Один ExecuteWithDelay, а не блокирующий вызов: eval обязан вернуться быстро,
// сам дамп займёт секунды-десятки секунд. Выдержка settle_ms повторяет DUMP_DELAY_MS
// из AutoDump — миру нужно время догрузить объекты после входа в уровень.
function captureChunk(capturedAt: string, settleMs: number): string {
  const tag = luaString(capturedAt)
  return [
    `ExecuteWithDelay(${settleMs}, function()`,
    `  print("[ww_capture_dumps] start captured_at=" .. ${tag} .. "\\n")`,
    '  local okA, errA = pcall(DumpUSMAP)',
    '  print("[ww_capture_dumps] DumpUSMAP done ok=" .. tostring(okA) .. " err=" .. tostring(errA) .. "\\n")',
    '  local okB, errB = pcall(DumpAllObjects)',
    '  print("[ww_capture_dumps] DumpAllObjects done ok=" .. tostring(okB) .. " err=" .. tostring(errB) .. "\\n")',
    '  local okC, errC = pcall(GenerateUHTCompatibleHeaders)',
    '  print("[ww_capture_dumps] UHT headers done ok=" .. tostring(okC) .. (okC and "" or " err=" .. tostring(errC)) .. "\\n")',
    `  print("[ww_capture_dumps] ALL DONE captured_at=" .. ${tag} .. "\\n")`,
    'end)',
    'return "scheduled"',
  ].join('\n')
}

function objectDumpMtime(ue4ssDir: string): number {
  const path = `${ue4ssDir}/UE4SS_ObjectDump.txt`
  return existsSync(path) ? statSync(path).mtimeMs : 0
}

export async function handleCaptureDumps(
  ctx: GameContext | null,
  config: ServerConfig,
  args: CaptureDumpsArgs,
): Promise<string> {
  const bridge = getBridge(config)
  const st = await bridge.readStatusStable()
  const fields: Record<string, Scalar> = { ...echoFields(ctx) }

  if (!bridge.isAlive(st)) {
    fields.status = 'game_not_running'
    fields.hint =
      'мост не отвечает: сначала ww_game_process action=start (с save и wait_for=world, если нужен загруженный уровень)'
    return renderAiText({ reportType: 'capture_dumps', fields })
  }

  Object.assign(fields, statusFields(st!))
  const inLevel = isLevelLoaded(st!.world)
  const capturedAt = inLevel ? 'in_level' : st!.world ? 'main_menu' : 'unknown'
  fields.captured_at = capturedAt

  if (capturedAt !== 'in_level' && !args.allow_main_menu) {
    fields.status = 'no_world'
    fields.hint =
      'дамп не из мира: часть блюпринтовых классов не загружена и в дамп не попадёт. ' +
      'Загрузите сохранение (ww_game_process action=start save=... wait_for=world), либо явно allow_main_menu=true'
    return renderAiText({ reportType: 'capture_dumps', fields })
  }

  const settleMs = Math.min(Math.max(args.settle_ms ?? DEFAULT_SETTLE_MS, 0), MAX_SETTLE_MS)
  const timeoutMs = Math.min(Math.max(args.timeout_ms ?? settleMs + 120_000, settleMs + 5_000), MAX_TIMEOUT_MS)
  fields.settle_ms = settleMs

  const logPath = `${config.ue4ssDir}/UE4SS.log`
  let logOffset = 0
  try {
    logOffset = readFileSync(logPath, 'utf8').length
  } catch {
    /* лога ещё нет — прочитаем с начала */
  }
  const usmapBefore = newestUsmap(config.ue4ssDir)
  const objectDumpBefore = objectDumpMtime(config.ue4ssDir)

  const t0 = Date.now()
  const sendRes = await bridge.call('eval', captureChunk(capturedAt, settleMs), SCHEDULE_TIMEOUT_MS)
  if (sendRes.status !== 'ok') {
    fields.status = 'schedule_failed'
    fields.hint =
      sendRes.status === 'timeout'
        ? 'мост не подтвердил постановку задачи вовремя'
        : `мост вернул ${sendRes.status}`
    return renderAiText({ reportType: 'capture_dumps', fields })
  }

  const deadline = Date.now() + timeoutMs
  let markerAt: string | null = null
  while (Date.now() < deadline) {
    if (!findGameProcess(config)) {
      fields.status = 'process_gone'
      const dump = lastCrashDump(config, t0)
      if (dump) {
        fields.crash_dump = dump.path
        fields.crash_dump_at = dump.at
      }
      fields.hint = 'игра исчезла во время снятия дампов; разбор — ww_crash_report'
      return renderAiText({ reportType: 'capture_dumps', fields })
    }
    let tail = ''
    try {
      const full = readFileSync(logPath, 'utf8')
      if (full.length > logOffset) tail = full.slice(logOffset)
    } catch {
      /* лог ещё не появился */
    }
    const m = MARKER_RE.exec(tail)
    if (m) {
      markerAt = m[1]
      break
    }
    await sleep(POLL_MS)
  }

  if (!markerAt) {
    fields.status = 'timeout'
    fields.waited_ms = timeoutMs
    fields.hint = 'маркер ALL DONE не появился за отведённое время; увеличьте timeout_ms либо проверьте лог вручную (ww_game_log)'
    return renderAiText({ reportType: 'capture_dumps', fields })
  }

  fields.marker_captured_at = markerAt
  const usmapAfter = newestUsmap(config.ue4ssDir)
  const objectDumpAfter = objectDumpMtime(config.ue4ssDir)
  const usmapUpdated = !!usmapAfter && (!usmapBefore || usmapAfter.mtimeMs > usmapBefore.mtimeMs)
  const objectDumpUpdated = objectDumpAfter > objectDumpBefore

  fields.usmap_file = usmapAfter?.name ?? 'не найден'
  fields.usmap_updated = usmapUpdated
  fields.object_dump_updated = objectDumpUpdated

  if (!usmapUpdated || !objectDumpUpdated) {
    fields.status = 'marker_without_files'
    fields.hint = 'маркер найден, но файлы дампа не обновились — проверьте UE4SS.log на ok=false у отдельных этапов'
    return renderAiText({ reportType: 'capture_dumps', fields })
  }

  fields.status = 'ok'
  fields.hint = 'дальше: bun run dumps:pull'
  return renderAiText({ reportType: 'capture_dumps', fields })
}

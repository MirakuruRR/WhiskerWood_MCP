import { readFileSync, statSync } from 'node:fs'
import { ServerConfig } from '../config'
import { GameContext } from '../utils/game-context'
import { renderAiText, Scalar } from '../utils/ai-text'
import { bridgeFailureFields, echoFields } from './bridge-common'
import { getBridge } from '../utils/bridge-client'
import { findGameProcess } from '../utils/game-process'
import { captureWindowPng, screenshotPngs, screenshotsDir, waitForNewScreenshot } from '../utils/screenshot'

export interface ScreenshotArgs {
  mode?: 'auto' | 'engine' | 'window'
  res?: string
  timeout_ms?: number
  attach_image?: boolean
}

export interface ScreenshotOutcome {
  text: string
  pngBase64?: string
}

const MAX_ATTACH_BYTES = 5_000_000

export async function handleScreenshot(
  ctx: GameContext | null,
  config: ServerConfig,
  args: ScreenshotArgs,
): Promise<ScreenshotOutcome> {
  const mode = args.mode ?? 'auto'
  const res = args.res ?? '1280x720'
  const fields: Record<string, Scalar> = { ...echoFields(ctx), mode }
  if (!/^\d+x\d+$/.test(res) && !/^\d+(\.\d+)?$/.test(res)) {
    return {
      text: renderAiText({
        reportType: 'screenshot',
        fields: { ...fields, status: 'bad_request', res, hint: 'res: либо WxH вида 1280x720, либо множитель вроде 2' },
      }),
    }
  }
  const timeout = Math.min(Math.max(args.timeout_ms ?? 15000, 3000), 60000)
  const dir = screenshotsDir(config)

  const proc = findGameProcess(config)
  const bridge = getBridge(config)
  const bridgeAlive = bridge.isAlive(await bridge.readStatusStable())
  if (!proc && !bridgeAlive) {
    return {
      text: renderAiText({
        reportType: 'screenshot',
        fields: { ...fields, status: 'game_not_running', hint: 'ни процесса игры, ни живого моста: снимать нечего' },
      }),
    }
  }

  let path: string | null = null
  let usedMode: 'engine' | 'window' = 'window'
  let windowError = ''
  let consoleError = ''
  let bridgeFields: Record<string, Scalar> = {}

  if (mode !== 'engine' && proc) {
    const cap = captureWindowPng(config, proc.pid)
    if (cap.ok) {
      path = cap.path
    } else {
      windowError = cap.error ?? 'capture_failed'
    }
  }

  if (!path && mode !== 'window' && bridgeAlive) {
    const before = screenshotPngs(dir)
    const sent = await bridge.call('console', `HighResShot ${res}`, 10000)
    if (sent.status === 'ok') {
      fields.console = sent.body.replace(/\s+/g, ' ').slice(0, 120)
      path = await waitForNewScreenshot(dir, before, timeout)
      if (path) usedMode = 'engine'
    } else if (sent.status === 'error') {
      consoleError = sent.body.replace(/\s+/g, ' ').slice(0, 200)
    } else {
      bridgeFields = bridgeFailureFields(sent)
    }
  }

  if (!path) {
    return {
      text: renderAiText({
        reportType: 'screenshot',
        fields: {
          ...fields,
          status: 'screenshot_failed',
          dir,
          ...(consoleError !== '' ? { console_error: consoleError } : {}),
          ...(windowError !== '' ? { window_error: windowError } : {}),
          ...bridgeFields,
          hint:
            'window-путь требует видимое окно класса UnrealWindow, engine-путь — живой мост и файл кадра за timeout_ms; проверь режим окна и состояние игры',
        },
      }),
    }
  }

  const size = statSync(path).size
  fields.status = 'ok'
  fields.mode = usedMode
  fields.file = path
  fields.bytes = size
  if (usedMode === 'engine') fields.res = res
  let pngBase64: string | undefined
  if (args.attach_image !== false) {
    if (size <= MAX_ATTACH_BYTES) pngBase64 = readFileSync(path).toString('base64')
    else fields.image_note = `кадр тяжелее ${MAX_ATTACH_BYTES} байт и в ответ не вложен; читай файл по пути из field file`
  }
  return { text: renderAiText({ reportType: 'screenshot', fields }), pngBase64 }
}

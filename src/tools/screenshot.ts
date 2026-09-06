import { readFileSync, statSync } from 'node:fs'
import { ServerConfig } from '../config'
import { GameContext } from '../utils/game-context'
import { renderAiText, Scalar } from '../utils/ai-text'
import { bridgeFailureFields, echoFields } from './bridge-common'
import { getBridge } from '../utils/bridge-client'
import { findGameProcess } from '../utils/game-process'
import {
  captureWindowPng,
  CropRect,
  postProcessScreenshot,
  screenshotPngs,
  screenshotsDir,
  waitForNewScreenshot,
} from '../utils/screenshot'

export interface ScreenshotArgs {
  mode?: 'auto' | 'engine' | 'window'
  res?: string
  crop?: CropRect
  timeout_ms?: number
  attach_image?: boolean
}

export interface ScreenshotOutcome {
  text: string
  pngBase64?: string
  mime?: 'image/png' | 'image/jpeg'
}

const MAX_ATTACH_BYTES = 5_000_000
const DEFAULT_BOX = 1920

const BOX_RE = /^(\d+)x(\d+)$/
const MULT_RE = /^\d+(\.\d+)?$/

export async function handleScreenshot(
  ctx: GameContext | null,
  config: ServerConfig,
  args: ScreenshotArgs,
): Promise<ScreenshotOutcome> {
  const mode = args.mode ?? 'auto'
  const fields: Record<string, Scalar> = { ...echoFields(ctx), mode }

  const resBox = BOX_RE.exec(args.res ?? '')
  const resMult = !resBox && MULT_RE.test(args.res ?? '')
  if (args.res !== undefined && !resBox && !resMult) {
    return {
      text: renderAiText({
        reportType: 'screenshot',
        fields: { ...fields, status: 'bad_request', res: args.res, hint: 'res: либо бокс WxH вида 1280x720, либо множитель вроде 2 (множитель — только mode=engine)' },
      }),
    }
  }
  if (resMult && mode !== 'engine') {
    return {
      text: renderAiText({
        reportType: 'screenshot',
        fields: {
          ...fields,
          status: 'bad_request',
          res: args.res ?? '',
          hint: 'множитель в res работает только в mode=engine: window снимает окно в нативе, а res задаёт бокс вложенной копии',
        },
      }),
    }
  }

  const boxW = resBox ? Number(resBox[1]) : DEFAULT_BOX
  const boxH = resBox ? Number(resBox[2]) : DEFAULT_BOX
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

  let src: string | null = null
  let usedMode: 'engine' | 'window' = 'window'
  let windowError = ''
  let consoleError = ''
  let bridgeFields: Record<string, Scalar> = {}

  if (mode !== 'engine' && proc) {
    const cap = captureWindowPng(config, proc.pid)
    if (cap.ok) {
      src = cap.path
    } else {
      windowError = cap.error ?? 'capture_failed'
    }
  }

  if (!src && mode !== 'window' && bridgeAlive) {
    const res = args.res ?? '1280x720'
    const before = screenshotPngs(dir)
    const sent = await bridge.call('console', `HighResShot ${res}`, 10000)
    if (sent.status === 'ok') {
      fields.console = sent.body.replace(/\s+/g, ' ').slice(0, 120)
      src = await waitForNewScreenshot(dir, before, timeout)
      if (src) usedMode = 'engine'
    } else if (sent.status === 'error') {
      consoleError = sent.body.replace(/\s+/g, ' ').slice(0, 200)
    } else {
      bridgeFields = bridgeFailureFields(sent)
    }
  }

  if (!src) {
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

  const post = postProcessScreenshot(config, src, args.crop ?? null, boxW, boxH, MAX_ATTACH_BYTES)
  if (!post.ok) {
    const cropBad = (post.error ?? '').includes('crop_out_of_bounds')
    return {
      text: renderAiText({
        reportType: 'screenshot',
        fields: {
          ...fields,
          status: cropBad ? 'crop_rejected' : 'post_failed',
          file: src,
          ...(args.crop ? { crop: `${args.crop.x},${args.crop.y},${args.crop.w},${args.crop.h}` } : {}),
          ...(post.error ? { error: post.error } : {}),
          hint: cropBad
            ? 'кроп целиком вне кадра: сверь x,y с размером окна (window снимает в нативе окна)'
            : 'мастер-кадр снят, но пост-обработка не удалась; файл доступен в field file',
        },
      }),
    }
  }

  const masterBytes = statSync(post.master).size
  const attachBytes = statSync(post.attach).size
  fields.status = 'ok'
  fields.mode = usedMode
  fields.file = post.master
  fields.bytes = masterBytes
  fields.attach_file = post.attach
  fields.attach_mime = post.attachMime
  fields.attach_bytes = attachBytes
  fields.res_role = usedMode === 'engine' ? 'render' : 'attach_box'
  if (args.res !== undefined) fields.res = args.res
  if (args.crop) fields.crop = `${args.crop.x},${args.crop.y},${args.crop.w},${args.crop.h}`

  let pngBase64: string | undefined
  let mime: ScreenshotOutcome['mime']
  if (args.attach_image !== false) {
    if (attachBytes <= MAX_ATTACH_BYTES) {
      pngBase64 = readFileSync(post.attach).toString('base64')
      mime = post.attachMime
    } else {
      fields.image_note = `вложенная копия тяжелее ${MAX_ATTACH_BYTES} байт и в ответ не попала; читай файл по пути из field attach_file`
    }
  }
  return { text: renderAiText({ reportType: 'screenshot', fields }), pngBase64, mime }
}

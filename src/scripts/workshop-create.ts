import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { deflateSync } from 'node:zlib'
import { requireConfig } from '../utils/cli-config'
import { kitStatus } from '../utils/kit'
import { WHISKERWOOD_APP_ID } from '../utils/steam-locate'
import { PAK_LIMIT_BYTES } from '../tools/loom-install'

const MOD_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const PREVIEW_LIMIT_BYTES = 1024 * 1024
const PREVIEW_EXTS = ['png', 'jpg', 'jpeg', 'gif']
const VDF_KEYS = ['appid', 'publishedfileid', 'contentfolder', 'previewfile', 'visibility', 'title', 'description', 'changenote'] as const

type Vdf = Partial<Record<(typeof VDF_KEYS)[number], string>>

function fail(message: string, hint?: string): never {
  console.error(`ОШИБКА: ${message}`)
  if (hint) console.error(`  → ${hint}`)
  process.exit(1)
}

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

function win(p: string): string {
  return p.replace(/\//g, '\\')
}

function readText(path: string): string {
  return readFileSync(path, 'utf8').replace(/^﻿/, '')
}

function parseVdf(text: string): Vdf {
  const out: Vdf = {}
  for (const m of text.matchAll(/"([A-Za-z]+)"\s+"((?:[^"\\]|\\.)*)"/g)) {
    const key = m[1].toLowerCase() as keyof Vdf
    if ((VDF_KEYS as readonly string[]).includes(key)) out[key] = m[2].replace(/\\(.)/g, '$1')
  }
  return out
}

function renderVdf(vdf: Vdf): string {
  const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const lines = VDF_KEYS.filter((k) => vdf[k] !== undefined).map((k) => `\t"${k}"\t\t"${esc(vdf[k] as string)}"`)
  return `"workshopitem"\r\n{\r\n${lines.join('\r\n').replace(/\r?\n/g, '\r\n')}\r\n}\r\n`
}

function crlf(lines: string[]): string {
  return lines.join('\r\n') + '\r\n'
}

// cmd читает .bat в OEM-кодировке: кириллица в пути (профиль пользователя) ломает его, поэтому прячем её за переменной
function batPath(p: string): string {
  const local = process.env.LOCALAPPDATA ? norm(process.env.LOCALAPPDATA) : null
  if (local && p.toLowerCase().startsWith(`${local.toLowerCase()}/`)) return `%LOCALAPPDATA%${win(p.slice(local.length))}`
  return win(p)
}

function syncBat(mod: string, modsDir: string): string {
  return crlf([
    '@echo off',
    'rem Copies the Cook & Install output into content for the Workshop upload',
    `set "SRC=${batPath(`${modsDir}/${mod}`)}"`,
    'set "DST=%~dp0content"',
    '',
    `if not exist "%SRC%\\${mod}.pak" (`,
    `    echo Not found: %SRC%\\${mod}.pak - run Cook ^& Install first.`,
    '    pause',
    '    exit /b 1',
    ')',
    'if exist "%DST%" rmdir /s /q "%DST%"',
    'mkdir "%DST%"',
    `copy /y "%SRC%\\${mod}.pak" "%DST%\\" >nul`,
    `copy /y "%SRC%\\${mod}.uplugin" "%DST%\\" >nul`,
    'echo Copied to %DST%:',
    'dir /b "%DST%"',
    'pause',
  ])
}

function uploadBat(mod: string, steamcmd: string, preview: string): string {
  return crlf([
    '@echo off',
    'rem Uploads content to the Workshop; the first upload writes the item id into publishedfileid',
    `set "STEAMCMD=${win(steamcmd)}"`,
    '',
    `if not exist "%~dp0${preview}" (`,
    `    echo Put a preview image to %~dp0${preview} first.`,
    '    pause',
    '    exit /b 1',
    ')',
    `if not exist "%~dp0content\\${mod}.pak" (`,
    '    echo Run sync.bat first.',
    '    pause',
    '    exit /b 1',
    ')',
    'set /p STEAM_USER=Steam login:',
    `"%STEAMCMD%" +login %STEAM_USER% +workshop_build_item "%~dp0${mod}.vdf" +quit`,
    'pause',
  ])
}

function steamcmdFromBat(path: string): string | null {
  if (!existsSync(path)) return null
  const m = /set "STEAMCMD=([^"]+)"/i.exec(readText(path))
  return m ? m[1] : null
}

function findPreview(dir: string): string | null {
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
  for (const ext of PREVIEW_EXTS) {
    const hit = files.find((f) => f.toLowerCase() === `preview.${ext}`)
    if (hit) return `${dir}/${hit}`
  }
  return null
}

function crc32(buf: Uint8Array): number {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}

// заглушка превью: однотонный квадрат, человек заменит своей картинкой
function placeholderPng(size = 512, rgb: [number, number, number] = [0x4a, 0x5d, 0x6e]): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.alloc(1 + size * 3)
  for (let x = 0; x < size; x++) row.set(rgb, 1 + x * 3)
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', new Uint8Array()),
  ])
}

function descriptionTemplate(summary: string): string {
  return [summary || 'TODO: one-line summary of the mod.', '', '[h2]Features[/h2]', '[list]', '[*]TODO', '[/list]'].join('\n')
}

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      preview: { type: 'string' },
      steamcmd: { type: 'string' },
      out: { type: 'string' },
      'rewrite-scripts': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  })

  const mod = positionals[0]
  if (!mod) fail('не задано имя мода', 'bun run workshop:create <Мод> [--preview <файл>] [--steamcmd <путь>]')
  if (!MOD_NAME_RE.test(mod)) fail(`недопустимое имя мода: ${mod}`)

  const cfg = requireConfig()
  const modsDir = `${norm(cfg.savedDir)}/mods`
  const srcDir = `${modsDir}/${mod}`
  const srcPak = `${srcDir}/${mod}.pak`
  const srcPlugin = `${srcDir}/${mod}.uplugin`
  if (!existsSync(srcPak) || !existsSync(srcPlugin)) {
    fail(`в ${srcDir} нет ${mod}.pak и ${mod}.uplugin`, `сначала ww_loom_install mod_name=${mod} (start → install)`)
  }

  let plugin: Record<string, unknown>
  try {
    plugin = JSON.parse(readText(srcPlugin)) as Record<string, unknown>
  } catch (e) {
    fail(`${srcPlugin} не JSON: ${(e as Error).message}`)
  }
  const pluginStr = (k: string) => (typeof plugin[k] === 'string' ? (plugin[k] as string).trim() : '')

  const kit = kitStatus(cfg).kit
  let root: string
  if (values.out) root = norm(values.out)
  else if (kit) root = `${kit.kitDir}/Workshop`
  else fail('кит не настроен (kitDir), а --out не задан', 'укажи kitDir в wwmcp.config.json или --out <папка Workshop>')
  const dir = `${root}/${mod}`
  const contentDir = `${dir}/content`
  const vdfPath = `${dir}/${mod}.vdf`

  const warnings: string[] = []
  const pakBytes = statSync(srcPak).size
  if (pakBytes === 0) fail(`${srcPak} пустой`)
  if (pakBytes >= PAK_LIMIT_BYTES) fail(`пак ${pakBytes} байт не пройдёт лимит загрузчика ${PAK_LIMIT_BYTES} байт`)
  if (!pluginStr('EngineVersion')) warnings.push(`в ${mod}.uplugin нет EngineVersion — загрузчик игры может отвергнуть мод`)
  if (/[^\x00-\x7F]/.test(dir)) warnings.push(`в пути ${win(dir)} есть не-ASCII символы — steamcmd и cmd могут его не прочитать`)

  const prev: Vdf = existsSync(vdfPath) ? parseVdf(readText(vdfPath)) : {}

  let preview = findPreview(dir)
  let previewFrom: string | null = null
  if (values.preview) {
    const src = norm(values.preview)
    if (!existsSync(src)) fail(`нет картинки ${src}`)
    const ext = src.split('.').pop()?.toLowerCase() ?? ''
    if (!PREVIEW_EXTS.includes(ext)) fail(`превью должно быть ${PREVIEW_EXTS.join('/')}: ${src}`)
    previewFrom = src
    preview = `${dir}/preview.${ext === 'jpeg' ? 'jpg' : ext}`
  } else if (!preview && kit) {
    const fromMod = findPreview(`${kit.contentMods}/${mod}`)
    if (fromMod) {
      previewFrom = fromMod
      preview = `${dir}/${fromMod.split('/').pop()}`
    }
  }
  const writePlaceholder = !preview
  if (!preview) preview = `${dir}/preview.png`
  const previewName = preview.split('/').pop() as string
  const previewSrc = previewFrom ?? (writePlaceholder ? null : preview)
  if (previewSrc && statSync(previewSrc).size > PREVIEW_LIMIT_BYTES) warnings.push(`превью больше 1 МБ — Steam его не примет`)

  const steamcmd =
    values.steamcmd ??
    steamcmdFromBat(`${dir}/upload.bat`) ??
    (existsSync(root) ? readdirSync(root).map((d) => steamcmdFromBat(`${root}/${d}/upload.bat`)).find((s) => s) : null) ??
    'steamcmd.exe'
  const writeUpload = values['rewrite-scripts'] || !existsSync(`${dir}/upload.bat`)
  const writeSync = values['rewrite-scripts'] || !existsSync(`${dir}/sync.bat`)
  if (writeUpload && steamcmd === 'steamcmd.exe') warnings.push('путь к steamcmd не найден — в upload.bat стоит steamcmd.exe из PATH, передай --steamcmd <путь>')

  const version = pluginStr('Version')
  const vdf: Vdf = {
    appid: WHISKERWOOD_APP_ID,
    publishedfileid: prev.publishedfileid ?? '0',
    contentfolder: win(contentDir),
    previewfile: win(`${dir}/${previewName}`),
    visibility: prev.visibility ?? '0',
    title: prev.title ?? (pluginStr('Name') || mod),
    description: prev.description ?? descriptionTemplate(pluginStr('Description')),
    changenote: prev.changenote ?? (version ? `Version ${version}: initial release` : 'Initial release'),
  }

  if (values['dry-run']) {
    console.log(renderVdf(vdf).replace(/\r\n/g, '\n'))
    for (const w of warnings) console.warn(`внимание: ${w}`)
    return
  }

  mkdirSync(dir, { recursive: true })
  rmSync(contentDir, { recursive: true, force: true })
  mkdirSync(contentDir)
  copyFileSync(srcPak, `${contentDir}/${mod}.pak`)
  copyFileSync(srcPlugin, `${contentDir}/${mod}.uplugin`)
  if (previewFrom) copyFileSync(previewFrom, preview)
  else if (writePlaceholder) writeFileSync(preview, placeholderPng())
  writeFileSync(vdfPath, renderVdf(vdf), 'utf8')
  if (writeSync) writeFileSync(`${dir}/sync.bat`, syncBat(mod, modsDir), 'utf8')
  if (writeUpload) writeFileSync(`${dir}/upload.bat`, uploadBat(mod, steamcmd, previewName), 'utf8')

  for (const w of warnings) console.warn(`внимание: ${w}`)
  console.log(`Готово: ${win(dir)}`)
}

main()

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { ServerConfig } from '../config'
import { renderAiText, Scalar } from '../utils/ai-text'
import { PathSandboxError } from '../utils/path-sandbox'
import { loadModProject, ModProject, MOD_MANIFEST } from '../utils/mod-project'
import { analyzeLua } from '../utils/lua-analyzer'
import { createZip, ZipEntry } from '../utils/zip'

export interface PackageModArgs {
  mod_root: string
  mod_version?: string
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.vscode', '.idea'])
const SKIP_FILE = /(\.(log|bak|orig|tmp|zip|7z|rar)$|^\.|~$|^Thumbs\.db$)/i
const README_NAMES = ['УСТАНОВКА.txt', 'README.txt', 'readme.txt']
const VERSION_RE = /^\d+(\.\d+){0,3}$/
const DEFAULT_VERSION = '1.0.0'

function report(fields: Record<string, Scalar>): string {
  return renderAiText({ reportType: 'mod_package', fields })
}

function collectFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > 8) return
    for (const name of readdirSync(dir).sort()) {
      const full = `${dir}/${name}`
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue
        walk(full, `${prefix}${name}/`, depth + 1)
      } else if (!SKIP_FILE.test(name)) {
        out.push(`${prefix}${name}`)
      }
    }
  }
  walk(root, '', 0)
  return out
}

interface Vendored {
  entries: ZipEntry[]
  modules: string[]
  missing: string[]
}

// у установленного мода package.path видит только Mods/<Имя>/Scripts/?.lua,
// поэтому lib/ репозитория переезжает внутрь мода
function vendorLibs(config: ServerConfig, sources: string[]): Vendored {
  const libRoot = `${config.modsRepo}/lib`
  const namespaces = new Set<string>()
  if (existsSync(libRoot)) {
    for (const e of readdirSync(libRoot, { withFileTypes: true })) {
      if (e.isDirectory()) namespaces.add(e.name)
    }
  }

  const queue: string[] = []
  for (const text of sources) queue.push(...analyzeLua(text).requires)

  const seen = new Set<string>()
  const entries: ZipEntry[] = []
  const modules: string[] = []
  const missing: string[] = []

  while (queue.length > 0) {
    const name = queue.shift() as string
    if (seen.has(name)) continue
    seen.add(name)
    const parts = name.split('.')
    if (!namespaces.has(parts[0])) continue
    const rel = `${parts.join('/')}.lua`
    const file = `${libRoot}/${rel}`
    if (!existsSync(file)) {
      missing.push(name)
      continue
    }
    const text = readFileSync(file, 'utf8')
    entries.push({ path: `Scripts/${rel}`, data: Buffer.from(text, 'utf8') })
    modules.push(name)
    queue.push(...analyzeLua(text).requires)
  }

  return { entries, modules: modules.sort(), missing }
}

function installNote(mod: ModProject, version: string): string {
  const title = `${mod.name} ${version} — мод для Whiskerwood`
  const lines = [title, '='.repeat(title.length)]
  if (mod.meta?.description) lines.push(mod.meta.description)
  lines.push(
    '',
    'Требования',
    '----------',
    `- Whiskerwood ${mod.meta?.game_version ?? 'см. страницу мода'}`,
    '- UE4SS, уже установленный в игру',
    '',
    'Установка',
    '---------',
    '1. Открой папку модов UE4SS:',
    '   <Steam>\\steamapps\\common\\Whiskerwood\\Whiskerwood\\Binaries\\Win64\\ue4ss\\Mods\\',
    `2. Скопируй туда из архива папку "${mod.name}" целиком.`,
    '3. Открой в той же папке файл mods.txt блокнотом и добавь строку',
    '',
    `   ${mod.name} : 1`,
    '',
    '   ВЫШЕ комментария "; Built-in keybinds, do not move up!".',
    '4. Запусти игру.',
    '',
    'Проверка',
    '--------',
    `В ue4ss\\UE4SS.log должны появиться строки с префиксом [${mod.name}].`,
    '',
    'Удаление',
    '--------',
    `Удали папку Mods\\${mod.name} и строку ${mod.name} из mods.txt.`,
    '',
  )
  return lines.join('\r\n')
}

function pickArchiveName(distDir: string, base: string): { file: string; bumped: boolean } {
  if (!existsSync(`${distDir}/${base}.zip`)) return { file: `${base}.zip`, bumped: false }
  for (let n = 2; n < 1000; n++) {
    const file = `${base}-b${n}.zip`
    if (!existsSync(`${distDir}/${file}`)) return { file, bumped: true }
  }
  return { file: `${base}-${Date.now()}.zip`, bumped: true }
}

export function handlePackageMod(config: ServerConfig, args: PackageModArgs): string {
  let mod: ModProject
  try {
    mod = loadModProject(config, args.mod_root)
  } catch (e) {
    if (e instanceof PathSandboxError) {
      return report({
        status: 'mod_root_rejected',
        mod_root: args.mod_root,
        sandbox_roots: config.sandboxRoots.join('; '),
      })
    }
    throw e
  }

  if (!existsSync(mod.entry)) {
    return report({
      status: 'entry_missing',
      mod_root: mod.root,
      entry: mod.entry,
      hint: 'нет Scripts/main.lua — создай мод через ww_scaffold_mod',
    })
  }
  if (!mod.meta) {
    return report({
      status: 'manifest_missing',
      mod_root: mod.root,
      hint: `нет ${MOD_MANIFEST}: релизный пакет собирается только из мода, созданного ww_scaffold_mod`,
    })
  }

  const version = args.mod_version ?? mod.meta.version ?? DEFAULT_VERSION
  if (!VERSION_RE.test(version)) {
    return report({ status: 'bad_version', mod_version: version, hint: 'версия вида 1.0 или 1.2.3' })
  }

  const files = collectFiles(mod.root)
  const luaSources: string[] = []
  for (const rel of files) {
    if (!rel.endsWith('.lua')) continue
    const text = readFileSync(`${mod.root}/${rel}`, 'utf8')
    const a = analyzeLua(text)
    if (a.syntaxError) {
      return report({
        status: 'lua_syntax_error',
        file: rel,
        line: a.syntaxError.line,
        error: a.syntaxError.message,
        hint: 'прогони ww_validate_mod и почини синтаксис до сборки релиза',
      })
    }
    luaSources.push(text)
  }

  const vendored = vendorLibs(config, luaSources)
  if (vendored.missing.length > 0) {
    return report({
      status: 'lib_module_missing',
      modules: vendored.missing.join(', '),
      lib_root: `${config.modsRepo}/lib`,
      hint: 'мод требует модуль общей библиотеки, которого нет в lib/',
    })
  }

  const entries: ZipEntry[] = []
  let readme = ''
  for (const rel of files) {
    if (README_NAMES.includes(rel)) {
      readme = readFileSync(`${mod.root}/${rel}`, 'utf8')
      continue
    }
    if (rel === MOD_MANIFEST) continue
    entries.push({ path: `${mod.name}/${rel}`, data: readFileSync(`${mod.root}/${rel}`) })
  }

  const shipped = { ...mod.meta, version, packaged_at: new Date().toISOString() }
  entries.push({
    path: `${mod.name}/${MOD_MANIFEST}`,
    data: Buffer.from(`${JSON.stringify(shipped, null, 2)}\n`, 'utf8'),
  })
  for (const e of vendored.entries) entries.push({ path: `${mod.name}/${e.path}`, data: e.data })
  const note = readme || installNote(mod, version)
  // BOM: файл открывают блокнотом, без него кириллица читается как cp1251
  entries.push({
    path: 'УСТАНОВКА.txt',
    data: Buffer.from(note.startsWith('﻿') ? note : `﻿${note}`, 'utf8'),
  })

  const distDir = `${config.modsRepo}/dist`
  mkdirSync(distDir, { recursive: true })
  const picked = pickArchiveName(distDir, `${mod.name}-${version}`)
  const archive = `${distDir}/${picked.file}`
  const zip = createZip(entries)
  writeFileSync(archive, zip)

  let manifestState = 'без изменений'
  if (mod.meta.version !== version) {
    writeFileSync(`${mod.root}/${MOD_MANIFEST}`, `${JSON.stringify({ ...mod.meta, version }, null, 2)}\n`, 'utf8')
    manifestState = `version=${version} записан в ${MOD_MANIFEST}`
  }

  const bridgeOnlyHooks = luaSources.some((s) => /WWRegisterHook/.test(s) && !/(?<!WW)RegisterHook/.test(s))

  return report({
    status: 'ok',
    mod: mod.name,
    version,
    archive,
    size_kb: Math.round((zip.length / 1024) * 10) / 10,
    files: entries.length,
    root_folder: `${mod.name}/`,
    vendored_libs: vendored.modules.length > 0 ? vendored.modules.join(', ') : 'нет',
    readme: readme ? 'взят из мода' : 'сгенерирован',
    manifest: manifestState,
    ...(picked.bumped
      ? {
          name_collision: `${mod.name}-${version}.zip уже лежит в dist, архив назван ${picked.file}`,
          hint: 'подними mod_version, если это действительно новый релиз',
        }
      : {}),
    ...(bridgeOnlyHooks
      ? {
          warning:
            'хуки ставятся только через WWRegisterHook: у игрока WWBridge нет, хуки не встанут. Нужен local register = WWRegisterHook or RegisterHook',
        }
      : {}),
    next: 'распакуй архив и проверь установку по УСТАНОВКА.txt',
  })
}

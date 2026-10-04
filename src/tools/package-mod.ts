import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { ServerConfig } from '../config'
import { renderAiText, Scalar } from '../utils/ai-text'
import { PathSandboxError } from '../utils/path-sandbox'
import { loadModProject, ModProject, MOD_DLL, MOD_ENTRY, MOD_MANIFEST, NATIVE_DIR } from '../utils/mod-project'
import { BUILD_JUNK, describeDll, inspectDll, modParts, ModParts, nativeNewestMtime, partsLabel } from '../utils/mod-native'
import { analyzeLua } from '../utils/lua-analyzer'
import { gitIgnored } from '../utils/git-ignore'
import { createZip, ZipEntry } from '../utils/zip'

export interface PackageModArgs {
  mod_root: string
  mod_version?: string
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.vscode', '.idea'])
const SKIP_FILE = /(\.(log|bak|orig|tmp|zip|7z|rar)$|^\.|~$|^Thumbs\.db$)/i
const README_RU = ['УСТАНОВКА.txt']
const README_EN = ['INSTALL.txt', 'README.txt', 'readme.txt']
const UE4SS_RELEASE = 'https://github.com/UE4SS-RE/RE-UE4SS/releases/tag/experimental-latest'
const WIN64 = '<Steam>\\steamapps\\common\\Whiskerwood\\Whiskerwood\\Binaries\\Win64\\'
const SIGNATURE_SINCE = '0.7.208.0'
const SIGNATURE_AOB =
  '48 89 5C 24 10 48 89 6C 24 18 56 57 41 54 41 56 41 57 48 81 EC ? ? ? ? 48 8B 05 ? ? ? ? 48 33 C4 48 89 84 24 ? ? ? ? 48 8B 29 33 DB 4C 8B 79 08'
const AOB_IN_TEXT_RE = /(return\s+")(?:[0-9A-F]{2}|\?{1,2})(?: (?:[0-9A-F]{2}|\?{1,2}))+(")/g
const SIGNATURE = [
  '   function Register()',
  `       return "${SIGNATURE_AOB}"`,
  '   end',
  '',
  '   function OnMatchFound(MatchAddress)',
  '       return MatchAddress',
  '   end',
]
const VERSION_RE = /^\d+(\.\d+){0,3}$/
const DEFAULT_VERSION = '1.0.0'

function report(fields: Record<string, Scalar>): string {
  return renderAiText({ reportType: 'mod_package', fields })
}

// .gitignore репозитория модов отсекает то, что мод пишет сам во время игры
export function collectFiles(root: string, ignoredOut?: string[]): string[] {
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
        if (SKIP_DIRS.has(name) || (depth === 0 && name === NATIVE_DIR)) continue
        walk(full, `${prefix}${name}/`, depth + 1)
      } else if (!SKIP_FILE.test(name) && !BUILD_JUNK.test(name)) {
        out.push(`${prefix}${name}`)
      }
    }
  }
  walk(root, '', 0)
  const ignored = gitIgnored(root, out)
  if (ignoredOut) ignoredOut.push(...out.filter((rel) => ignored.has(rel)))
  return out.filter((rel) => !ignored.has(rel))
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

function installNoteRu(mod: ModProject, version: string, parts: ModParts): string {
  const title = `${mod.name} ${version} — мод для Whiskerwood`
  const lines = [title, '='.repeat(title.length)]
  if (mod.meta?.description) lines.push(mod.meta.description)
  lines.push(
    '',
    'Требования',
    '----------',
    `- Whiskerwood ${mod.meta?.game_version ?? 'см. страницу мода'}`,
    '- UE4SS, установленный в игру (как — ниже)',
    ...(parts.dll
      ? [
          '- в моде есть нативная часть dlls\\main.dll (C++-мод UE4SS), собранная под',
          '  UE4SS experimental-latest: после обновления UE4SS она может перестать',
          '  загружаться — тогда нужна новая версия мода',
        ]
      : []),
    '',
    'Шаг 1. UE4SS',
    '------------',
    'Если UE4SS уже стоит — пункты 1-2 пропусти, но пункт 3 проверь: начиная',
    `с Whiskerwood ${SIGNATURE_SINCE} (движок UE 5.8) старая сигнатура не подходит.`,
    '',
    '1. Скачай сборку "experimental-latest" (обычный zip, не -dev):',
    `   ${UE4SS_RELEASE}`,
    '   Стабильный 3.0.1 НЕ подойдёт — в нём нет поддержки UE 5.6 и новее.',
    '2. Распакуй так, чтобы файл dwmapi.dll и папка ue4ss\\ легли прямо в',
    `   ${WIN64}`,
    '3. Создай (или перезапиши) файл ue4ss\\UE4SS_Signatures\\StaticConstructObject.lua',
    '   с текстом:',
    '',
    ...SIGNATURE,
    '',
    '   Без этого файла или со старым текстом UE4SS не найдёт',
    '   StaticConstructObject_Internal: игра зависнет в главном меню, а в',
    `   ue4ss\\UE4SS.log пойдут строки "Was unable to find AOB for 'StaticConstructObject'".`,
    '4. Запусти игру и убедись, что она стартует.',
    '',
    'Шаг 2. Мод',
    '----------',
    '1. Открой папку модов UE4SS:',
    `   ${WIN64}ue4ss\\Mods\\`,
    `2. Скопируй туда из архива папку "${mod.name}" целиком.`,
    '3. Открой в той же папке файл mods.txt блокнотом и добавь строку',
    '',
    `   ${mod.name} : 1`,
    '',
    '   ВЫШЕ комментария "; Built-in keybinds, do not move up!".',
    '4. Запусти игру.',
    ...(parts.dll ? ['', 'Обновляя мод, сначала закрой игру: запущенная игра держит dlls\\main.dll,', 'и Windows не даст его перезаписать.'] : []),
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

function installNoteEn(mod: ModProject, version: string, parts: ModParts): string {
  const title = `${mod.name} ${version} — a mod for Whiskerwood`
  const lines = [title, '='.repeat(title.length)]
  if (mod.meta?.description) lines.push(mod.meta.description)
  lines.push(
    '',
    'Requirements',
    '------------',
    `- Whiskerwood ${mod.meta?.game_version ?? 'see the mod page'}`,
    '- UE4SS installed into the game (see below)',
    ...(parts.dll
      ? [
          '- the mod has a native part, dlls\\main.dll (a UE4SS C++ mod), built against',
          '  UE4SS experimental-latest: after a UE4SS update it may stop loading —',
          '  a new mod version will be needed then',
        ]
      : []),
    '',
    'Step 1. UE4SS',
    '-------------',
    'If UE4SS is already installed, skip items 1-2 but do check item 3: starting',
    `with Whiskerwood ${SIGNATURE_SINCE} (UE 5.8) the old signature no longer works.`,
    '',
    '1. Download the "experimental-latest" build (the plain zip, not the -dev one):',
    `   ${UE4SS_RELEASE}`,
    '   The stable 3.0.1 release will NOT work — it has no UE 5.6+ support.',
    '2. Unpack it so that dwmapi.dll and the ue4ss\\ folder end up directly in',
    `   ${WIN64}`,
    '3. Create (or overwrite) the file ue4ss\\UE4SS_Signatures\\StaticConstructObject.lua',
    '   with this text:',
    '',
    ...SIGNATURE,
    '',
    '   Without this file, or with the old text, UE4SS cannot find',
    '   StaticConstructObject_Internal: the game hangs in the main menu and',
    `   ue4ss\\UE4SS.log fills with "Was unable to find AOB for 'StaticConstructObject'".`,
    '4. Launch the game and make sure it starts.',
    '',
    'Step 2. The mod',
    '---------------',
    '1. Open the UE4SS mods folder:',
    `   ${WIN64}ue4ss\\Mods\\`,
    `2. Copy the whole "${mod.name}" folder from this archive into it.`,
    '3. Open mods.txt in the same folder and add the line',
    '',
    `   ${mod.name} : 1`,
    '',
    '   ABOVE the "; Built-in keybinds, do not move up!" comment.',
    '4. Start the game.',
    ...(parts.dll ? ['', 'Close the game before updating the mod: a running game holds dlls\\main.dll', 'and Windows will not let you overwrite it.'] : []),
    '',
    'Verify',
    '------',
    `ue4ss\\UE4SS.log should contain lines prefixed with [${mod.name}].`,
    '',
    'Uninstall',
    '---------',
    `Delete the Mods\\${mod.name} folder and the ${mod.name} line from mods.txt.`,
    '',
  )
  return lines.join('\r\n')
}

// Свой readme мода несёт копию сигнатуры, и после патча движка она молча устаревает
function refreshSignature(text: string): { text: string; refreshed: boolean } {
  const next = text.replace(AOB_IN_TEXT_RE, `$1${SIGNATURE_AOB}$2`)
  return { text: next, refreshed: next !== text }
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

  const parts = modParts(mod.root, mod.meta?.entry ?? MOD_ENTRY)
  if (!parts.lua && !parts.dll) {
    return report({
      status: 'entry_missing',
      mod_root: mod.root,
      entry: mod.entry,
      hint: parts.native
        ? `нет ни Scripts/main.lua, ни ${MOD_DLL}: собери нативную часть из ${NATIVE_DIR}/`
        : 'нет Scripts/main.lua — создай мод через ww_scaffold_mod',
    })
  }
  const dll = parts.dll ? inspectDll(`${mod.root}/${MOD_DLL}`) : null
  if (dll && dll.machine !== 'x64') {
    return report({ status: 'dll_not_x64', dll: `${mod.root}/${MOD_DLL}`, machine: dll.machine, hint: 'игра 64-битная: UE4SS загрузит только x64 DLL' })
  }
  const dllStale = dll !== null && parts.native && nativeNewestMtime(mod.root) > dll.mtimeMs
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

  const gitignored: string[] = []
  const files = collectFiles(mod.root, gitignored)
  const luaSources: string[] = []
  let bridgeOnlyHooks = false
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
    const coldStart = a.lints.find((l) => l.code === 'bp_hook_at_load_time')
    if (coldStart) {
      return report({
        status: 'hook_at_load_time',
        file: rel,
        line: coldStart.line,
        error: coldStart.message,
        hint: 'у игрока мод грузится из mods.txt до загрузки карты и умрёт на первом же хуке; прогони ww_validate_mod',
      })
    }
    if (a.usesWWRegisterHook && !a.usesDirectRegisterHook) bridgeOnlyHooks = true
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
  let readmeRu = ''
  let readmeEn = ''
  for (const rel of files) {
    if (README_RU.includes(rel)) {
      readmeRu = readFileSync(`${mod.root}/${rel}`, 'utf8')
      continue
    }
    if (README_EN.includes(rel)) {
      readmeEn = readmeEn || readFileSync(`${mod.root}/${rel}`, 'utf8')
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
  const ru = refreshSignature(readmeRu)
  const en = refreshSignature(readmeEn)
  // BOM: файл открывают блокнотом, без него кириллица читается как cp1251
  const withBom = (text: string): Buffer =>
    Buffer.from(text.startsWith('﻿') ? text : `﻿${text}`, 'utf8')
  entries.push({ path: 'УСТАНОВКА.txt', data: withBom(ru.text || installNoteRu(mod, version, parts)) })
  entries.push({ path: 'INSTALL.txt', data: withBom(en.text || installNoteEn(mod, version, parts)) })

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

  return report({
    status: 'ok',
    mod: mod.name,
    version,
    archive,
    size_kb: Math.round((zip.length / 1024) * 10) / 10,
    files: entries.length,
    root_folder: `${mod.name}/`,
    parts: partsLabel(parts),
    ...(dll ? { dll: describeDll(dll) } : {}),
    ...(dllStale
      ? { warning_dll_stale: `исходники ${NATIVE_DIR}/ новее ${MOD_DLL}: в архив ушла старая DLL — пересобери нативную часть и собери пакет заново` }
      : {}),
    ...(gitignored.length > 0 ? { excluded_by_gitignore: gitignored.slice(0, 10).join(', ') + (gitignored.length > 10 ? ` и ещё ${gitignored.length - 10}` : '') } : {}),
    vendored_libs: vendored.modules.length > 0 ? vendored.modules.join(', ') : 'нет',
    readme_ru: !readmeRu ? 'сгенерирован' : ru.refreshed ? 'взят из мода, сигнатура в архиве заменена на текущую' : 'взят из мода',
    readme_en: !readmeEn ? 'сгенерирован' : en.refreshed ? 'взят из мода, сигнатура в архиве заменена на текущую' : 'взят из мода',
    manifest: manifestState,
    ...(picked.bumped
      ? {
          name_collision: `${mod.name}-${version}.zip уже лежит в dist, архив назван ${picked.file}`,
          hint: 'подними mod_version, если это действительно новый релиз',
        }
      : {}),
    ...(ru.refreshed || en.refreshed
      ? { readme_hint: 'в readme мода устаревшая сигнатура StaticConstructObject — обнови и исходный файл, а не только архив' }
      : {}),
    ...(bridgeOnlyHooks
      ? {
          warning:
            'хуки ставятся только через WWRegisterHook: у игрока WWBridge нет, глобали не существует и хуки не встанут. Ставь их через require("ww.hook")',
        }
      : {}),
    next: 'распакуй архив и проверь установку по УСТАНОВКА.txt / INSTALL.txt',
  })
}

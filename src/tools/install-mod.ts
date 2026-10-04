import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs'
import { basename } from 'node:path'
import { ServerConfig } from '../config'
import { renderAiText, Scalar } from '../utils/ai-text'
import { PathSandboxError } from '../utils/path-sandbox'
import { MOD_DLL, MOD_ENTRY, MOD_MANIFEST, modSandbox, readModMeta } from '../utils/mod-project'
import {
  DLL_DIR,
  FileLockedError,
  gameModDir,
  isLink,
  isStale,
  placeFile,
  PlaceResult,
  purgeStale,
  removeFile,
} from '../utils/mod-native'
import { findGameProcess } from '../utils/game-process'
import { enableInModsTxt, registerInModsTxt } from '../utils/ue4ss-deploy'
import { modsTxtPath } from '../utils/ue4ss-mods'
import { extractZip, ZipEntry, ZipReadError } from '../utils/zip'
import { gitIgnored } from '../utils/git-ignore'
import { collectFiles } from './package-mod'

export interface InstallModArgs {
  mod_root?: string
  zip?: string
  name?: string
  enable?: boolean
  force?: boolean
  dll_only?: boolean
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

function report(fields: Record<string, Scalar>): string {
  return renderAiText({ reportType: 'mod_install', fields })
}

function looksLikeMod(dir: string): boolean {
  return existsSync(`${dir}/${MOD_ENTRY}`) || existsSync(`${dir}/${MOD_DLL}`)
}

function entriesFromModRoot(root: string): ZipEntry[] {
  return collectFiles(root).map((rel) => ({ path: rel, data: readFileSync(`${root}/${rel}`) }))
}

/** ww_package_mod кладёт всё под "<Имя мода>/...", плюс пара свободных README рядом — их отбрасываем. */
function entriesFromZip(buf: Buffer): { entries: ZipEntry[]; folderName: string | null } {
  const all = extractZip(buf)
  const manifestEntry = all.find((e) => /^[^/]+\/mod\.json$/.test(e.path))
  if (!manifestEntry) return { entries: all, folderName: null }
  const folder = manifestEntry.path.split('/')[0]
  const prefix = `${folder}/`
  const entries = all
    .filter((e) => e.path.startsWith(prefix))
    .map((e) => ({ path: e.path.slice(prefix.length), data: e.data }))
  return { entries, folderName: folder }
}

function listTree(root: string): { files: string[]; dirs: string[] } {
  const files: string[] = []
  const dirs: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        dirs.push(`${prefix}${e.name}`)
        walk(`${dir}/${e.name}`, `${prefix}${e.name}/`)
      } else files.push(`${prefix}${e.name}`)
    }
  }
  walk(root, '')
  return { files, dirs }
}

interface SyncResult {
  dllChanged: string[]
  dllSwapped: string[]
  removed: number
  kept: string[]
}

// каталог не сносится целиком: загруженную игрой DLL удалить нельзя, её можно только отодвинуть
function syncInto(targetDir: string, entries: ZipEntry[], runtime: (rels: string[]) => Set<string>): SyncResult {
  purgeStale(targetDir)
  const res: SyncResult = { dllChanged: [], dllSwapped: [], removed: 0, kept: [] }
  const wanted = new Set(entries.map((e) => e.path.toLowerCase()))
  for (const e of entries) {
    const how: PlaceResult = placeFile(e.data, `${targetDir}/${e.path}`)
    if (!e.path.toLowerCase().endsWith('.dll') || how === 'unchanged') continue
    res.dllChanged.push(e.path)
    if (how === 'swapped') res.dllSwapped.push(e.path)
  }
  const tree = listTree(targetDir)
  const extra = tree.files.filter((rel) => !wanted.has(rel.toLowerCase()) && !isStale(rel))
  const keep = runtime(extra)
  for (const rel of extra) {
    if (keep.has(rel)) {
      res.kept.push(rel)
      continue
    }
    if (removeFile(`${targetDir}/${rel}`) === 'swapped' && rel.toLowerCase().endsWith('.dll')) {
      res.dllChanged.push(rel)
      res.dllSwapped.push(rel)
    }
    res.removed++
  }
  for (const rel of tree.dirs.sort((a, b) => b.length - a.length)) {
    try {
      rmdirSync(`${targetDir}/${rel}`)
    } catch {}
  }
  return res
}

function backupExisting(config: ServerConfig, targetDir: string, name: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = `${config.stateDir}/backup/${name}-${ts}`
  mkdirSync(dest, { recursive: true })
  cpSync(targetDir, dest, { recursive: true, filter: (src) => !isStale(src) })
  return dest
}

export function handleInstallMod(config: ServerConfig, args: InstallModArgs): string {
  if (!args.mod_root && !args.zip) {
    return report({ status: 'no_source', hint: 'нужен mod_root или zip' })
  }
  if (args.mod_root && args.zip) {
    return report({ status: 'ambiguous_source', hint: 'mod_root и zip одновременно не принимаются' })
  }

  let entries: ZipEntry[]
  let derivedName: string | null = null
  let sourceRoot: string | null = null

  if (args.mod_root) {
    let root: string
    try {
      root = modSandbox(config).validateAndResolve(args.mod_root, config.modsRepo)
    } catch (e) {
      if (e instanceof PathSandboxError) {
        return report({ status: 'mod_root_rejected', mod_root: args.mod_root, sandbox_roots: config.sandboxRoots.join('; ') })
      }
      throw e
    }
    if (!looksLikeMod(root)) {
      return report({ status: 'entry_missing', mod_root: root, hint: `нет ни ${MOD_ENTRY}, ни ${MOD_DLL}` })
    }
    derivedName = readModMeta(root)?.name ?? basename(root)
    sourceRoot = root
    entries = entriesFromModRoot(root)
  } else {
    const zipInput = args.zip as string
    let zipPath: string
    try {
      zipPath = modSandbox(config).validateAndResolve(zipInput, config.modsRepo)
    } catch (e) {
      if (e instanceof PathSandboxError) {
        return report({ status: 'zip_rejected', zip: zipInput, sandbox_roots: config.sandboxRoots.join('; ') })
      }
      throw e
    }
    if (!existsSync(zipPath)) return report({ status: 'zip_not_found', zip: zipPath })
    let parsed: { entries: ZipEntry[]; folderName: string | null }
    try {
      parsed = entriesFromZip(readFileSync(zipPath))
    } catch (e) {
      if (e instanceof ZipReadError) return report({ status: 'zip_unreadable', zip: zipPath, error: e.message })
      throw e
    }
    entries = parsed.entries
    derivedName = parsed.folderName
    const manifestEntry = entries.find((e) => e.path === MOD_MANIFEST)
    if (manifestEntry) {
      try {
        const meta = JSON.parse(manifestEntry.data.toString('utf8')) as { name?: string }
        if (typeof meta.name === 'string') derivedName = meta.name
      } catch {
        /* mod.json битый — остаёмся на имени папки верхнего уровня из архива */
      }
    }
  }

  const name = args.name ?? derivedName
  if (!name) {
    return report({ status: 'name_unresolved', hint: 'не нашли mod.json — укажи name явно' })
  }
  if (!NAME_RE.test(name)) {
    return report({ status: 'bad_name', name, hint: 'имя мода: буквы/цифры/._- без разделителей пути' })
  }
  const hasLua = entries.some((e) => e.path === MOD_ENTRY)
  const hasDll = entries.some((e) => e.path === MOD_DLL)
  if (args.dll_only) {
    if (!hasDll) return report({ status: 'dll_missing', name, hint: `dll_only: в источнике нет ${MOD_DLL}` })
    entries = entries.filter((e) => e.path.startsWith(`${DLL_DIR}/`) || e.path === MOD_MANIFEST)
  } else if (!hasLua && !hasDll) {
    return report({ status: 'entry_missing', name, hint: `в источнике нет ни ${MOD_ENTRY}, ни ${MOD_DLL}` })
  }

  const targetDir = gameModDir(config.ue4ssDir, name)
  let backup: string | null = null
  if (existsSync(targetDir) || isLink(targetDir)) {
    const empty = !isLink(targetDir) && listTree(targetDir).files.length === 0
    if (!looksLikeMod(targetDir) && !empty && !args.force) {
      return report({
        status: 'target_looks_foreign',
        target: targetDir,
        hint: `каталог уже существует и не похож на мод UE4SS (нет ни ${MOD_ENTRY}, ни ${MOD_DLL}); force: true — перезаписать`,
      })
    }
    if (existsSync(targetDir)) backup = backupExisting(config, targetDir, name)
    // ссылка ведёт в чужие исходники: писать сквозь неё нельзя
    if (isLink(targetDir)) unlinkSync(targetDir)
  }

  mkdirSync(targetDir, { recursive: true })
  let sync: SyncResult
  try {
    // то, что .gitignore не пускает в пакет, мод пишет сам во время игры: при переустановке его не трогаем
    const runtime = (rels: string[]): Set<string> => {
      if (sourceRoot) return gitIgnored(sourceRoot, rels)
      const prefix = `mods/${name}/`
      const hit = gitIgnored(config.modsRepo, rels.map((r) => prefix + r))
      return new Set(rels.filter((r) => hit.has(prefix + r)))
    }
    sync = syncInto(targetDir, entries, runtime)
  } catch (e) {
    if (e instanceof FileLockedError) {
      return report({
        status: 'file_locked',
        name,
        file: e.path,
        ...(backup ? { backup } : {}),
        hint: 'файл держит запущенная игра и не даёт даже переименовать: закрой игру (ww_game_process action=stop) и повтори установку; каталог мог остаться частично обновлённым',
      })
    }
    throw e
  }

  const enable = args.enable !== false
  const modsTxtState = enable ? enableInModsTxt(modsTxtPath(config), name) : registerInModsTxt(modsTxtPath(config), name, false)
  const restart = sync.dllChanged.length > 0 && (sync.dllSwapped.length > 0 || findGameProcess(config) !== null)
  const installedLua = !args.dll_only && hasLua

  return report({
    status: 'ok',
    name,
    target: targetDir,
    parts: args.dll_only ? 'dll (dev-раскладка: Lua идёт через ww_deploy_mod)' : hasLua && hasDll ? 'lua+dll' : hasDll ? 'dll' : 'lua',
    files: entries.length,
    ...(sync.removed > 0 ? { removed_files: sync.removed } : {}),
    ...(sync.kept.length > 0 ? { kept_runtime_files: sync.kept.join(', ') } : {}),
    ...(hasDll ? { dll: sync.dllChanged.length > 0 ? `обновлена: ${sync.dllChanged.join(', ')}` : 'не изменилась' } : {}),
    ...(sync.dllSwapped.length > 0
      ? { dll_swapped: 'прежнюю DLL держит запущенная игра: она переименована в *.ww-old и удалится при следующей установке' }
      : {}),
    mods_txt: modsTxtState,
    ...(backup ? { backup } : {}),
    ...(restart ? { restart_required: 'новая DLL загрузится только после перезапуска игры: ww_game_process action=restart' } : {}),
    next: restart
      ? installedLua
        ? 'ww_game_process action=restart — и Lua, и DLL загрузятся из каталога игры при старте'
        : 'ww_game_process action=restart wait_for=world, затем ww_deploy_mod для Lua-части, если она есть'
      : installedLua && hasDll
        ? 'перезапусти игру. Это релизная раскладка: Lua-часть грузится из mods.txt, и dev-загрузка через ww_deploy_mod её задвоит; для dev-цикла ставь dll_only: true'
        : hasDll && !installedLua
          ? 'перезапусти игру — DLL загружается только при старте; Lua-часть, если есть, грузи ww_deploy_mod'
          : 'перезапусти игру; если мод уже стоял и правки только в Lua — быстрее ww_deploy_mod (hot reload)',
  })
}

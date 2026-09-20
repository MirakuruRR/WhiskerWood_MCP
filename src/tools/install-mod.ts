import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { ServerConfig } from '../config'
import { renderAiText, Scalar } from '../utils/ai-text'
import { PathSandboxError } from '../utils/path-sandbox'
import { MOD_ENTRY, MOD_MANIFEST, modSandbox, readModMeta } from '../utils/mod-project'
import { enableInModsTxt, registerInModsTxt } from '../utils/ue4ss-deploy'
import { modsTxtPath } from '../utils/ue4ss-mods'
import { extractZip, ZipEntry, ZipReadError } from '../utils/zip'
import { collectFiles } from './package-mod'

export interface InstallModArgs {
  mod_root?: string
  zip?: string
  name?: string
  enable?: boolean
  force?: boolean
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

function report(fields: Record<string, Scalar>): string {
  return renderAiText({ reportType: 'mod_install', fields })
}

function looksLikeMod(dir: string): boolean {
  return existsSync(`${dir}/${MOD_ENTRY}`)
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

function writeEntries(targetDir: string, entries: ZipEntry[]): void {
  for (const e of entries) {
    const full = `${targetDir}/${e.path}`
    mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true })
    writeFileSync(full, e.data)
  }
}

function backupExisting(config: ServerConfig, targetDir: string, name: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = `${config.stateDir}/backup/${name}-${ts}`
  mkdirSync(dest, { recursive: true })
  cpSync(targetDir, dest, { recursive: true })
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
    if (!existsSync(`${root}/${MOD_ENTRY}`)) {
      return report({ status: 'entry_missing', mod_root: root, hint: `нет ${MOD_ENTRY}` })
    }
    derivedName = readModMeta(root)?.name ?? basename(root)
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
  if (!entries.some((e) => e.path === MOD_ENTRY)) {
    return report({ status: 'entry_missing', name, hint: `в источнике нет ${MOD_ENTRY}` })
  }

  const targetDir = `${config.ue4ssDir}/Mods/${name}`
  let backup: string | null = null
  if (existsSync(targetDir)) {
    if (!looksLikeMod(targetDir) && !args.force) {
      return report({
        status: 'target_looks_foreign',
        target: targetDir,
        hint: `каталог уже существует и не похож на мод UE4SS (нет ${MOD_ENTRY}); force: true — перезаписать`,
      })
    }
    backup = backupExisting(config, targetDir, name)
    rmSync(targetDir, { recursive: true, force: true })
  }

  mkdirSync(targetDir, { recursive: true })
  writeEntries(targetDir, entries)

  const enable = args.enable !== false
  const modsTxtState = enable ? enableInModsTxt(modsTxtPath(config), name) : registerInModsTxt(modsTxtPath(config), name, false)

  return report({
    status: 'ok',
    name,
    target: targetDir,
    files: entries.length,
    mods_txt: modsTxtState,
    ...(backup ? { backup } : {}),
    next: 'перезапусти игру; если мод уже стоял и правки только в Lua — быстрее ww_deploy_mod (hot reload)',
  })
}

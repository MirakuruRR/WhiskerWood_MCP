import { cpSync, existsSync, lstatSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'

export type LinkMode = 'junction' | 'copy'

export function linkModDir(sourceDir: string, targetDir: string): LinkMode {
  if (existsSync(targetDir)) {
    const st = lstatSync(targetDir)
    if (st.isSymbolicLink()) rmSync(targetDir, { force: true })
    else rmSync(targetDir, { recursive: true, force: true })
  }
  try {
    symlinkSync(sourceDir, targetDir, 'junction')
    return 'junction'
  } catch {
    cpSync(sourceDir, targetDir, { recursive: true })
    return 'copy'
  }
}

export type ModsTxtState = 'уже включён' | 'включён' | 'добавлен'

export function enableInModsTxt(modsTxt: string, modName: string, anchor = /^\s*BPModLoaderMod\s*:/): ModsTxtState {
  const text = existsSync(modsTxt) ? readFileSync(modsTxt, 'utf8') : ''
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const idx = lines.findIndex((l) => new RegExp(`^\\s*${modName}\\s*:`).test(l))
  if (idx >= 0) {
    if (/:\s*1\s*$/.test(lines[idx])) return 'уже включён'
    lines[idx] = `${modName} : 1`
    writeFileSync(modsTxt, lines.join(eol), 'utf8')
    return 'включён'
  }
  const anchorAt = lines.findIndex((l) => anchor.test(l))
  const at = anchorAt >= 0 ? anchorAt + 1 : lines.length
  lines.splice(at, 0, `${modName} : 1`)
  writeFileSync(modsTxt, lines.join(eol), 'utf8')
  return 'добавлен'
}

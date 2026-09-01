import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'

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

export interface SharedLibsState {
  namespaces: string[]
  mode: LinkMode | 'none'
}

// у каждого Lua-мода UE4SS свой package.path, поэтому lib/ репозитория не виден
// установленному моду; Mods/shared уже входит в путь поиска require у всех модов
export function linkSharedLibs(modsRepo: string, ue4ssDir: string): SharedLibsState {
  const libRoot = `${modsRepo}/lib`
  if (!existsSync(libRoot)) return { namespaces: [], mode: 'none' }

  const shared = `${ue4ssDir}/Mods/shared`
  mkdirSync(shared, { recursive: true })

  const namespaces: string[] = []
  let mode: LinkMode | 'none' = 'none'
  for (const entry of readdirSync(libRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    mode = linkModDir(`${libRoot}/${entry.name}`, `${shared}/${entry.name}`)
    namespaces.push(entry.name)
  }
  return { namespaces, mode }
}

export type ModsTxtState = 'уже включён' | 'включён' | 'добавлен' | 'перемещён ниже WWBridge'

const BRIDGE = 'WWBridge'

function lineOf(lines: string[], name: string): number {
  return lines.findIndex((l) => l.split(':')[0].trim() === name)
}

// package.path до lib/ расширяет WWBridge, поэтому моды репозитория обязаны грузиться после него
function insertAt(lines: string[], modName: string): number {
  if (modName !== BRIDGE) {
    const bridge = lineOf(lines, BRIDGE)
    if (bridge >= 0) return bridge + 1
  }
  const loader = lineOf(lines, 'BPModLoaderMod')
  return loader >= 0 ? loader + 1 : lines.length
}

export function enableInModsTxt(modsTxt: string, modName: string): ModsTxtState {
  const text = existsSync(modsTxt) ? readFileSync(modsTxt, 'utf8') : ''
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const line = `${modName} : 1`
  const save = () => writeFileSync(modsTxt, lines.join(eol), 'utf8')

  const idx = lineOf(lines, modName)
  if (idx < 0) {
    lines.splice(insertAt(lines, modName), 0, line)
    save()
    return 'добавлен'
  }

  const bridge = lineOf(lines, BRIDGE)
  if (modName !== BRIDGE && bridge >= 0 && idx < bridge) {
    lines.splice(idx, 1)
    lines.splice(insertAt(lines, modName), 0, line)
    save()
    return 'перемещён ниже WWBridge'
  }

  if (/:\s*1\s*$/.test(lines[idx])) return 'уже включён'
  lines[idx] = line
  save()
  return 'включён'
}

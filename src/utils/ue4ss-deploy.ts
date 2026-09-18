import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'

export type LinkMode = 'junction' | 'copy'

export function linkModDir(sourceDir: string, targetDir: string): LinkMode {
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  if (existsSync(targetDir)) {
    const st = lstatSync(targetDir)
    if (st.isSymbolicLink()) {
      try {
        if (norm(readlinkSync(targetDir)) === norm(sourceDir)) {
          return 'junction'
        }
      } catch {}
      try {
        unlinkSync(targetDir)
      } catch {
        rmSync(targetDir, { force: true, recursive: true })
      }
    } else {
      rmSync(targetDir, { recursive: true, force: true })
    }
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
  source: string | null
}

// репозиторий модов перекрывает штатную библиотеку целиком: если там есть свой lib/,
// берём только его, иначе рядом оказались бы две копии ww.* с разными версиями
export function sharedLibsRoot(configDir: string, modsRepo: string): string | null {
  for (const root of [`${modsRepo}/lib`, `${configDir}/data/lib`]) {
    if (existsSync(root)) return root
  }
  return null
}

// у каждого Lua-мода UE4SS свой package.path, поэтому lib/ не виден установленному
// моду; Mods/shared уже входит в путь поиска require у всех модов
export function linkSharedLibs(configDir: string, modsRepo: string, ue4ssDir: string): SharedLibsState {
  const libRoot = sharedLibsRoot(configDir, modsRepo)
  if (!libRoot) return { namespaces: [], mode: 'none', source: null }

  const shared = `${ue4ssDir}/Mods/shared`
  mkdirSync(shared, { recursive: true })

  const namespaces: string[] = []
  let mode: LinkMode | 'none' = 'none'
  for (const entry of readdirSync(libRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    mode = linkModDir(`${libRoot}/${entry.name}`, `${shared}/${entry.name}`)
    namespaces.push(entry.name)
  }
  return { namespaces, mode, source: libRoot }
}

export type ModsTxtState = 'уже включён' | 'включён' | 'добавлен' | 'перемещён ниже WWBridge' | 'добавлен выключенным' | 'оставлен как есть'

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
  return registerInModsTxt(modsTxt, modName, true)
}

// AutoDump ставится выключенным: он снимает дампы каждый запуск, а нужен только
// при переиндексации. Уже стоящую строку не трогаем — её состояние выбрал человек
export function registerInModsTxt(modsTxt: string, modName: string, enabled: boolean): ModsTxtState {
  const text = existsSync(modsTxt) ? readFileSync(modsTxt, 'utf8') : ''
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const line = `${modName} : ${enabled ? 1 : 0}`
  const save = () => writeFileSync(modsTxt, lines.join(eol), 'utf8')

  const idx = lineOf(lines, modName)
  if (idx < 0) {
    lines.splice(insertAt(lines, modName), 0, line)
    save()
    return enabled ? 'добавлен' : 'добавлен выключенным'
  }
  if (!enabled) return 'оставлен как есть'

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

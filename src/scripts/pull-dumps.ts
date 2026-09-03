import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { ConfigError, loadConfig, validateConfig } from '../config'

const PAK_FILTER = '(AssetRegistry\.bin|Content/Data/|Config/Default)'

function fmtTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

function capturedAtFrom(logPath: string): string | null {
  let text: string
  try {
    text = readFileSync(logPath, 'utf8')
  } catch {
    return null
  }
  let found: string | null = null
  for (const m of text.matchAll(/ALL DONE captured_at=(\w+)/g)) found = m[1]
  return found
}

function copyTree(from: string, to: string): number {
  rmSync(to, { recursive: true, force: true })
  cpSync(from, to, { recursive: true })
  let n = 0
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${dir}/${e.name}`)
      else n++
    }
  }
  walk(to)
  return n
}

function unpackPak(repoRoot: string, pakPath: string, outDir: string): void {
  rmSync(outDir, { recursive: true, force: true })
  for (const py of [['python'], ['py', '-3']]) {
    const proc = Bun.spawnSync([...py, `${repoRoot}/wwpak.py`, 'unpack', pakPath, outDir, PAK_FILTER], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (proc.exitCode === 0) {
      console.log(`  ${new TextDecoder().decode(proc.stdout).trim()}`)
      return
    }
    if (proc.exitCode === null) continue
    throw new Error(`wwpak.py упал (код ${proc.exitCode}):\n${new TextDecoder().decode(proc.stderr).trim()}`)
  }
  throw new Error('не найден python — он нужен для wwpak.py, чтобы вынуть AssetRegistry.bin из пака')
}

async function main(): Promise<void> {
  let cfg
  try {
    cfg = loadConfig()
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message)
      process.exit(1)
    }
    throw e
  }
  const problems = validateConfig(cfg)
  if (problems.length > 0) {
    console.error('Конфигурация не прошла проверку:')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }

  const repoRoot = `${import.meta.dir}/../..`
  const srcObjectDump = `${cfg.ue4ssDir}/UE4SS_ObjectDump.txt`
  const srcUht = `${cfg.ue4ssDir}/UHTHeaderDump`
  const srcLog = `${cfg.ue4ssDir}/UE4SS.log`
  const usmapName = readdirSync(cfg.ue4ssDir).find((f) => f.endsWith('.usmap'))

  const missing: string[] = []
  if (!existsSync(srcObjectDump)) missing.push(srcObjectDump)
  if (!existsSync(srcUht)) missing.push(srcUht)
  if (!usmapName) missing.push(`${cfg.ue4ssDir}/*.usmap`)
  if (missing.length > 0) {
    console.error('AutoDump ничего не оставил — не найдены:')
    for (const m of missing) console.error(`  - ${m}`)
    console.error('Запусти игру с AutoDump : 1 и дождись "ALL DONE" в UE4SS.log.')
    process.exit(1)
  }

  const capturedAt = capturedAtFrom(srcLog)
  if (!capturedAt) {
    console.error(`В ${srcLog} нет строки "ALL DONE captured_at=..." — дамп не доснялся.`)
    console.error('Зайди в сохранение и подожди ~60 с (или нажми Ctrl+Alt+F9), потом повтори.')
    process.exit(1)
  }

  const pakMtime = statSync(cfg.pakPath).mtimeMs
  const dumpMtime = statSync(`${cfg.ue4ssDir}/${usmapName}`).mtimeMs
  console.log(`Пак:  ${fmtTime(pakMtime)}`)
  console.log(`Дамп: ${fmtTime(dumpMtime)} (captured_at=${capturedAt})`)
  if (dumpMtime < pakMtime) {
    console.error('Дамп старше пака — он от прошлой версии игры. Перезапусти игру и пересними.')
    process.exit(1)
  }

  mkdirSync(cfg.dumpsDir, { recursive: true })
  for (const f of readdirSync(cfg.dumpsDir)) {
    if (f.endsWith('.usmap')) rmSync(`${cfg.dumpsDir}/${f}`)
  }
  const usmapDest = `${cfg.dumpsDir}/${usmapName!.replace(/\.usmap$/, `.${capturedAt}.usmap`)}`

  console.log('Перекладываю в dumps/...')
  copyFileSync(srcObjectDump, `${cfg.dumpsDir}/UE4SS_ObjectDump.txt`)
  copyFileSync(`${cfg.ue4ssDir}/${usmapName}`, usmapDest)
  if (existsSync(srcLog)) copyFileSync(srcLog, `${cfg.dumpsDir}/phase0-UE4SS.log`)
  console.log(`  UE4SS_ObjectDump.txt, ${usmapDest.split('/').pop()}`)
  const uhtFiles = copyTree(srcUht, `${cfg.dumpsDir}/UHTHeaderDump`)
  console.log(`  UHTHeaderDump/ — ${uhtFiles} файлов`)

  console.log('Извлекаю из пака (wwpak.py)...')
  unpackPak(repoRoot, cfg.pakPath, `${cfg.dumpsDir}/pak`)

  const registry = `${cfg.dumpsDir}/pak/Whiskerwood/AssetRegistry.bin`
  if (!existsSync(registry)) {
    console.error(`AssetRegistry.bin не извлёкся: ${registry}`)
    process.exit(1)
  }
  console.log('Готово. Дальше: bun run setup')
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})

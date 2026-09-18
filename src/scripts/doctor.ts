import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { ConfigError, ServerConfig, loadConfig, validateConfig } from '../config'
import { repoRoot } from '../utils/cli-config'
import { getBridge } from '../utils/bridge-client'
import { defaultSeedPath } from './memory-sync'
import { sharedLibsRoot } from '../utils/ue4ss-deploy'
import { WHISKERWOOD_APP_ID, findSteamGame } from '../utils/steam-locate'

type Level = 'ok' | 'warn' | 'fail'

interface Check {
  level: Level
  title: string
  detail?: string
  fix?: string
}

const MARK: Record<Level, string> = { ok: ' ok ', warn: 'внимание', fail: 'ОШИБКА' }

const checks: Check[] = []
const add = (level: Level, title: string, detail?: string, fix?: string) => checks.push({ level, title, detail, fix })

function run(cmd: string[]): { code: number; out: string } {
  try {
    const p = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' })
    return { code: p.exitCode ?? 1, out: new TextDecoder().decode(p.stdout).trim() }
  } catch {
    return { code: 1, out: '' }
  }
}

function fmtTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

function checkToolchain(): void {
  add('ok', `bun ${Bun.version}`)

  const py = [['python', '--version'], ['py', '-3', '--version']].map(run).find((r) => r.code === 0)
  if (py) add('ok', py.out.replace(/^Python\s*/, 'python '))
  else add('fail', 'python не найден', 'нужен для wwpak.py — вынуть AssetRegistry.bin из пака', 'поставьте Python 3 и включите его в PATH')

  const dotnet = run(['dotnet', '--list-sdks'])
  if (dotnet.code !== 0) {
    add('fail', '.NET SDK не найден', 'сайдкар WwParse (CUE4Parse) не соберётся', 'поставьте .NET SDK 10: https://dotnet.microsoft.com/download')
  } else {
    const versions = dotnet.out.split(/\r?\n/).map((l) => l.trim().split(' ')[0])
    const has10 = versions.some((v) => v.startsWith('10.'))
    if (has10) add('ok', `.NET SDK ${versions.filter((v) => v.startsWith('10.')).join(', ')}`)
    else add('fail', `.NET SDK 10 не найден (есть: ${versions.join(', ') || 'ничего'})`, undefined, 'сайдкару нужен именно net10.0')
  }
}

function checkGame(cfg: ServerConfig | null): void {
  const steam = findSteamGame()
  if (steam) add('ok', `игра найдена в Steam: ${steam.gameDir}`, `AppID ${WHISKERWOOD_APP_ID}, библиотека ${steam.library}`)
  else add('warn', 'игра не найдена через Steam', 'не беда, если копия не из Steam — путь берётся из конфига')

  if (!cfg) return
  for (const [label, path, isDir] of [
    ['каталог игры', cfg.gameDir, true],
    ['исполняемый файл', cfg.exePath, false],
    ['пак', cfg.pakPath, false],
  ] as Array<[string, string, boolean]>) {
    if (!existsSync(path)) add('fail', `${label} не найден: ${path}`, undefined, 'поправьте wwmcp.config.json')
    else if (isDir !== statSync(path).isDirectory()) add('fail', `${label}: не тот тип пути: ${path}`)
    else add('ok', `${label}: ${path}`)
  }
  if (steam && cfg.gameDir.toLowerCase() !== steam.gameDir.toLowerCase()) {
    add('warn', 'конфиг указывает не на ту копию, что нашлась в Steam', `конфиг: ${cfg.gameDir}`, 'если копий несколько — убедитесь, что моддите ту же, что запускаете')
  }
}

function checkUe4ss(cfg: ServerConfig): void {
  const win64 = `${cfg.ue4ssDir}/..`
  if (!existsSync(cfg.ue4ssDir)) {
    add('fail', `UE4SS не установлен: нет ${cfg.ue4ssDir}`, undefined, 'скачайте UE4SS и распакуйте в Whiskerwood/Binaries/Win64')
    return
  }
  const loader = ['dwmapi.dll', 'xinput1_3.dll'].find((d) => existsSync(`${win64}/${d}`))
  if (loader) add('ok', `загрузчик UE4SS: ${loader}`)
  else add('fail', 'рядом с exe нет dwmapi.dll — UE4SS не подхватится игрой', undefined, 'распакуйте UE4SS целиком, вместе с dwmapi.dll')

  const log = `${cfg.ue4ssDir}/UE4SS.log`
  if (!existsSync(log)) {
    add('warn', 'UE4SS.log отсутствует', 'игра ещё ни разу не запускалась с UE4SS', 'запустите игру один раз, потом повторите проверку')
  } else {
    const text = readFileSync(log, 'utf8')
    const version = /v\d+\.\d+\.\d+(-\d+)?/.exec(text)?.[0] ?? 'версия не определилась'
    add('ok', `UE4SS ${version}`, `лог обновлён ${fmtTime(statSync(log).mtimeMs)}`)
  }

  const modsTxt = `${cfg.ue4ssDir}/Mods/mods.txt`
  if (!existsSync(modsTxt)) {
    add('fail', `нет ${modsTxt}`, undefined, 'UE4SS распакован не полностью')
    return
  }
  const lines = readFileSync(modsTxt, 'utf8').split(/\r?\n/)
  const state = (name: string): string | null => {
    const l = lines.find((x) => x.split(':')[0].trim() === name)
    return l ? (/:\s*1\s*$/.test(l) ? 'включён' : 'выключен') : null
  }
  for (const [name, want] of [['WWBridge', 'включён'], ['AutoDump', 'выключен']] as Array<[string, string]>) {
    const installed = existsSync(`${cfg.ue4ssDir}/Mods/${name}`)
    const s = state(name)
    if (!installed || s === null) {
      add(name === 'WWBridge' ? 'fail' : 'warn', `${name} не развёрнут`, undefined, 'bun run bridge:deploy')
    } else if (name === 'WWBridge' && s !== want) {
      add('fail', `WWBridge выключен в mods.txt`, undefined, 'bun run bridge:deploy')
    } else {
      add('ok', `${name}: развёрнут, в mods.txt ${s}`)
    }
  }

  const libs = sharedLibsRoot(repoRoot(), cfg.modsRepo)
  const shared = `${cfg.ue4ssDir}/Mods/shared/ww`
  if (!libs) add('fail', 'библиотека ww.* не найдена ни в репозитории модов, ни в data/lib')
  else if (!existsSync(shared)) add('warn', 'ww.* не связана с Mods/shared', `источник: ${libs}`, 'bun run bridge:deploy')
  else add('ok', `библиотека ww.*: ${libs} → Mods/shared`)
}

function checkDumps(cfg: ServerConfig): void {
  const usmap = existsSync(cfg.dumpsDir) ? readdirSync(cfg.dumpsDir).find((f) => f.endsWith('.usmap')) : undefined
  const objectDump = `${cfg.dumpsDir}/UE4SS_ObjectDump.txt`
  const registry = `${cfg.dumpsDir}/pak/Whiskerwood/AssetRegistry.bin`
  const missing = [
    !existsSync(objectDump) && 'UE4SS_ObjectDump.txt',
    !usmap && '*.usmap',
    !existsSync(`${cfg.dumpsDir}/UHTHeaderDump`) && 'UHTHeaderDump/',
    !existsSync(registry) && 'AssetRegistry.bin',
  ].filter(Boolean) as string[]

  if (missing.length > 0) {
    add('warn', `дампы неполные: нет ${missing.join(', ')}`, undefined, 'AutoDump : 1 → зайти в сохранение → bun run dumps:pull')
    return
  }

  const pakMtime = statSync(cfg.pakPath).mtimeMs
  const stale = [objectDump, `${cfg.dumpsDir}/${usmap}`, registry].filter((p) => statSync(p).mtimeMs < pakMtime)
  if (stale.length > 0) {
    add('fail', 'дампы старше пака — игра обновилась, а дампы не переснимали', 'из таких дампов таблицы молча собираются пустыми', 'AutoDump : 1 → зайти в сохранение → bun run dumps:pull → bun run setup')
  } else {
    const captured = usmap!.includes('.in_level.') ? 'in_level' : 'main_menu'
    if (captured === 'main_menu') add('warn', 'дамп снят в главном меню, а не в мире', 'часть блюпринтовых классов не была загружена', 'зайдите в сохранение и переснимите')
    else add('ok', `дампы свежие, сняты в мире (${fmtTime(statSync(`${cfg.dumpsDir}/${usmap}`).mtimeMs)})`)
  }
}

function checkProfile(cfg: ServerConfig): void {
  let profiles: string[] = []
  try {
    profiles = readdirSync(cfg.distDir).filter((d) => existsSync(`${cfg.distDir}/${d}/profile.json`))
  } catch {}
  if (profiles.length === 0) {
    add('fail', 'индекс не собран', undefined, 'bun run setup')
    return
  }
  const fpPath = `${cfg.stateDir}/game-fingerprint.json`
  let gameVersion: string | null = null
  try {
    gameVersion = JSON.parse(readFileSync(fpPath, 'utf8')).projectVersion ?? null
  } catch {}

  for (const p of profiles) {
    const contract = JSON.parse(readFileSync(`${cfg.distDir}/${p}/profile.json`, 'utf8'))
    const current = gameVersion && contract.gameVersion === gameVersion
    add(current || !gameVersion ? 'ok' : 'warn', `профиль ${p}`, `версия игры ${contract.gameVersion}, собран ${contract.builtAt}${current ? ' — совпадает с игрой' : ''}`)
  }
  if (gameVersion && !profiles.some((p) => JSON.parse(readFileSync(`${cfg.distDir}/${p}/profile.json`, 'utf8')).gameVersion === gameVersion)) {
    add('fail', `под текущую версию игры (${gameVersion}) профиля нет`, undefined, 'bun run setup')
  }
}

async function checkBridge(cfg: ServerConfig): Promise<void> {
  const bridge = getBridge(cfg)
  const st = await bridge.readStatusStable()
  if (!st) {
    if (!existsSync(bridge.statusPath)) add('warn', 'мост ни разу не стартовал', `нет ${bridge.statusPath}`, 'bun run bridge:deploy, затем запустите игру')
    else add('warn', 'игра не запущена', 'статус моста есть, но не читается')
    return
  }
  if (!bridge.isAlive(st)) add('warn', 'игра не запущена', 'heartbeat моста устарел')
  else add('ok', 'мост отвечает, игра запущена')
}

function checkMemory(cfg: ServerConfig): void {
  const seed = defaultSeedPath()
  if (!existsSync(seed)) {
    add('warn', 'общей базы знаний нет в репозитории', seed)
    return
  }
  const lines = readFileSync(seed, 'utf8').trim().split(/\r?\n/).filter((l) => l.length > 0).length
  const db = `${cfg.distDir}/whiskerwood-memory.db`
  if (!existsSync(db)) add('warn', `общая база (${lines} записей) ещё не применена`, undefined, 'bun run memory:sync')
  else add('ok', `память на месте, в общей базе ${lines} записей`, 'обновить: git pull && bun run memory:sync')
}

async function main(): Promise<void> {
  console.log('Проверка стенда Whiskerwood MCP\n')
  checkToolchain()

  let cfg: ServerConfig | null = null
  try {
    cfg = loadConfig()
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e
    add('fail', 'конфигурация не найдена', (e as Error).message.split('\n')[0], 'скопируйте wwmcp.config.example.json в wwmcp.config.json и поправьте пути')
  }

  checkGame(cfg)
  if (cfg) {
    const problems = validateConfig(cfg)
    for (const p of problems) add('fail', `конфиг: ${p}`)
    checkUe4ss(cfg)
    checkDumps(cfg)
    checkProfile(cfg)
    checkMemory(cfg)
    await checkBridge(cfg)
  }

  for (const c of checks) {
    console.log(`[${MARK[c.level]}] ${c.title}`)
    if (c.detail) console.log(`         ${c.detail}`)
    if (c.fix) console.log(`         → ${c.fix}`)
  }

  const fails = checks.filter((c) => c.level === 'fail')
  const warns = checks.filter((c) => c.level === 'warn')
  console.log(`\nитого: ${checks.length - fails.length - warns.length} ok, ${warns.length} предупреждений, ${fails.length} ошибок`)
  if (fails.length > 0) {
    console.log('Стенд не готов. Сначала закройте ошибки выше.')
    process.exit(1)
  }
  console.log(warns.length > 0 ? 'Стенд рабочий, но не всё идеально.' : 'Стенд полностью готов.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

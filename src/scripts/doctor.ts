import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { ConfigError, ServerConfig, loadConfig, validateConfig } from '../config'
import { repoRoot } from '../utils/cli-config'
import { getBridge } from '../utils/bridge-client'
import { defaultSeedPath } from './memory-sync'
import { sharedLibsRoot } from '../utils/ue4ss-deploy'
import { editorPluginPaths, findEditorProcess, kitStatus, NEW_MOD_SCRIPT, savedModsDir } from '../utils/kit'
import { loomDrift } from '../tools/loom-status'
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
    const sha = /Git SHA #([0-9a-f]+)/.exec(text)?.[1]
    add('ok', `UE4SS ${version}${sha ? ` (${sha})` : ''}`, `лог обновлён ${fmtTime(statSync(log).mtimeMs)}`)
    const sdkManifest = `${import.meta.dir}/../../data/ue4ss-sdk/manifest.json`
    if (sha && !existsSync(sdkManifest)) {
      add('ok', 'заголовков C++-модов нет (data/ue4ss-sdk)', 'нужны только для сборки C++-части мода: bun run ue4ss-sdk')
    } else if (sha) {
      const sdk = JSON.parse(readFileSync(sdkManifest, 'utf8')) as { ue4ss_commit: string }
      if (sdk.ue4ss_commit.startsWith(sha)) add('ok', `заголовки C++-модов (data/ue4ss-sdk) того же коммита UE4SS`)
      else
        add(
          'warn',
          `заголовки C++-модов от другого коммита UE4SS: ${sdk.ue4ss_commit.slice(0, 8)}, а стоит ${sha}`,
          'C++-мод, собранный на них, может не загрузиться или упасть',
          'bun run ue4ss-sdk',
        )
    }
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

function checkLoom(cfg: ServerConfig): void {
  const st = kitStatus(cfg)
  if (!st.configured) {
    add(
      'warn',
      `кит Loom не настроен${st.problem ? `: ${st.problem}` : ''}`,
      'Loom-инструменты ответят kit_not_configured, остальное работает как раньше',
      'скилл /ww-setup: указать путь к киту (ключ kitDir)',
    )
    return
  }
  const kit = st.kit!
  add('ok', `кит: ${kit.kitDir}`, `проект ${kit.projectName}.uproject`)
  if (kit.engineDir) {
    add(
      'ok',
      `движок: ${kit.engineDir}`,
      kit.engineSource === 'registry' ? `найден по реестру, EngineAssociation ${kit.engineAssociation ?? '—'}` : 'задан ключом engineDir',
    )
  } else {
    add('fail', 'движок не найден', 'EngineAssociation кита не разрешился и engineDir не задан', 'задайте engineDir в конфиге')
  }

  for (const [label, path, fix] of [
    ['loom.exe', kit.loomExe, 'кит собран не полностью: нет плагина LoomEditor с бинарями'],
  ] as Array<[string, string, string]>) {
    if (existsSync(path)) add('ok', `${label}: ${path}`)
    else add('fail', `нет ${label}: ${path}`, undefined, fix)
  }

  if (existsSync(kit.typesJson)) {
    const stTypes = statSync(kit.typesJson)
    add('ok', `types.json: ${Math.round(stTypes.size / 1048576)} МБ`, `обновлён ${fmtTime(stTypes.mtimeMs)}`)
    if (existsSync(cfg.pakPath) && stTypes.mtimeMs < statSync(cfg.pakPath).mtimeMs) {
      add('warn', 'types.json старше пака игры', 'кит мог отстать от патча: Loom соберёт мод против старых сигнатур', 'обновите кит и соберите Blueprint в редакторе, затем ww_loom_status')
    }
  } else {
    add('warn', 'types.json ещё не создан', 'ни одна сборка Blueprint в редакторе не проходила', 'откройте кит в редакторе и соберите мод (LoomBuild)')
  }

  if (existsSync(kit.reportJson)) {
    const rep = statSync(kit.reportJson)
    const summary = readReportSummary(kit.reportJson)
    add('ok', `report.json от ${fmtTime(rep.mtimeMs)}`, summary)
    if (/failed=[1-9]/.test(summary)) {
      add(
        'warn',
        "в последней сборке Loom есть failed Blueprint'ы",
        summary,
        'перед следующей сборкой удалите <kit>/Saved/Autosaves: недособранный Blueprint роняет следующий LoomBuild на assert FindObject<UBlueprint>',
      )
    }
  } else {
    add('warn', 'report.json отсутствует', 'сборок Blueprint ещё не было')
  }

  const opsBuild = readJsonOrNull(`${kit.opsDir}/build.json`) as { version?: string } | null
  const uplugin = readJsonOrNull(`${kit.kitDir}/Plugins/LoomEditor/LoomEditor.uplugin`) as { VersionName?: string } | null
  if (opsBuild?.version && uplugin?.VersionName) {
    if (opsBuild.version !== uplugin.VersionName) {
      add('fail', 'плагин LoomEditor и loom.exe разной версии', `плагин ${uplugin.VersionName}, ops собраны ${opsBuild.version}`, 'обновите кит целиком и пересоберите Blueprint в редакторе')
    } else {
      add('ok', `версия Loom: ${opsBuild.version}`, 'из ops/build.json и LoomEditor.uplugin')
    }
  } else if (!opsBuild) {
    add('warn', 'версию Loom определить нечем', 'loom build ещё не проходил', 'соберите Blueprint в редакторе')
  }

  const drift = loomDrift(cfg)
  if (drift.diff !== 'ok') {
    add('warn', 'сверка types.json с индексом не выполнена', String(drift.diff_reason ?? ''))
  } else {
    const missInGame = Number(drift.kit_classes_missing_from_game ?? 0) + Number(drift.kit_functions_missing_from_game ?? 0)
    if (missInGame > 0) {
      add(
        'fail',
        `кит отстал от патча игры: ${missInGame} сущностей есть в ките, но нет в игре`,
        `${drift.kit_classes_missing_from_game} классов, ${drift.kit_functions_missing_from_game} функций`,
        'обновите кит до текущего патча: стабы едут из патча кита, в редакторе их не пересобрать',
      )
    } else if (Number(drift.functions_params_differ ?? 0) > 0) {
      add('warn', `параметры разошлись у ${drift.functions_params_differ} функций кита`, `${drift.game_module_functions} сверено`)
    } else {
      add(
        'ok',
        `types.json сходится с игрой: ${drift.game_module_classes} классов и ${drift.game_module_functions} функций своих модулей`,
        `BlueprintCallable вне кита: ${drift.bp_callable_missing_from_kit} — Loom их не видит, поломкой не является`,
      )
    }
    if (drift.uht_modules_absent) {
      add('warn', 'UHT-дампов игровых модулей нет: сверка BlueprintCallable пропущена', String(drift.uht_modules_absent), 'ww_capture_dumps → bun run dumps:pull')
    }
  }

  const editor = findEditorProcess(kit.uproject)
  if (editor) add('ok', `редактор открыт с этим .uproject (pid ${editor.pid})`, 'сборка пойдёт через DirectoryWatcher, headless не нужен')
  else add('ok', 'редактор закрыт', 'headless-сборка возможна: UnrealEditor-Cmd -run=LoomBuild')

  const plugins = editorPluginPaths(kit)
  const noPlugins = plugins ? [plugins.python, plugins.scripting].filter((p) => !existsSync(p)) : ['движок не найден']
  if (!existsSync(NEW_MOD_SCRIPT)) add('fail', 'нет скрипта создания мода', NEW_MOD_SCRIPT, 'восстановите data/loom/new_mod.py из репозитория')
  else if (noPlugins.length > 0) add('warn', 'ww_loom_new_mod недоступен', `нет ${noPlugins.join(', ')}`, 'новый мод — через New mod... в редакторе')
  else add('ok', 'ww_loom_new_mod готов', 'PythonScriptPlugin и EditorScriptingUtilities есть в движке')

  if (existsSync(kit.gameInstallTxt)) {
    const text = readFileSync(kit.gameInstallTxt, 'utf8')
    const line = text.split(/\r?\n/).find((l) => l.trim().length > 0 && !l.startsWith(';'))?.trim() ?? ''
    const kitGame = line.replace(/[\\/]Whiskerwood$/, '').replace(/\\/g, '/').toLowerCase()
    if (kitGame.length === 0) add('warn', 'GameInstallDirectory.txt пуст')
    else if (kitGame !== cfg.gameDir.toLowerCase()) {
      add('warn', 'кит смотрит на другую установку игры', `кит: ${line}`, `конфиг: ${cfg.gameDir}`)
    } else add('ok', 'кит и конфиг смотрят на одну установку игры')
  }

  const mods = existsSync(kit.contentMods) ? readdirSync(kit.contentMods).filter((d) => statSync(`${kit.contentMods}/${d}`).isDirectory()) : []
  add('ok', `модов в ките: ${mods.length}`, mods.slice(0, 12).join(', '))
  add('ok', `пак мода кладётся в ${savedModsDir(cfg)}`, 'загрузка pak-мода — только при старте игры')
}

function readJsonOrNull(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as unknown
  } catch {
    return null
  }
}

function readReportSummary(path: string): string {
  try {
    const rep = JSON.parse(readFileSync(path, 'utf8')) as {
      ok?: boolean
      errors?: unknown[]
      blueprints?: Array<{ status?: string }>
    }
    const bps = rep.blueprints ?? []
    const failed = bps.filter((b) => b.status === 'failed').length
    const built = bps.filter((b) => b.status === 'built').length
    return `ok=${rep.ok ?? '?'}, built=${built}, failed=${failed}, errors=${(rep.errors ?? []).length}`
  } catch (e) {
    return `не разобран: ${(e as Error).message}`
  }
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
    checkLoom(cfg)
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

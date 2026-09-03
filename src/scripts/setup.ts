import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { ConfigError, loadConfig, validateConfig } from '../config'
import { ProfileContract } from '../contract'
import { INDEX_SCHEMA_VERSION } from '../schema'
import { ensureFingerprint } from '../utils/game-fingerprint'
import { ProfileBusyError, publishStagedProfile, stagingDirFor, sweepStagingAndTrash } from '../utils/profile-publish'
import { profileIdFor } from '../contract'
import { buildReflectionIndex } from './index-reflection'
import { buildGameDataIndex } from './index-gamedata'

interface InputFingerprint {
  size: number
  mtimeMs: number
  md5: string
}

interface BuildFingerprint {
  schemaVersion: number
  profileId: string
  inputs: Record<string, InputFingerprint>
}

async function md5OfFile(path: string): Promise<string> {
  const hash = createHash('md5')
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk)
  return hash.digest('hex')
}

async function fingerprintInput(path: string, cached?: InputFingerprint, hash = true): Promise<InputFingerprint> {
  const st = statSync(path)
  const size = Number(st.size)
  const mtimeMs = st.mtimeMs
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
    return { size, mtimeMs, md5: cached.md5 }
  }
  // Пак — 4 ГБ, хешировать его на каждую сверку нельзя: сравниваем по size+mtime
  return { size, mtimeMs, md5: hash ? await md5OfFile(path) : `${size}:${mtimeMs}` }
}

function findUsmap(dumpsDir: string): { path: string; capturedAt: string } | null {
  let files: string[]
  try {
    files = readdirSync(dumpsDir)
  } catch {
    return null
  }
  const inLevel = files.filter((f) => f.endsWith('.usmap') && f.includes('.in_level.'))
  const any = files.filter((f) => f.endsWith('.usmap'))
  const chosen = inLevel[0] ?? any[0]
  if (!chosen) return null
  return { path: `${dumpsDir}/${chosen}`, capturedAt: chosen.includes('.in_level.') ? 'in_level' : 'main_menu' }
}

function fmtTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

function detectEngineVersion(usmapPath: string): string {
  const base = usmapPath.split('/').pop() ?? ''
  const m = /^Whiskerwood-(.+)-[0-9a-f]{6,}\./.exec(base)
  return m ? m[1] : 'unknown'
}

function detectUe4ssVersion(logPath: string): string {
  try {
    const text = readFileSync(logPath, 'utf8')
    const full = /v\d+\.\d+\.\d+-\d+/.exec(text)
    if (full) return full[0]
    const m = /v\d+\.\d+\.\d+/.exec(text)
    return m ? m[0] : 'unknown'
  } catch {
    return 'unknown'
  }
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force')
  const allowStale = process.argv.includes('--allow-stale-dumps')

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

  const objectDumpPath = `${cfg.dumpsDir}/UE4SS_ObjectDump.txt`
  const uhtDir = `${cfg.dumpsDir}/UHTHeaderDump`
  const assetRegistryPath = `${cfg.dumpsDir}/pak/Whiskerwood/AssetRegistry.bin`
  const usmap = findUsmap(cfg.dumpsDir)

  const missing: string[] = []
  if (!existsSync(objectDumpPath)) missing.push(objectDumpPath)
  if (!usmap) missing.push(`${cfg.dumpsDir}/*.usmap`)
  if (!existsSync(uhtDir)) missing.push(uhtDir)
  if (!existsSync(assetRegistryPath)) missing.push(assetRegistryPath)
  if (missing.length > 0) {
    console.error('Не найдены входные файлы сборки:')
    for (const m of missing) console.error(`  - ${m}`)
    process.exit(1)
  }

  console.log('Отпечаток игры (уровень 2: ProjectVersion из пака + sha256 exe)...')
  const fp = await ensureFingerprint(cfg)
  console.log(`  версия игры: ${fp.projectVersion}`)

  const pakMtime = statSync(cfg.pakPath).mtimeMs
  const dumpInputs: Array<[string, string]> = [
    ['UE4SS_ObjectDump.txt', objectDumpPath],
    ['usmap', usmap!.path],
    ['UHTHeaderDump/', uhtDir],
    ['AssetRegistry.bin', assetRegistryPath],
  ]
  console.log(`Свежесть входов (пак: ${fmtTime(pakMtime)}):`)
  const stale: string[] = []
  for (const [label, path] of dumpInputs) {
    const m = statSync(path).mtimeMs
    if (m < pakMtime) stale.push(label)
    console.log(`  ${label.padEnd(21)} ${fmtTime(m)}${m < pakMtime ? '  ← СТАРШЕ ПАКА' : ''}`)
  }
  console.log(`  дамп снят: ${usmap!.capturedAt}`)
  if (stale.length > 0) {
    const head = `Дампы старше пака: ${stale.join(', ')}. Игра обновилась, а дампы не переснимали.`
    if (!allowStale) {
      console.error(head)
      console.error('Собирать из них нельзя: .usmap от прошлой версии ломает разбор молча —')
      console.error('таблицы с изменившимся layout отдают ноль строк без единой ошибки.')
      console.error('  1. Игра с AutoDump : 1, войти в сохранение, дождаться в UE4SS.log строки')
      console.error('     "ALL DONE captured_at=in_level"')
      console.error('  2. bun run dumps:pull')
      console.error('  3. bun run setup')
      console.error('Собрать вопреки проверке: --allow-stale-dumps')
      process.exit(1)
    }
    console.warn(`${head} Продолжаю из-за --allow-stale-dumps.`)
  }

  const profileId = profileIdFor(fp.projectVersion)
  const fpPath = `${cfg.stateDir}/build-fingerprint.json`
  const cachedBuildFp: BuildFingerprint | null = existsSync(fpPath)
    ? (JSON.parse(readFileSync(fpPath, 'utf8')) as BuildFingerprint)
    : null

  const inputPaths: Record<string, string> = {
    objectDump: objectDumpPath,
    usmap: usmap!.path,
    assetRegistry: assetRegistryPath,
    pak: cfg.pakPath,
  }
  const cheapInputs = new Set(['pak'])

  if (!force && cachedBuildFp && cachedBuildFp.profileId === profileId && cachedBuildFp.schemaVersion === INDEX_SCHEMA_VERSION) {
    let same = true
    for (const [key, path] of Object.entries(inputPaths)) {
      if (!path) continue
      const cached = cachedBuildFp.inputs[key]
      if (!cached) {
        same = false
        break
      }
      const fresh = await fingerprintInput(path, cached, !cheapInputs.has(key))
      if (fresh.md5 !== cached.md5) {
        same = false
        break
      }
    }
    if (same && existsSync(`${cfg.distDir}/${profileId}/profile.json`)) {
      console.log(`Профиль ${profileId} актуален, входы не изменились. Пересборка не нужна (--force для принудительной).`)
      return
    }
  }

  sweepStagingAndTrash(cfg.distDir)
  const staging = stagingDirFor(cfg.distDir, profileId)
  mkdirSync(staging, { recursive: true })
  console.log(`Сборка профиля ${profileId} в ${staging}...`)

  const t0 = Date.now()
  const summary = await buildReflectionIndex(`${staging}/index.db`, cfg, {
    objectDumpPath,
    usmapPath: usmap!.path,
    uhtDir,
    assetRegistryPath,
    gameVersion: fp.projectVersion,
    engineVersion: detectEngineVersion(usmap!.path),
    exeSize: fp.exeSize,
    exeSha256: fp.exeSha256,
    ue4ssVersion: detectUe4ssVersion(`${cfg.ue4ssDir}/UE4SS.log`),
    dumpCapturedAt: usmap!.capturedAt,
  })

  console.log('Данные игры (сайдкар WwParse: CUE4Parse + .usmap)...')
  const gamedata = await buildGameDataIndex(`${staging}/index.db`, cfg, {
    pakPath: cfg.pakPath,
    usmapPath: usmap!.path,
    jsonlPath: `${cfg.stateDir}/gamedata.jsonl`,
  })
  console.log(`  ${gamedata.meta.sidecar_log}`)

  console.log('Ключевые метрики:')
  const keys = [
    'objects_total',
    'objects_indexed',
    'objects_skipped_by_kind',
    'cdo_skipped',
    'bp_hook_path_from_dump',
    'bp_hook_path_from_registry',
    'bp_unresolved',
    'coverage_bp_ratio',
    'uht_params_merged',
    'uht_out_params',
    'usmap_enums_matched',
    'usmap_filled_types',
    'enum_cross_check_mismatches',
    'registry_assets',
  ]
  for (const k of keys) console.log(`  ${k}: ${summary.meta[k]}`)
  for (const k of ['gamedata_tables', 'gamedata_data_assets', 'gamedata_rows', 'loc_tables', 'loc_entries', 'gamedata_failed_assets']) {
    console.log(`  ${k}: ${gamedata.meta[k]}`)
  }

  const abort = (code: number, phase: string): never => {
    console.error(`Приёмочные критерии ${phase} НЕ выполнены — профиль не опубликован.`)
    console.error(`Прежний профиль остался в силе, черновик: ${staging}`)
    process.exit(code)
  }

  console.log('Приёмочные проверки фазы 1:')
  console.log(`  SetResearchTopic найден с hook_path: ${summary.acceptance.setResearchTopicFound}`)
  console.log(`  startResearch найден (ожидается ЛОЖЬ): ${summary.acceptance.startResearchFound}`)
  console.log(`  MouseMessageBlip_C.Construct hook_path: ${summary.acceptance.mouseBlipHookPath ?? 'НЕТ'}`)
  if (!summary.acceptance.setResearchTopicFound || summary.acceptance.startResearchFound || !summary.acceptance.mouseBlipHookPath) {
    abort(2, 'фазы 1')
  }

  console.log('Приёмочные проверки фазы 3:')
  console.log(`  TechUnlocksV2 строк: ${gamedata.acceptance.techUnlocksRows} (пример ключа: ${gamedata.acceptance.techUnlocksSampleKey ?? 'НЕТ'})`)
  console.log(`  mod.desc.starvation [Ru]: ${gamedata.acceptance.starvationRu ?? 'НЕТ'}`)
  if (gamedata.acceptance.techUnlocksRows === 0 || !gamedata.acceptance.starvationRu) {
    abort(3, 'фазы 3')
  }

  const contract: ProfileContract = {
    profileId,
    gameId: 'whiskerwood',
    gameVersion: fp.projectVersion,
    schemaVersion: INDEX_SCHEMA_VERSION,
    indexRevision: summary.meta.built_at as string,
    builtAt: summary.meta.built_at as string,
    dumpCapturedAt: usmap!.capturedAt,
    typeSourcePrimary: 'uht',
  }
  writeFileSync(`${staging}/profile.json`, JSON.stringify(contract, null, 2))

  let target: string
  try {
    target = await publishStagedProfile(staging, cfg.distDir, profileId)
  } catch (e) {
    if (!(e instanceof ProfileBusyError)) throw e
    console.error(`Индекс собран и проверки прошли, но опубликовать не вышло: ${e.path} занят.`)
    console.error('Каталог держит запущенный MCP-сервер (bun run src/stdio.ts) — Windows не даёт его подменить.')
    console.error('Останови сервер (в Claude Code — /mcp, перезапуск whiskerwood) и повтори bun run setup --force.')
    console.error('Действующий профиль не пострадал.')
    process.exit(4)
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

  const newBuildFp: BuildFingerprint = { schemaVersion: INDEX_SCHEMA_VERSION, profileId, inputs: {} }
  for (const [key, path] of Object.entries(inputPaths)) {
    if (!path) continue
    newBuildFp.inputs[key] = await fingerprintInput(path, cachedBuildFp?.inputs[key], !cheapInputs.has(key))
  }
  writeFileSync(fpPath, JSON.stringify(newBuildFp, null, 2))

  console.log(`Готово за ${elapsed}с: ${target}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

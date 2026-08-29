import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { ConfigError, loadConfig, validateConfig } from '../config'
import { ProfileContract } from '../contract'
import { INDEX_SCHEMA_VERSION } from '../schema'
import { ensureFingerprint } from '../utils/game-fingerprint'
import { publishStagedProfile, stagingDirFor, sweepStagingAndTrash } from '../utils/profile-publish'
import { profileIdFor } from '../contract'
import { buildReflectionIndex } from './index-reflection'

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

async function fingerprintInput(path: string, cached?: InputFingerprint): Promise<InputFingerprint> {
  const st = statSync(path)
  const size = Number(st.size)
  const mtimeMs = st.mtimeMs
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
    return { size, mtimeMs, md5: cached.md5 }
  }
  return { size, mtimeMs, md5: await md5OfFile(path) }
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
  const oldDumpPath = `${cfg.dumpsDir}/GObjects-Dump-WithProperties.txt`
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

  const profileId = profileIdFor(fp.projectVersion)
  const fpPath = `${cfg.stateDir}/build-fingerprint.json`
  const cachedBuildFp: BuildFingerprint | null = existsSync(fpPath)
    ? (JSON.parse(readFileSync(fpPath, 'utf8')) as BuildFingerprint)
    : null

  const inputPaths: Record<string, string> = {
    objectDump: objectDumpPath,
    usmap: usmap!.path,
    assetRegistry: assetRegistryPath,
    oldDump: existsSync(oldDumpPath) ? oldDumpPath : '',
  }

  if (!force && cachedBuildFp && cachedBuildFp.profileId === profileId && cachedBuildFp.schemaVersion === INDEX_SCHEMA_VERSION) {
    let same = true
    for (const [key, path] of Object.entries(inputPaths)) {
      if (!path) continue
      const cached = cachedBuildFp.inputs[key]
      if (!cached) {
        same = false
        break
      }
      const fresh = await fingerprintInput(path, cached)
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
    oldDumpPath: existsSync(oldDumpPath) ? oldDumpPath : null,
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

  const target = await publishStagedProfile(staging, cfg.distDir, profileId)
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

  const newBuildFp: BuildFingerprint = { schemaVersion: INDEX_SCHEMA_VERSION, profileId, inputs: {} }
  for (const [key, path] of Object.entries(inputPaths)) {
    if (!path) continue
    newBuildFp.inputs[key] = await fingerprintInput(path, cachedBuildFp?.inputs[key])
  }
  writeFileSync(fpPath, JSON.stringify(newBuildFp, null, 2))

  console.log(`Готово за ${elapsed}с: ${target}`)
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

  console.log('Приёмочные проверки фазы 1:')
  console.log(`  SetResearchTopic найден с hook_path: ${summary.acceptance.setResearchTopicFound}`)
  console.log(`  startResearch найден (ожидается ЛОЖЬ): ${summary.acceptance.startResearchFound}`)
  console.log(`  MouseMessageBlip_C.Construct hook_path: ${summary.acceptance.mouseBlipHookPath ?? 'НЕТ'}`)
  if (!summary.acceptance.setResearchTopicFound || summary.acceptance.startResearchFound || !summary.acceptance.mouseBlipHookPath) {
    console.error('Приёмочные критерии фазы 1 НЕ выполнены')
    process.exit(2)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

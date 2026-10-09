import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname } from 'node:path'
import { ServerConfig } from '../config'
import { renderAiText, Scalar } from '../utils/ai-text'
import { activeJob, cancelJob, jobProgress, JobRecord, listJobs, readJob, startJob, updateJob } from '../utils/jobs'
import { findEditorProcess, kitEngineVersion, KitPaths, kitStatus, runUatBat, savedModsDir, savedModsSandbox } from '../utils/kit'
import { failureDetail, unrealPakList } from '../utils/loom'
import { PathSandboxError } from '../utils/path-sandbox'

export interface LoomInstallArgs {
  action: 'start' | 'status' | 'install' | 'cancel'
  mod_name?: string
  job_id?: string
  skip_cook?: boolean
  version?: string
}

const REPORT_TYPE = 'loom_install'
const MOD_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
export const PAK_LIMIT_BYTES = 123_999_999
const NEXT_RESTART = 'ww_game_process restart save=<сохранение> wait_for=world — pak-мод подхватывается только при старте игры'

const MOUNT_RE = /Listing .* with mount point "(.*)"/
const ENTRY_RE = /^LogPakFile: Display: "(.+)" offset: \d+, size: \d+ bytes/

function report(fields: Record<string, Scalar>, blocks?: Record<string, string>): string {
  return renderAiText({ reportType: REPORT_TYPE, fields, results: blocks ? [{ fields: {}, blocks }] : undefined })
}

function norm(p: string): string {
  return p.replace(/\\/g, '/')
}

function segments(p: string): string[] {
  return norm(p)
    .split('/')
    .filter((s) => s.length > 0 && s !== '.' && s !== '..')
}

function hasRun(segs: string[], run: string[]): boolean {
  outer: for (let i = 0; i + run.length <= segs.length; i++) {
    for (let j = 0; j < run.length; j++) {
      if (segs[i + j].toLowerCase() !== run[j].toLowerCase()) continue outer
    }
    return true
  }
  return false
}

function isOurPath(full: string[], modName: string): boolean {
  return hasRun(full, ['Content', 'Mods', modName]) || hasRun(full, ['Game', 'Mods', modName])
}

interface ModSource {
  dir: string
  upluginPath: string
  engineVersion: string | null
  palPath: string | null
}

type ModSourceResult = { ok: true; source: ModSource } | { ok: false; status: string; fields: Record<string, Scalar>; hint: string }

function readModSource(kit: KitPaths, modName: string): ModSourceResult {
  const dir = `${kit.contentMods}/${modName}`
  if (!existsSync(dir)) {
    let names: string[] = []
    try {
      names = readdirSync(kit.contentMods, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .slice(0, 30)
    } catch {}
    return {
      ok: false,
      status: 'mod_folder_missing',
      fields: { mod: modName, content_mods: kit.contentMods, mods_found: names.join(', ') || 'нет' },
      hint: `нет каталога ${dir}; имя мода — это имя папки в <кит>/Content/Mods`,
    }
  }

  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {}

  const upluginPath = `${dir}/${modName}.uplugin`
  if (!existsSync(upluginPath)) {
    const found = entries.filter((f) => f.toLowerCase().endsWith('.uplugin'))
    return {
      ok: false,
      status: 'uplugin_missing',
      fields: { mod: modName, mod_dir: dir, uplugins_found: found.join(', ') || 'нет' },
      hint: `нет ${modName}.uplugin: папка, .uplugin и .pak обязаны носить одно имя`,
    }
  }

  let engineVersion: string | null = null
  try {
    const raw = readFileSync(upluginPath, 'utf8').replace(/^\uFEFF/, '')
    const json = JSON.parse(raw) as { EngineVersion?: unknown }
    engineVersion = typeof json.EngineVersion === 'string' ? json.EngineVersion : null
  } catch (e) {
    return {
      ok: false,
      status: 'uplugin_broken',
      fields: { mod: modName, uplugin: upluginPath, error: (e as Error).message },
      hint: 'исправь .uplugin: это JSON, кит пишет его через Mod Tools',
    }
  }

  const palName = `PAL_${modName}.uasset`
  return {
    ok: true,
    source: {
      dir,
      upluginPath,
      engineVersion,
      palPath: entries.includes(palName) ? `${dir}/${palName}` : null,
    },
  }
}

interface PakFile {
  file: string
  name: string
  chunk: number | null
  bytes: number
  mtimeMs: number
  big: boolean
}

function pakFiles(kit: KitPaths): PakFile[] {
  let names: string[]
  try {
    names = readdirSync(kit.pakOutputDir)
  } catch {
    return []
  }
  const out: PakFile[] = []
  for (const name of names) {
    const m = /^pakchunk(\d+)-Windows\.pak$/i.exec(name)
    if (!m) continue
    try {
      const st = statSync(`${kit.pakOutputDir}/${name}`)
      out.push({
        file: norm(`${kit.pakOutputDir}/${name}`),
        name,
        chunk: Number(m[1]),
        bytes: st.size,
        mtimeMs: st.mtimeMs,
        big: st.size >= PAK_LIMIT_BYTES,
      })
    } catch {}
  }
  return out.sort((a, b) => Number(a.big) - Number(b.big) || a.bytes - b.bytes)
}

export interface PakProbe {
  file: string
  name: string
  chunk: number | null
  bytes: number
  mtimeMs: number
  mountPoint: string
  entries: number
  samples: string[]
  ours: number
  foreign: number
  foreignSamples: string[]
  dedicated: boolean
  holds: boolean
  error: string | null
}

/** Разбор одного пака: mount point, число файлов и сколько из них принадлежат моду. */
export async function probePak(kit: KitPaths, modName: string, file: string, chunk: number | null): Promise<PakProbe> {
  const st = statSync(file)
  const probe: PakProbe = {
    file: norm(file),
    name: basename(file),
    chunk,
    bytes: st.size,
    mtimeMs: st.mtimeMs,
    mountPoint: '',
    entries: 0,
    samples: [],
    ours: 0,
    foreign: 0,
    foreignSamples: [],
    dedicated: false,
    holds: false,
    error: null,
  }

  // Список читается потоком: у pakchunk0 он на мегабайты, и хвост вывода обрезается в runExternal.
  const res = await unrealPakList(kit, probe.file, {
    timeoutMs: 120_000,
    onLine: (line) => {
      if (probe.mountPoint.length === 0) {
        const m = MOUNT_RE.exec(line)
        if (m) probe.mountPoint = m[1]
      }
      const e = ENTRY_RE.exec(line)
      if (!e) return
      probe.entries++
      if (probe.samples.length < 5) probe.samples.push(e[1])
      const full = [...segments(probe.mountPoint), ...segments(e[1])]
      if (isOurPath(full, modName)) probe.ours++
      else {
        probe.foreign++
        if (probe.foreignSamples.length < 5) probe.foreignSamples.push(full.join('/'))
      }
    },
  })

  if (res.outcome !== 'ok') probe.error = `${res.outcome}: ${failureDetail(res)}`
  probe.dedicated = hasRun(segments(probe.mountPoint), ['Content', 'Mods', modName])
  probe.holds = probe.dedicated || probe.ours > 0
  return probe
}

interface ChunkCache {
  mod: string
  chunk: number | null
  pak: string
  bytes: number
  at: number
}

function chunkCachePath(config: ServerConfig, modName: string): string {
  return norm(`${config.jobsDir}/chunk-${modName}.cache`)
}

function readChunkCache(config: ServerConfig, modName: string): ChunkCache | null {
  try {
    return JSON.parse(readFileSync(chunkCachePath(config, modName), 'utf8')) as ChunkCache
  } catch {
    return null
  }
}

function writeChunkCache(config: ServerConfig, modName: string, probe: PakProbe): void {
  try {
    mkdirSync(config.jobsDir, { recursive: true })
    const rec: ChunkCache = { mod: modName, chunk: probe.chunk, pak: probe.file, bytes: probe.bytes, at: Date.now() }
    writeFileSync(chunkCachePath(config, modName), JSON.stringify(rec, null, 1))
  } catch {}
}

interface PakSearch {
  paks: PakFile[]
  probes: PakProbe[]
  best: PakProbe | null
  others: PakProbe[]
  oversizeSkipped: number
}

async function findModPak(config: ServerConfig, kit: KitPaths, modName: string, remember: boolean): Promise<PakSearch> {
  const all = pakFiles(kit)
  const cached = readChunkCache(config, modName)
  const ordered = [...all]
  if (cached && cached.chunk !== null) {
    const i = ordered.findIndex((p) => p.chunk === cached.chunk && !p.big)
    if (i > 0) ordered.unshift(...ordered.splice(i, 1))
  }

  const probes: PakProbe[] = []
  let best: PakProbe | null = null
  let oversizeSkipped = 0

  for (const p of ordered) {
    if (p.big && best && best.dedicated) {
      oversizeSkipped++
      continue
    }
    const probe = await probePak(kit, modName, p.file, p.chunk)
    probes.push(probe)
    if (probe.error || !probe.holds) continue
    const better =
      !best ||
      (probe.dedicated && !best.dedicated) ||
      (probe.dedicated === best.dedicated && probe.mtimeMs > best.mtimeMs)
    if (better) best = probe
  }

  if (best && remember) writeChunkCache(config, modName, best)
  return { paks: all, probes, best, others: probes.filter((p) => p.holds && p !== best), oversizeSkipped }
}

function probeSummary(probes: PakProbe[]): string {
  return probes
    .map((p) => `${p.name}: ${p.error ? `ошибка листинга (${p.error})` : `файлов ${p.entries}, мода ${p.ours}, mount "${p.mountPoint}"`}`)
    .join('\n')
}

type TargetResult = { ok: true; dir: string } | { ok: false; status: string; fields: Record<string, Scalar>; hint: string }

const SAVED_MODS_HINT = 'каталог модов игры недоступен: проверь savedDir в конфиге'

/** Без create ничего не создаёт: status лишь смотрит, куда легла бы установка. */
function resolveTarget(config: ServerConfig, modName: string, create: boolean): TargetResult {
  const root = savedModsDir(config)
  if (!create && !existsSync(root)) return { ok: true, dir: norm(`${root}/${modName}`) }
  try {
    if (create) mkdirSync(root, { recursive: true })
  } catch (e) {
    return { ok: false, status: 'saved_mods_unavailable', fields: { saved_mods: root, error: (e as Error).message }, hint: SAVED_MODS_HINT }
  }

  let real: string
  try {
    real = realpathSync(root)
  } catch (e) {
    return { ok: false, status: 'saved_mods_unavailable', fields: { saved_mods: root, error: (e as Error).message }, hint: SAVED_MODS_HINT }
  }

  let dir: string
  try {
    dir = savedModsSandbox(config).validateAndResolve(`${root}/${modName}`)
  } catch (e) {
    if (e instanceof PathSandboxError) {
      return {
        ok: false,
        status: 'target_outside_sandbox',
        fields: { mod: modName, saved_mods: root },
        hint: 'установка пишет только в <saved>/mods/<Мод>',
      }
    }
    throw e
  }

  const parent = norm(dirname(dir)).toLowerCase()
  if (parent !== norm(real).toLowerCase() || basename(dir).toLowerCase() !== modName.toLowerCase()) {
    return {
      ok: false,
      status: 'target_not_mod_folder',
      fields: { mod: modName, resolved: norm(dir), expected_parent: norm(real) },
      hint: 'цель обязана быть ровно папкой текущего мода внутри <saved>/mods',
    }
  }
  return { ok: true, dir: norm(dir) }
}

function backupExisting(config: ServerConfig, targetDir: string, modName: string): string | null {
  let files: string[] = []
  try {
    files = readdirSync(targetDir)
  } catch {
    return null
  }
  if (files.length === 0) return null
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = norm(`${config.stateDir}/backup/${modName}-${ts}`)
  try {
    mkdirSync(dest, { recursive: true })
    cpSync(targetDir, dest, { recursive: true })
    return dest
  } catch {
    return null
  }
}

const COMPARE_CHUNK = 1 << 20

function sameFile(a: string, b: string): boolean {
  let fa: number | null = null
  let fb: number | null = null
  try {
    const size = statSync(a).size
    if (size !== statSync(b).size) return false
    fa = openSync(a, 'r')
    fb = openSync(b, 'r')
    const ba = Buffer.allocUnsafe(COMPARE_CHUNK)
    const bb = Buffer.allocUnsafe(COMPARE_CHUNK)
    for (let pos = 0; pos < size; ) {
      const n = Math.min(COMPARE_CHUNK, size - pos)
      if (readSync(fa, ba, 0, n, pos) !== n || readSync(fb, bb, 0, n, pos) !== n) return false
      if (ba.compare(bb, 0, n, 0, n) !== 0) return false
      pos += n
    }
    return true
  } catch {
    return false
  } finally {
    if (fa !== null) closeSync(fa)
    if (fb !== null) closeSync(fb)
  }
}

type InstalledState = 'absent' | 'match' | 'differs'

function installedState(targetDir: string, modName: string, probe: PakProbe, source: ModSource): InstalledState {
  const pak = `${targetDir}/${modName}.pak`
  const uplugin = `${targetDir}/${modName}.uplugin`
  if (!existsSync(pak) && !existsSync(uplugin)) return 'absent'
  return sameFile(probe.file, pak) && sameFile(source.upluginPath, uplugin) ? 'match' : 'differs'
}

interface InstallResult {
  fields: Record<string, Scalar>
  blocks?: Record<string, string>
}

function checkPak(kit: KitPaths, modName: string, source: ModSource, probe: PakProbe, base: Record<string, Scalar>): InstallResult | null {
  if (probe.foreign > 0) {
    return {
      fields: {
        status: 'pak_has_foreign_assets',
        ...base,
        mod_entries: probe.ours,
        foreign_entries: probe.foreign,
        limit_bytes: PAK_LIMIT_BYTES,
        hint:
          `в паке ${probe.foreign} чужих файлов, он не выделен моду. Обычно это отсутствие PAL_${modName}.uasset с ChunkId: ` +
          `ассеты уезжают в общий pakchunk0 вместе со всем китом. Создай PAL в редакторе (Mod Tools → New mod… / правый клик по папке мода) и повтори cook`,
      },
      blocks: { foreign_samples: probe.foreignSamples.join('\n') },
    }
  }

  if (probe.bytes >= PAK_LIMIT_BYTES) {
    return {
      fields: {
        status: 'pak_too_large',
        ...base,
        limit_bytes: PAK_LIMIT_BYTES,
        hint: `пак ${probe.bytes} байт не пройдёт лимит загрузчика ${PAK_LIMIT_BYTES} байт: убери из папки мода лишние ассеты или вынеси их в отдельный мод`,
      },
    }
  }

  const expectedVersion = kitEngineVersion(kit)
  if (!source.engineVersion) {
    return {
      fields: {
        status: 'engine_version_missing',
        ...base,
        uplugin: source.upluginPath,
        engine_version_expected: expectedVersion,
        hint: `.uplugin без EngineVersion — так писали моды старого кита (5.6); перезапиши его через Mod Tools на ${expectedVersion}`,
      },
    }
  }
  if (source.engineVersion.trim() !== expectedVersion) {
    return {
      fields: {
        status: 'engine_version_mismatch',
        ...base,
        uplugin: source.upluginPath,
        engine_version: source.engineVersion,
        engine_version_expected: expectedVersion,
        hint: `EngineVersion в .uplugin — ${source.engineVersion}, а движок кита ${expectedVersion}`,
      },
    }
  }
  return null
}

function wwoffPresent(targetDir: string, modName: string): boolean {
  return existsSync(`${targetDir}/${modName}.pak.wwoff`) || existsSync(`${targetDir}/${modName}.wwoff`)
}

function otherPaks(targetDir: string, modName: string): string[] {
  try {
    return readdirSync(targetDir).filter((f) => f.toLowerCase().endsWith('.pak') && f !== `${modName}.pak`)
  } catch {
    return []
  }
}

type Mode = 'check' | 'install'

/** check только читает; install копирует, если в <saved>/mods лежит не то. */
async function settle(
  config: ServerConfig,
  kit: KitPaths,
  modName: string,
  source: ModSource,
  probe: PakProbe,
  mode: Mode,
  installNext: string,
  extra: Record<string, Scalar> = {},
): Promise<InstallResult> {
  const base: Record<string, Scalar> = {
    mod: modName,
    chunk: probe.chunk ?? -1,
    pak_name: probe.name,
    pak_source: probe.file,
    pak_bytes: probe.bytes,
    pak_entries: probe.entries,
    mount_point: probe.mountPoint,
    dedicated_chunk: probe.dedicated,
    ...extra,
  }

  const failed = checkPak(kit, modName, source, probe, base)
  if (failed) return failed

  const checks: Record<string, Scalar> = {
    engine_version: source.engineVersion ?? '',
    foreign_entries: 0,
    size_ok: true,
    names_ok: true,
  }
  const palWarning: Record<string, Scalar> = source.palPath
    ? {}
    : { warning: `нет PAL_${modName}.uasset — ассеты могут уезжать в общий чанк при следующем cook` }

  const target = resolveTarget(config, modName, mode === 'install')
  if (!target.ok) return { fields: { status: target.status, ...base, ...target.fields, hint: target.hint } }
  const targetDir = target.dir
  const pakTarget = norm(`${targetDir}/${modName}.pak`)
  const upluginTarget = norm(`${targetDir}/${modName}.uplugin`)
  const others = otherPaks(targetDir, modName)
  const state = installedState(targetDir, modName, probe, source)

  if (state === 'match') {
    return {
      fields: {
        status: mode === 'install' ? 'already_installed' : 'installed',
        ...base,
        target_dir: targetDir,
        pak_target: pakTarget,
        uplugin_target: upluginTarget,
        ...checks,
        installed: 'match',
        note: '.pak и .uplugin в <saved>/mods совпадают с собранными побайтно — копировать нечего',
        ...(others.length > 0 ? { other_paks: others.join(', ') } : {}),
        ...(wwoffPresent(targetDir, modName) ? { wwoff_present: true } : {}),
        ...palWarning,
        next: NEXT_RESTART,
      },
    }
  }

  if (mode === 'check') {
    return {
      fields: {
        status: 'ready_to_install',
        ...base,
        target_dir: targetDir,
        ...checks,
        installed: state,
        ...(state === 'differs' ? { note: 'в <saved>/mods лежит другая версия: install сохранит её в state/backup и заменит' } : {}),
        ...(others.length > 0 ? { other_paks: others.join(', ') } : {}),
        ...palWarning,
        next: `${installNext} — копирует .pak и .uplugin в ${targetDir}`,
      },
    }
  }

  const backup = backupExisting(config, targetDir, modName)
  try {
    mkdirSync(targetDir, { recursive: true })
    copyFileSync(probe.file, pakTarget)
    copyFileSync(source.upluginPath, upluginTarget)
  } catch (e) {
    return {
      fields: {
        status: 'copy_failed',
        ...base,
        target_dir: targetDir,
        error: (e as Error).message,
        ...(backup ? { backup } : {}),
        hint: 'игра может держать .pak открытым: закрой её и повтори',
      },
    }
  }

  const written = statSync(pakTarget).size
  if (written !== probe.bytes) {
    return {
      fields: {
        status: 'copy_verify_failed',
        ...base,
        pak_target: pakTarget,
        pak_bytes_written: written,
        hint: 'размер скопированного пака не совпал с исходным, установка неполная',
      },
    }
  }

  return {
    fields: {
      status: 'installed',
      ...base,
      target_dir: targetDir,
      pak_target: pakTarget,
      uplugin_source: source.upluginPath,
      uplugin_target: upluginTarget,
      ...checks,
      replaced: state === 'differs',
      ...(backup ? { backup } : {}),
      ...(others.length > 0 ? { other_paks: others.join(', ') } : {}),
      ...(wwoffPresent(targetDir, modName) ? { wwoff_present: true } : {}),
      ...palWarning,
      next: NEXT_RESTART,
    },
  }
}

function pakNotFoundReport(kit: KitPaths, modName: string, search: PakSearch, extra: Record<string, Scalar> = {}): string {
  const probed = search.probes.length
  const cooked = extra.cook === 'done'
  return report(
    {
      status: 'pak_not_found',
      mod: modName,
      ...extra,
      paks_dir: kit.pakOutputDir,
      paks_total: search.paks.length,
      paks_probed: probed,
      oversize_skipped: search.oversizeSkipped,
      limit_bytes: PAK_LIMIT_BYTES,
      hint: cooked
        ? `cook прошёл, но пака мода нет: проверь PAL_${modName}.uasset и что cook не отфильтровал папку мода`
        : probed === 0
          ? `в ${kit.pakOutputDir} нет ни одного pakchunk<N>-Windows.pak — сначала прогони cook (action=start без skip_cook)`
          : `ни в одном паке нет Content/Mods/${modName}. Если cook был, проверь PAL_${modName}.uasset: без него ассеты попадают в общий чанк, а он больше лимита загрузчика`,
    },
    probed > 0 ? { probes: probeSummary(search.probes) } : undefined,
  )
}

function cookArgs(kit: KitPaths): string[] {
  return [
    'BuildCookRun',
    `-project=${kit.uproject}`,
    '-platform=Win64',
    '-clientconfig=Shipping',
    '-build',
    '-cook',
    '-stage',
    '-pak',
    '-archive',
    `-archivedirectory=${kit.kitDir}`,
    '-nocompileeditor',
    '-installed',
    '-iterativecooking',
    '-cookincremental',
    '-nop4',
    '-utf8output',
    '-unattended',
    '-WaitForUATMutex',
  ]
}

const COOK_LABEL = 'Cook & Install '

function cookLabel(modName: string): string {
  return `${COOK_LABEL}${modName}`
}

/** Имя мода берём из label: job-runner перезаписывает meta своим снимком и затирает result, записанный после старта. */
function jobModName(job: JobRecord): string | null {
  if (job.label.startsWith(COOK_LABEL)) {
    const name = job.label.slice(COOK_LABEL.length).trim()
    if (name.length > 0) return name
  }
  const mod = job.result?.mod
  return typeof mod === 'string' && mod.length > 0 ? mod : null
}

function cookJobs(config: ServerConfig, modName: string | null): JobRecord[] {
  const want = modName?.toLowerCase() ?? null
  return listJobs(config, 50).filter((j) => j.kind === 'cook' && (want === null || jobModName(j)?.toLowerCase() === want))
}

/** Идущий cook важнее завершённого: иначе свежий джоб другого мода перекроет его. */
function currentCookJob(config: ServerConfig, modName: string | null): JobRecord | null {
  const jobs = cookJobs(config, modName)
  return jobs.find((j) => j.status === 'running') ?? jobs[0] ?? null
}

function runningCookJob(config: ServerConfig, modName: string): JobRecord | null {
  return cookJobs(config, modName).find((j) => j.status === 'running') ?? null
}

function busyReport(config: ServerConfig, job: JobRecord, modName: string): string {
  const p = jobProgress(config, job.id, 5)
  const rebuilding = job.kind === 'cook' && jobModName(job)?.toLowerCase() === modName.toLowerCase()
  return report({
    status: 'busy',
    mod: modName,
    running_job: job.id,
    running_kind: job.kind,
    progress: p?.progress ?? '',
    hint:
      job.kind === 'cook'
        ? `${rebuilding ? 'пак этого мода сейчас пересобирается, ставить и проверять его нельзя' : 'один джоб на кит за раз: cook пишет в pakchunk, ставить и запускать новый нельзя'}. Дождись ww_loom_install action=status job_id=${job.id} или сними через action=cancel job_id=${job.id}`
        : job.kind === 'editor-build'
          ? `в ките идёт сборка Blueprint (${job.id}): дождись ww_loom_build action=status job_id=${job.id} или сними через ww_loom_build action=cancel job_id=${job.id}`
          : job.kind === 'new-mod'
            ? `в ките создаётся мод (${job.id}): дождись ww_loom_new_mod action=status job_id=${job.id}`
            : `в ките идёт джоб ${job.id}: один джоб на кит за раз, дождись его завершения`,
  })
}

type KitResult = { ok: true; kit: KitPaths } | { ok: false; text: string }

function requireKitReport(config: ServerConfig, extra: Record<string, Scalar> = {}): KitResult {
  const st = kitStatus(config)
  if (st.configured && st.kit) return { ok: true, kit: st.kit }
  return {
    ok: false,
    text: report({
      status: 'kit_not_configured',
      problem: st.problem ?? 'кит не настроен',
      ...extra,
      hint: 'укажи kitDir в конфиге (см. /ww-setup): инструменту нужен кит с Whiskerwood.uproject',
    }),
  }
}

function modNameProblem(modName: string): string | null {
  if (modName.length === 0) return report({ status: 'mod_name_required', hint: 'укажи mod_name — имя папки мода в <кит>/Content/Mods' })
  if (!MOD_NAME_RE.test(modName)) {
    return report({
      status: 'bad_mod_name',
      mod: modName,
      hint: 'имя мода: буквы, цифры, . _ - без разделителей пути; оно же имя папки, .uplugin и .pak',
    })
  }
  return null
}

function installCommand(job: JobRecord | null, modName: string): string {
  return job ? `ww_loom_install action=install job_id=${job.id}` : `ww_loom_install action=install mod_name=${modName}`
}

async function settleMod(config: ServerConfig, kit: KitPaths, modName: string, job: JobRecord | null, mode: Mode): Promise<string> {
  const extra: Record<string, Scalar> = job
    ? {
        from: 'cook_job',
        job_id: job.id,
        cook: 'done',
        exit_code: job.exitCode ?? 0,
        cook_s: Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000),
      }
    : { stage: mode === 'install' ? 'install_only' : 'check_only' }

  const src = readModSource(kit, modName)
  if (!src.ok) return report({ status: src.status, ...src.fields, ...extra, hint: src.hint })

  const search = await findModPak(config, kit, modName, mode === 'install')
  if (!search.best) return pakNotFoundReport(kit, modName, search, extra)

  const res = await settle(config, kit, modName, src.source, search.best, mode, installCommand(job, modName), extra)
  if (job && mode === 'install' && res.fields.status === 'installed') {
    updateJob(config, job.id, { result: { ...(job.result ?? {}), install: { ...res.fields, installed_at: new Date().toISOString() } } })
  }
  return report(res.fields, res.blocks)
}

async function startAction(config: ServerConfig, args: LoomInstallArgs): Promise<string> {
  const k = requireKitReport(config)
  if (!k.ok) return k.text
  const kit = k.kit

  const modName = (args.mod_name ?? '').trim()
  const bad = modNameProblem(modName)
  if (bad) return bad

  const src = readModSource(kit, modName)
  if (!src.ok) return report({ status: src.status, ...src.fields, hint: src.hint })

  const running = activeJob(config)
  if (running) return busyReport(config, running, modName)

  if (args.skip_cook) return settleMod(config, kit, modName, null, 'install')

  const bat = runUatBat(kit)
  if (!bat || !existsSync(bat)) {
    return report({
      status: 'runuat_missing',
      kit_dir: kit.kitDir,
      engine_dir: kit.engineDir ?? 'не найден',
      hint: 'RunUAT.bat берётся из движка кита: проверь engineDir и EngineAssociation в .uproject',
    })
  }

  const started = startJob(config, {
    kind: 'cook',
    label: cookLabel(modName),
    cmd: ['cmd', '/c', bat, ...cookArgs(kit)],
    cwd: kit.kitDir,
    project: kit.uproject,
    timeoutMs: 0,
  })
  if (started.status === 'busy' && started.running) return busyReport(config, started.running, modName)
  if (started.status !== 'started' || !started.job) {
    return report({ status: 'job_start_failed', mod: modName, error: started.error ?? 'не удалось запустить job-runner' })
  }

  const id = started.job.id
  return report({
    status: 'cooking',
    mod: modName,
    job_id: id,
    log: started.job.logPath,
    cwd: kit.kitDir,
    pak_output: kit.pakOutputDir,
    ...(src.source.palPath ? {} : { warning: `нет PAL_${modName}.uasset — ассеты уедут в общий pakchunk0, и установка не пройдёт проверку чужих ассетов` }),
    next: `ww_loom_install action=status job_id=${id} — прогресс cook (идёт минуты); при status=ready_to_install — action=install job_id=${id}`,
  })
}

type CookPick = { ok: true; job: JobRecord | null; modArg: string } | { ok: false; text: string }

function pickCookJob(config: ServerConfig, args: LoomInstallArgs, action: string): CookPick {
  const modArg = (args.mod_name ?? '').trim()
  if (!args.job_id) return { ok: true, job: null, modArg }
  const job = readJob(config, args.job_id)
  if (!job) return { ok: false, text: report({ status: 'no_job', job_id: args.job_id, hint: `джоб ${args.job_id} не найден в ${config.jobsDir}: хранятся последние 20 джобов` }) }
  if (job.kind !== 'cook') {
    return {
      ok: false,
      text: report({
        status: 'foreign_job',
        job_id: job.id,
        job_kind: job.kind,
        job_status: job.status,
        hint:
          job.kind === 'editor-build'
            ? `это сборка Blueprint, она принадлежит ww_loom_build: ww_loom_build action=${action === 'cancel' ? 'cancel' : 'status'} job_id=${job.id}`
            : job.kind === 'new-mod'
              ? `это создание мода, оно принадлежит ww_loom_new_mod: ww_loom_new_mod action=${action === 'cancel' ? 'cancel' : 'status'} job_id=${job.id}`
              : `джоб вида ${job.kind} — не cook`,
      }),
    }
  }
  const jobMod = jobModName(job)
  if (modArg && jobMod && jobMod.toLowerCase() !== modArg.toLowerCase()) {
    return {
      ok: false,
      text: report({ status: 'mod_mismatch', job_id: job.id, job_mod: jobMod, mod: modArg, hint: `джоб ${job.id} собирал ${jobMod}, а не ${modArg}: убери mod_name или job_id` }),
    }
  }
  return { ok: true, job, modArg }
}

function unfinishedCookReport(config: ServerConfig, job: JobRecord, modName: string, action: string): string | null {
  const elapsed = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000)
  const mod = modName || 'неизвестен'
  if (job.status === 'running') {
    const p = jobProgress(config, job.id, 20)
    return report(
      {
        status: 'cooking',
        mod,
        job_id: job.id,
        elapsed_s: elapsed,
        log_lines: p?.lines ?? 0,
        progress: p?.progress ?? '',
        ...(action === 'install' ? { note: 'cook ещё идёт: ставить нечего, ничего не скопировано' } : {}),
        next: `ww_loom_install action=status job_id=${job.id}`,
      },
      p ? { log_tail: p.logTail } : undefined,
    )
  }
  if (job.status === 'cancelled') {
    return report({
      status: 'cancelled',
      mod,
      job_id: job.id,
      elapsed_s: elapsed,
      hint: `cook прерван: pakchunk мог остаться недописанным — повтори action=start; что лежит в паке сейчас, покажет action=status mod_name=${modName || '<Мод>'} без job_id`,
    })
  }
  if (job.status === 'failed' || job.status === 'lost') {
    const p = jobProgress(config, job.id, 20)
    return report(
      {
        status: 'cook_failed',
        mod,
        job_id: job.id,
        job_status: job.status,
        exit_code: job.exitCode ?? -1,
        elapsed_s: elapsed,
        error: job.error ?? '',
        next: `хвост лога ниже: RunUAT мог упасть на cook, а мог на сборке; после правки — снова action=start. Пак прошлого удачного cook проверит action=status mod_name=${modName || '<Мод>'} без job_id`,
      },
      p ? { log_tail: p.logTail } : undefined,
    )
  }
  return null
}

/** Без job_id пак берётся как есть, но тот, что сейчас пересобирается, ни проверять, ни ставить нельзя. */
async function builtPakAction(config: ServerConfig, modName: string, mode: Mode): Promise<string> {
  const bad = modNameProblem(modName)
  if (bad) return bad
  const rebuilding = runningCookJob(config, modName)
  if (rebuilding) return busyReport(config, rebuilding, modName)
  if (mode === 'install') {
    const running = activeJob(config)
    if (running) return busyReport(config, running, modName)
  }
  const k = requireKitReport(config)
  if (!k.ok) return k.text
  return settleMod(config, k.kit, modName, null, mode)
}

async function statusAction(config: ServerConfig, args: LoomInstallArgs): Promise<string> {
  const picked = pickCookJob(config, args, 'status')
  if (!picked.ok) return picked.text
  const { modArg } = picked
  if (!picked.job && modArg) return builtPakAction(config, modArg, 'check')

  const job = picked.job ?? currentCookJob(config, null)
  if (!job) {
    return report({
      status: 'no_job',
      hint: 'cook ещё не запускался: action=start mod_name=<Мод>; status mod_name=<Мод> проверит уже собранный пак без cook',
    })
  }

  const modName = jobModName(job) ?? modArg
  const unfinished = unfinishedCookReport(config, job, modName, 'status')
  if (unfinished) return unfinished

  if (!modName) {
    return report({
      status: 'cook_done_no_mod',
      job_id: job.id,
      exit_code: job.exitCode ?? 0,
      hint: `джоб завершён, но мод в нём не записан: status или install с job_id=${job.id} и mod_name=<Мод>`,
    })
  }

  const k = requireKitReport(config, { job_id: job.id })
  if (!k.ok) return k.text
  return settleMod(config, k.kit, modName, job, 'check')
}

async function installAction(config: ServerConfig, args: LoomInstallArgs): Promise<string> {
  const picked = pickCookJob(config, args, 'install')
  if (!picked.ok) return picked.text
  const { job, modArg } = picked

  if (!job) {
    if (modArg) return builtPakAction(config, modArg, 'install')
    const last = currentCookJob(config, null)
    return report({
      status: 'no_job',
      ...(last ? { last_cook_job: last.id, last_cook_status: last.status } : {}),
      hint: 'укажи, что ставить: action=install mod_name=<Мод> — уже собранный пак без оглядки на джобы, action=install job_id=<id> — пак завершённого cook',
    })
  }

  const modName = jobModName(job) ?? modArg
  const unfinished = unfinishedCookReport(config, job, modName, 'install')
  if (unfinished) return unfinished
  const bad = modNameProblem(modName)
  if (bad) return bad

  const running = activeJob(config)
  if (running) return busyReport(config, running, modName)

  const k = requireKitReport(config, { job_id: job.id })
  if (!k.ok) return k.text
  return settleMod(config, k.kit, modName, job, 'install')
}

async function cancelAction(config: ServerConfig, args: LoomInstallArgs): Promise<string> {
  const modArg = (args.mod_name ?? '').trim()
  let job: JobRecord | null
  if (args.job_id) {
    const picked = pickCookJob(config, args, 'cancel')
    if (!picked.ok) return picked.text
    job = picked.job
  } else {
    if (modArg) {
      const bad = modNameProblem(modArg)
      if (bad) return bad
    }
    job = currentCookJob(config, modArg || null)
  }
  if (!job) {
    return report({
      status: 'no_job',
      ...(modArg ? { mod: modArg } : {}),
      hint: args.job_id
        ? `джоб ${args.job_id} не найден в ${config.jobsDir}`
        : modArg
          ? `cook мода ${modArg} не запускался: отменять нечего`
          : 'cook ещё не запускался: отменять нечего',
    })
  }
  if (job.status !== 'running') {
    return report({ status: 'job_not_running', job_id: job.id, job_status: job.status, exit_code: job.exitCode ?? -1, hint: 'отменять нечего: джоб уже завершён' })
  }

  const after = cancelJob(config, job.id)
  await new Promise((r) => setTimeout(r, 1000))
  const st = kitStatus(config)
  const proc = st.kit ? findEditorProcess(st.kit.uproject) : null
  const survived = proc !== null && /-run=cook/i.test(proc.commandLine)
  return report({
    status: survived ? 'cancel_incomplete' : (after?.status ?? 'unknown'),
    job_id: job.id,
    kind: job.kind,
    mod: jobModName(job) ?? 'неизвестен',
    ...(survived && proc ? { hint: `джоб помечен отменённым, но UnrealEditor-Cmd -run=Cook (pid ${proc.pid}) ещё жив: taskkill /T /F /PID ${proc.pid}` } : {}),
    next: 'снято деревом процессов: runner → cmd → RunUAT → UnrealEditor-Cmd. pakchunk мог остаться недописанным — новый cook через action=start',
  })
}

export async function handleLoomInstall(config: ServerConfig, args: LoomInstallArgs): Promise<string> {
  const action = args.action ?? 'status'
  if (action === 'start') return startAction(config, args)
  if (action === 'status') return statusAction(config, args)
  if (action === 'install') return installAction(config, args)
  if (action === 'cancel') return cancelAction(config, args)
  return report({ status: 'unknown_action', action: String(action), hint: 'action: start | status | install | cancel' })
}

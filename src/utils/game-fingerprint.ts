import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { ServerConfig } from '../config'
import { PakReader } from './pak-reader'

export interface GameFingerprint {
  exeSize: number
  exeMtimeMs: number
  pakSize: number
  pakMtimeMs: number
  projectVersion: string
  exeSha256: string
  computedAt: string
}

export class FingerprintError extends Error {}

function fpPath(config: ServerConfig): string {
  return `${config.stateDir}/game-fingerprint.json`
}

export function readCachedFingerprint(config: ServerConfig): GameFingerprint | null {
  const p = fpPath(config)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as GameFingerprint
  } catch {
    return null
  }
}

export interface Level1Result {
  status: 'fresh' | 'stale' | 'no_cache' | 'missing_files'
  detail?: string
}

export function checkFingerprintLevel1(config: ServerConfig): Level1Result {
  const cached = readCachedFingerprint(config)
  if (!cached) return { status: 'no_cache' }

  let exe: { size: number; mtimeMs: number }
  let pak: { size: number; mtimeMs: number }
  try {
    const e = statSync(config.exePath)
    const p = statSync(config.pakPath)
    exe = { size: Number(e.size), mtimeMs: e.mtimeMs }
    pak = { size: Number(p.size), mtimeMs: p.mtimeMs }
  } catch {
    return { status: 'missing_files', detail: 'exe или пак недоступны' }
  }

  if (
    exe.size === cached.exeSize &&
    exe.mtimeMs === cached.exeMtimeMs &&
    pak.size === cached.pakSize &&
    pak.mtimeMs === cached.pakMtimeMs
  ) {
    return { status: 'fresh' }
  }
  return { status: 'stale', detail: 'size/mtime exe или пака расходятся с кэшем' }
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = Bun.file(path).stream()
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

export function readProjectVersionFromPak(pakPath: string): string {
  const pak = new PakReader(pakPath)
  try {
    const ini = pak.readText('Whiskerwood/Config/DefaultGame.ini')
    const m = /^ProjectVersion=(.*)$/m.exec(ini)
    if (!m) throw new FingerprintError('в DefaultGame.ini нет ProjectVersion')
    return m[1].trim()
  } finally {
    pak.close()
  }
}

export async function recomputeFingerprintLevel2(config: ServerConfig): Promise<GameFingerprint> {
  const exeStat = statSync(config.exePath)
  const pakStat = statSync(config.pakPath)
  const projectVersion = readProjectVersionFromPak(config.pakPath)
  const exeSha256 = await sha256OfFile(config.exePath)
  const fp: GameFingerprint = {
    exeSize: Number(exeStat.size),
    exeMtimeMs: exeStat.mtimeMs,
    pakSize: Number(pakStat.size),
    pakMtimeMs: pakStat.mtimeMs,
    projectVersion,
    exeSha256,
    computedAt: new Date().toISOString(),
  }
  mkdirSync(config.stateDir, { recursive: true })
  writeFileSync(fpPath(config), JSON.stringify(fp, null, 2))
  return fp
}

export async function ensureFingerprint(config: ServerConfig): Promise<GameFingerprint> {
  const l1 = checkFingerprintLevel1(config)
  if (l1.status === 'fresh') return readCachedFingerprint(config)!
  return recomputeFingerprintLevel2(config)
}

export function assertProfileMatchesGame(fingerprint: GameFingerprint, profileGameVersion: string): void {
  if (fingerprint.projectVersion === profileGameVersion) return
  throw new FingerprintError(
    [
      `игра обновилась: установленная версия ${fingerprint.projectVersion}, профиль индекса собран для ${profileGameVersion}.`,
      'Индекс устарел и может отдавать несуществующие сигнатуры. Пересборка (делает человек):',
      '1. Запустить игру с включённым AutoDump (mods.txt: AutoDump : 1)',
      '2. Загрузить сохранение и дождаться в UE4SS.log строк "DumpUSMAP done ok=true" и "UHT headers done"',
      '3. Выйти из игры',
      '4. bun run setup',
    ].join('\n'),
  )
}

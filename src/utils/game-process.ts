import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { ServerConfig } from '../config'
import { BridgeClient } from './bridge-client'
import { modlogPath } from './kit'
import { isLevelLoaded } from '../tools/bridge-common'

export interface ProcInfo {
  pid: number
  startedAt: number
  memMb: number
  responding: boolean
}

export interface ProcessState {
  pid?: number
  launchedAt?: number
  stopRequestedAt?: number
  save?: string
  logArchive?: string
  modlogOffset?: number
}

export type WaitTarget = 'none' | 'process' | 'bridge' | 'menu' | 'world'

export interface WaitResult {
  reached: boolean
  status: 'reached' | 'timeout' | 'process_gone'
  waitedMs: number
  world: string
}

const LOG_KEEP = 10
const KILL_WAIT_MS = 15_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function ps(script: string): string {
  const p = Bun.spawnSync(['powershell', '-NoProfile', '-NonInteractive', '-Command', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return new TextDecoder().decode(p.stdout).trim()
}

export function processName(config: ServerConfig): string {
  return basename(config.exePath)
}

export function findGameProcess(config: ServerConfig): ProcInfo | null {
  const name = processName(config).replace(/\.exe$/i, '')
  const out = ps(
    `$p = Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1; ` +
      `if ($p) { $t = 0; try { $t = [int64](New-TimeSpan -Start ([datetime]'1970-01-01') -End $p.StartTime.ToUniversalTime()).TotalMilliseconds } catch {}; ` +
      `[Console]::Out.Write(('{0};{1};{2};{3}' -f $p.Id, $t, $p.WorkingSet64, $p.Responding)) }`,
  )
  if (!out) return null
  const [pid, started, mem, resp] = out.split(';')
  const id = Number(pid)
  if (!Number.isFinite(id) || id <= 0) return null
  return {
    pid: id,
    startedAt: Number(started) || 0,
    memMb: Math.round((Number(mem) || 0) / 1048576),
    responding: /true/i.test(resp ?? ''),
  }
}

export function isSteamRunning(): boolean {
  return ps(`if (Get-Process -Name 'steam' -ErrorAction SilentlyContinue) { [Console]::Out.Write('yes') }`) === 'yes'
}

export function killGame(config: ServerConfig): boolean {
  const p = Bun.spawnSync(['taskkill', '/F', '/T', '/IM', processName(config)], { stdout: 'pipe', stderr: 'pipe' })
  return p.exitCode === 0
}

export async function waitProcessGone(config: ServerConfig): Promise<boolean> {
  const deadline = Date.now() + KILL_WAIT_MS
  while (Date.now() < deadline) {
    if (!findGameProcess(config)) return true
    await sleep(400)
  }
  return findGameProcess(config) === null
}

let cachedAppId: string | null = null

export function resolveAppId(config: ServerConfig): string {
  if (config.steamAppId) return config.steamAppId
  if (cachedAppId !== null) return cachedAppId
  cachedAppId = ''
  const steamApps = dirname(dirname(config.gameDir))
  const installDir = basename(config.gameDir).toLowerCase()
  try {
    for (const f of readdirSync(steamApps)) {
      if (!/^appmanifest_\d+\.acf$/i.test(f)) continue
      const text = readFileSync(`${steamApps}/${f}`, 'utf8')
      const dir = /"installdir"\s+"([^"]+)"/i.exec(text)?.[1] ?? ''
      if (dir.toLowerCase() === installDir) {
        cachedAppId = /"appid"\s+"(\d+)"/i.exec(text)?.[1] ?? /(\d+)/.exec(f)?.[1] ?? ''
        break
      }
    }
  } catch {
    cachedAppId = ''
  }
  return cachedAppId
}

export function launchViaSteam(config: ServerConfig, args: string[]): { ok: boolean; url: string; error?: string } {
  const appId = resolveAppId(config)
  if (!appId) {
    return {
      ok: false,
      url: '',
      error: `не удалось определить Steam AppID по ${dirname(dirname(config.gameDir))}; задайте "steamAppId" в wwmcp.config.json`,
    }
  }
  const url =
    args.length > 0 ? `steam://run/${appId}//${encodeURIComponent(args.join(' '))}` : `steam://rungameid/${appId}`
  try {
    Bun.spawn(['cmd', '/c', 'start', '', url], { stdout: 'ignore', stderr: 'ignore' }).unref()
    return { ok: true, url }
  } catch (e) {
    return { ok: false, url, error: (e as Error).message }
  }
}

export function rotateLog(config: ServerConfig): string {
  const path = `${config.ue4ssDir}/UE4SS.log`
  if (!existsSync(path)) return ''
  const dir = `${config.stateDir}/logs`
  mkdirSync(dir, { recursive: true })
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '')
  const dest = `${dir}/UE4SS-${ts}.log`
  try {
    renameSync(path, dest)
  } catch {
    return ''
  }
  const old = readdirSync(dir)
    .filter((f) => f.startsWith('UE4SS-'))
    .sort()
  for (const f of old.slice(0, Math.max(0, old.length - LOG_KEEP))) {
    try {
      rmSync(`${dir}/${f}`)
    } catch {}
  }
  return dest
}

function statePath(config: ServerConfig): string {
  return `${config.stateDir}/game-process.json`
}

// modlog принадлежит игре и только растёт: сессию отрезает офсет, снятый до старта
export function modlogSize(config: ServerConfig): number {
  try {
    return statSync(modlogPath(config)).size
  } catch {
    return 0
  }
}

export function readState(config: ServerConfig): ProcessState {
  try {
    return JSON.parse(readFileSync(statePath(config), 'utf8')) as ProcessState
  } catch {
    return {}
  }
}

export function writeState(config: ServerConfig, patch: ProcessState): ProcessState {
  const next = { ...readState(config), ...patch }
  try {
    mkdirSync(config.stateDir, { recursive: true })
    writeFileSync(statePath(config), JSON.stringify(next, null, 2))
  } catch {}
  return next
}

/** Каталог UE-краша (UECC-*): CrashContext.runtime-xml и/или минидамп. Служебные папки вроде wwguard сюда не попадают. */
function isUeCrashDir(dir: string): boolean {
  try {
    return readdirSync(dir).some((f) => f === 'CrashContext.runtime-xml' || f.toLowerCase().endsWith('.dmp'))
  } catch {
    return false
  }
}

export function lastCrashDump(config: ServerConfig, sinceMs: number): { path: string; at: string } | null {
  const dir = `${dirname(config.saveDir)}/Crashes`
  let best: { path: string; at: number } | null = null
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  for (const f of names) {
    const full = `${dir}/${f}`
    try {
      const st = statSync(full)
      if (!st.isDirectory() || st.mtimeMs < sinceMs || (best && st.mtimeMs <= best.at)) continue
      if (!isUeCrashDir(full)) continue
      best = { path: full, at: st.mtimeMs }
    } catch {}
  }
  return best ? { path: best.path, at: new Date(best.at).toISOString() } : null
}

export interface SaveEntry {
  name: string
  sizeMb: number
  savedAt: string
  savedAtMs: number
  autosave: boolean
}

export function listSaves(config: ServerConfig): SaveEntry[] {
  let files: string[]
  try {
    files = readdirSync(config.saveDir)
  } catch {
    return []
  }
  const out: SaveEntry[] = []
  for (const f of files) {
    if (!f.toLowerCase().endsWith('.whisker')) continue
    const st = statSync(`${config.saveDir}/${f}`)
    const name = f.replace(/\.whisker$/i, '')
    out.push({
      name,
      sizeMb: Math.round((st.size / 1048576) * 10) / 10,
      savedAt: new Date(st.mtimeMs).toISOString(),
      savedAtMs: st.mtimeMs,
      autosave: /_autosave$/i.test(name),
    })
  }
  return out.sort((a, b) => b.savedAtMs - a.savedAtMs)
}

export function findSave(config: ServerConfig, name: string): SaveEntry | null {
  const needle = name.replace(/\.whisker$/i, '').toLowerCase()
  return listSaves(config).find((s) => s.name.toLowerCase() === needle) ?? null
}

function luaString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// EArcoGameType.SAVE_FILE=2, ESaveLocation.SAVED_GAMES=1
export function enterPlayChunk(saveName: string): string {
  return [
    'local gi = FindFirstOf("ArcoGameInstance")',
    'if not gi or not gi:IsValid() then return "no_game_instance" end',
    `gi:EnterPlay(gi, ${luaString(saveName)}, 2, 1, false)`,
    'return "enter_play_sent"',
  ].join('\n')
}

export async function waitFor(
  config: ServerConfig,
  bridge: BridgeClient,
  target: WaitTarget,
  timeoutMs: number,
): Promise<WaitResult> {
  const t0 = Date.now()
  if (target === 'none') return { reached: true, status: 'reached', waitedMs: 0, world: '' }

  const deadline = t0 + timeoutMs
  let procSeen = false
  let lastProcCheck = 0

  while (Date.now() < deadline) {
    const now = Date.now()
    if (now - lastProcCheck > 1500) {
      lastProcCheck = now
      const proc = findGameProcess(config)
      if (proc) procSeen = true
      else if (procSeen) return { reached: false, status: 'process_gone', waitedMs: now - t0, world: '' }
      if (target === 'process' && proc) return { reached: true, status: 'reached', waitedMs: now - t0, world: '' }
    }

    if (target !== 'process') {
      const st = await bridge.readStatusStable()
      if (bridge.isAlive(st)) {
        const world = st!.world
        if (target === 'bridge' || (target === 'menu' && world !== '') || (target === 'world' && isLevelLoaded(world))) {
          return { reached: true, status: 'reached', waitedMs: Date.now() - t0, world }
        }
      }
    }
    await sleep(500)
  }

  const st = await bridge.readStatusStable()
  return { reached: false, status: 'timeout', waitedMs: Date.now() - t0, world: st?.world ?? '' }
}

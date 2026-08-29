import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { ServerConfig } from '../config'

const HEARTBEAT_STALE_MS = 3000
const POLL_INTERVAL_MS = 25
const STATUS_RETRIES = 4
const ORPHAN_MAX_AGE_MS = 60_000
const SWEEP_EVERY_MS = 30_000

export type BridgeResult =
  | { status: 'ok'; body: string; elapsedMs: number; exec: string }
  | { status: 'error'; body: string; elapsedMs: number; exec: string }
  | { status: 'game_not_running' }
  | { status: 'session_changed' }
  | { status: 'timeout'; waitedMs: number }

export interface BridgeStatus {
  session: string
  tick: number
  ts: number
  startedTs: number
  busy: string
  world: string
  lastError: string
  freshMs: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function field(text: string, key: string): string {
  return new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1]?.trim() ?? ''
}

export class BridgeClient {
  /** Сериализует дозапись в in/queue: два параллельных tool-call'а иначе теряют запрос. */
  private queueLock: Promise<void> = Promise.resolve()
  private lastSweepAt = 0

  readonly inDir: string
  readonly outDir: string
  readonly statusPath: string
  readonly queuePath: string

  constructor(
    readonly root: string,
    private readonly defaultTimeoutMs: number,
  ) {
    this.inDir = `${root}/in`
    this.outDir = `${root}/out`
    this.statusPath = `${root}/bridge.status`
    this.queuePath = `${this.inDir}/queue`
  }

  ensureDirs(): void {
    mkdirSync(this.inDir, { recursive: true })
    mkdirSync(this.outDir, { recursive: true })
  }

  readStatus(): BridgeStatus | null {
    let text: string
    try {
      text = readFileSync(this.statusPath, 'utf8')
    } catch {
      return null
    }
    let freshMs = Number.POSITIVE_INFINITY
    try {
      freshMs = Date.now() - statSync(this.statusPath).mtimeMs
    } catch {
      return null
    }
    const session = field(text, 'session')
    if (!session) return null
    return {
      session,
      tick: Number(field(text, 'tick') || 0),
      ts: Number(field(text, 'ts') || 0),
      startedTs: Number(field(text, 'started_ts') || 0),
      busy: field(text, 'busy'),
      world: field(text, 'world'),
      lastError: field(text, 'last_error'),
      freshMs: Math.max(0, freshMs),
    }
  }

  /** Мост подменяет bridge.status через remove+rename: короткое окно, когда файла нет. */
  async readStatusStable(): Promise<BridgeStatus | null> {
    for (let i = 0; i < STATUS_RETRIES; i++) {
      const st = this.readStatus()
      if (st) return st
      if (i < STATUS_RETRIES - 1) await sleep(15)
    }
    return null
  }

  isAlive(st: BridgeStatus | null): boolean {
    return st !== null && st.freshMs < HEARTBEAT_STALE_MS
  }

  async call(op: string, payload = '', timeoutMs = this.defaultTimeoutMs): Promise<BridgeResult> {
    this.ensureDirs()
    this.sweepStaleThrottled()

    const start = await this.readStatusStable()
    if (!this.isAlive(start)) return { status: 'game_not_running' }
    const session = start!.session
    const id = randomBytes(4).toString('hex')
    const req = `id=${id}\nop=${op}\ntimeout_ms=${timeoutMs}\n--payload--\n${payload}`

    // Порядок обязателен: тело раньше очереди — мост не увидит id без .req.
    // Дозапись в queue под мьютексом и через append, а не через перезапись.
    await (this.queueLock = this.queueLock.then(() => {
      const tmp = `${this.inDir}/${id}.req.tmp`
      writeFileSync(tmp, req)
      renameSync(tmp, `${this.inDir}/${id}.req`)
      appendFileSync(this.queuePath, `${id}\n`)
    }))

    const res = `${this.outDir}/${id}.res`
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (existsSync(res)) {
        let text: string
        try {
          text = readFileSync(res, 'utf8')
        } catch {
          await sleep(POLL_INTERVAL_MS)
          continue
        }
        try {
          unlinkSync(res)
        } catch {
          /* уже удалён */
        }
        const sep = text.indexOf('\n--result--\n')
        const head = sep < 0 ? text : text.slice(0, sep)
        const body = sep < 0 ? '' : text.slice(sep + '\n--result--\n'.length)
        if (field(head, 'session') !== session) return { status: 'session_changed' }
        const elapsedMs = Number(field(head, 'elapsed_ms') || 0)
        const exec = field(head, 'exec')
        return field(head, 'ok') === 'true'
          ? { status: 'ok', body, elapsedMs, exec }
          : { status: 'error', body, elapsedMs, exec }
      }

      const st = this.readStatus()
      if (st) {
        if (st.session !== session) return { status: 'session_changed' }
        // Застывший heartbeat при busy === нашем id означает, что игровой поток занят
        // именно нашим чанком. Обрывать здесь — значит убивать успешный вызов.
        if (st.freshMs >= HEARTBEAT_STALE_MS && st.busy !== id) {
          return { status: 'game_not_running' }
        }
      }
      await sleep(POLL_INTERVAL_MS)
    }
    this.discard(id)
    return { status: 'timeout', waitedMs: timeoutMs }
  }

  /** Вызывается при старте сервера: чужие .req/.res от прошлых запусков не наши. */
  sweepOrphans(): void {
    this.ensureDirs()
    for (const dir of [this.inDir, this.outDir]) {
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        continue
      }
      for (const name of names) {
        if (!/\.(req|res|tmp|work)$/.test(name) && name !== 'queue') continue
        try {
          rmSync(`${dir}/${name}`, { force: true })
        } catch {
          /* занят мостом — уйдёт на следующем проходе */
        }
      }
    }
  }

  private discard(id: string): void {
    try {
      rmSync(`${this.inDir}/${id}.req`, { force: true })
    } catch {
      /* мост уже забрал */
    }
  }

  private sweepStaleThrottled(): void {
    const now = Date.now()
    if (now - this.lastSweepAt < SWEEP_EVERY_MS) return
    this.lastSweepAt = now
    let names: string[]
    try {
      names = readdirSync(this.outDir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.res')) continue
      const p = `${this.outDir}/${name}`
      try {
        if (now - statSync(p).mtimeMs > ORPHAN_MAX_AGE_MS) rmSync(p, { force: true })
      } catch {
        /* исчез сам */
      }
    }
  }
}

const clients = new Map<string, BridgeClient>()

export function getBridge(config: ServerConfig): BridgeClient {
  const root = `${config.stateDir}/bridge`
  let client = clients.get(root)
  if (!client) {
    client = new BridgeClient(root, config.bridgeTimeoutMs)
    client.ensureDirs()
    clients.set(root, client)
  }
  return client
}

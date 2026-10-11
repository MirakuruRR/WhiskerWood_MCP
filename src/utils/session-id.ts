import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface SessionInfo {
  id: string
  pid: number
  startedAt: number
}

/** Каждая сессия клиента поднимает свой процесс MCP-сервера: pid и есть её адрес. */
export const SESSION: SessionInfo = {
  id: (process.env.WWMCP_SESSION ?? '').trim() || `mcp-${process.pid}`,
  pid: process.pid,
  startedAt: Date.now(),
}

const ACTIVITY_THROTTLE_MS = 3_000
let lastTouch = 0

/** Метка «эта сессия работает с игрой»: по ней другая сессия узнаёт, что игру сейчас трогают. */
export function touchActivity(path: string, op: string): void {
  const now = Date.now()
  if (now - lastTouch < ACTIVITY_THROTTLE_MS) return
  lastTouch = now
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ ...SESSION, at: now, op }))
  } catch {}
}

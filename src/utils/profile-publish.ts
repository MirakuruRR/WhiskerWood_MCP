import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

async function renameWithRetry(from: string, to: string, attempts = 6): Promise<void> {
  let delay = 100
  for (let i = 0; i < attempts; i++) {
    try {
      renameSync(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (i === attempts - 1 || !['EPERM', 'EBUSY', 'EACCES', 'EEXIST'].includes(code ?? '')) throw e
      if (typeof Bun !== 'undefined') Bun.gc(true)
      await new Promise((r) => setTimeout(r, delay))
      delay *= 2
    }
  }
}

export function stagingDirFor(distDir: string, profileId: string): string {
  const stagingRoot = `${dirname(distDir)}/.staging`
  mkdirSync(stagingRoot, { recursive: true })
  return `${stagingRoot}/${profileId}__${randomUUID()}`
}

export async function publishStagedProfile(stagingDir: string, distDir: string, profileId: string): Promise<string> {
  const target = `${distDir}/${profileId}`
  const trashRoot = `${dirname(distDir)}/.trash`
  mkdirSync(trashRoot, { recursive: true })
  mkdirSync(dirname(target), { recursive: true })

  if (existsSync(target)) {
    const trash = `${trashRoot}/${profileId}__${randomUUID()}`
    await renameWithRetry(target, trash)
    try {
      await renameWithRetry(stagingDir, target)
    } catch (e) {
      await renameWithRetry(trash, target).catch(() => {})
      throw e
    }
    rmSync(trash, { recursive: true, force: true })
  } else {
    await renameWithRetry(stagingDir, target)
  }
  return target
}

export function sweepStagingAndTrash(distDir: string): void {
  const base = dirname(distDir)
  const stagingRoot = `${base}/.staging`
  const trashRoot = `${base}/.trash`

  if (existsSync(stagingRoot)) {
    rmSync(stagingRoot, { recursive: true, force: true })
  }
  if (existsSync(trashRoot)) {
    for (const entry of readdirSync(trashRoot)) {
      rmSync(`${trashRoot}/${entry}`, { recursive: true, force: true })
    }
  }
}

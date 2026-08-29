import { Database } from 'bun:sqlite'
import { ServerConfig } from '../config'
import { assertProfileMatchesGame, checkFingerprintLevel1, readCachedFingerprint, recomputeFingerprintLevel2 } from './game-fingerprint'
import { listProfiles, ProfileInfo, resolveProfile } from './game-registry'
import { openIndexDb } from './db'

export interface GameContext {
  gameId: string
  gameVersion: string
  profileId: string
  profileDir: string
  indexRevision: string
  builtAt: string
  fingerprintFresh: boolean
  db: Database
}

export function versionEchoFields(ctx: GameContext): Record<string, string> {
  return {
    game_version: ctx.gameVersion,
    index_revision: ctx.indexRevision,
  }
}

export async function createGameContext(config: ServerConfig, requestedVersion?: string): Promise<GameContext> {
  const profiles = listProfiles(config.distDir)
  const profile: ProfileInfo = resolveProfile(profiles, requestedVersion)
  const contract = profile.contract!

  let fingerprintFresh = true
  const l1 = checkFingerprintLevel1(config)
  if (l1.status === 'fresh') {
    const fp = readCachedFingerprint(config)
    if (fp) assertProfileMatchesGame(fp, contract.gameVersion)
  } else if (l1.status === 'missing_files') {
    fingerprintFresh = false
  } else {
    const fp = await recomputeFingerprintLevel2(config)
    assertProfileMatchesGame(fp, contract.gameVersion)
  }

  const db = openIndexDb(`${profile.dir}/index.db`)
  return {
    gameId: contract.gameId,
    gameVersion: contract.gameVersion,
    profileId: profile.profileId,
    profileDir: profile.dir,
    indexRevision: contract.indexRevision,
    builtAt: contract.builtAt,
    fingerprintFresh,
    db,
  }
}

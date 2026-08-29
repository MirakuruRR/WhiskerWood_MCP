import { INDEX_SCHEMA_VERSION } from './schema'

export const GAME_ID = 'whiskerwood'

export interface ProfileContract {
  profileId: string
  gameId: string
  gameVersion: string
  schemaVersion: number
  indexRevision: string
  builtAt: string
  dumpCapturedAt: string
  typeSourcePrimary: string
}

export function profileIdFor(version: string): string {
  return `${GAME_ID}-${version}`
}

export function validateContract(raw: unknown): ProfileContract | string {
  if (typeof raw !== 'object' || raw === null) return 'profile.json: пустой или нечитаемый'
  const c = raw as Record<string, unknown>
  if (c.gameId !== GAME_ID) return `profile.json: gameId=${String(c.gameId)}, ожидается ${GAME_ID}`
  if (typeof c.gameVersion !== 'string') return 'profile.json: отсутствует gameVersion'
  if (c.schemaVersion !== INDEX_SCHEMA_VERSION) {
    return `profile.json: schemaVersion=${String(c.schemaVersion)}, сервер поддерживает ${INDEX_SCHEMA_VERSION}; профиль нужно пересобрать (bun run setup)`
  }
  const profileId = `${GAME_ID}-${c.gameVersion}`
  if (typeof c.profileId === 'string' && c.profileId !== profileId) {
    return `profile.json: profileId=${c.profileId} не совпадает с каталогом (${profileId})`
  }
  return {
    profileId,
    gameId: GAME_ID,
    gameVersion: c.gameVersion,
    schemaVersion: INDEX_SCHEMA_VERSION,
    indexRevision: typeof c.indexRevision === 'string' ? c.indexRevision : 'unknown',
    builtAt: typeof c.builtAt === 'string' ? c.builtAt : 'unknown',
    dumpCapturedAt: typeof c.dumpCapturedAt === 'string' ? c.dumpCapturedAt : 'unknown',
    typeSourcePrimary: typeof c.typeSourcePrimary === 'string' ? c.typeSourcePrimary : 'unknown',
  }
}

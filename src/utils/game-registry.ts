import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { GAME_ID, ProfileContract, profileIdFor, validateContract } from '../contract'
import { compareVersions } from './version'

export interface ProfileInfo {
  profileId: string
  dir: string
  status: 'ready' | 'broken'
  reason?: string
  contract?: ProfileContract
}

export function listProfiles(distDir: string): ProfileInfo[] {
  if (!existsSync(distDir)) return []
  const out: ProfileInfo[] = []
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${GAME_ID}-`)) continue
    const dir = `${distDir}/${entry.name}`
    const markerPath = `${dir}/profile.json`
    if (!existsSync(markerPath)) {
      out.push({ profileId: entry.name, dir, status: 'broken', reason: 'нет profile.json (сборка не завершена)' })
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(markerPath, 'utf8'))
    } catch {
      out.push({ profileId: entry.name, dir, status: 'broken', reason: 'profile.json не читается' })
      continue
    }
    const contract = validateContract(parsed)
    if (typeof contract === 'string') {
      out.push({ profileId: entry.name, dir, status: 'broken', reason: contract })
      continue
    }
    if (!existsSync(`${dir}/index.db`)) {
      out.push({ profileId: entry.name, dir, status: 'broken', reason: 'нет index.db' })
      continue
    }
    if (profileIdFor(contract.gameVersion) !== entry.name) {
      out.push({
        profileId: entry.name,
        dir,
        status: 'broken',
        reason: `суффикс каталога ${entry.name} не совпадает с gameVersion=${contract.gameVersion}`,
      })
      continue
    }
    out.push({ profileId: entry.name, dir, status: 'ready', contract })
  }
  return out
}

export class ProfileResolutionError extends Error {}

export function describeProfiles(profiles: ProfileInfo[]): string {
  if (profiles.length === 0) return 'готовых профилей нет'
  return profiles
    .map((p) => (p.status === 'ready' ? `${p.contract!.gameVersion} (ready)` : `${p.profileId} (broken: ${p.reason})`))
    .join('; ')
}

export function resolveProfile(profiles: ProfileInfo[], requestedVersion?: string): ProfileInfo {
  const ready = profiles.filter((p) => p.status === 'ready')

  if (requestedVersion) {
    const exact = profiles.filter((p) => p.contract?.gameVersion === requestedVersion || p.profileId === profileIdFor(requestedVersion))
    if (exact.length === 0) {
      throw new ProfileResolutionError(
        `профиль для версии "${requestedVersion}" не найден. Доступно: ${describeProfiles(profiles)}. Пересоберите: bun run setup`,
      )
    }
    if (exact.length > 1) {
      throw new ProfileResolutionError(
        `неоднозначность: несколько профилей подходят под версию "${requestedVersion}". Уточните версию явно.`,
      )
    }
    const p = exact[0]
    if (p.status !== 'ready') {
      throw new ProfileResolutionError(`профиль ${p.profileId} сломан: ${p.reason}`)
    }
    return p
  }

  if (ready.length === 0) {
    throw new ProfileResolutionError(
      `нет ни одного готового профиля. Доступно: ${describeProfiles(profiles)}. Соберите индекс: bun run setup`,
    )
  }
  ready.sort((a, b) => compareVersions(b.contract!.gameVersion, a.contract!.gameVersion))
  return ready[0]
}

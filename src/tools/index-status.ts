import { GameContext, versionEchoFields } from '../utils/game-context'
import { renderAiText } from '../utils/ai-text'
import { ServerConfig } from '../config'
import { checkFingerprintLevel1 } from '../utils/game-fingerprint'

export function handleIndexStatus(ctx: GameContext, config: ServerConfig): string {
  const meta = ctx.db.query('SELECT key, value FROM profile_meta ORDER BY key').all() as Array<{ key: string; value: string }>
  const fields: Record<string, string | number | boolean> = {
    ...versionEchoFields(ctx),
    profile_id: ctx.profileId,
    built_at: ctx.builtAt,
    fingerprint: checkFingerprintLevel1(config).status,
  }
  for (const row of meta) {
    if (row.key === 'built_at') continue
    fields[`meta_${row.key}`] = row.value
  }
  return renderAiText({
    reportType: 'index_status',
    fields,
  })
}

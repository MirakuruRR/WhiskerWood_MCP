import { GameContext, versionEchoFields } from '../utils/game-context'
import { renderAiText } from '../utils/ai-text'
import { ServerConfig } from '../config'
import { checkFingerprintLevel1 } from '../utils/game-fingerprint'

const SUMMARY_META_KEYS = new Set(['dump_captured_at', 'engine_version', 'schema_version'])

export function handleIndexStatus(ctx: GameContext, config: ServerConfig, args: { detail?: 'summary' | 'full' } = {}): string {
  const detail = args.detail === 'full' ? 'full' : 'summary'
  const meta = ctx.db.query('SELECT key, value FROM profile_meta ORDER BY key').all() as Array<{ key: string; value: string }>
  const fields: Record<string, string | number | boolean> = {
    ...versionEchoFields(ctx),
    profile_id: ctx.profileId,
    built_at: ctx.builtAt,
    fingerprint: checkFingerprintLevel1(config).status,
    detail,
  }
  for (const row of meta) {
    if (row.key === 'built_at') continue
    if (detail === 'summary' && !row.key.startsWith('coverage_bp_') && !SUMMARY_META_KEYS.has(row.key)) continue
    fields[`meta_${row.key}`] = row.value
  }
  return renderAiText({
    reportType: 'index_status',
    fields,
  })
}

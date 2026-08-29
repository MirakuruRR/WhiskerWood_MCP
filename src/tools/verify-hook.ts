import { GameContext, versionEchoFields } from '../utils/game-context'
import { renderAiText, AiTextResult, Scalar } from '../utils/ai-text'
import { normalizeUserPath } from '../scripts/parsers/path-forms'
import { findObject, suggestSimilar } from './common'

export interface VerifyHookArgs {
  paths: string[]
  live?: boolean
}

const MAX_PATHS = 50

export function handleVerifyHook(ctx: GameContext, args: VerifyHookArgs): string {
  const paths = args.paths.slice(0, MAX_PATHS)
  const dumpCapturedAt = (ctx.db.query("SELECT value FROM profile_meta WHERE key = 'dump_captured_at'").get() as { value: string } | null)?.value ?? 'unknown'

  const results: AiTextResult[] = paths.map((raw) => {
    const norm = normalizeUserPath(raw)
    const obj = findObject(ctx, raw)

    if (obj) {
      if (obj.hook_path) {
        const fields: Record<string, Scalar> = {
          input: raw,
          status: 'found',
          resolved_path: obj.path,
          kind: obj.kind,
          hook_path: obj.hook_path,
        }
        return { fields }
      }
      if (obj.hook_path_status === 'bp_asset_unresolved' || obj.hook_path_status === 'bp_asset_ambiguous') {
        const fields: Record<string, Scalar> = {
          input: raw,
          status: 'found_hook_path_unavailable',
          resolved_path: obj.path,
          kind: obj.kind,
          reason: obj.hook_path_status === 'bp_asset_ambiguous' ? 'ассетный путь неоднозначен' : 'ассетный путь не разрезолвлен',
        }
        return { fields }
      }
      const fields: Record<string, Scalar> = {
        input: raw,
        status: 'found',
        resolved_path: obj.path,
        kind: obj.kind,
        note: 'объект в индексе есть; хукового пути нет (не класс и не функция)',
      }
      return { fields }
    }

    const looksBp = raw.startsWith('/Game/') || norm.indexPath.includes('_C')
    const possiblyNotLoaded = looksBp && dumpCapturedAt !== 'in_level'
    const suggestions = suggestSimilar(ctx, raw, 5)
    const fields: Record<string, Scalar> = {
      input: raw,
      status: possiblyNotLoaded ? 'not_found_possibly_not_loaded' : 'not_found',
      suggestions: suggestions.length > 0 ? suggestions.join('; ') : 'нет',
    }
    return { fields }
  })

  return renderAiText({
    reportType: 'hook_verification',
    fields: {
      ...versionEchoFields(ctx),
      checked: paths.length,
      truncated: args.paths.length > MAX_PATHS,
      ...(args.live
        ? { live: 'недоступно в фазе 1: live-проба через bridge появится в фазе 2' }
        : {}),
      ...(args.paths.length > MAX_PATHS ? { limit: MAX_PATHS } : {}),
    },
    results,
  })
}

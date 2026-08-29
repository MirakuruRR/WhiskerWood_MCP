import { ServerConfig } from '../config'
import { GameContext, versionEchoFields } from '../utils/game-context'
import { renderAiText, AiTextResult, Scalar } from '../utils/ai-text'
import { normalizeUserPath } from '../scripts/parsers/path-forms'
import { getBridge } from '../utils/bridge-client'
import { findObject, isHookable, ObjectHit, suggestSimilar } from './common'
import { isLevelLoaded } from './bridge-common'

export interface VerifyHookArgs {
  paths: string[]
  live?: boolean
}

const MAX_PATHS = 50
const BP_SEGMENT_RE = /(^|\.)[^.]*_C(\.|$)/

interface LiveProbe {
  found: boolean
  via: string
}

function looksBlueprint(raw: string, indexPath: string): boolean {
  return raw.startsWith('/Game/') || BP_SEGMENT_RE.test(indexPath)
}

// Кандидат на live-пробу собирается только там, где форма выводится однозначно:
// готовый путь из индекса, уже смонтированный путь от агента либо нативный
// Pkg.Class[.Func] с пакетом, известным индексу. /Game-пути не угадываются (§9.1).
function probeCandidate(ctx: GameContext, raw: string, obj: ObjectHit | null): string | null {
  if (obj) return obj.hook_path ?? obj.object_path ?? null
  const s = raw.trim()
  if (s.startsWith('/')) return s
  const parts = normalizeUserPath(s).indexPath.split('.')
  if (parts.length < 2) return null
  const known = ctx.db
    .query("SELECT 1 AS ok FROM objects WHERE kind = 'Package' AND path = ? LIMIT 1")
    .get(parts[0]) as { ok: number } | null
  if (!known) return null
  if (parts.length === 2) return `/Script/${parts[0]}.${parts[1]}`
  return `/Script/${parts[0]}.${parts[1]}:${parts.slice(2).join('.')}`
}

function parseProbeReply(body: string): Map<string, LiveProbe> {
  const out = new Map<string, LiveProbe>()
  for (const line of body.split('\n')) {
    const m = /^(.*) = (found|not_found) via=(\S+)$/.exec(line.trim())
    if (m) out.set(m[1], { found: m[2] === 'found', via: m[3] })
  }
  return out
}

export async function handleVerifyHook(
  ctx: GameContext,
  config: ServerConfig,
  args: VerifyHookArgs,
): Promise<string> {
  const paths = args.paths.slice(0, MAX_PATHS)
  const dumpCapturedAt =
    (ctx.db.query("SELECT value FROM profile_meta WHERE key = 'dump_captured_at'").get() as
      | { value: string }
      | null)?.value ?? 'unknown'

  const rows = paths.map((raw) => {
    const obj = findObject(ctx, raw)
    return { raw, obj, candidate: probeCandidate(ctx, raw, obj) }
  })

  let liveNote = ''
  let levelLoaded = false
  let probes = new Map<string, LiveProbe>()

  if (args.live) {
    const bridge = getBridge(config)
    const st = await bridge.readStatusStable()
    if (!bridge.isAlive(st)) {
      liveNote = 'game_not_running: live-проба пропущена, ответ построен только по индексу'
    } else {
      levelLoaded = isLevelLoaded(st!.world)
      const candidates = [...new Set(rows.map((r) => r.candidate).filter((c): c is string => c !== null))]
      if (candidates.length === 0) {
        liveNote = 'ни один путь не приводится к однозначной форме для StaticFindObject'
      } else {
        const res = await bridge.call('probe', candidates.join('\n'))
        if (res.status === 'ok') {
          probes = parseProbeReply(res.body)
          liveNote = levelLoaded
            ? 'ok'
            : 'ok, но уровень не загружен: не найденное сейчас может существовать после загрузки'
        } else {
          liveNote = `${res.status}: live-проба не выполнена`
        }
      }
    }
  }

  const results: AiTextResult[] = rows.map(({ raw, obj, candidate }) => {
    const norm = normalizeUserPath(raw)
    const probe = candidate ? probes.get(candidate) : undefined
    const fields: Record<string, Scalar> = { input: raw }

    const attachLive = () => {
      if (!args.live) return
      if (!probe) {
        fields.live = candidate ? 'не проверено' : 'не проверено (путь неоднозначен)'
        return
      }
      fields.live = probe.found ? 'found' : 'not_found'
      fields.live_via = probe.via
      fields.live_probed_path = candidate!
    }

    if (obj) {
      if (obj.hook_path && isHookable(obj.kind)) {
        fields.status = 'found'
        fields.resolved_path = obj.path
        fields.kind = obj.kind
        fields.hook_path = obj.hook_path
        attachLive()
        if (probe && !probe.found) {
          fields.note =
            'в индексе есть, в живой игре не найден: пакет не загружен в память сейчас — это не ошибка пути, хук сработает после загрузки'
        }
        return { fields }
      }
      if (obj.hook_path || obj.object_path) {
        fields.status = 'found_not_hookable'
        fields.resolved_path = obj.path
        fields.kind = obj.kind
        fields.object_path = obj.object_path ?? obj.hook_path!
        fields.note = 'этот вид объектов нельзя хукать; путь годится для StaticFindObject, не для RegisterHook'
        attachLive()
        return { fields }
      }
      if (obj.hook_path_status === 'bp_asset_unresolved' || obj.hook_path_status === 'bp_asset_ambiguous') {
        fields.status = 'found_hook_path_unavailable'
        fields.resolved_path = obj.path
        fields.kind = obj.kind
        fields.reason =
          obj.hook_path_status === 'bp_asset_ambiguous' ? 'ассетный путь неоднозначен' : 'ассетный путь не разрезолвлен'
        attachLive()
        return { fields }
      }
      fields.status = 'found_not_hookable'
      fields.resolved_path = obj.path
      fields.kind = obj.kind
      fields.note = 'объект в индексе есть; хукового пути нет (не класс и не функция)'
      attachLive()
      return { fields }
    }

    if (probe?.found) {
      fields.status = 'found_live_only'
      fields.kind = 'unknown'
      fields.hook_path = candidate!
      fields.note =
        'в индексе отсутствует, но в живой игре найден: объект создан в рантайме либо профиль устарел; путь рабочий'
      attachLive()
      return { fields }
    }

    const bpish = looksBlueprint(raw, norm.indexPath)
    const staleDump = dumpCapturedAt !== 'in_level'
    const liveDone = args.live === true && probe !== undefined
    // Спайк 4 (2026-08-29): StaticFindObject видит только загруженные объекты — виджет
    // главного меню не находится при загруженном игровом уровне. Значит live-негатив
    // по BP-пути не окончателен никогда, даже при загруженном уровне.
    const possiblyNotLoaded = bpish && (staleDump || liveDone)

    fields.status = possiblyNotLoaded ? 'not_found_possibly_not_loaded' : 'not_found'
    if (possiblyNotLoaded) {
      fields.reason = liveDone
        ? 'BP-путь не найден в живой игре, но StaticFindObject видит только загруженные объекты'
        : `дамп снят вне уровня (dump_captured_at=${dumpCapturedAt})`
    }
    attachLive()
    const suggestions = suggestSimilar(ctx, raw, 5)
    fields.suggestions = suggestions.length > 0 ? suggestions.join('; ') : 'нет'
    return { fields }
  })

  return renderAiText({
    reportType: 'hook_verification',
    fields: {
      ...versionEchoFields(ctx),
      checked: paths.length,
      truncated: args.paths.length > MAX_PATHS,
      ...(args.live ? { live: liveNote, level_loaded: levelLoaded } : {}),
      ...(args.paths.length > MAX_PATHS ? { limit: MAX_PATHS } : {}),
    },
    results,
  })
}

import { Database } from 'bun:sqlite'
import { ServerConfig } from '../config'
import { profileIdFor } from '../contract'
import { AiTextResult, renderAiText } from '../utils/ai-text'
import { describeProfiles, listProfiles, ProfileInfo } from '../utils/game-registry'
import { compareVersions } from '../utils/version'

export interface DiffVersionsArgs {
  from: string
  to: string
  kind?: string
  limit?: number
}

interface SideRow {
  path: string
  kind: string
  package: string
  is_blueprint: number
  hook_path: string | null
  bp_side: number
}

interface SigRow {
  path: string
  package: string
  hook_path: string | null
  sig_from: string
  sig_to: string
  names_from: string
  names_to: string
}

interface HookRow {
  path: string
  kind: string
  is_blueprint: number
  hp_from: string | null
  hp_to: string | null
  st_from: string
  st_to: string
}

class DiffError extends Error {}

function pick(profiles: ProfileInfo[], version: string, role: string): ProfileInfo {
  const hit = profiles.find((p) => p.contract?.gameVersion === version || p.profileId === profileIdFor(version))
  if (!hit) throw new DiffError(`профиль ${role}="${version}" не найден. Доступно: ${describeProfiles(profiles)}`)
  if (hit.status !== 'ready') throw new DiffError(`профиль ${role}="${version}" сломан: ${hit.reason}`)
  return hit
}

const SIG_CTE = (schema: string, alias: string): string => `${alias} AS (
  SELECT function_path AS fp, group_concat(part, ', ') AS sig, group_concat(nm, ',') AS names
  FROM (
    SELECT function_path,
           (CASE WHEN is_return THEN '-> ' ELSE '' END) || COALESCE(type_name, '?') || ' ' || name ||
           (CASE WHEN is_out AND NOT is_return THEN ' [out]' ELSE '' END) AS part,
           name AS nm
    FROM ${schema}.function_params ORDER BY function_path, ordinal
  ) GROUP BY function_path
)`

export function handleDiffVersions(config: ServerConfig, args: DiffVersionsArgs): string {
  const profiles = listProfiles(config.distDir)
  let from: ProfileInfo
  let to: ProfileInfo
  try {
    from = pick(profiles, args.from, 'from')
    to = pick(profiles, args.to, 'to')
  } catch (e) {
    if (!(e instanceof DiffError)) throw e
    return renderAiText({
      reportType: 'version_diff',
      fields: {
        status: 'profile_not_found',
        error: e.message,
        hint: 'сравнивать можно только собранные профили. Новый профиль появляется после bun run setup на новой версии игры',
      },
    })
  }

  if (from.profileId === to.profileId) {
    return renderAiText({
      reportType: 'version_diff',
      fields: { status: 'same_profile', error: `from и to указывают на один профиль ${from.profileId}` },
    })
  }

  const limit = Math.min(Math.max(args.limit ?? 60, 1), 200)
  const kind = args.kind
  const bpKind = kind === 'bp' || kind === 'BlueprintGeneratedClass'
  const kindSql = (a: string): string =>
    !kind ? ` AND ${a}.kind <> 'Package'` : bpKind ? ` AND ${a}.kind LIKE '%BlueprintGeneratedClass'` : ` AND ${a}.kind = ?`
  const kindParams: string[] = kind && !bpKind ? [kind] : []
  // функция BP-класса сама не помечена is_blueprint, но её hook_path ведёт в /Game
  const bpSide = (a: string): string => `(${a}.is_blueprint = 1 OR COALESCE(${a}.hook_path, '') LIKE '/Game/%')`

  const db = new Database(`${from.dir}/index.db`, { readonly: true, create: false })
  let removed: SideRow[] = []
  let added: SideRow[] = []
  let sigChanged: SigRow[] = []
  let hookChanged: HookRow[] = []
  const counts = { removed: 0, removed_bp: 0, added: 0, added_bp: 0, sig: 0, hook: 0 }

  try {
    db.run(`ATTACH DATABASE '${to.dir.replaceAll("'", "''")}/index.db' AS newer`)

    const sideQuery = (src: string, other: string): string => `
      SELECT a.path, a.kind, a.package, a.is_blueprint, a.hook_path, ${bpSide('a')} AS bp_side
      FROM ${src}.objects a
      LEFT JOIN ${other}.objects b ON b.path = a.path
      WHERE b.path IS NULL${kindSql('a')}`

    const countSide = (src: string, other: string): { n: number; bp: number | null } =>
      db
        .query(
          `SELECT COUNT(*) AS n, SUM(${bpSide('a')}) AS bp
           FROM ${src}.objects a LEFT JOIN ${other}.objects b ON b.path = a.path
           WHERE b.path IS NULL${kindSql('a')}`,
        )
        .get(...(kindParams as never[])) as { n: number; bp: number | null }

    const rc = countSide('main', 'newer')
    const ac = countSide('newer', 'main')
    counts.removed = rc.n
    counts.removed_bp = rc.bp ?? 0
    counts.added = ac.n
    counts.added_bp = ac.bp ?? 0

    removed = db
      .query(`${sideQuery('main', 'newer')} ORDER BY bp_side, a.kind, a.path LIMIT ?`)
      .all(...(kindParams as never[]), limit) as SideRow[]
    added = db
      .query(`${sideQuery('newer', 'main')} ORDER BY bp_side, a.kind, a.path LIMIT ?`)
      .all(...(kindParams as never[]), limit) as SideRow[]

    if (!kind || kind === 'Function') {
      const all = db
        .query(
          `WITH ${SIG_CTE('main', 'sig_a')}, ${SIG_CTE('newer', 'sig_b')}
           SELECT o.path, o.package, o.hook_path,
                  COALESCE(sa.sig, '') AS sig_from, COALESCE(sb.sig, '') AS sig_to,
                  COALESCE(sa.names, '') AS names_from, COALESCE(sb.names, '') AS names_to
           FROM main.objects o
           JOIN newer.objects o2 ON o2.path = o.path
           LEFT JOIN sig_a sa ON sa.fp = o.path
           LEFT JOIN sig_b sb ON sb.fp = o.path
           WHERE o.kind = 'Function' AND COALESCE(sa.sig, '') <> COALESCE(sb.sig, '')
           ORDER BY o.path`,
        )
        .all() as SigRow[]
      counts.sig = all.length
      sigChanged = all.slice(0, limit)
    }

    const allHooks = db
      .query(
        `SELECT o.path, o.kind, o.is_blueprint, o.hook_path AS hp_from, o2.hook_path AS hp_to,
                o.hook_path_status AS st_from, o2.hook_path_status AS st_to
         FROM main.objects o
         JOIN newer.objects o2 ON o2.path = o.path
         WHERE COALESCE(o.hook_path, '') <> COALESCE(o2.hook_path, '')${kindSql('o')}
         ORDER BY o.is_blueprint, o.path`,
      )
      .all(...(kindParams as never[])) as HookRow[]
    counts.hook = allHooks.length
    hookChanged = allHooks.slice(0, limit)
  } finally {
    db.close()
  }

  const results: AiTextResult[] = []

  for (const r of sigChanged) {
    const shapeChanged = r.names_from !== r.names_to
    results.push({
      fields: {
        change: shapeChanged ? 'signature_changed' : 'param_types_changed',
        path: r.path,
        package: r.package,
        ...(r.hook_path ? { hook_path: r.hook_path } : {}),
        signature_from: r.sig_from || '(без параметров)',
        signature_to: r.sig_to || '(без параметров)',
        impact: shapeChanged
          ? 'состав параметров изменился — арность коллбэка хука тоже, перегенерируй через ww_generate_hook'
          : 'имена параметров те же, изменились только типы; чаще это разная полнота дампа, а не патч (§6.1)',
      },
    })
  }
  for (const r of removed) {
    results.push({
      fields: {
        change: 'removed',
        path: r.path,
        kind: r.kind,
        package: r.package,
        ...(r.hook_path ? { hook_path: r.hook_path } : {}),
        ...(r.bp_side
          ? {
              caveat:
                'BP-класс: дамп это снимок памяти, отсутствие может значить «ассет не был загружен», а не «удалён». Перепроверь ww_verify_hook с live: true',
            }
          : {}),
      },
    })
  }
  for (const r of hookChanged) {
    results.push({
      fields: {
        change: 'hook_path_changed',
        path: r.path,
        kind: r.kind,
        hook_path_from: r.hp_from ?? `(нет: ${r.st_from})`,
        hook_path_to: r.hp_to ?? `(нет: ${r.st_to})`,
      },
    })
  }
  for (const r of added) {
    results.push({
      fields: {
        change: 'added',
        path: r.path,
        kind: r.kind,
        package: r.package,
        ...(r.hook_path ? { hook_path: r.hook_path } : {}),
      },
    })
  }

  const direction = compareVersions(to.contract!.gameVersion, from.contract!.gameVersion) >= 0 ? 'forward' : 'backward'
  const truncated =
    counts.removed > removed.length ||
    counts.added > added.length ||
    counts.sig > sigChanged.length ||
    counts.hook > hookChanged.length

  return renderAiText({
    reportType: 'version_diff',
    fields: {
      status: 'ok',
      from: from.contract!.gameVersion,
      to: to.contract!.gameVersion,
      direction,
      from_dump_captured_at: from.contract!.dumpCapturedAt,
      to_dump_captured_at: to.contract!.dumpCapturedAt,
      ...(kind ? { kind } : {}),
      removed: counts.removed,
      removed_blueprint: counts.removed_bp,
      added: counts.added,
      added_blueprint: counts.added_bp,
      signature_changed: counts.sig,
      hook_path_changed: counts.hook,
      hint: 'сравниваются два снимка рефлексии; BP-половина зависит от того, что было загружено в момент дампа (§6.3). Что именно сломалось в модах, покажет ww_validate_mod',
    },
    results,
    truncated,
    limit,
  })
}

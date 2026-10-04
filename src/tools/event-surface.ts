import { readFileSync, statSync } from 'node:fs'
import { ServerConfig } from '../config'
import { GameContext, versionEchoFields } from '../utils/game-context'
import { AiTextResult, MAX_RESULTS, renderAiText, Scalar } from '../utils/ai-text'
import { BpDelegateParam, bpClass, bpDelegates, bpFunction, bpUnavailableHint, loomPathOf, loomType } from '../utils/loom-types'
import { kitStatus } from '../utils/kit'
import { lookupObject, ObjectHit, suggestSimilar } from './common'

export interface EventSurfaceArgs {
  class_path: string
  depth?: number
  limit?: number
}

const DEFAULT_LIMIT = 12
const MAX_DEPTH = 3
const MAX_FIELD_CLASSES = 40
const MAX_SUBCLASS_SCAN = 60
const MAX_DT_ROWS = 10
const MAX_DT_SHOWN = 6
const MAX_SAMPLE = 8
const MAX_SNIPPET = 180
const MODAPI_LOOM = '/Script/SystemCore.ModAPI'
const CLASS_KIND_RE = /^(Class|.*GeneratedClass)$/

const RESERVED = new Set([
  'break',
  'continue',
  'else',
  'for',
  'if',
  'let',
  'match',
  'return',
  'while',
  'false',
  'none',
  'true',
  'self',
  'super',
])

interface RawSignatureParam {
  name?: string
  type?: string
  dir?: string
  const_ref?: boolean
}

interface RawProperty {
  type?: string
  signature?: RawSignatureParam[]
}

interface RawFunction {
  flags?: string[]
  params?: RawSignatureParam[]
}

interface RawClass {
  super?: string
  interface?: boolean
  editor_only?: boolean
  properties?: Record<string, RawProperty>
  functions?: Record<string, RawFunction>
}

interface LoomDump {
  classes: Record<string, RawClass>
  structs?: Record<string, unknown>
}

interface DelegatePoint {
  name: string
  owner: string
  signature: RawSignatureParam[]
}

interface EventPoint {
  name: string
  owner: string
  fn: RawFunction
  nativeOwner: string | null
}

let typesCache: { key: string; dump: LoomDump } | null = null

function typesJsonPath(config: ServerConfig): string | null {
  const st = kitStatus(config)
  return st.configured && st.kit ? st.kit.typesJson : null
}

function readTypes(config: ServerConfig): LoomDump | null {
  const path = typesJsonPath(config)
  if (!path) return null
  let key: string
  try {
    const s = statSync(path)
    key = `${path}|${s.mtimeMs}|${s.size}`
  } catch {
    return null
  }
  if (typesCache && typesCache.key === key) return typesCache.dump
  try {
    const dump = JSON.parse(readFileSync(path, 'utf8')) as LoomDump
    if (!dump || typeof dump !== 'object' || !dump.classes) return null
    typesCache = { key, dump }
    return dump
  } catch {
    return null
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function ident(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED.has(name) ? name : `\`${name}\``
}

function callbackName(delegate: string): string {
  const up = delegate.slice(0, 1).toUpperCase()
  const name = `${up}${delegate.slice(1)}`
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : 'Handler'
}

function signatureOf(params: RawSignatureParam[] | undefined): RawSignatureParam[] {
  return Array.isArray(params) ? params : []
}

function paramsOf(params: RawSignatureParam[]): string {
  return params
    .filter((p) => p.dir !== 'return')
    .map((p) => {
      const prefix = p.dir === 'ref' || p.const_ref === true ? 'ref ' : p.dir === 'out' ? 'out ' : ''
      return `${prefix}${ident(String(p.name ?? ''))}: ${loomType(String(p.type ?? ''))}`
    })
    .join(', ')
}

function returnsOf(params: RawSignatureParam[]): string | null {
  const ret = params.find((p) => p.dir === 'return')
  return ret ? loomType(String(ret.type ?? '')) : null
}

function signatureText(params: RawSignatureParam[]): string {
  const ret = returnsOf(params)
  return `${`(${paramsOf(params)})`}${ret ? ` -> ${ret}` : ''}`
}

function handlerText(name: string, params: RawSignatureParam[]): string {
  const ret = returnsOf(params)
  return `on ${ident(name)}(${paramsOf(params)})${ret ? ` -> ${ret}` : ''}`
}

function bodyText(header: string): string {
  return [`${header} {`, '    ', '}'].join('\n')
}

function lineageOf(dump: LoomDump, classPath: string): Array<{ path: string; cls: RawClass }> {
  const out: Array<{ path: string; cls: RawClass }> = []
  const seen = new Set<string>()
  let current: string | undefined = classPath
  while (current && !seen.has(current) && out.length < 64) {
    seen.add(current)
    const cls: RawClass | undefined = dump.classes[current]
    if (!cls) break
    out.push({ path: current, cls })
    current = cls.super
  }
  return out
}

function rawSignature(dump: LoomDump, owner: string, name: string): RawSignatureParam[] | null {
  const prop = dump.classes[owner]?.properties?.[name]
  if (!prop || !Array.isArray(prop.signature)) return null
  return prop.signature
}

function fromBpSignature(params: BpDelegateParam[]): RawSignatureParam[] {
  return params.map((p) => ({ name: p.name, type: p.type }))
}

function delegatePoints(
  ctx: GameContext,
  config: ServerConfig,
  dump: LoomDump,
  classPath: string,
): DelegatePoint[] {
  const list = bpDelegates(ctx, config, classPath) ?? []
  return list.map((d) => ({
    name: d.name,
    owner: d.owner,
    signature: rawSignature(dump, d.owner, d.name) ?? fromBpSignature(d.signature),
  }))
}

function eventsOf(dump: LoomDump, classPath: string): EventPoint[] {
  const byName = new Map<string, EventPoint>()
  for (const link of lineageOf(dump, classPath)) {
    for (const [name, fn] of Object.entries(link.cls.functions ?? {})) {
      const flags = Array.isArray(fn.flags) ? fn.flags : []
      if (!flags.includes('event') || flags.includes('internal')) continue
      const existing = byName.get(name)
      if (existing) {
        if (link.path.startsWith('/Script/')) existing.nativeOwner = link.path
        continue
      }
      byName.set(name, { name, owner: link.path, fn, nativeOwner: link.path.startsWith('/Script/') ? link.path : null })
    }
  }
  return [...byName.values()]
}

function objectClassesIn(property: RawProperty): string[] {
  const raw = String(property.type ?? '')
  const out: string[] = []
  const direct = /^object:(.+)$/.exec(raw)
  if (direct) out.push(direct[1])
  for (const inner of raw.matchAll(/(?:array|set)<object:([^>]+)>/g)) out.push(inner[1])
  return out
}

interface IndexRow {
  path: string
  kind: string
  super_path: string | null
  is_blueprint: number
}

function indexPathOfLoom(ctx: GameContext, loomPath: string): string | null {
  if (!loomPath.startsWith('/')) return loomPath
  const row = ctx.db
    .query('SELECT path FROM objects WHERE hook_path = ? OR object_path = ? LIMIT 1')
    .get(loomPath, loomPath) as { path: string } | null
  return row?.path ?? null
}

function functionRow(ctx: GameContext, ownerLoomPath: string, name: string): { path: string; hook_path: string | null } | null {
  const indexPath = indexPathOfLoom(ctx, ownerLoomPath)
  if (!indexPath) return null
  return ctx.db
    .query("SELECT path, hook_path FROM objects WHERE kind = 'Function' AND path = ?")
    .get(`${indexPath}.${name}`) as { path: string; hook_path: string | null } | null
}

function propertyEvidence(ctx: GameContext, ownerLoomPath: string, name: string): string {
  const indexPath = indexPathOfLoom(ctx, ownerLoomPath)
  if (!indexPath) return 'индекс: владелец не найден'
  const row = ctx.db
    .query('SELECT prop_kind, type_name FROM properties WHERE owner_path = ? AND name = ?')
    .get(indexPath, name) as { prop_kind: string; type_name: string | null } | null
  if (!row) return 'индекс: поля нет в дампе (properties)'
  if (row.prop_kind === 'MulticastInlineDelegateProperty' || row.prop_kind === 'MulticastSparseDelegateProperty') {
    return `индекс: properties.prop_kind=${row.prop_kind} (${row.type_name ?? '—'})`
  }
  return `индекс: properties.prop_kind=${row.prop_kind} — не делегат`
}

function traceHint(ctx: GameContext, ownerLoomPath: string, name: string, delegate: boolean): string {
  const row = functionRow(ctx, ownerLoomPath, delegate ? `${name}__DelegateSignature` : name)
  if (row?.hook_path) {
    return delegate
      ? `ww_trace_calls ${row.hook_path} — сигнатурная функция диспетчера: видно, когда его рассылают`
      : `ww_trace_calls ${row.hook_path} — видно, зовёт ли игра событие и когда`
  }
  return delegate
    ? 'сигнатурной UFunction в индексе нет: трейсом делегат не поймать — проверяй подпиской с ModAPI.LogMessage и ww_game_log source=modlog'
    : 'путь в индексе не найден: проверь ww_verify_hook, дальше ww_lift по пакету класса'
}

function bindHint(receiver: string, delegate: string, callback: string): string {
  return `${receiver}.${ident(delegate)}.bind(${callback})`
}

interface DtRow {
  table: string
  row: string
  klass: string
  match: string
  snippet: string
}

interface DtScan {
  rows: DtRow[]
  total: number
  tables: string[]
}

function datatableCandidates(ctx: GameContext, patterns: Array<{ pattern: string; klass: string }>): DtScan {
  const rows: DtRow[] = []
  const seen = new Set<string>()
  const tables = new Set<string>()
  let total = 0
  for (const { pattern, klass } of patterns) {
    if (pattern.length < 4) continue
    const count = ctx.db
      .query(
        "SELECT COUNT(*) c FROM datatable_rows r JOIN datatables d ON d.name = r.table_name WHERE d.kind = 'datatable' AND r.row_json LIKE ?",
      )
      .get(`%${pattern}%`) as { c: number }
    total += count.c
    if (count.c === 0) continue
    const found = ctx.db
      .query(
        "SELECT r.table_name, r.row_name, r.row_json FROM datatable_rows r JOIN datatables d ON d.name = r.table_name WHERE d.kind = 'datatable' AND r.row_json LIKE ? ORDER BY r.table_name, r.row_name LIMIT ?",
      )
      .all(`%${pattern}%`, MAX_DT_ROWS) as Array<{ table_name: string; row_name: string; row_json: string }>
    for (const f of found) {
      tables.add(f.table_name)
      const key = `${f.table_name}|${f.row_name}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push({
        table: f.table_name,
        row: f.row_name,
        klass,
        match: pattern,
        snippet: snippetAround(f.row_json, pattern),
      })
    }
  }
  return { rows, total, tables: [...tables].sort() }
}

function snippetAround(json: string, pattern: string): string {
  const i = json.toLowerCase().indexOf(pattern.toLowerCase())
  if (i < 0) return ''
  const span = 70
  const from = Math.max(0, i - span)
  const to = Math.min(json.length, i + pattern.length + span)
  const body = json.slice(from, to).replace(/\s+/g, ' ')
  return `${from > 0 ? '…' : ''}${body.slice(0, MAX_SNIPPET)}${to < json.length ? '…' : ''}`
}

interface RefScan {
  total: number
  superstruct: number
  other: number
  otherKinds: string
  sample: string
}

function refEdges(ctx: GameContext, indexPath: string, name: string): RefScan {
  const rows = ctx.db
    .query(
      `SELECT c.caller_path, o.kind, o.super_path
       FROM calls c LEFT JOIN objects o ON o.path = c.caller_path
       WHERE c.kind = 'ref' AND (c.callee_path = ? OR (c.callee_path IS NULL AND c.callee_name = ? COLLATE NOCASE))`,
    )
    .all(indexPath, name) as Array<{ caller_path: string; kind: string | null; super_path: string | null }>
  let superstruct = 0
  const others = new Map<string, number>()
  const sample: string[] = []
  for (const r of rows) {
    if (r.super_path === indexPath) superstruct++
    else others.set(r.kind ?? 'unknown', (others.get(r.kind ?? 'unknown') ?? 0) + 1)
    if (sample.length < MAX_SAMPLE) sample.push(`${r.caller_path} (${r.kind ?? 'unknown'})`)
  }
  return {
    total: rows.length,
    superstruct,
    other: rows.length - superstruct,
    otherKinds: [...others.entries()]
      .map(([kind, count]) => `${kind}=${count}`)
      .sort()
      .join(', '),
    sample: sample.join('; '),
  }
}

function subclassesOf(ctx: GameContext, indexPath: string): Array<{ path: string; is_blueprint: number }> {
  return ctx.db
    .query('SELECT path, is_blueprint FROM objects WHERE super_path = ? ORDER BY is_blueprint DESC, path')
    .all(indexPath) as Array<{ path: string; is_blueprint: number }>
}

function assetPathOf(ctx: GameContext, indexPath: string): string | null {
  const row = ctx.db.query('SELECT asset_path FROM bp_classes WHERE path = ?').get(indexPath) as
    | { asset_path: string | null }
    | null
  return row?.asset_path ?? null
}

function classPatterns(hookPath: string | null, name: string, assetPath: string | null): { strong: string[]; weak: string } {
  const strong: string[] = []
  const hook = hookPath ?? ''
  if (hook.startsWith('/Script/')) strong.push(hook)
  const asset = assetPath ?? (hook.startsWith('/Game/') ? hook.split(':')[0].replace(/\.[^.]+$/, '') : null)
  if (asset && asset.startsWith('/Game/')) strong.push(`Content/${asset.slice('/Game/'.length)}`)
  if (name.endsWith('_C')) strong.push(name)
  return { strong, weak: name.endsWith('_C') ? name.slice(0, -2) : name }
}

export function handleEventSurface(ctx: GameContext, config: ServerConfig, args: EventSurfaceArgs): string {
  const echo = versionEchoFields(ctx)
  const limit = clamp(Math.trunc(args.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1, MAX_RESULTS)
  const depth = clamp(Math.trunc(args.depth ?? 1), 0, MAX_DEPTH)
  const fail = (status: string, extra: Record<string, Scalar>): string =>
    renderAiText({ reportType: 'event_surface', fields: { ...echo, status, query: args.class_path, ...extra } })

  const missing = bpUnavailableHint(config)
  if (missing) {
    return fail('types_json_unavailable', {
      error: missing,
      hint: 'точки реакции читаются из types.json кита: пропиши kitDir через /ww-setup и собери кит — тогда события и диспетчеры станут видны. Пока класс и его связи ищи через ww_find_symbol, ww_get_type и ww_find_callers',
    })
  }
  const dump = readTypes(config)
  if (!dump) {
    return fail('types_json_unreadable', {
      types_json: typesJsonPath(config) ?? '—',
      error: 'types.json кита не разобрался как JSON',
      hint: 'файл пишет LoomBuild: пересобери кит, обрезанный или чужой файл не читается',
    })
  }

  const lookup = lookupObject(ctx, args.class_path)
  const obj: ObjectHit | null = lookup.hit
  const loomPath = obj ? loomPathOf(ctx, obj.path) : loomPathOf(ctx, args.class_path)
  const info = bpClass(ctx, config, obj ? obj.path : args.class_path)
  const cls = loomPath ? dump.classes[loomPath] : undefined

  if (!obj && !cls) {
    const suggestions = suggestSimilar(ctx, args.class_path)
    return fail('not_found', {
      loom_path: loomPath ?? '—',
      hint: lookup.isModPath
        ? 'путь мода: в индексе игры его нет — смотри события собранного мода в types.json, а разведку веди по игровому классу-родителю'
        : 'класс не найден ни в индексе, ни в types.json: найди точное имя через ww_find_symbol и повтори',
      suggestions: suggestions.length > 0 ? suggestions.join('; ') : 'нет',
    })
  }

  const resolvedIndex = obj?.path ?? loomPath ?? args.class_path
  if (obj && !CLASS_KIND_RE.test(obj.kind)) {
    return fail('not_a_class', {
      resolved_path: resolvedIndex,
      kind: obj.kind,
      loom_path: loomPath ?? '—',
      hint: 'точки реакции есть только у классов: у функции смотри ww_find_callers, у структуры и енума — ww_get_type',
    })
  }

  const results: AiTextResult[] = []
  const fields: Record<string, Scalar> = {
    ...echo,
    status: cls ? 'ok' : 'class_not_in_types',
    query: args.class_path,
    resolved_path: resolvedIndex,
    loom_path: loomPath ?? '—',
    kind: obj?.kind ?? 'Class',
    is_blueprint: obj ? obj.is_blueprint === 1 : Boolean(info?.is_game_blueprint),
    depth,
    limit,
    limit_scope: 'на секцию: делегаты ModAPI, диспетчеры класса, диспетчеры полей, события — считаются по отдельности',
    sources: 'types.json кита (диспетчеры и события) + index.db (подтверждение полей, DataTable, xref)',
  }
  if (info?.editor_only) fields.editor_only = 'класс только для редактора: в игре его нет'
  if (cls?.interface) fields.interface = 'интерфейс: его функции реализуются через implements, а не наследованием'
  if (!cls) fields.note = info?.note ?? 'класса нет в types.json: диспетчеры и события перечислить нечем'

  let point = 0
  let truncated = false
  const shown: Record<string, number> = { modapi: 0, dispatcher: 0, field: 0, event: 0 }
  const take = (section: string): boolean => {
    if ((shown[section] ?? 0) >= limit) {
      truncated = true
      return false
    }
    shown[section] = (shown[section] ?? 0) + 1
    point++
    return true
  }

  const modapiDelegates = delegatePoints(ctx, config, dump, MODAPI_LOOM)
  const modapiCall = bpFunction(ctx, config, 'SystemCore.ModAPI', 'GetModAPI')
  const modapiReceiver = modapiCall?.loom_call ? modapiCall.loom_call.split(' -> ')[0] : null
  if (modapiDelegates.length === 0) {
    fields.modapi = `${MODAPI_LOOM} нет в types.json: глобальные делегаты ModAPI перечислить нечем`
  } else {
    for (const d of modapiDelegates) {
      if (!take('modapi')) break
      const callback = callbackName(d.name)
      const receiver = modapiReceiver ?? '<объект: ModAPI>'
      results.push({
        fields: {
          point,
          kind: 'modapi_delegate',
          preference: 1,
          name: d.name,
          owner: d.owner,
          signature: signatureText(d.signature),
          callback: `fn ${callback}(${paramsOf(d.signature)}) { }`,
          bind: bindHint(receiver, d.name, callback),
          scope: 'глобальный: подписка доступна из любой точки мода',
          evidence: `types.json ${d.owner}: ${d.name} = multicast_delegate; ${propertyEvidence(ctx, d.owner, d.name)}`,
          verify: traceHint(ctx, d.owner, d.name, true),
          ...(modapiReceiver ? { receiver_from: 'ww_get_function SystemCore.ModAPI.GetModAPI → loom_call' } : {}),
        },
      })
    }
  }

  if (cls) {
    const ownDelegates = delegatePoints(ctx, config, dump, loomPath!)
    const modapiNames = new Set(modapiDelegates.map((d) => d.name))
    const emitted = new Set<string>([...modapiNames, ...ownDelegates.map((d) => d.name)])
    for (const d of ownDelegates) {
      if (d.owner === MODAPI_LOOM && modapiNames.has(d.name)) continue
      if (!take('dispatcher')) break
      const callback = callbackName(d.name)
      const ret = returnsOf(d.signature)
      results.push({
        fields: {
          point,
          kind: 'dispatcher',
          preference: 2,
          name: d.name,
          owner: d.owner,
          ...(d.owner === loomPath ? {} : { inherited_from: d.owner }),
          signature: signatureText(d.signature),
          callback: `fn ${callback}(${paramsOf(d.signature)}) { }`,
          bind: bindHint('self', d.name, callback),
          evidence: `types.json ${d.owner}: ${d.name} = multicast_delegate; ${propertyEvidence(ctx, d.owner, d.name)}`,
          verify: traceHint(ctx, d.owner, d.name, true),
          ...(ret ? { note: `делегат отдаёт ${ret}: Loom биндит только функции без возврата` } : {}),
        },
      })
    }

    const fieldPoints = fieldDelegatePoints(ctx, config, dump, loomPath!, depth, emitted)
    for (const fp of fieldPoints.dispatchers) {
      if (!take('field')) break
      const callback = callbackName(fp.delegate)
      const receiver = `<объект: ${fp.ownerShort}>`
      results.push({
        fields: {
          point,
          kind: 'field_dispatcher',
          preference: 2,
          name: fp.delegate,
          owner: fp.owner,
          via: `${fp.via} (${fp.viaType})`,
          field_depth: fp.depth,
          signature: signatureText(fp.signature),
          callback: `fn ${callback}(${paramsOf(fp.signature)}) { }`,
          bind: bindHint(receiver, fp.delegate, callback),
          evidence: `types.json ${fp.owner}: ${fp.delegate} = multicast_delegate; поле ${fp.via} объявлено в ${fp.viaOwner}`,
          verify: traceHint(ctx, fp.owner, fp.delegate, true),
          note: `биндится на объект из поля ${fp.via}: подставь свою переменную типа ${fp.ownerShort}`,
        },
      })
    }
    if (fieldPoints.skipped > 0) {
      fields.field_classes_skipped = `${fieldPoints.skipped} классов из полей не обойдено (лимит ${MAX_FIELD_CLASSES} на глубине ${depth})`
    }

    const events = eventsOf(dump, loomPath!).sort((a, b) => {
      const rank = (e: EventPoint): number => (e.nativeOwner ? 0 : 1)
      return rank(a) - rank(b) || a.name.localeCompare(b.name)
    })
    for (const e of events) {
      if (!take('event')) break
      const flags = Array.isArray(e.fn.flags) ? e.fn.flags : []
      const inDump = functionRow(ctx, e.owner, e.name)
      results.push({
        fields: {
          point,
          kind: 'event',
          preference: 3,
          name: e.name,
          owner: e.owner,
          ...(e.nativeOwner && e.nativeOwner !== e.owner ? { native_declaration: e.nativeOwner } : {}),
          declared_in: e.owner.startsWith('/Script/') ? 'c++ (игра может звать сама)' : 'Blueprint',
          signature: signatureText(signatureOf(e.fn.params)),
          handler: handlerText(e.name, signatureOf(e.fn.params)),
          flags: flags.join(', ') || '—',
          overridable: flags.includes('not_callable')
            ? 'только переопределить: вызвать нельзя'
            : 'переопределить и вызвать: у родителя есть реализация, в обработчике доступно super.Имя(...)',
          evidence: `types.json ${e.owner}: ${e.name} flags=[${flags.join(', ')}]; индекс: ${
            inDump ? 'функция есть в дампе' : 'функции в дампе нет'
          }`,
          verify: traceHint(ctx, e.owner, e.name, false),
        },
      })
    }
    if (events.length === 0 && ownDelegates.length === 0 && fieldPoints.dispatchers.length === 0) {
      fields.no_points = 'ни диспетчеров, ни событий у класса нет: остаются делегаты ModAPI и Tick'
    }

    appendEvidence(ctx, results, fields, obj, resolvedIndex, limit)
    appendTickFallback(ctx, results, dump, loomPath!, events)
  } else {
    appendEvidence(ctx, results, fields, obj, resolvedIndex, limit)
    appendTickFallback(ctx, results, dump, null, null)
  }

  fields.points = point
  fields.hint =
    'точки идут по убыванию предпочтения: 1 делегаты ModAPI → 2 диспетчеры класса и его полей → 3 переопределяемые события и следы спавна → 4 Tick. Поле verify — как проверить точку вживую, evidence — откуда взяты данные'
  return renderAiText({ reportType: 'event_surface', fields, results, truncated, totalFound: point })
}

interface FieldDispatcher {
  delegate: string
  owner: string
  ownerShort: string
  signature: RawSignatureParam[]
  via: string
  viaType: string
  viaOwner: string
  viaClass: string
  depth: number
}

const ENGINE_CLASS_RE = /^\/Script\/(Engine|UMG|Slate|SlateCore|CoreUObject|InputCore|MovieScene|AIModule|NavigationSystem)\./

function fieldDelegatePoints(
  ctx: GameContext,
  config: ServerConfig,
  dump: LoomDump,
  classPath: string,
  depth: number,
  emitted: Set<string>,
): { dispatchers: FieldDispatcher[]; skipped: number } {
  const dispatchers: FieldDispatcher[] = []
  const visited = new Set<string>(lineageOf(dump, classPath).map((l) => l.path))
  visited.add(MODAPI_LOOM)
  const seenDelegate = new Set<string>(emitted)
  let frontier = [classPath]
  let budget = MAX_FIELD_CLASSES
  let skipped = 0

  for (let level = 1; level <= depth; level++) {
    const candidates: Array<{ target: string; via: string; viaType: string; viaOwner: string }> = []
    for (const owner of frontier) {
      for (const link of lineageOf(dump, owner)) {
        for (const [fieldName, prop] of Object.entries(link.cls.properties ?? {})) {
          for (const target of objectClassesIn(prop)) {
            if (visited.has(target)) continue
            visited.add(target)
            candidates.push({ target, via: fieldName, viaType: String(prop.type ?? ''), viaOwner: link.path })
          }
        }
      }
    }
    const next: string[] = []
    for (const c of candidates) {
      if (budget <= 0) {
        skipped++
        continue
      }
      budget--
      const cls = dump.classes[c.target]
      if (!cls || cls.editor_only) continue
      next.push(c.target)
      for (const d of delegatePoints(ctx, config, dump, c.target)) {
        if (seenDelegate.has(d.name)) continue
        seenDelegate.add(d.name)
        dispatchers.push({
          delegate: d.name,
          owner: d.owner,
          ownerShort: d.owner.slice(d.owner.lastIndexOf('.') + 1),
          signature: d.signature,
          via: c.via,
          viaType: c.viaType,
          viaOwner: c.viaOwner,
          viaClass: c.target,
          depth: level,
        })
      }
    }
    if (next.length === 0) break
    frontier = next
  }
  dispatchers.sort((a, b) => {
    const rank = (f: FieldDispatcher): number => (ENGINE_CLASS_RE.test(f.viaClass) ? 1 : 0)
    return rank(a) - rank(b) || a.depth - b.depth || a.via.localeCompare(b.via) || a.delegate.localeCompare(b.delegate)
  })
  return { dispatchers, skipped }
}

function appendEvidence(
  ctx: GameContext,
  results: AiTextResult[],
  fields: Record<string, Scalar>,
  obj: ObjectHit | null,
  resolvedIndex: string,
  limit: number,
): void {
  if (!obj) {
    fields.spawn_evidence = 'класса нет в индексе: следов спавна (DataTable, xref) по нему не видно'
    return
  }
  const refs = refEdges(ctx, obj.path, obj.name)
  const subs = subclassesOf(ctx, obj.path)
  const bpSubs = subs.filter((s) => s.is_blueprint === 1)

  const { strong, weak } = classPatterns(obj.hook_path, obj.name, assetPathOf(ctx, obj.path))
  const scan = datatableCandidates(
    ctx,
    strong.map((pattern) => ({ pattern, klass: obj.path })),
  )
  const subPatterns = bpSubs
    .slice(0, MAX_SUBCLASS_SCAN)
    .map((s) => ({ pattern: s.path.slice(s.path.lastIndexOf('.') + 1), klass: s.path }))
    .filter((p) => p.pattern.endsWith('_C'))
  const subScan = subPatterns.length > 0 ? datatableCandidates(ctx, subPatterns) : null
  const weakScan =
    scan.total === 0 && (subScan?.total ?? 0) === 0 && weak.length >= 4
      ? datatableCandidates(ctx, [{ pattern: weak, klass: obj.path }])
      : null

  const found = new Map<string, DtRow>()
  for (const r of [...scan.rows, ...(subScan?.rows ?? []), ...(weakScan?.rows ?? [])]) found.set(`${r.table}|${r.row}`, r)

  results.push({
    fields: {
      kind: 'spawn_evidence',
      preference: 3,
      index_path: obj.path,
      subclasses_total: subs.length,
      subclasses_bp: bpSubs.length,
      subclasses_sample: subs.slice(0, MAX_SAMPLE).map((s) => s.path).join('; ') || 'нет',
      refs_total: refs.total,
      refs_superstruct: refs.superstruct,
      refs_other: refs.other,
      refs_other_kinds: refs.otherKinds || 'нет',
      refs_sample: refs.sample || 'нет',
      verdict:
        found.size > 0
          ? 'класс (или его подкласс) стоит в DataTable: игру можно переключить на свой класс через ModAPI.WriteDataTableValue — строку смотри в кандидатах ниже'
          : subs.length > 0
            ? 'наследники в игре есть, но в DataTable их имён не нашлось: подмены класса не видно, наследника придётся спавнить самому'
            : 'ни наследников, ни ссылок из DataTable: класс нигде не подставляется — реагировать можно подпиской на его делегаты, а свой класс придётся спавнить самому',
      caveat: 'xref покрывает только просканированный при сборке индекса prefix BP-байткода',
    },
  })

  const shown: DtRow[] = []
  const push = (r: DtRow, matchKind: string): void => {
    if (shown.length >= MAX_DT_SHOWN || shown.some((x) => x.table === r.table && x.row === r.row)) return
    shown.push(r)
    results.push({
      fields: {
        kind: 'datatable_candidate',
        preference: 3,
        table: r.table,
        row: r.row,
        class: r.klass,
        match: r.match,
        match_kind: matchKind,
        snippet: r.snippet,
      },
    })
  }
  for (const r of scan.rows) push(r, 'путь класса')
  for (const r of subScan?.rows ?? []) push(r, `имя подкласса (просканировано ${subPatterns.length} из ${bpSubs.length})`)
  for (const r of weakScan?.rows ?? []) push(r, 'короткое имя: слабое совпадение, проверь строку целиком')
  if (found.size === 0) {
    fields.datatable =
      subPatterns.length > 0
        ? `класс и имена его подклассов (${subPatterns.length} шт.) в DataTable не встречаются — подмены через WriteDataTableValue тут не видно`
        : 'класс в DataTable не встречается: подмены через WriteDataTableValue тут не видно'
  } else {
    fields.datatable = `строк-кандидатов ${found.size}; подстрочный поиск — КАНДИДАТ, а не факт: строку сверяй целиком через ww_get_datatable <таблица> row=<строка>. Подмена — ModAPI.WriteDataTableValue, и таблица у него адресуется ключом modTables (например GridActors), а не именем ассета: сверь ключ через ModAPI.ListDataTables`
  }
  const matchedClasses = [...new Set([...found.values()].map((r) => r.klass))]
  if (matchedClasses.length > 0) {
    fields.datatable_classes = `${matchedClasses.slice(0, MAX_SAMPLE * 3).join(', ')}${
      matchedClasses.length > MAX_SAMPLE * 3 ? ` … всего ${matchedClasses.length}` : ''
    }`
  }
  const tables = new Set([...scan.tables, ...(subScan?.tables ?? []), ...(weakScan?.tables ?? [])])
  if (tables.size > 0) fields.datatable_tables = [...tables].sort().join(', ')
}

function appendTickFallback(
  ctx: GameContext,
  results: AiTextResult[],
  dump: LoomDump,
  classPath: string | null,
  events: EventPoint[] | null,
): void {
  if (classPath && dump.classes[classPath]?.interface === true) return
  const tick = classPath
    ? eventsOf(dump, classPath).find((e) => e.name === 'ReceiveTick' || e.name === 'Tick') ?? null
    : null
  const isActorTick = tick?.name === 'ReceiveTick'
  const actorLike = classPath
    ? lineageOf(dump, classPath).some((l) => l.path === '/Script/Engine.Actor' || l.path === '/Script/Engine.ActorComponent')
    : false
  const tickHandler = tick ? handlerText(tick.name, signatureOf(tick.fn.params)) : 'on ReceiveTick(DeltaSeconds: float)'
  const actorRecipe = ['default PrimaryActorTick.bTickEvenWhenPaused = true', '', bodyText(tickHandler)].join('\n')
  results.push({
    fields: {
      kind: 'tick_fallback',
      preference: 4,
      when: 'последнее средство: ни делегата, ни события, которое игра зовёт сама',
      tick_event: tick
        ? `${tick.name} (${tick.owner})`
        : actorLike
          ? 'ReceiveTick есть у Actor, но в types.json не нашёлся'
          : 'нет: класс не Actor и не виджет — тика у него нет',
      paused_recipe: isActorTick
        ? 'default PrimaryActorTick.bTickEvenWhenPaused = true'
        : actorLike
          ? 'нет: PrimaryActorTick — поле Actor, тик компонента идёт не через него'
          : '—',
      tick_group: isActorTick ? 'SetTickGroup(ETickingGroup.TG_PostUpdateWork) в on ReceiveBeginPlay' : '—',
      verify: tick ? traceHint(ctx, tick.owner, tick.name, false) : '—',
      ...(events ? { events_available: events.length } : {}),
      note: actorLike || tick
        ? 'Tick — последним: он крутится каждый кадр, а делегат и событие приходят по факту'
        : 'тика у класса нет: кроме делегатов ModAPI и своих диспетчеров реагировать не на что',
    },
    ...(tick || actorLike ? { blocks: { recipe: tick && !isActorTick ? bodyText(tickHandler) : actorRecipe } } : {}),
  })
}

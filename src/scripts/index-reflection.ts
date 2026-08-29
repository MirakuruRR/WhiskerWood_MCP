import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { INDEX_SCHEMA_SQL, INDEX_SCHEMA_VERSION } from '../schema'
import { ServerConfig } from '../config'
import { lastSegment, normalizeDumpPath, outerOf, packageOf } from './parsers/path-forms'
import { parseObjectDump } from './parsers/object-dump'
import { BP_KINDS, OLD_SCALAR_TYPES, parseGObjectsDump } from './parsers/gobjects'
import { parseUsmap, usmapTypeToString } from './parsers/usmap'
import { parseUhtModules, UhtFunction } from './parsers/uht'
import { parseAssetRegistry } from './parsers/asset-registry'

export interface BuildMeta {
  [key: string]: string | number
}

export interface BuildSummary {
  meta: BuildMeta
  acceptance: {
    setResearchTopicFound: boolean
    startResearchFound: boolean
    mouseBlipHookPath: string | null
  }
}

const GAME_MODULES = ['ProjectArco', 'SystemCore', 'LowCore', 'NauticalKit', 'ShaderCore']
const BP_ASSET_CLASSES = new Set(['Blueprint', 'WidgetBlueprint', 'AnimBlueprint'])
const GENERATED_CLASSES = new Set(['BlueprintGeneratedClass', 'WidgetBlueprintGeneratedClass', 'AnimBlueprintGeneratedClass'])

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk)
  return hash.digest('hex')
}

export interface ReflectionInputs {
  objectDumpPath: string
  oldDumpPath: string | null
  usmapPath: string
  uhtDir: string
  assetRegistryPath: string
  gameVersion: string
  engineVersion: string
  exeSize: number
  exeSha256: string
  ue4ssVersion: string
  dumpCapturedAt: string
}

export async function buildReflectionIndex(dbPath: string, cfg: ServerConfig, inputs: ReflectionInputs): Promise<BuildSummary> {
  const meta: BuildMeta = {}

  const dump = await parseObjectDump(inputs.objectDumpPath)
  meta.dump_lines_total = dump.counters.linesTotal
  meta.dump_inner_no_addr = dump.counters.innerNoAddr
  meta.dump_enum_value_lines = dump.counters.enumValueLines
  meta.dump_unparsed_lines = dump.counters.unparsed
  meta.unresolved_sps = 0
  meta.unresolved_pc = dump.counters.unresolvedPc
  meta.unresolved_ss = dump.counters.unresolvedSs
  meta.unresolved_ai = dump.counters.unresolvedAi
  meta.unresolved_em = dump.counters.unresolvedEm
  meta.unresolved_ic = dump.counters.unresolvedIc
  meta.unresolved_df = dump.counters.unresolvedDf
  meta.unresolved_kv = dump.counters.unresolvedKv
  meta.unresolved_owr = dump.counters.unresolvedOwr

  const usmap = await parseUsmap(inputs.usmapPath)
  const registry = await parseAssetRegistry(inputs.assetRegistryPath)
  const uht = parseUhtModules(inputs.uhtDir, GAME_MODULES)
  meta.uht_functions = uht.size
  meta.usmap_names = usmap.names.length
  meta.usmap_enums = usmap.enums.length
  meta.usmap_schemas = usmap.schemas.length
  meta.registry_names = registry.names.length
  meta.registry_asset_records = registry.assets.length
  meta.registry_resync_skips = registry.recordsSkippedByResync

  interface ObjAcc {
    path: string
    kind: string
    package: string
    outerPath: string | null
    name: string
    dumpIndex: number | null
    superPath: string | null
    isBlueprint: number
    gameFullPath: string | null
    hookPath: string | null
    objectPath: string | null
    hookStatus: 'ok' | 'bp_asset_unresolved' | 'bp_asset_ambiguous'
    source: 'new' | 'old'
  }

  const objects = new Map<string, ObjAcc>()
  const ambiguousBp = new Map<string, string[]>()

  const addRawPath = (addr: string, kind: string, rawPath: string, isBlueprint: boolean, source: 'new' | 'old'): ObjAcc | null => {
    const norm = normalizeDumpPath(rawPath)
    let path = norm.indexPath
    const existing = objects.get(path)
    if (existing) {
      if (existing.source === 'new' || source === 'new') {
        if (!existing.gameFullPath && norm.gameFullPath) existing.gameFullPath = norm.gameFullPath
        return existing
      }
      const alt = norm.gameFullPath ?? `${path}__dup`
      path = alt
      if (isBlueprint) {
        const list = ambiguousBp.get(norm.indexPath) ?? [existing.path]
        list.push(path)
        ambiguousBp.set(norm.indexPath, list)
      }
    }
    const name = lastSegment(path)
    const row: ObjAcc = {
      path,
      kind,
      package: packageOf(path),
      outerPath: kind === 'Function' ? outerOf(path) : kind === 'Package' ? null : packageOf(path),
      name,
      dumpIndex: source === 'new' ? parseInt(addr, 16) : null,
      superPath: null,
      isBlueprint: isBlueprint ? 1 : 0,
      gameFullPath: norm.gameFullPath,
      hookPath: null,
      objectPath: null,
      hookStatus: 'ok',
      source,
    }
    objects.set(path, row)
    return row
  }

  for (const o of dump.objects) {
    addRawPath(o.addr, o.kind, o.rawPath, o.isBlueprint, 'new')
  }

  for (const o of dump.objects) {
    const row = objects.get(normalizeDumpPath(o.rawPath).indexPath)
    if (!row) continue
    const raw = dump.addrRows.get(o.addr)
    if (raw?.sps && !/^0+$/.test(raw.sps)) {
      const superRow = dump.addrRows.get(raw.sps)
      if (superRow) {
        row.superPath = normalizeDumpPath(superRow.rawPath).indexPath
      } else {
        meta.unresolved_sps = Number(meta.unresolved_sps ?? 0) + 1
      }
    }
  }

  const addrToIndexPath = new Map<string, string>()
  for (const o of dump.objects) {
    addrToIndexPath.set(o.addr, normalizeDumpPath(o.rawPath).indexPath)
  }

  const params = new Map<string, Array<{ ordinal: number; offset: number; propKind: string; name: string; typeName: string | null; innerType: string | null; isReturn: number; source: string }>>()
  const props = new Map<string, Array<{ ordinal: number; offset: number; propKind: string; name: string; typeName: string | null; innerType: string | null; source: string }>>()

  for (const m of dump.members) {
    const ownerIdx = addrToIndexPath.get(m.ownerAddr)
    if (!ownerIdx) continue
    const owner = objects.get(ownerIdx)
    if (!owner) continue
    const isReturn = m.name === 'ReturnValue' ? 1 : 0
    if (owner.kind === 'Function' || owner.kind === 'DelegateFunction' || owner.kind === 'SparseDelegateFunction') {
      let arr = params.get(owner.path)
      if (!arr) {
        arr = []
        params.set(owner.path, arr)
      }
      arr.push({
        ordinal: m.ordinal,
        offset: m.offset,
        propKind: m.propKind,
        name: m.name,
        typeName: m.resolved.typeName,
        innerType: m.resolved.innerType,
        isReturn,
        source: m.resolved.typeName ? 'objdump' : 'none',
      })
    } else {
      let arr = props.get(owner.path)
      if (!arr) {
        arr = []
        props.set(owner.path, arr)
      }
      arr.push({
        ordinal: m.ordinal,
        offset: m.offset,
        propKind: m.propKind,
        name: m.name,
        typeName: m.resolved.typeName,
        innerType: m.resolved.innerType,
        source: m.resolved.typeName ? 'objdump' : 'none',
      })
    }
  }

  let oldBpClasses = 0
  let oldBpFunctions = 0
  if (inputs.oldDumpPath && existsSync(inputs.oldDumpPath)) {
    const oldClasses = new Set<string>()
    for await (const obj of parseGObjectsDump(inputs.oldDumpPath)) {
      if (BP_KINDS.has(obj.kind)) {
        if (obj.name.startsWith('Default__')) continue
        if (objects.has(obj.path)) continue
        const row: ObjAcc = {
          path: obj.path,
          kind: obj.kind,
          package: obj.package,
          outerPath: obj.package,
          name: obj.name,
          dumpIndex: obj.dumpIndex,
          superPath: null,
          isBlueprint: 1,
          gameFullPath: null,
          hookPath: null,
          objectPath: null,
          hookStatus: 'ok',
          source: 'old',
        }
        objects.set(obj.path, row)
        oldClasses.add(obj.path)
        oldBpClasses++
      } else if (obj.kind === 'Function' && obj.outerPath && oldClasses.has(obj.outerPath)) {
        if (objects.has(obj.path)) continue
        objects.set(obj.path, {
          path: obj.path,
          kind: 'Function',
          package: packageOf(obj.path),
          outerPath: obj.outerPath,
          name: obj.name,
          dumpIndex: obj.dumpIndex,
          superPath: null,
          isBlueprint: 0,
          gameFullPath: null,
          hookPath: null,
          objectPath: null,
          hookStatus: 'ok',
          source: 'old',
        })
        const arr = obj.members.map((mm) => ({
          ordinal: mm.ordinal,
          offset: mm.offset,
          propKind: mm.propKind,
          name: mm.name,
          typeName: OLD_SCALAR_TYPES[mm.propKind] ?? null,
          innerType: null,
          isReturn: mm.name === 'ReturnValue' ? 1 : 0,
          source: OLD_SCALAR_TYPES[mm.propKind] ? 'objdump' : 'none',
        }))
        params.set(obj.path, arr)
        oldBpFunctions++
      }
    }
  }
  meta.union_bp_classes_from_menu_dump = oldBpClasses
  meta.union_bp_functions_from_menu_dump = oldBpFunctions

  const registryAssetsByPath = new Map<string, { name: string; className: string }>()
  const bpAssetNames = new Map<string, string[]>()
  for (const a of registry.assets) {
    const prev = registryAssetsByPath.get(a.pkgPath)
    const generated = GENERATED_CLASSES.has(a.className)
    if (!prev || (generated === false && GENERATED_CLASSES.has(prev.className))) {
      registryAssetsByPath.set(a.pkgPath, { name: a.assetName, className: a.className })
    }
    if (BP_ASSET_CLASSES.has(a.className)) {
      const list = bpAssetNames.get(a.assetName) ?? []
      list.push(a.pkgPath)
      bpAssetNames.set(a.assetName, list)
    }
  }
  meta.registry_assets = registryAssetsByPath.size
  meta.registry_bp_assets = [...registryAssetsByPath.values()].filter((v) => BP_ASSET_CLASSES.has(v.className)).length

  interface BpAcc {
    path: string
    package: string
    kind: string
    assetPath: string | null
    objectPath: string | null
    resolution: 'ok' | 'not_found' | 'ambiguous'
    candidates: string | null
  }
  const bpClasses: BpAcc[] = []
  let bpFromDumpPath = 0
  let bpFromRegistry = 0
  let bpUnresolved = 0

  for (const row of objects.values()) {
    if (!row.isBlueprint) continue
    const className = row.name
    let assetPath: string | null = null
    let resolution: BpAcc['resolution'] = 'ok'
    let candidates: string | null = null

    if (row.gameFullPath) {
      const dotIdx = row.gameFullPath.lastIndexOf('.')
      assetPath = row.gameFullPath.slice(0, dotIdx)
      if (registryAssetsByPath.has(assetPath)) bpFromDumpPath++
    } else {
      const candidatesList = bpAssetNames.get(row.package) ?? []
      if (candidatesList.length === 1) {
        assetPath = candidatesList[0]
        bpFromRegistry++
      } else if (candidatesList.length === 0) {
        resolution = 'not_found'
        bpUnresolved++
      } else {
        resolution = 'ambiguous'
        candidates = candidatesList.join('\n')
        bpUnresolved++
      }
    }

    bpClasses.push({
      path: row.path,
      package: row.package,
      kind: row.kind,
      assetPath,
      objectPath: assetPath ? `${assetPath}.${className}` : null,
      resolution,
      candidates,
    })
  }
  meta.bp_hook_path_from_dump = bpFromDumpPath
  meta.bp_hook_path_from_registry = bpFromRegistry
  meta.bp_unresolved = bpUnresolved

  const bpByPath = new Map(bpClasses.map((b) => [b.path, b]))

  for (const row of objects.values()) {
    if (row.kind === 'Package') continue
    if (row.kind === 'Enum' || row.kind === 'ScriptStruct') {
      row.objectPath = row.gameFullPath ?? `/Script/${row.path}`
      continue
    }
    const isFunc = row.kind === 'Function'
    const isClassLike = row.kind === 'Class' || GENERATED_CLASSES.has(row.kind)
    if (!isFunc && !isClassLike) continue

    if (row.isBlueprint || (row.outerPath && bpByPath.has(row.outerPath))) {
      let bp: BpAcc | undefined
      let funcName: string | null = null
      if (isFunc) {
        bp = bpByPath.get(row.outerPath ?? '')
        funcName = row.name
      } else {
        bp = bpByPath.get(row.path)
      }
      if (bp?.assetPath) {
        const classPath = `${bp.assetPath}.${lastSegment(bp.path)}`
        row.hookPath = funcName ? `${classPath}:${funcName}` : classPath
        row.objectPath = row.hookPath
        row.hookStatus = 'ok'
      } else {
        row.hookPath = null
        row.hookStatus = bp?.resolution === 'ambiguous' ? 'bp_asset_ambiguous' : 'bp_asset_unresolved'
      }
      continue
    }

    if (row.gameFullPath) {
      row.hookPath = row.gameFullPath
      row.objectPath = row.gameFullPath
      continue
    }

    if (isFunc) {
      const outer = row.outerPath
      if (!outer) continue
      row.hookPath = `/Script/${outer}:${row.name}`
    } else {
      row.hookPath = `/Script/${row.path}`
    }
    row.objectPath = row.hookPath
  }

  let objectPathOnly = 0
  for (const row of objects.values()) {
    if (row.objectPath && !row.hookPath) objectPathOnly++
  }
  meta.objects_object_path_only = objectPathOnly

  const uhtMerged = { params: 0, returns: 0, outParams: 0 }
  for (const [funcPath, arr] of params) {
    const pkg = packageOf(funcPath)
    if (!GAME_MODULES.includes(pkg)) continue
    const outer = outerOf(funcPath)
    if (!outer) continue
    const className = lastSegment(outer)
    const funcName = lastSegment(funcPath)
    const uhtFn: UhtFunction | undefined = uht.get(`${pkg}:${className}.${funcName}`)
    if (!uhtFn) continue
    for (const p of arr) {
      if (p.isReturn) {
        if (uhtFn.returnType && uhtFn.returnType !== 'void') {
          p.typeName = uhtFn.returnType
          p.innerType = null
          p.source = 'uht'
          uhtMerged.returns++
        }
        continue
      }
      const up = uhtFn.params.find((x) => x.name === p.name)
      if (!up) continue
      if (up.type) {
        p.typeName = up.type
        p.innerType = null
        p.source = 'uht'
        uhtMerged.params++
      }
      if (up.isOut) uhtMerged.outParams++
      ;(p as { isOut?: number }).isOut = up.isOut ? 1 : 0
    }
  }
  meta.uht_params_merged = uhtMerged.params
  meta.uht_returns_merged = uhtMerged.returns
  meta.uht_out_params = uhtMerged.outParams

  const moduleOfPathIdx = (pathIdx: number | null): string | null => {
    if (pathIdx === null) return null
    const p = usmap.names[pathIdx]
    if (!p) return null
    const lastSlash = p.lastIndexOf('/')
    const tail = lastSlash >= 0 ? p.slice(lastSlash + 1) : p
    const dot = tail.indexOf('.')
    return dot >= 0 ? tail.slice(0, dot) : tail
  }

  const enumObjectsByName = new Map<string, ObjAcc[]>()
  for (const row of objects.values()) {
    if (row.kind !== 'Enum') continue
    const list = enumObjectsByName.get(row.name) ?? []
    list.push(row)
    enumObjectsByName.set(row.name, list)
  }

  interface EnumAcc {
    enumPath: string
    values: Array<{ name: string; value: number }>
  }
  const enumRows: EnumAcc[] = []
  let enumsMatched = 0
  let enumsUnmatched = 0
  for (const e of usmap.enums) {
    const enumName = usmap.names[e.nameIdx]
    const candidates = enumObjectsByName.get(enumName) ?? []
    let target: ObjAcc | undefined
    if (candidates.length === 1) {
      target = candidates[0]
    } else if (candidates.length > 1) {
      const module = moduleOfPathIdx(e.pathIdx)
      target = candidates.find((c) => c.package === module)
    }
    if (!target) {
      enumsUnmatched++
      continue
    }
    enumsMatched++
    enumRows.push({
      enumPath: target.path,
      values: e.values.map((v) => ({ name: usmap.names[v.nameIdx], value: v.value })),
    })
  }
  meta.usmap_enums_matched = enumsMatched
  meta.usmap_enums_unmatched = enumsUnmatched

  let enumCrossCheckMismatches = 0
  let enumCrossChecked = 0
  for (const er of enumRows) {
    const shortName = lastSegment(er.enumPath)
    const dumpVals = dump.enumValues.get(shortName)
    if (!dumpVals) continue
    enumCrossChecked++
    const byName = new Map(er.values.map((v) => [v.name, v.value]))
    for (const dv of dumpVals) {
      const uv = byName.get(dv.name)
      if (uv === undefined || uv !== dv.value) {
        enumCrossCheckMismatches++
        break
      }
    }
  }
  meta.enum_cross_checked = enumCrossChecked
  meta.enum_cross_check_mismatches = enumCrossCheckMismatches

  const schemaByModuleAndName = new Map<string, (typeof usmap.schemas)[number]>()
  for (const s of usmap.schemas) {
    const module = moduleOfPathIdx(s.pathIdx)
    const key = `${module ?? ''}:${usmap.names[s.nameIdx]}`
    if (!schemaByModuleAndName.has(key)) schemaByModuleAndName.set(key, s)
  }

  let superFromUsmap = 0
  const classByName = new Map<string, ObjAcc[]>()
  for (const row of objects.values()) {
    if (row.kind !== 'Class' && row.kind !== 'ScriptStruct') continue
    const list = classByName.get(row.name) ?? []
    list.push(row)
    classByName.set(row.name, list)
  }

  for (const s of usmap.schemas) {
    if (s.superNameIdx === null) continue
    const schemaName = usmap.names[s.nameIdx]
    const superName = usmap.names[s.superNameIdx]
    const module = moduleOfPathIdx(s.pathIdx)
    const target = schemaByModuleAndName.get(`${module ?? ''}:${schemaName}`)
    if (!target) continue
    const candidates = classByName.get(schemaName) ?? []
    const obj = candidates.length === 1 ? candidates[0] : candidates.find((c) => c.package === module)
    if (!obj || obj.superPath) continue
    const superCandidates = classByName.get(superName) ?? []
    if (superCandidates.length === 1) {
      obj.superPath = superCandidates[0].path
      superFromUsmap++
    }
  }
  meta.super_from_usmap = superFromUsmap

  let usmapFilledProps = 0
  const fillFromUsmap = (ownerPath: string, arr: Array<{ name: string; typeName: string | null; innerType: string | null; source: string }>) => {
    const pkg = packageOf(ownerPath)
    const ownerName = lastSegment(ownerPath)
    const schema = schemaByModuleAndName.get(`${pkg}:${ownerName}`) ?? schemaByModuleAndName.get(`:${ownerName}`)
    if (!schema) return
    for (const p of arr) {
      if (p.typeName) continue
      const sp = schema.props.find((x) => usmap.names[x.nameIdx] === p.name)
      if (!sp) continue
      const t = usmapTypeToString(sp.type, usmap.names)
      if (t && t !== 'unknown') {
        p.typeName = t
        p.source = 'usmap'
        usmapFilledProps++
      }
    }
  }
  for (const [owner, arr] of props) fillFromUsmap(owner, arr)
  for (const [owner, arr] of params) fillFromUsmap(owner, arr)
  meta.usmap_filled_types = usmapFilledProps

  const bpAssetPathSet = new Set(bpClasses.filter((b) => b.resolution === 'ok' && b.assetPath).map((b) => b.assetPath!))
  let covered = 0
  let bpDenominator = 0
  for (const [pkgPath, info] of registryAssetsByPath) {
    if (!BP_ASSET_CLASSES.has(info.className)) continue
    bpDenominator++
    if (bpAssetPathSet.has(pkgPath)) covered++
  }
  const coverageRatio = bpDenominator > 0 ? covered / bpDenominator : 0
  meta.coverage_bp_ratio = Number(coverageRatio.toFixed(4))
  meta.coverage_bp_covered = covered
  meta.coverage_bp_denominator = bpDenominator

  meta.schema_version = INDEX_SCHEMA_VERSION
  meta.game_version = inputs.gameVersion
  meta.engine_version = inputs.engineVersion
  meta.exe_sha256 = inputs.exeSha256
  meta.exe_size = inputs.exeSize
  meta.dump_sha256 = await sha256OfFile(inputs.objectDumpPath)
  meta.usmap_sha256 = await sha256OfFile(inputs.usmapPath)
  meta.built_at = new Date().toISOString()
  meta.ue4ss_version = inputs.ue4ssVersion
  meta.type_source_primary = 'uht'
  meta.dump_captured_at = inputs.dumpCapturedAt
  meta.objects_total = dump.counters.objectsTotal
  meta.objects_indexed = objects.size
  meta.objects_skipped_by_kind = dump.counters.objectsSkippedByKind
  meta.cdo_skipped = dump.counters.cdoSkipped
  // Ответы спайков фазы 2, снятые на живой игре 2026-08-29 (см. 2026-08-29-phase2-results.md)
  meta.hook_path_separator = 'colon'
  meta.static_find_object_sees = 'loaded_only'

  const db = new Database(dbPath, { create: true })
  try {
    db.exec(INDEX_SCHEMA_SQL)
    db.exec('BEGIN')

    const insMeta = db.prepare('INSERT INTO profile_meta (key, value) VALUES (?, ?)')
    for (const [k, v] of Object.entries(meta)) insMeta.run(k, String(v))

    const insObj = db.prepare(
      'INSERT OR REPLACE INTO objects (path, kind, package, outer_path, name, dump_index, super_path, is_blueprint, hook_path, hook_path_status, object_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const row of objects.values()) {
      insObj.run(row.path, row.kind, row.package, row.outerPath, row.name, row.dumpIndex, row.superPath, row.isBlueprint, row.hookPath, row.hookStatus, row.objectPath)
    }

    const insBp = db.prepare(
      'INSERT OR REPLACE INTO bp_classes (path, package, kind, asset_path, object_path, resolution, candidates) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    for (const b of bpClasses) {
      insBp.run(b.path, b.package, b.kind, b.assetPath, b.objectPath, b.resolution, b.candidates)
    }

    const insProp = db.prepare(
      'INSERT OR REPLACE INTO properties (owner_path, ordinal, offset, prop_kind, name, type_name, inner_type, type_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const [owner, arr] of props) {
      for (const p of arr) {
        insProp.run(owner, p.ordinal, p.offset, p.propKind, p.name, p.typeName, p.innerType, p.source)
      }
    }

    const insParam = db.prepare(
      'INSERT OR REPLACE INTO function_params (function_path, ordinal, offset, prop_kind, name, type_name, inner_type, type_source, is_return, is_out) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const [func, arr] of params) {
      for (const p of arr) {
        const merged = (p as { isOut?: number }).isOut
        insParam.run(func, p.ordinal, p.offset, p.propKind, p.name, p.typeName, p.innerType, p.source, p.isReturn, merged ?? 0)
      }
    }

    const insEnum = db.prepare('INSERT OR REPLACE INTO enum_values (enum_path, ordinal, name, value) VALUES (?, ?, ?, ?)')
    for (const e of enumRows) {
      e.values.forEach((v, i) => insEnum.run(e.enumPath, i, v.name, v.value))
    }

    const insAsset = db.prepare('INSERT OR REPLACE INTO assets (asset_path, name, class_name, in_pak) VALUES (?, ?, ?, 1)')
    for (const [pkgPath, info] of registryAssetsByPath) {
      insAsset.run(pkgPath, info.name, info.className)
    }

    const insFtsSrc = db.prepare('INSERT INTO objects_fts_src (rowid, name, path, package, kind) VALUES (?, ?, ?, ?, ?)')
    const insFts = db.prepare('INSERT INTO symbols_fts (rowid, name, path, package, kind) VALUES (?, ?, ?, ?, ?)')
    let rowid = 0
    for (const row of objects.values()) {
      if (row.kind === 'Package') continue
      rowid++
      insFtsSrc.run(rowid, row.name, row.path, row.package, row.kind)
      insFts.run(rowid, row.name, row.path, row.package, row.kind)
    }

    db.exec('COMMIT')

    const setResearchTopic = db
      .query('SELECT path, hook_path FROM objects WHERE path = ? AND kind = ?')
      .get('SystemCore.UnlockResearchComponent.SetResearchTopic', 'Function') as { path: string; hook_path: string | null } | null
    const startResearch = db
      .query('SELECT path FROM objects WHERE path = ? AND kind = ?')
      .get('SystemCore.UnlockResearchComponent.startResearch', 'Function')
    const mmb = db
      .query('SELECT hook_path FROM objects WHERE path = ? AND kind = ?')
      .get('MouseMessageBlip.MouseMessageBlip_C.Construct', 'Function') as { hook_path: string | null } | null

    return {
      meta,
      acceptance: {
        setResearchTopicFound: Boolean(setResearchTopic?.hook_path),
        startResearchFound: Boolean(startResearch),
        mouseBlipHookPath: mmb?.hook_path ?? null,
      },
    }
  } finally {
    db.close()
  }
}

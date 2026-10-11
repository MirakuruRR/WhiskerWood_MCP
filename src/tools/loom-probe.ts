import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { ServerConfig } from '../config'
import { renderAiText, Scalar } from '../utils/ai-text'
import { kitStatus } from '../utils/kit'
import { describeRun, failureDetail, loomCheck } from '../utils/loom'
import { PathSandbox, PathSandboxError } from '../utils/path-sandbox'
import { translateCheckError } from './loom-validate'

export interface LoomProbeArgs {
  code: string
  parent?: string
  mod_name?: string
}

const REPORT_TYPE = 'loom_probe'
const PROBE_ASSET = '/Game/Probe/Probe'
const HEADER_RE = /^\s*(?:editor\s+blueprint|blueprint|enum|struct|interface)\s+[^\s:]+\s*(?::\s*\S+)?\s*at\s+(\/Game\/\S+)/m
const MOD_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const ASSET_RE = /\.(uasset|uexp|umap|ubulk|uplugin)$/i

function report(fields: Record<string, Scalar>, blocks?: Record<string, string>): string {
  return renderAiText({ reportType: REPORT_TYPE, fields, results: blocks ? [{ fields: {}, blocks }] : undefined })
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (!ASSET_RE.test(e.name)) out.push(p)
  }
  return out
}

function stampOf(path: string): string {
  try {
    const st = statSync(path)
    return `${st.size}:${st.mtimeMs}`
  } catch {
    return ''
  }
}

export async function handleLoomProbe(config: ServerConfig, args: LoomProbeArgs): Promise<string> {
  const st = kitStatus(config)
  if (!st.configured || !st.kit) {
    return report({ status: 'kit_not_configured', problem: st.problem ?? 'кит не настроен', hint: 'укажи kitDir в конфиге: без кита нет ни loom.exe, ни types.json' })
  }
  const kit = st.kit
  if (!existsSync(kit.typesJson)) {
    return report({ status: 'types_missing', hint: `нет ${kit.typesJson}: собери кит хотя бы раз (ww_loom_build) — LoomBuild дампит типы` })
  }
  const modName = (args.mod_name ?? '').trim()
  if (modName && (!MOD_NAME_RE.test(modName) || !existsSync(`${kit.contentMods}/${modName}`))) {
    return report({ status: 'mod_not_found', mod: modName, hint: `мода нет в ${kit.contentMods}` })
  }

  const code = args.code.replace(/^\uFEFF/, '')
  const header = HEADER_RE.exec(code)
  const asset = header ? header[1] : PROBE_ASSET
  const wrapLines = header ? 0 : 2
  const source = header ? code : `blueprint Probe : ${(args.parent ?? 'Actor').trim()} at ${PROBE_ASSET}\n\n${code}`
  if (modName && asset.startsWith(`/Game/Mods/${modName}/`)) {
    return report({ status: 'bad_args', asset, hint: 'заголовок кода указывает внутрь мода из mod_name — переименуй ассет, иначе он заменит файл мода в песочнице' })
  }

  const root = `${config.stateDir}/loom-probe`
  let file: string
  try {
    mkdirSync(root, { recursive: true })
    const sandbox = new PathSandbox([root])
    rmSync(sandbox.validateAndResolve(`${root}/Content`), { recursive: true, force: true })
    mkdirSync(`${root}/Intermediate/Loom`, { recursive: true })
    if (!existsSync(`${root}/Probe.uproject`)) writeFileSync(`${root}/Probe.uproject`, '{}')
    const types = `${root}/Intermediate/Loom/types.json`
    if (stampOf(kit.typesJson) !== stampOf(types)) copyFileSync(kit.typesJson, types)
    if (modName) {
      const from = `${kit.contentMods}/${modName}`
      for (const f of sourceFiles(from)) {
        const to = sandbox.validateAndResolve(`${root}/Content/Mods/${modName}/${f.slice(from.length + 1)}`)
        mkdirSync(to.replace(/[\\/][^\\/]+$/, ''), { recursive: true })
        copyFileSync(f, to)
      }
    }
    file = sandbox.validateAndResolve(`${root}/Content/${asset.slice('/Game/'.length)}.lm`)
    mkdirSync(file.replace(/[\\/][^\\/]+$/, ''), { recursive: true })
    writeFileSync(file, source)
  } catch (e) {
    return report({ status: e instanceof PathSandboxError ? 'sandbox_violation' : 'scratch_failed', error: (e as Error).message })
  }

  const run = await loomCheck({ ...kit, kitDir: root })
  const json = run.json as
    | { ok?: boolean; sources?: number; errors?: Array<{ file: string; line?: number; column?: number; message: string }>; missing?: string[] }
    | null
  if (!json) {
    return report({ status: 'check_failed', check: describeRun(run.result), error: run.parseError ?? failureDetail(run.result) })
  }

  const probeRel = `Content/${asset.slice('/Game/'.length)}.lm`
  const isProbe = (f: string): boolean => f.replace(/\\/g, '/').endsWith(probeRel)
  const errors = json.errors ?? []
  const own = errors.filter((e) => isProbe(e.file))
  const other = errors.length - own.length
  const missing = (json.missing ?? []).filter((m) => new RegExp(`\\b${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(code))

  const fields: Record<string, Scalar> = {
    status: own.length === 0 ? 'ok' : 'errors',
    check: describeRun(run.result),
    asset,
    ...(header ? {} : { wrapped: `blueprint Probe : ${(args.parent ?? 'Actor').trim()} — строки ошибок даны по присланному коду` }),
    ...(modName ? { context_mod: modName } : {}),
    errors: own.length,
    ...(other > 0 ? { context_errors: other } : {}),
    missing: missing.length > 0 ? missing.join('; ') : 'нет',
  }
  const blocks: Record<string, string> = {}
  if (own.length > 0) {
    blocks.errors = own
      .map((e) => {
        const line = Math.max((e.line ?? 0) - wrapLines, 0)
        const text = translateCheckError(e.message)
        return `${line}:${e.column ?? 0}: ${text}${text !== e.message ? ` (loom: ${e.message})` : ''}`
      })
      .join('\n')
  }
  const contextErrors = errors.filter((e) => !isProbe(e.file)).slice(0, 5)
  if (contextErrors.length > 0) {
    blocks.context_errors = contextErrors.map((e) => `${e.file.replace(/\\/g, '/').replace(/^.*?Content\//, 'Content/')}:${e.line ?? 0}: ${e.message}`).join('\n')
  }
  if (missing.length > 0) {
    fields.hint = 'missing — имена, которых нет в types.json: игровой Blueprint LoomBuild подгрузит при сборке, остальное похоже на опечатку или встроенное имя Loom; сверь через ww_find_symbol'
  } else if (own.length === 0) {
    fields.hint = 'loom check по типам кита прошёл; правила игры (ww_loom_validate) и сборка этот кусок не проверяли'
  }
  return report(fields, Object.keys(blocks).length > 0 ? blocks : undefined)
}

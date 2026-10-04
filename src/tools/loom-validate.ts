import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, relative } from 'node:path'
import { ServerConfig } from '../config'
import { GameContext, createGameContext, versionEchoFields } from '../utils/game-context'
import { AiTextResult, MAX_RESULTS, Scalar, renderAiText } from '../utils/ai-text'
import { KitPaths, kitStatus } from '../utils/kit'
import { JsonRun, describeRun, failureDetail, loomCheck } from '../utils/loom'
import { KitTypes, loadKitTypes } from '../utils/loom-kit-types'
import { LmSource, locateToken, parseLm, shortTypeName } from '../utils/lm-parser'
import { activePitfalls, PitfallHint } from './memory-common'
import { findByShortName } from './common'

export interface LoomValidateArgs {
  mod_root?: string
  mod_name?: string
  version?: string
}

type Severity = 'error' | 'warn' | 'info'

interface Finding {
  severity: Severity
  code: string
  file: string
  line: number
  column: number
  message: string
  extra?: Record<string, Scalar>
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 }

const WORLD_RECEIVERS = new Set([
  'GameplayStatics',
  'WidgetBlueprintLibrary',
  'KismetSystemLibrary',
  'KismetGameplayStatics',
  'KismetRenderingLibrary',
])

const WORLD_CALLS = new Set([
  'GetWorld',
  'GetAllActorsOfClass',
  'GetAllActorsOfClassWithTag',
  'GetPlayerController',
  'GetPlayerPawn',
  'GetPlayerCharacter',
  'SpawnActor',
  'SpawnObject',
  'GetAllWidgetsOfClass',
  'create_widget',
])

const CHECK_TRANSLATIONS: Array<{ re: RegExp; text: (m: RegExpExecArray) => string }> = [
  { re: /^unknown type '([^']+)'$/, text: (m) => `тип ${m[1]} не найден: его нет ни в типах кита, ни в игре` },
  { re: /^no variable ([^\s]+)$/, text: (m) => `${m[1]} не найден как переменная или тип` },
  {
    re: /^unexpected character '(.)'$/,
    text: (m) =>
      m[1] === '\uFEFF'
        ? 'файл начинается с BOM: Loom видит его как лишний символ и падает на строке 1. Сохрани .lm в UTF-8 без BOM'
        : `неожиданный символ '${m[1]}'`,
  },
  { re: /^expected an expression, found end of line$/, text: () => 'ожидалось выражение, а строка закончилась' },
  {
    re: /^(.+) must be saved as \.\.\.\/([^,]+), not (.+)$/,
    text: (m) => `${m[1]}: ассет обязан называться ${m[2]}, а заголовок говорит ${m[3]}`,
  },
  {
    re: /^its header says the (.+) is at (.+), but the file is at (.+); a source must be beside what it builds$/,
    text: (m) =>
      `заголовок говорит, что ${m[1]} лежит в ${m[2]}, а файл находится в ${m[3]}: исходник обязан лежать рядом с тем, что собирает`,
  },
  { re: /^no parent class (.+)$/, text: (m) => `класс-родитель ${m[1]} не найден` },
]

const FALLBACK_DEPRECATED_FIELDS = new Set(['ImageSize'])

const MEMORY_PITFALL_LIMIT = 5

interface Counters {
  logUnchecked: number
  pitfalls: number
  driftChecked: number
  driftMissing: number
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

function toPosix(from: string, to: string): string | null {
  const rel = relative(from, to)
  if (rel.startsWith('..') || rel === '') return null
  return rel.replace(/\\/g, '/')
}

function listFiles(dir: string, ext: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const full = `${dir}/${name}`
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) listFiles(full, ext, out)
    else if (name.toLowerCase().endsWith(ext)) out.push(full)
  }
  return out
}

/** Проект мода — ближайшая папка вверх с .uproject: то же правило, каким Loom ищет проект исходника. */
function findProjectRoot(from: string, fallback: string): string {
  let dir = normPath(from)
  for (let i = 0; i < 12; i++) {
    try {
      if (readdirSync(dir).some((f) => f.endsWith('.uproject'))) return dir
    } catch {
      break
    }
    const parent = dirname(dir).replace(/\\/g, '/')
    if (parent === dir) break
    dir = parent
  }
  return fallback
}

function translateCheckError(message: string): string {
  for (const t of CHECK_TRANSLATIONS) {
    const m = t.re.exec(message)
    if (m) return t.text(m)
  }
  return message
}

function isStringLiteral(text: string): boolean {
  const t = text.trim()
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"')
}

function literalText(text: string): string {
  const t = text.trim()
  return isStringLiteral(t) ? t.slice(1, -1) : t
}

function hasModPrefix(text: string, modName: string): boolean {
  const lower = text.toLowerCase()
  const mod = modName.toLowerCase()
  if (!lower.startsWith(mod)) return false
  const next = lower.charAt(mod.length)
  return next === '' || !/[a-z0-9_]/.test(next)
}

function shortName(path: string): string {
  return (path.split('.').pop() ?? path).replace(/_C$/, '')
}

function splitRoot(target: string): string | null {
  const first = /^[A-Za-z_]\w*/.exec(target.replace(/\s+/g, ''))
  return first ? first[0] : null
}

function membersAfterRoot(target: string): string[] {
  const flat = target.replace(/\s+/g, '').replace(/\[[^\]]*\]/g, '')
  return flat.split('.').filter((s) => s.length > 0).slice(1)
}

function worldCallOn(lm: LmSource, line: number): string | null {
  for (const call of lm.calls) {
    if (call.line !== line) continue
    if (WORLD_CALLS.has(call.name)) return call.name
    const head = call.receiver.split('.')[0]
    if (WORLD_RECEIVERS.has(head)) return `${head}.${call.name}`
  }
  return null
}

function deprecatedFields(ctx: GameContext | null): Set<string> {
  if (!ctx) return FALLBACK_DEPRECATED_FIELDS
  try {
    const rows = ctx.db
      .query(
        `SELECT name, COUNT(*) AS total, SUM(CASE WHEN type_name LIKE '%DeprecateSlateVector2D%' THEN 1 ELSE 0 END) AS dep
         FROM properties GROUP BY name HAVING dep > 0`,
      )
      .all() as Array<{ name: string; total: number; dep: number }>
    const out = new Set<string>()
    for (const r of rows) if (r.dep === r.total) out.add(r.name)
    return out.size > 0 ? out : FALLBACK_DEPRECATED_FIELDS
  } catch {
    return FALLBACK_DEPRECATED_FIELDS
  }
}

interface ModFiles {
  root: string
  name: string
  sources: string[]
  uplugin: string | null
  pal: string | null
  files: string[]
}

function collectMod(root: string): ModFiles {
  const name = basename(root)
  const files = listFiles(root, '')
  return {
    root,
    name,
    sources: files.filter((f) => f.toLowerCase().endsWith('.lm')).sort(),
    uplugin: files.find((f) => f.toLowerCase().endsWith('.uplugin')) ?? null,
    pal: files.find((f) => basename(f).toLowerCase() === `pal_${name.toLowerCase()}.uasset`) ?? null,
    files,
  }
}

function checkHeader(lm: LmSource, mod: ModFiles, out: Finding[]): void {
  const at = (line: number, column: number) => ({ file: lm.rel, line, column })
  if (!lm.header) {
    out.push({
      ...at(1, 1),
      severity: 'error',
      code: 'header_missing',
      message: 'нет строки заголовка: Loom не знает, что собирать из этого файла',
    })
    return
  }
  const header = lm.header
  if (header.kind !== 'blueprint' && header.kind !== 'editor_blueprint') return
  const expectedName = basename(lm.file).replace(/\.lm$/i, '')
  if (header.name !== expectedName) {
    out.push({
      ...at(header.line, 1),
      severity: 'error',
      code: 'blueprint_name_mismatch',
      message: `blueprint ${header.name}, а файл называется ${expectedName}.lm: ассет собирается по имени из заголовка, а исходник берётся по файлу`,
      extra: { expected: expectedName },
    })
  }
  if (!header.parent) {
    out.push({
      ...at(header.line, 1),
      severity: 'error',
      code: 'parent_missing',
      message: 'в заголовке нет класса-родителя: Loom не знает, от чего наследовать',
    })
  }
  const relNoExt = lm.rel.replace(/\.lm$/i, '')
  const expectedPath = `/Game/Mods/${mod.name}/${relNoExt}`
  if (header.assetPath !== expectedPath) {
    out.push({
      ...at(header.line, 1),
      severity: 'error',
      code: 'header_path_mismatch',
      message: `заголовок говорит at ${header.assetPath}, а исходник лежит в ${expectedPath}: путь обязан совпадать с расположением файла`,
      extra: { expected: expectedPath },
    })
  }
}

function checkModFiles(mod: ModFiles, out: Finding[]): { upluginName: string | null; engineVersion: string | null } {
  let upluginName: string | null = null
  let engineVersion: string | null = null
  const rel = mod.uplugin ? (toPosix(mod.root, mod.uplugin) ?? '') : ''

  if (!mod.uplugin) {
    out.push({
      file: '',
      line: 0,
      column: 0,
      severity: 'error',
      code: 'uplugin_missing',
      message: `нет ${mod.name}.uplugin: игра не увидит мод, а папка, файл .uplugin и будущий .pak обязаны называться одинаково`,
    })
  } else {
    const upluginBase = basename(mod.uplugin).replace(/\.uplugin$/i, '')
    if (upluginBase !== mod.name) {
      out.push({
        file: rel,
        line: 0,
        column: 0,
        severity: 'error',
        code: 'uplugin_name_mismatch',
        message: `файл ${upluginBase}.uplugin лежит в папке ${mod.name}: папка, .uplugin и будущий .pak обязаны называться одинаково`,
      })
    }
    try {
      const meta = JSON.parse(readFileSync(mod.uplugin, 'utf8')) as Record<string, unknown>
      upluginName = typeof meta.Name === 'string' ? meta.Name : null
      engineVersion = typeof meta.EngineVersion === 'string' ? meta.EngineVersion : null
      if (engineVersion && engineVersion !== '5.8') {
        out.push({
          file: rel,
          line: 0,
          column: 0,
          severity: 'warn',
          code: 'uplugin_engine_version',
          message: `EngineVersion ${engineVersion}, а игра на UE 5.8: мод собран старым китом`,
        })
      }
    } catch (e) {
      out.push({
        file: rel,
        line: 0,
        column: 0,
        severity: 'warn',
        code: 'uplugin_unreadable',
        message: `.uplugin не разобран как JSON: ${(e as Error).message}`,
      })
    }
  }

  if (!mod.pal) {
    out.push({
      file: '',
      line: 0,
      column: 0,
      severity: 'error',
      code: 'pal_missing',
      message: `нет PAL_${mod.name}.uasset: без первичной метки ассетов Cook & Install не соберёт .pak`,
    })
  }
  return { upluginName, engineVersion }
}

function checkLogs(lm: LmSource, mod: ModFiles, out: Finding[], counters: Counters): void {
  const defaults = new Map<string, string>()
  for (const v of lm.vars) if (v.value && isStringLiteral(v.value)) defaults.set(v.name, literalText(v.value))
  for (const d of lm.defaults) {
    const last = d.members[d.members.length - 1]
    if (isStringLiteral(d.value)) defaults.set(last, literalText(d.value))
  }

  for (const call of lm.calls) {
    if (call.name !== 'LogMessage') continue
    const first = (call.args[0] ?? '').trim()
    if (first.length === 0) {
      out.push({
        file: lm.rel,
        line: call.line,
        column: call.column,
        severity: 'warn',
        code: 'logmessage_no_args',
        message: 'LogMessage без аргументов: первым идёт текст, вторым — писать ли в лог',
      })
      continue
    }
    if (isStringLiteral(first)) {
      const text = literalText(first)
      if (!hasModPrefix(text, mod.name)) {
        out.push({
          file: lm.rel,
          line: call.line,
          column: call.column,
          severity: 'warn',
          code: 'logmessage_no_prefix',
          message: `LogMessage("${text.slice(0, 60)}"): строка без префикса "${mod.name}: " — в modlog её не отличить от чужих`,
        })
      }
      continue
    }
    const head = /^([A-Za-z_]\w*)/.exec(first)
    const known = head ? defaults.get(head[1]) : undefined
    if (known !== undefined) {
      if (!hasModPrefix(known, mod.name)) {
        out.push({
          file: lm.rel,
          line: call.line,
          column: call.column,
          severity: 'warn',
          code: 'logmessage_no_prefix',
          message: `LogMessage(${head![1]} ...): значение по умолчанию "${known.slice(0, 40)}" без префикса "${mod.name}: "`,
          extra: { variable: head![1] },
        })
      }
      continue
    }
    counters.logUnchecked++
  }
}

function checkVarDefaults(lm: LmSource, out: Finding[]): void {
  const report = (line: number, name: string, value: string): void => {
    if (!/\\n/.test(value)) return
    out.push({
      file: lm.rel,
      line,
      column: 1,
      severity: 'error',
      code: 'var_default_newline',
      message: `${name}: перевод строки "\\n" в значении по умолчанию. UE не разбирает его при импорте, компилятор выдаёт предупреждение, а Loom считает любое предупреждение провалом — собирай строку в коде`,
    })
  }
  for (const v of lm.vars) if (v.value) report(v.line, v.name, v.value)
  for (const d of lm.defaults) report(d.line, d.target, d.value)
}

function checkWidgetParent(lm: LmSource, kitTypes: KitTypes | null, out: Finding[]): void {
  if (!kitTypes || !lm.header?.parent) return
  const parentPath = kitTypes.resolveClass(lm.header.parent)
  if (!parentPath || parentPath.startsWith('/Script/')) return
  if (!kitTypes.isWidget(parentPath)) return
  out.push({
    file: lm.rel,
    line: lm.header.line,
    column: 1,
    severity: 'warn',
    code: 'widget_parent_canvas',
    message: `родитель ${lm.header.parent} — игровой виджет: Loom делает в наследнике свой корневой CanvasPanel Loom_Canvas, а он перекрывает дерево родителя — в игре виджет будет пустым и нулевого размера. Обход: не наследоваться, а create_widget(${lm.header.parent}) и настраивать экземпляр снаружи`,
    extra: { parent: parentPath },
  })
}

function checkOverrides(lm: LmSource, kitTypes: KitTypes | null, out: Finding[]): void {
  if (!kitTypes || !lm.header?.parent) return
  const parentPath = kitTypes.resolveClass(lm.header.parent)
  if (!parentPath) return
  for (const body of lm.bodies) {
    if (body.kind !== 'on' || body.component) continue
    const declared = kitTypes.parentFunction(parentPath, body.name)
    if (!declared || declared.isInterface) continue
    if (!declared.returns && !declared.outputs && !declared.isConst) continue
    const what = declared.returns ? 'возвращаемым значением' : declared.outputs ? 'out-параметром' : 'const'
    out.push({
      file: lm.rel,
      line: body.line,
      column: 1,
      severity: 'warn',
      code: 'override_with_return',
      message: `on ${body.name}: родитель ${shortName(declared.owner)} объявляет ${body.name} функцией с ${what}, а такой override не собирается — применитель рвёт только exec-связи, а редактор ждёт вызов родителя у return-узла (cannot link ... would break the target's other links)`,
      extra: { owner: declared.owner, workaround: 'обойтись без переопределения: настроить объект снаружи' },
    })
  }
}

function checkDeprecatedWrites(lm: LmSource, kitTypes: KitTypes | null, uniqueFields: Set<string>, out: Finding[]): void {
  const varTypes = new Map<string, string>()
  for (const v of lm.vars) varTypes.set(v.name, v.type)
  for (const write of lm.writes) {
    const last = write.members[write.members.length - 1]
    const root = splitRoot(write.target)
    const declared = root ? varTypes.get(root) : undefined
    const chainType = declared && kitTypes ? kitTypes.fieldChainType(declared, membersAfterRoot(write.target)) : null
    if (chainType && /DeprecateSlateVector2D/.test(chainType)) {
      out.push({
        file: lm.rel,
        line: write.line,
        column: write.column,
        severity: 'error',
        code: 'deprecated_vector2d_assign',
        message: `${write.target}: поле типа DeprecateSlateVector2D — Loom собирает его через MakeVector2D, и тип не совпадает, поэтому присваивание не собирается`,
        extra: { type: chainType, workaround: 'задавать размер через слот или SetRenderScale' },
      })
      continue
    }
    if (!chainType && uniqueFields.has(last)) {
      out.push({
        file: lm.rel,
        line: write.line,
        column: write.column,
        severity: 'warn',
        code: 'deprecated_vector2d_assign',
        message: `${write.target}: ${last} — поле типа DeprecateSlateVector2D (так объявляет SlateBrush в типах кита), а Loom собирает его через MakeVector2D и тип не совпадает. Тип получателя по исходнику не выведен`,
        extra: { field: last },
      })
    }
  }
}

function checkWorldAccess(lm: LmSource, out: Finding[]): void {
  if (lm.header?.name !== 'BP_MapLoad') return
  const begin = lm.bodies.find((b) => b.kind === 'on' && b.name === 'ReceiveBeginPlay' && !b.component)
  if (!begin) return
  const lines = lm.text.split('\n')
  let bindLine = 0
  for (let i = begin.line; i <= begin.endLine; i++) {
    if ((lines[i - 1] ?? '').includes('onLoadingFinished')) {
      bindLine = i
      break
    }
  }
  let early = 0
  for (let i = begin.line; i <= begin.endLine; i++) {
    const what = worldCallOn(lm, i)
    if (!what) continue
    if (bindLine !== 0 && i > bindLine) continue
    early++
    out.push({
      file: lm.rel,
      line: i,
      column: 1,
      severity: 'error',
      code: 'world_before_loading_finished',
      message: `${what}: обращение к миру в ReceiveBeginPlay ${
        bindLine === 0 ? 'без подписки на onLoadingFinished' : `до onLoadingFinished (строка ${bindLine})`
      }. BP_MapLoad спавнится во время загрузочного экрана, мир трогают только из обработчика onLoadingFinished`,
      extra: bindLine === 0 ? { hint: 'ModAPI.GetModAPI().onLoadingFinished.bind(Функция)' } : { bind_line: bindLine },
    })
  }
  if (early === 0 && bindLine === 0) {
    const elsewhere = lm.calls.some((c) => c.line > begin.endLine && worldTouching(c.name, c.receiver))
    if (elsewhere) {
      out.push({
        file: lm.rel,
        line: begin.line,
        column: 1,
        severity: 'info',
        code: 'no_loading_bind',
        message:
          'ReceiveBeginPlay не подписывается на onLoadingFinished, хотя в файле есть работа с миром: без подписки она может выполниться до готовности карты',
        extra: { hint: 'ModAPI.GetModAPI().onLoadingFinished.bind(Функция)' },
      })
    }
  }
}

function worldTouching(name: string, receiver: string): boolean {
  if (WORLD_CALLS.has(name)) return true
  return WORLD_RECEIVERS.has(receiver.split('.')[0])
}

function indexChain(ctx: GameContext, startPath: string): string[] {
  const out: string[] = []
  let cur: string | null = startPath
  const seen = new Set<string>()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    out.push(cur)
    const row = ctx.db.query('SELECT super_path FROM objects WHERE path = ?').get(cur) as { super_path: string | null } | null
    cur = row?.super_path ?? null
  }
  return out
}

function indexMember(ctx: GameContext, chain: string[], member: string): boolean {
  for (const path of chain) {
    const fn = ctx.db
      .query("SELECT 1 AS x FROM objects WHERE outer_path = ? AND name = ? AND kind = 'Function' LIMIT 1")
      .get(path, member) as { x: number } | null
    if (fn) return true
    const prop = ctx.db.query('SELECT 1 AS x FROM properties WHERE owner_path = ? AND name = ? LIMIT 1').get(path, member) as
      | { x: number }
      | null
    if (prop) return true
  }
  return false
}

function checkDrift(
  ctx: GameContext | null,
  sources: LmSource[],
  kitTypes: KitTypes | null,
  out: Finding[],
  counters: Counters,
): void {
  if (!ctx || !kitTypes) return
  const seen = new Set<string>()
  for (const lm of sources) {
    for (const ref of lm.typeRefs) {
      const name = shortTypeName(ref.name)
      if (!name || seen.has(`t:${name}`)) continue
      seen.add(`t:${name}`)
      const sym = kitTypes.resolve(name)
      if (!sym || !sym.path.startsWith('/Script/')) continue
      counters.driftChecked++
      const indexPath = sym.path.replace(/^\/Script\//, '')
      const row = ctx.db.query('SELECT kind FROM objects WHERE path = ?').get(indexPath) as { kind: string } | null
      if (row) continue
      counters.driftMissing++
      out.push({
        file: lm.rel,
        line: ref.line,
        column: ref.column,
        severity: 'warn',
        code: 'kit_symbol_not_in_game',
        message: `${name} (${ref.via}): есть в стабах кита (${sym.path}), но не в индексе игры — стабы кита разъехались после патча либо класс не попал в дамп. Сборка пройдёт, а в игре вызов промахнётся; проверь ww_find_symbol`,
        extra: { kit_path: sym.path },
      })
    }
    for (const use of lm.memberUses) {
      const key = `m:${use.receiver}.${use.member}`
      if (seen.has(key)) continue
      seen.add(key)
      const owner = kitTypes.resolveClass(use.receiver)
      if (!owner || !owner.startsWith('/Script/')) continue
      if (!kitTypes.declaresFunction(owner, use.member) && !kitTypes.hasProperty(owner, use.member)) continue
      const chain = indexChain(ctx, owner.replace(/^\/Script\//, ''))
      if (chain.length === 0) continue
      if (indexMember(ctx, chain, use.member)) continue
      counters.driftMissing++
      out.push({
        file: lm.rel,
        line: use.line,
        column: 1,
        severity: 'warn',
        code: 'kit_member_not_in_game',
        message: `${use.receiver}.${use.member}: ${use.member} объявлен у ${owner} в стабах кита, но такого члена нет у класса в индексе игры — стабы кита разъехались после патча (частая причина: член только для редактора)`,
        extra: { kit_path: owner },
      })
    }
    const varTypes = new Map<string, string>()
    for (const v of lm.vars) varTypes.set(v.name, v.type)
    for (const b of lm.bodies) for (const prm of b.params) varTypes.set(prm.name, prm.type)
    for (const write of lm.writes) {
      const root = splitRoot(write.target)
      const declared = root ? varTypes.get(root) : undefined
      const owner = declared ? kitTypes.resolveClass(declared) : null
      const member = write.members[write.members.length - 1]
      if (!owner || !owner.startsWith('/Script/') || !member) continue
      const key = `w:${owner}.${member}`
      if (seen.has(key)) continue
      seen.add(key)
      if (!kitTypes.hasProperty(owner, member)) continue
      const chain = indexChain(ctx, owner.replace(/^\/Script\//, ''))
      if (chain.length === 0) continue
      if (indexMember(ctx, chain, member)) continue
      counters.driftMissing++
      out.push({
        file: lm.rel,
        line: write.line,
        column: write.column,
        severity: 'warn',
        code: 'kit_member_not_in_game',
        message: `${write.target}: поле ${member} есть у ${owner} в стабах кита, но его нет у класса в индексе игры — в shipping-сборке такого поля не существует (обычно это поле только для редактора)`,
        extra: { kit_path: owner },
      })
    }
  }
}

interface PitfallHit {
  token: string
  summary: string
  public_id: string
  file: string
  line: number
  column: number
}

// Тег-символ ищется в исходнике, но типы и ключевые слова языка (.lm) в роли триггера бесполезны
function symbolLike(token: string): boolean {
  return token.length >= 5 && /[A-Z_]/.test(token)
}

function collectPitfalls(lm: LmSource, pitfalls: PitfallHint[]): PitfallHit[] {
  const out: PitfallHit[] = []
  for (const p of pitfalls) {
    for (const token of p.tokens) {
      if (!symbolLike(token)) continue
      const at = locateToken(lm.text, token, lm.comments)
      if (!at) continue
      out.push({ token, summary: p.summary, public_id: p.public_id, file: lm.rel, line: at.line, column: at.column })
      break
    }
  }
  return out
}

function checkMissing(ctx: GameContext | null, names: string[], out: Finding[]): void {
  for (const name of names) {
    const short = name.startsWith('/') ? (name.split(/[./]/).pop() ?? name) : name
    if (ctx) {
      const classes = findByShortName(ctx, short, 1)
      const pkg = ctx.db.query("SELECT path FROM objects WHERE name = ? AND kind = 'Package' LIMIT 1").get(short) as
        | { path: string }
        | null
      const asset = ctx.db.query('SELECT asset_path FROM assets WHERE name = ? LIMIT 1').get(short) as { asset_path: string } | null
      const gamePath = classes[0]?.path ?? pkg?.path ?? asset?.asset_path ?? null
      const present = gamePath !== null
      out.push({
        file: '',
        line: 0,
        column: 0,
        severity: present ? 'info' : 'warn',
        code: present ? 'check_missing_game_bp' : 'check_missing_unknown',
        message: present
          ? `${name}: нет в types.json кита, но есть в игре — LoomBuild подгрузит класс при сборке, это не ошибка`
          : `${name}: нет ни в типах кита, ни в индексе игры — похоже на опечатку, а не на игровой класс`,
        extra: gamePath ? { game_path: gamePath } : {},
      })
      continue
    }
    out.push({
      file: '',
      line: 0,
      column: 0,
      severity: 'info',
      code: 'check_missing_game_bp',
      message: `${name}: нет в types.json кита — LoomBuild подгружает такие имена при сборке. Профиль игры не открыт, сверить с игрой нечем`,
    })
  }
}

function listModNames(contentMods: string): string[] {
  try {
    return readdirSync(contentMods)
      .filter((n) => {
        try {
          return statSync(`${contentMods}/${n}`).isDirectory()
        } catch {
          return false
        }
      })
      .slice(0, 30)
  } catch {
    return []
  }
}

export async function handleLoomValidate(config: ServerConfig, args: LoomValidateArgs): Promise<string> {
  const st = kitStatus(config)
  if (!st.configured || !st.kit) {
    return renderAiText({
      reportType: 'loom_validation',
      fields: {
        status: 'kit_not_configured',
        problem: st.problem ?? 'кит не настроен',
        hint: 'укажи kitDir в конфиге (или через /ww-setup): без кита нет ни loom check, ни types.json',
      },
    })
  }
  const kit: KitPaths = st.kit

  if (!args.mod_root && !args.mod_name) {
    return renderAiText({
      reportType: 'loom_validation',
      fields: {
        status: 'mod_required',
        hint: 'укажи mod_name (папка в <кит>/Content/Mods) или mod_root (путь к папке мода)',
        content_mods: kit.contentMods,
        available: listModNames(kit.contentMods).join('; ') || 'нет папок',
      },
    })
  }

  const modRoot = normPath(args.mod_root ?? `${kit.contentMods}/${args.mod_name}`)
  let isDir = false
  try {
    isDir = existsSync(modRoot) && statSync(modRoot).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) {
    return renderAiText({
      reportType: 'loom_validation',
      fields: {
        status: 'mod_root_not_found',
        mod_root: modRoot,
        hint: 'укажи mod_name (папка в <кит>/Content/Mods) или mod_root (путь к папке мода)',
        available: listModNames(kit.contentMods).join('; ') || 'нет папок',
      },
    })
  }

  const mod = collectMod(modRoot)
  const findings: Finding[] = []
  const pitfallHits: PitfallHit[] = []
  const counters: Counters = { logUnchecked: 0, pitfalls: 0, driftChecked: 0, driftMissing: 0 }
  const pitfalls = activePitfalls(config, mod.name)
  const kitTypes = loadKitTypes(kit.typesJson)
  const parsed: LmSource[] = []

  for (const file of mod.sources) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (e) {
      findings.push({
        file: toPosix(mod.root, file) ?? basename(file),
        line: 0,
        column: 0,
        severity: 'error',
        code: 'unreadable',
        message: (e as Error).message,
      })
      continue
    }
    const lm = parseLm(file, toPosix(mod.root, file) ?? basename(file), text)
    parsed.push(lm)
    if (lm.bom) {
      findings.push({
        file: lm.rel,
        line: 1,
        column: 1,
        severity: 'error',
        code: 'bom_at_start',
        message: 'файл начинается с BOM: Loom видит его как лишний символ и падает на строке 1 — сохрани .lm в UTF-8 без BOM',
      })
    }
    checkHeader(lm, mod, findings)
    checkLogs(lm, mod, findings, counters)
    checkVarDefaults(lm, findings)
    checkWidgetParent(lm, kitTypes, findings)
    checkOverrides(lm, kitTypes, findings)
    pitfallHits.push(...collectPitfalls(lm, pitfalls))
    for (const u of lm.unknown) {
      findings.push({
        file: lm.rel,
        line: u.line,
        column: 1,
        severity: 'info',
        code: 'parser_unknown_line',
        message: `строка не разобрана встроенным разбором .lm (tree-sitter-loom в системе нет): ${u.text.slice(0, 80)}`,
      })
    }
  }

  counters.pitfalls = pitfallHits.length
  for (const hit of pitfallHits.slice(0, MEMORY_PITFALL_LIMIT)) {
    findings.push({
      file: hit.file,
      line: hit.line,
      column: hit.column,
      severity: 'info',
      code: 'memory_pitfall',
      message: `${hit.token}: в проектной памяти на это записаны грабли — ${hit.summary}`,
      extra: { public_id: hit.public_id, details_via: 'ww_memory_search' },
    })
  }
  if (pitfallHits.length > MEMORY_PITFALL_LIMIT) {
    const rest = pitfallHits.slice(MEMORY_PITFALL_LIMIT)
    const tokens = [...new Set(rest.map((h) => h.token))]
    findings.push({
      file: rest[0].file,
      line: rest[0].line,
      column: rest[0].column,
      severity: 'info',
      code: 'memory_pitfall_more',
      message: `в памяти есть заметки ещё про ${tokens.length} символов этого мода: ${tokens.join(', ')}. Детали — ww_memory_search по символу`,
    })
  }

  const upluginMeta = checkModFiles(mod, findings)

  let ctx: GameContext | null = null
  let indexNote = 'индекс игры не открыт: структурные правила выполнены, сверка стабов кита с игрой пропущена'
  try {
    ctx = await createGameContext(config, args.version)
    indexNote = 'ok'
  } catch (e) {
    ctx = null
    indexNote = `профиль не открыт (${(e as Error).message.split('\n')[0].slice(0, 120)})`
  }

  const uniqueDeprecated = deprecatedFields(ctx)
  for (const lm of parsed) {
    checkDeprecatedWrites(lm, kitTypes, uniqueDeprecated, findings)
    checkWorldAccess(lm, findings)
  }
  checkDrift(ctx, parsed, kitTypes, findings, counters)

  const projectRoot = findProjectRoot(mod.root, kit.kitDir)
  const projectRel = toPosix(projectRoot, mod.root)
  let checkRun: JsonRun | null = null
  let checkStatus = 'ok'
  let checkSummary = ''
  let checkMissingNames: string[] = []
  const checkFields: Record<string, Scalar> = {}

  if (!existsSync(`${projectRoot}/Intermediate/Loom/types.json`)) {
    checkStatus = 'types_missing'
    checkSummary = `нет ${projectRoot}/Intermediate/Loom/types.json: loom check без типов кита не работает, собери проект через LoomBuild`
    checkFields.check = 'skipped'
  } else {
    checkRun = await loomCheck({ ...kit, kitDir: projectRoot })
    const json = checkRun.json as
      | {
          ok?: boolean
          sources?: number
          errors?: Array<{ file: string; line?: number; column?: number; message: string }>
          missing?: string[]
        }
      | null
    checkFields.check = describeRun(checkRun.result)
    if (!json) {
      checkStatus = 'check_failed'
      checkSummary = checkRun.parseError ?? failureDetail(checkRun.result)
    } else {
      checkFields.check_sources = json.sources ?? 0
      checkFields.check_ok = json.ok === true
      const own = (file: string): boolean =>
        projectRel === null ? true : file.replace(/\\/g, '/').startsWith(`${projectRel}/`)
      const missing = (json.missing ?? []).filter((m) => parsed.some((p) => new RegExp(`\\b${escapeRe(m)}\\b`).test(p.text)))
      checkMissingNames = missing
      const ours = (json.errors ?? []).filter((e) => own(e.file))
      let added = 0
      for (const err of ours) {
        if (missing.some((m) => err.message.includes(m))) continue
        const rel = projectRel !== null ? err.file.replace(/\\/g, '/').slice(projectRel.length + 1) : err.file
        const line = err.line ?? 0
        const same = findings.find((f) => f.file === rel && f.line === line)
        if (same) {
          if (!same.message.includes(err.message)) same.message = `${same.message} — loom check: ${err.message}`
          if (!same.extra) same.extra = {}
          same.extra.loom = err.message
          continue
        }
        added++
        findings.push({
          file: rel || err.file,
          line,
          column: err.column ?? 0,
          severity: 'error',
          code: 'loom_check',
          message: translateCheckError(err.message),
          extra: { loom: err.message },
        })
      }
      if (missing.length > 0) checkMissing(ctx, missing, findings)
      const otherErrors = (json.errors ?? []).length - ours.length
      checkStatus = added > 0 ? 'errors' : 'ok'
      checkSummary = json.ok
        ? `${json.sources ?? 0} исходников проекта, ошибок нет`
        : ours.length === 0
          ? `в этом моде ошибок нет; в других модах проекта ${otherErrors}`
          : added === 0
            ? `${ours.length} ошибок loom check — все разобраны правилами выше`
            : `${ours.length} ошибок loom check, из них новых ${added}`
    }
  }

  findings.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.file.localeCompare(b.file) || a.line - b.line,
  )

  const errors = findings.filter((f) => f.severity === 'error').length
  const warnings = findings.filter((f) => f.severity === 'warn').length
  const limited = findings.slice(0, MAX_RESULTS)

  const results: AiTextResult[] = limited.map((f) => ({
    fields: {
      severity: f.severity,
      code: f.code,
      at: f.file.length > 0 ? `${f.file}:${f.line}${f.column ? `:${f.column}` : ''}` : 'мод',
      message: f.message,
      ...(f.extra ?? {}),
    },
  }))

  return renderAiText({
    reportType: 'loom_validation',
    fields: {
      ...(ctx ? versionEchoFields(ctx) : {}),
      status:
        checkStatus === 'check_failed' || checkStatus === 'types_missing'
          ? checkStatus
          : errors > 0
            ? 'invalid'
            : warnings > 0
              ? 'ok_with_warnings'
              : 'ok',
      mod: mod.name,
      mod_root: mod.root,
      sources: parsed.length,
      blueprints: parsed.filter((p) => p.header?.kind === 'blueprint' || p.header?.kind === 'editor_blueprint').length,
      uplugin: mod.uplugin ? basename(mod.uplugin) : 'нет',
      uplugin_name: upluginMeta.upluginName ?? 'нет',
      engine_version: upluginMeta.engineVersion ?? 'нет',
      pal: mod.pal ? basename(mod.pal) : 'нет',
      project: projectRoot,
      check: checkFields.check ?? 'skipped',
      check_status: checkStatus,
      check_summary: checkSummary,
      ...(checkRun ? { check_ms: checkRun.result.ms } : {}),
      check_missing: checkMissingNames.length > 0 ? checkMissingNames.join('; ') : 'нет',
      kit_types: kit.typesJson,
      kit_types_loaded: kitTypes ? 'ok' : 'не прочитан',
      index_check: indexNote,
      index_symbols_checked: counters.driftChecked,
      index_symbols_missing: counters.driftMissing,
      parser: 'встроенный структурный разбор .lm (tree-sitter-loom в системе нет)',
      parser_unknown_lines: parsed.reduce((n, p) => n + p.unknown.length, 0),
      log_calls_unchecked: counters.logUnchecked,
      memory_pitfalls: counters.pitfalls,
      errors,
      warnings,
      infos: findings.length - errors - warnings,
      hint:
        errors === 0 && warnings === 0
          ? 'дальше: ww_loom_build (сборка), затем ww_loom_install (cook → Saved/mods)'
          : 'правь .lm и гоняй ww_loom_validate заново: loom check видит только исходник',
    },
    results,
    truncated: findings.length > limited.length,
    totalFound: findings.length,
    limit: MAX_RESULTS,
  })
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

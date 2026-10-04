import { statSync } from 'node:fs'
import { RunResult } from './loom'
import {
  dropWidgetTreeRoot,
  enclosingItem,
  findExport,
  functionNames,
  printedItems,
  removeCdoDefault,
  removeCdoNestedField,
  removeFieldFromTemplates,
  removeInternalRefFields,
  removeTemplateField,
  removeWidgetField,
  stubFunction,
  unsupportedTokensOf,
  ubergraphHandlers,
  ubergraphName,
} from './lift-json'

/** Движок подъёма для ww_lift и пакетного подъёма игры; цикл прогонов — у вызывающего. */

/** Увеличивать при правке фолбэков и препроцессинга: входит в ключ кэша ww_lift. */
export const LIFT_RULES_VERSION = 2

export type LiftMarkKind = 'function' | 'event' | 'default' | 'component' | 'widget' | 'widget_tree'

export interface LiftMark {
  kind: LiftMarkKind
  name: string
  reason: string
}

export type MarkSink = (mark: LiftMark) => void

export function pushMark(marks: LiftMark[], mark: LiftMark): void {
  if (!marks.some((m) => m.kind === mark.kind && m.name === mark.name)) marks.push(mark)
}

export function firstLine(text: string): string {
  return (text.replace(/\r/g, '').split('\n').find((l) => l.trim().length > 0) ?? '').trim()
}

export function isInside(child: string, parent: string | null): boolean {
  if (!parent) return false
  const a = child.replace(/\\/g, '/').toLowerCase()
  const b = parent.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
  return a === b || a.startsWith(`${b}/`)
}

export function stampOf(path: string): string {
  try {
    const s = statSync(path)
    return `${s.size}:${Math.round(s.mtimeMs)}`
  } catch {
    return 'нет'
  }
}

function loomFailure(res: RunResult): string {
  const err = res.stderr.replace(/\r/g, '').trim()
  if (err.length > 0) return err
  const out = res.stdout.replace(/\r/g, '').trim()
  if (out.length > 0) return out
  return `loom lift умер без вывода (outcome=${res.outcome}${res.code !== null ? `, exit=${res.code}` : ''})`
}

/** ok — исходники записаны; unavailable — loom.exe не запустился, править нечего; overflow и silent —
 *  Loom умер на переполнении стека (текстом или молча), виновника не назвать; refused — отказы
 *  `could not lift <ассет>: …`, их лечат правила applyFallback. */
export type LoomRunKind = 'ok' | 'unavailable' | 'overflow' | 'silent' | 'refused'

export interface LoomRunVerdict {
  kind: LoomRunKind
  error: string
}

const STACK_OVERFLOW = /overflowed its stack|stack overflow/i

export function classifyLoomRun(res: RunResult): LoomRunVerdict {
  if (res.outcome === 'ok') return { kind: 'ok', error: '' }
  const error = loomFailure(res)
  if (res.outcome === 'not_found' || res.outcome === 'not_configured') return { kind: 'unavailable', error }
  if (STACK_OVERFLOW.test(error)) return { kind: 'overflow', error }
  if (res.stderr.replace(/\r/g, '').trim().length === 0) return { kind: 'silent', error }
  return { kind: 'refused', error }
}

export interface LiftFailure {
  asset: string
  chunk: string
}

/** Отказы одного прогона: `could not lift <ассет>: <подробность>`. Подробность может занимать сотни
 *  строк — в отказе парсера Loom печатает весь напечатанный исходник. */
export function splitFailures(text: string): LiftFailure[] {
  const out: LiftFailure[] = []
  const trimmed = text.replace(/\r/g, '')
  let at = trimmed.indexOf('could not lift ')
  while (at >= 0) {
    const head = at + 'could not lift '.length
    const colon = trimmed.indexOf(':', head)
    const next = trimmed.indexOf('could not lift ', head)
    if (colon < 0 || (next >= 0 && next < colon)) {
      at = next
      continue
    }
    out.push({ asset: trimmed.slice(head, colon).trim(), chunk: trimmed.slice(at, next >= 0 ? next : undefined) })
    at = next
  }
  return out
}

/** Отказ по одному ассету; без строки `could not lift` — весь вывод. */
export function failureChunk(text: string, asset: string): string {
  const failures = splitFailures(text)
  return (failures.find((f) => f.asset === asset) ?? failures[0])?.chunk ?? text
}

export function refusalTail(chunk: string): string {
  const one = firstLine(chunk).replace(/^could not lift \S+: /, '')
  const parts = one.split(': ')
  const tail = parts.length > 2 ? parts.slice(2).join(': ') : one
  return tail.length > 160 ? `${tail.slice(0, 160)}…` : tail
}

/** Отказы, которые правкой JSON не снять: пакет не поднимется, сколько ни крути цикл. */
export function deadEnd(chunk: string): string | null {
  const head = firstLine(chunk)
  if (/loom cannot express: a byte/.test(head)) return 'переменная типа byte: в Loom 0.1.0 для неё нет типа'
  if (/names that start with Loom_/.test(head)) return 'пакет собран самим Loom (имена Loom_*): такие обратно не поднимаются'
  if (/the project lacks it/.test(head)) return 'тип переменной или поля отсутствует в types.json кита'
  return null
}

/** Функции с байткодом, который Loom 0.1.0 не читает, застабливаются до первого прогона. */
export function stubUnsupportedFunctions(exports: unknown[], mark: MarkSink): number {
  let stubbed = 0
  for (const name of functionNames(exports)) {
    const exp = findExport(exports, name)
    if (!exp) continue
    const tokens = unsupportedTokensOf(exp)
    if (tokens.length === 0 || !stubFunction(exports, name)) continue
    stubbed++
    mark({ kind: 'function', name, reason: `байткод с ${tokens.join(', ')}` })
  }
  return stubbed
}

export function dropWidgetTree(exports: unknown[], reason: string, mark: MarkSink): boolean {
  if (!dropWidgetTreeRoot(exports)) return false
  mark({ kind: 'widget_tree', name: 'WidgetTree', reason })
  return true
}

const PARSE_FAILURE = /the lifted source does not parse: (\d+):(\d+)[^\n]*\n([\s\S]*)$/

/** Одна правка JSON на отказ Loom по ассету; возвращает описание правки или null, если править нечем.
 *  Правила читают голову отказа — первую строку; хвост нужен только отказу парсера, там исходник. */
export function applyFallback(exports: unknown[], chunk: string, mark: MarkSink): string | null {
  const head = firstLine(chunk)
  const reason = refusalTail(chunk)

  if (head.includes('reading the widget tree') && dropWidgetTree(exports, 'подъём отказал на дереве виджетов', mark)) {
    return 'выброшено дерево виджетов'
  }

  const defPath =
    /variable ([^\n:]+)'s default/.exec(head)?.[1]?.trim() ??
    /a default for ([A-Za-z0-9_.]+)/.exec(head)?.[1] ??
    /(?:^|: )default ([A-Za-z0-9_.]+):/.exec(head)?.[1] ??
    null
  if (defPath && removeCdoDefault(exports, defPath)) {
    mark({ kind: 'default', name: defPath, reason })
    return `убран default ${defPath}`
  }

  const component = /component (.+?)'s ([^\s:,]+)/.exec(head)
  if (component) {
    const [, name, field] = component
    const removed = removeTemplateField(exports, name, field, /which its class does not have/.test(head))
    if (removed.length > 0) {
      for (const c of removed) {
        mark({ kind: 'component', name: `${c}.${field}`, reason: c === name ? reason : `поля нет в классе шаблона (отказ на ${name})` })
      }
      return `убрано поле ${field} у шаблонов: ${removed.join(', ')}`
    }
  }

  const unexpected = /unexpected input: ([A-Za-z_]\w*), which/.exec(head)
  if (unexpected) {
    const field = unexpected[1]
    const path = removeCdoNestedField(exports, field)
    if (path) {
      mark({ kind: 'default', name: path, reason })
      return `убран default ${path}: поля нет в типе кита`
    }
    const removed = removeFieldFromTemplates(exports, field)
    if (removed.length > 0) {
      for (const c of removed) mark({ kind: 'component', name: `${c}.${field}`, reason })
      return `убрано поле ${field} у шаблонов: ${removed.join(', ')}`
    }
  }

  const widget = /widget ([^\s':]+)'s ([^\s:,]+)/.exec(head)
  if (widget && removeWidgetField(exports, widget[1], widget[2])) {
    mark({ kind: 'widget', name: `${widget[1]}.${widget[2]}`, reason })
    return `убрано поле ${widget[2]} виджета ${widget[1]}`
  }

  const unexpressible = /(?:^|: )variable (.+?): loom cannot express/.exec(head)?.[1]?.trim()
  if (unexpressible && removeCdoDefault(exports, unexpressible)) {
    mark({ kind: 'default', name: unexpressible, reason })
    return `убран default ${unexpressible}: типа нет в Loom`
  }

  const graph = ubergraphName(exports)
  if (graph && head.includes('reading the event graph') && stubFunction(exports, graph)) {
    mark({ kind: 'event', name: graph, reason })
    return `застаблен граф событий ${graph}`
  }

  if (graph && head.includes('an event graph with no entry jump')) {
    const stubbed = ubergraphHandlers(exports, graph).filter((name) => {
      if (!stubFunction(exports, name)) return false
      mark({ kind: 'event', name, reason: 'событие входит в застабленный граф событий' })
      return true
    })
    if (stubbed.length > 0) return `застаблены события: ${stubbed.join(', ')}`
  }

  const event = /(?:^|: )event ([^\n:]+):/.exec(head)?.[1]?.trim()
  if (event && stubFunction(exports, event)) {
    mark({ kind: 'event', name: event, reason })
    return `застаблено событие ${event}`
  }

  const fn = /(?:^|: )(?:reading )?function ([^\n:]+):/.exec(head)?.[1]?.trim()
  if (fn && stubFunction(exports, fn)) {
    mark({ kind: 'function', name: fn, reason })
    return `застаблена функция ${fn}`
  }

  const unparsed = PARSE_FAILURE.exec(chunk.replace(/\r/g, ''))
  if (unparsed) return applyParseFallback(exports, Number(unparsed[1]), unparsed[2], unparsed[3], mark)

  return null
}

/** Отказ парсера на напечатанном исходнике: внутри тела — застаблить тело; на строке default —
 *  снять default (Loom печатает ссылку путём с двоеточием и сам его не читает); на строке component —
 *  снять у шаблона ссылки на экспорты внутри пакета. */
function applyParseFallback(exports: unknown[], line: number, col: string, source: string, mark: MarkSink): string | null {
  const at = `${line}:${col}`
  const item = enclosingItem(source, line)
  if (item && stubFunction(exports, item.name)) {
    mark({
      kind: item.kind === 'fn' ? 'function' : 'event',
      name: item.name,
      reason: `напечатанный исходник не разбирается обратно (${at})`,
    })
    return `застаблен ${item.kind} ${item.name}: исходник не разбирается обратно`
  }

  const printed = (source.split('\n')[line - 1] ?? '').trim()
  const target = /^default\s+((?:`[^`]+`|[^\s=.]+)(?:\s*\.\s*(?:`[^`]+`|[^\s=.]+))*)\s*=/.exec(printed)?.[1]
  const path = target?.replace(/\s+/g, '') ?? null
  if (path && removeCdoDefault(exports, path)) {
    mark({ kind: 'default', name: path, reason: `напечатанный исходник не разбирается обратно (${at})` })
    return `убран default ${path}: напечатанный исходник не разбирается обратно`
  }

  const comp = /^component\s+([^\s:]+)\s*:/.exec(printed)?.[1]
  const removed = comp ? removeInternalRefFields(exports, comp) : []
  if (comp && removed.length > 0) {
    mark({
      kind: 'component',
      name: `${comp}.${removed.join(', ')}`,
      reason: `ссылка на экспорт внутри пакета не читается обратно (${at})`,
    })
    return `убраны ссылки внутри пакета у шаблона ${comp}: ${removed.join(', ')}`
  }
  return null
}

export function bytecodePath(assetPath: string, className: string | null, name: string): string {
  const pkg = assetPath.split('/').pop() ?? assetPath
  return `${pkg}.${className ?? `${pkg}_C`}.${name}`
}

/** Застабленные тела помечаются комментарием прямо над телом, остальное — списком в конце файла. */
export function applyMarks(text: string, marks: LiftMark[], bytecodeOf: (name: string) => string): string {
  const lines = text.split('\n')
  const byName = new Map(printedItems(text).map((i) => [i.name, i]))
  const inline = new Map<number, string[]>()
  const loose: LiftMark[] = []
  const tree = marks.find((m) => m.kind === 'widget_tree')

  for (const mark of marks) {
    if (mark.kind === 'widget_tree') continue
    const item = mark.kind === 'function' || mark.kind === 'event' ? byName.get(mark.name) : undefined
    if (item) {
      const at = item.from - 1
      inline.set(at, [...(inline.get(at) ?? []), `// not lifted: ${mark.reason} → ww_get_bytecode ${bytecodeOf(mark.name)}`])
      continue
    }
    loose.push(mark)
  }

  const out: string[] = []
  if (tree) out.push(`// дерево виджетов не поднято (${tree.reason}): раскладку показывает ww_ui_tree`)
  for (let i = 0; i < lines.length; i++) {
    for (const note of inline.get(i) ?? []) out.push(note)
    out.push(lines[i])
  }
  if (loose.length > 0) {
    out.push('')
    out.push('// не поднято:')
    for (const mark of loose) out.push(`//   ${mark.kind} ${mark.name}: ${mark.reason}`)
  }
  return out.join('\n')
}

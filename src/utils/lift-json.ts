export type JsonObject = Record<string, unknown>

export interface PreprocessStats {
  hexKeys: number
  tinyFloats: number
}

/** Токены, которых подъём Loom 0.1.0 не читает: функции с ними застабливаются до первого прогона. */
export const UNSUPPORTED_TOKENS = [
  'EX_SwitchValue',
  'EX_VectorConst',
  'EX_RotationConst',
  'EX_TransformConst',
  'EX_CallMulticastDelegate',
]

/** CUE4Parse кладёт в цвета ключ Hex, который подъём не переваривает, а печататель Loom пишет
 *  мелкие float экспонентой, которую его же парсер не читает обратно. */
export function preprocessExports(exports: unknown[]): PreprocessStats {
  const stats: PreprocessStats = { hexKeys: 0, tinyFloats: 0 }
  clean(exports, stats)
  return stats
}

function clean(node: unknown, stats: PreprocessStats): void {
  if (Array.isArray(node)) {
    for (const item of node) clean(item, stats)
    return
  }
  if (typeof node !== 'object' || node === null) return
  const obj = node as JsonObject
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'Hex') {
      delete obj[key]
      stats.hexKeys++
      continue
    }
    if (typeof value === 'number' && value !== 0 && Math.abs(value) < 1e-4) {
      obj[key] = 0
      stats.tinyFloats++
      continue
    }
    clean(value, stats)
  }
}

function asObjects(exports: unknown[]): JsonObject[] {
  return exports.filter((e): e is JsonObject => typeof e === 'object' && e !== null && !Array.isArray(e))
}

export function findExport(exports: unknown[], name: string): JsonObject | null {
  return asObjects(exports).find((e) => e.Name === name) ?? null
}

export function findExportOfType(exports: unknown[], type: string): JsonObject | null {
  return asObjects(exports).find((e) => e.Type === type) ?? null
}

export function propertiesOf(exp: JsonObject | null): JsonObject | null {
  const props = exp?.Properties
  return typeof props === 'object' && props !== null && !Array.isArray(props) ? (props as JsonObject) : null
}

export function classExport(exports: unknown[]): JsonObject | null {
  return (
    asObjects(exports).find(
      (e) => e.Type === 'BlueprintGeneratedClass' || e.Type === 'WidgetBlueprintGeneratedClass',
    ) ?? null
  )
}

export function classNameOf(exports: unknown[]): string | null {
  const cls = classExport(exports)
  return typeof cls?.Name === 'string' ? cls.Name : null
}

function cdoExport(exports: unknown[]): JsonObject | null {
  const cls = classExport(exports)
  const ref = cls?.ClassDefaultObject
  if (typeof ref !== 'object' || ref === null) return null
  const objectName = (ref as JsonObject).ObjectName
  if (typeof objectName !== 'string') return null
  const name = objectName.split("'")[1]
  return name ? findExport(exports, name) : null
}

/** Токены неподдерживаемых выражений во всём дереве байткода функции. */
export function unsupportedTokensOf(exp: JsonObject): string[] {
  const found = new Set<string>()
  walkTokens(exp.ScriptBytecode, found)
  return UNSUPPORTED_TOKENS.filter((t) => found.has(t))
}

function walkTokens(node: unknown, found: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) walkTokens(item, found)
    return
  }
  if (typeof node !== 'object' || node === null) return
  const obj = node as JsonObject
  if (typeof obj.Token === 'string' && UNSUPPORTED_TOKENS.includes(obj.Token)) found.add(obj.Token)
  for (const value of Object.values(obj)) walkTokens(value, found)
}

/** Пустое тело: подъём прочитает его как функцию, которая сразу возвращает. Повторный вызов — не правка. */
export function stubFunction(exports: unknown[], name: string): boolean {
  const exp = findExport(exports, name)
  if (!exp || exp.Type !== 'Function' || exp.ScriptBytecode === undefined) return false
  if (isStubbed(exp.ScriptBytecode)) return false
  exp.ScriptBytecode = [
    { Token: 'EX_Return', StatementIndex: 0, Expression: { Token: 'EX_Nothing' } },
    { Token: 'EX_EndOfScript', StatementIndex: 1 },
  ]
  return true
}

function isStubbed(bytecode: unknown): boolean {
  if (!Array.isArray(bytecode) || bytecode.length !== 2) return false
  const tokens = bytecode.map((s) => (typeof s === 'object' && s !== null ? (s as JsonObject).Token : null))
  return tokens[0] === 'EX_Return' && tokens[1] === 'EX_EndOfScript'
}

export function functionNames(exports: unknown[]): string[] {
  return asObjects(exports)
    .filter((e) => e.Type === 'Function' && typeof e.Name === 'string')
    .map((e) => e.Name as string)
}

export function ubergraphName(exports: unknown[]): string | null {
  return functionNames(exports).find((n) => n.startsWith('ExecuteUbergraph_')) ?? null
}

/** События, которые входят в граф событий: без самого графа они все отказывают одинаково. */
export function ubergraphHandlers(exports: unknown[], ubergraph: string): string[] {
  const marker = `:${ubergraph}'`
  return asObjects(exports)
    .filter((e) => e.Type === 'Function' && typeof e.Name === 'string' && e.Name !== ubergraph)
    .filter((e) => JSON.stringify(e.ScriptBytecode ?? null).includes(marker))
    .map((e) => e.Name as string)
}

export function dropWidgetTreeRoot(exports: unknown[]): boolean {
  const props = propertiesOf(findExportOfType(exports, 'WidgetTree'))
  if (!props || !('RootWidget' in props)) return false
  delete props.RootWidget
  return true
}

export function removeWidgetField(exports: unknown[], widget: string, field: string): boolean {
  const props = propertiesOf(findExport(exports, widget))
  if (!props || !(field in props)) return false
  delete props[field]
  return true
}

const TEMPLATE_SUFFIX = '_GEN_VARIABLE'

function templateExports(exports: unknown[]): JsonObject[] {
  return asObjects(exports).filter((e) => typeof e.Name === 'string' && e.Name.endsWith(TEMPLATE_SUFFIX))
}

function componentOf(template: JsonObject): string {
  return String(template.Name).slice(0, -TEMPLATE_SUFFIX.length)
}

function dropProperty(exp: JsonObject, field: string): boolean {
  const props = propertiesOf(exp)
  if (!props || !(field in props)) return false
  delete props[field]
  return true
}

/** Поле шаблона компонента; возвращает компоненты, у которых оно снято. С `sameClass` поле снимается
 *  и у остальных шаблонов того же класса: поля нет в классе — отказ повторится на каждом из них. */
export function removeTemplateField(exports: unknown[], component: string, field: string, sameClass: boolean): string[] {
  const own = findExport(exports, `${component}${TEMPLATE_SUFFIX}`)
  if (!own || !dropProperty(own, field)) return removeFieldFromTemplates(exports, field)
  const removed = [component]
  if (!sameClass) return removed
  for (const tpl of templateExports(exports)) {
    if (tpl !== own && tpl.Type === own.Type && dropProperty(tpl, field)) removed.push(componentOf(tpl))
  }
  return removed
}

/** Loom называет компонент не так, как экспорт шаблона: поле снимается у всех шаблонов, где оно есть. */
export function removeFieldFromTemplates(exports: unknown[], field: string): string[] {
  return templateExports(exports)
    .filter((tpl) => dropProperty(tpl, field))
    .map(componentOf)
}

/** Loom зовёт поле вложенной структуры CDO одним именем (`bCanEverTick` из `PrimaryComponentTick`):
 *  ищем объемлющее свойство и снимаем путь целиком. */
export function removeCdoNestedField(exports: unknown[], field: string): string | null {
  const props = propertiesOf(cdoExport(exports))
  if (!props) return null
  if (field in props && removeCdoDefault(exports, field)) return field
  for (const [key, value] of Object.entries(props)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    if (!(field in (value as JsonObject))) continue
    const path = `${key}.${field}`
    if (removeCdoDefault(exports, path)) return path
  }
  return null
}

/** Ссылка на экспорт внутри того же пакета (`…campfire.10`) печатается путём с двоеточием, который
 *  Loom сам не читает обратно: такие поля шаблона компонента снимаются. */
export function removeInternalRefFields(exports: unknown[], component: string): string[] {
  const props = propertiesOf(findExport(exports, `${component}${TEMPLATE_SUFFIX}`))
  if (!props) return []
  const removed: string[] = []
  for (const [key, value] of Object.entries(props)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const ref = value as JsonObject
    const objectPath = typeof ref.ObjectPath === 'string' ? ref.ObjectPath : ''
    const objectName = typeof ref.ObjectName === 'string' ? ref.ObjectName : ''
    if (!/\.\d+$/.test(objectPath) && !objectName.includes(':')) continue
    delete props[key]
    removed.push(key)
  }
  return removed
}

/** Значение по умолчанию у CDO: путь может быть вложенным (`PrimaryActorTick.bCanEverTick`). */
export function removeCdoDefault(exports: unknown[], path: string): boolean {
  const cdo = cdoExport(exports)
  const props = propertiesOf(cdo)
  if (!props) return false
  const parts = path.split('.')
  let holder: JsonObject = props
  for (const part of parts.slice(0, -1)) {
    const next = holder[part]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) return false
    holder = next as JsonObject
  }
  const last = parts[parts.length - 1]
  if (!(last in holder)) return false
  delete holder[last]
  return true
}

export interface PrintedItem {
  kind: 'fn' | 'on' | 'event'
  name: string
  from: number
  to: number
}

const ITEM_START = /^(?:(?:private|protected|pure|mut)\s+)*(fn|on|event)\s/

/** Объемлющий `fn | on | event` для строки напечатанного исходника — по ошибке парсера `L:C`.
 *  `on` печатается как `on Компонент.Событие`, а в пакете функция зовётся одним событием. */
export function printedItems(text: string): PrintedItem[] {
  const lines = text.split('\n')
  const items: PrintedItem[] = []
  let current: PrintedItem | null = null
  for (let i = 0; i < lines.length; i++) {
    const m = ITEM_START.exec(lines[i])
    if (!m) continue
    if (current) {
      current.to = i
      items.push(current)
    }
    const header = lines[i].replace(/\s*[({].*$/, '').trim()
    const tail = header.slice(m[0].length).trim()
    const bare = tail.includes('.') ? tail.slice(tail.lastIndexOf('.') + 1) : tail
    current = {
      kind: m[1] as PrintedItem['kind'],
      name: bare.replace(/`/g, '').trim(),
      from: i + 1,
      to: Number.MAX_SAFE_INTEGER,
    }
  }
  if (current) {
    current.to = lines.length
    items.push(current)
  }
  return items
}

export function enclosingItem(text: string, line: number): PrintedItem | null {
  for (const item of printedItems(text)) {
    if (line >= item.from && line <= item.to) return item
  }
  return null
}

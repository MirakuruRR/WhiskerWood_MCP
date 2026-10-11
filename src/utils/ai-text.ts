export const MAX_RESULTS = 200
export const FTS_LIMIT = 10

export type Scalar = string | number | boolean

export interface AiTextResult {
  fields: Record<string, Scalar>
  blocks?: Record<string, string>
}

export interface AiTextReport {
  reportType: string
  fields?: Record<string, Scalar>
  results?: AiTextResult[]
  truncated?: boolean
  totalFound?: number
  limit?: number
}

export class AiTextRenderError extends Error {}

function assertScalar(name: string, value: Scalar): string {
  if (typeof value === 'string' && value.includes('\n')) {
    throw new AiTextRenderError(`поле "${name}" содержит перенос строки; многострочные значения передавайте через blocks`)
  }
  return String(value)
}

export function renderAiText(report: AiTextReport): string {
  const lines: string[] = []
  lines.push(`report_type: ${report.reportType}`)
  if (report.fields) {
    for (const [k, v] of Object.entries(report.fields)) {
      lines.push(`${k}: ${assertScalar(k, v)}`)
    }
  }
  const results = report.results ?? []
  lines.push(`result_count: ${results.length}`)
  if (report.truncated !== undefined) lines.push(`truncated: ${report.truncated}`)
  if (report.totalFound !== undefined) lines.push(`total_found: ${report.totalFound}`)
  if (report.limit !== undefined) lines.push(`limit: ${report.limit}`)

  for (let i = 0; i < results.length; i++) {
    lines.push('')
    lines.push(`[result_${i + 1}]`)
    const r = results[i]
    for (const [k, v] of Object.entries(r.fields)) {
      lines.push(`${k}: ${assertScalar(k, v)}`)
    }
    if (r.blocks) {
      for (const [k, body] of Object.entries(r.blocks)) {
        lines.push(`<<<${k}`)
        lines.push(body.replace(/\n$/, ''))
        lines.push(`${k}>>>`)
      }
    }
  }
  return lines.join('\n')
}

export function errorText(reportType: string, status: string, message: string): string {
  const lines = message.replace(/\r/g, '').split('\n')
  const first = (lines[0] ?? '').trim()
  return renderAiText({
    reportType,
    fields: { status, error: first },
    results: lines.length > 1 ? [{ fields: {}, blocks: { details: message } }] : undefined,
  })
}

/** Поля шапки отчёта renderAiText — для инструментов, которые зовут друг друга. */
export function aiTextFields(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    if (line.length === 0 || line.startsWith('[')) break
    const i = line.indexOf(': ')
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 2)
  }
  return out
}

export function aiTextBlock(text: string, name: string): string | null {
  const start = text.indexOf(`<<<${name}\n`)
  if (start < 0) return null
  const end = text.indexOf(`\n${name}>>>`, start)
  return end < 0 ? null : text.slice(start + name.length + 4, end)
}

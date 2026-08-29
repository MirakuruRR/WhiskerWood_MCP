export function buildFtsQuery(pattern: string): string | null {
  const tokens = pattern
    .replace(/["'*^(){}[\]:]/g, ' ')
    .split(/[\s.,;|\\/&]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return null
  return tokens.map((t) => `"${t}"*`).join(' AND ')
}

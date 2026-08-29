export function tokenizePattern(pattern: string): string[] {
  return pattern
    .replace(/["'*^(){}[\]:]/g, ' ')
    .split(/[\s.,;|\\/&]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

export function buildFtsQuery(pattern: string): string | null {
  const tokens = tokenizePattern(pattern)
  if (tokens.length === 0) return null
  return tokens.map((t) => `"${t}"*`).join(' AND ')
}

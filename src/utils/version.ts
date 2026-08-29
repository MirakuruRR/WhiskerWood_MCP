export function parseVersionComponents(v: string): number[] {
  return v
    .split(/[.\-+]/)
    .map((s) => /^\d+$/.test(s) ? parseInt(s, 10) : NaN)
    .filter((n) => Number.isFinite(n))
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersionComponents(a)
  const pb = parseVersionComponents(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

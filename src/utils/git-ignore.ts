import { existsSync } from 'node:fs'

// без git или вне репозитория — пустое множество: тогда исключать нечем
export function gitIgnored(cwd: string, paths: string[]): Set<string> {
  if (paths.length === 0 || !existsSync(cwd)) return new Set()
  try {
    const p = Bun.spawnSync(['git', '-C', cwd, 'check-ignore', '--stdin', '-z'], {
      stdin: Buffer.from(`${paths.join('\0')}\0`, 'utf8'),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (p.exitCode !== 0 && p.exitCode !== 1) return new Set()
    return new Set(new TextDecoder().decode(p.stdout).split('\0').filter((s) => s.length > 0))
  } catch {
    return new Set()
  }
}

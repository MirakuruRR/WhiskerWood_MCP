import { resolve } from 'node:path'
import { ConfigError, ServerConfig, configWarnings, loadConfig, validateConfig } from '../config'

// data/ и bridge/ — содержимое репозитория, а конфиг через WWMCP_CONFIG может лежать где угодно
export function repoRoot(): string {
  return resolve(import.meta.dir, '../..').replace(/\\/g, '/')
}

export function requireConfig(): ServerConfig {
  let cfg: ServerConfig
  try {
    cfg = loadConfig()
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message)
      process.exit(1)
    }
    throw e
  }

  const problems = validateConfig(cfg)
  if (problems.length > 0) {
    console.error('Конфигурация не прошла проверку:')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }

  for (const w of configWarnings(cfg)) console.warn(`внимание: ${w}`)
  return cfg
}

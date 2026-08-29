import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ConfigError, loadConfig, validateConfig } from './config'
import { createServer } from './server'
import { sweepStagingAndTrash } from './utils/profile-publish'

async function main(): Promise<void> {
  let cfg
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

  sweepStagingAndTrash(cfg.distDir)

  const server = createServer(cfg)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('whiskerwood-mcp запущен (stdio)')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

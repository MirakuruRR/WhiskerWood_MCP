import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ConfigError, loadConfig, validateConfig } from '../config'
import { getBridge } from '../utils/bridge-client'
import { enableInModsTxt, linkModDir } from '../utils/ue4ss-deploy'

const MOD_NAME = 'WWBridge'

function norm(p: string): string {
  return p.replace(/\\/g, '/')
}

function writeConfigLua(sourceDir: string, root: string, pollMs: number, modsRepo: string): void {
  const body = `return {\n    root = "${root}",\n    poll_ms = ${pollMs},\n    mods_repo = "${modsRepo}",\n}\n`
  writeFileSync(`${sourceDir}/Scripts/config.lua`, body, 'utf8')
}

function main(): void {
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

  const sourceDir = norm(resolve(cfg.configDir, 'bridge', MOD_NAME))
  if (!existsSync(`${sourceDir}/Scripts/main.lua`)) {
    console.error(`не найден исходник моста: ${sourceDir}/Scripts/main.lua`)
    process.exit(1)
  }

  const bridge = getBridge(cfg)
  bridge.ensureDirs()
  bridge.sweepOrphans()
  mkdirSync(`${cfg.stateDir}/bridge`, { recursive: true })

  writeConfigLua(sourceDir, `${cfg.stateDir}/bridge`, cfg.bridgePollMs, cfg.modsRepo)

  const targetDir = `${cfg.ue4ssDir}/Mods/${MOD_NAME}`
  const mode = linkModDir(sourceDir, targetDir)
  const modsTxtState = enableInModsTxt(`${cfg.ue4ssDir}/Mods/mods.txt`, MOD_NAME)

  console.log(`WWBridge развёрнут: ${targetDir} (${mode})`)
  console.log(`  config.lua: root=${cfg.stateDir}/bridge poll_ms=${cfg.bridgePollMs}`)
  console.log(`  mods.txt: ${modsTxtState}`)
  console.log('Перезапустите игру, затем проверьте ww_game_status')
}

main()

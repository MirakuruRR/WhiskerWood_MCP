import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getBridge } from '../utils/bridge-client'
import { requireConfig } from '../utils/cli-config'
import { enableInModsTxt, linkModDir, linkSharedLibs, registerInModsTxt } from '../utils/ue4ss-deploy'

const MOD_NAME = 'WWBridge'
const DUMPER = 'AutoDump'

function norm(p: string): string {
  return p.replace(/\\/g, '/')
}

function writeConfigLua(sourceDir: string, root: string, pollMs: number, modsRepo: string): void {
  const body = `return {\n    root = "${root}",\n    poll_ms = ${pollMs},\n    mods_repo = "${modsRepo}",\n}\n`
  writeFileSync(`${sourceDir}/Scripts/config.lua`, body, 'utf8')
}

function main(): void {
  const cfg = requireConfig()

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

  const modsTxt = `${cfg.ue4ssDir}/Mods/mods.txt`
  const targetDir = `${cfg.ue4ssDir}/Mods/${MOD_NAME}`
  const mode = linkModDir(sourceDir, targetDir)
  const modsTxtState = enableInModsTxt(modsTxt, MOD_NAME)

  console.log(`WWBridge развёрнут: ${targetDir} (${mode})`)
  console.log(`  config.lua: root=${cfg.stateDir}/bridge poll_ms=${cfg.bridgePollMs}`)
  console.log(`  mods.txt: ${modsTxtState}`)

  const dumperSource = norm(resolve(cfg.configDir, 'bridge', DUMPER))
  if (existsSync(`${dumperSource}/Scripts/main.lua`)) {
    const dumperMode = linkModDir(dumperSource, `${cfg.ue4ssDir}/Mods/${DUMPER}`)
    const dumperState = registerInModsTxt(modsTxt, DUMPER, false)
    console.log(`AutoDump развёрнут (${dumperMode}), mods.txt: ${dumperState}`)
    console.log(`  включается вручную (${DUMPER} : 1) только на время переиндексации`)
  } else {
    console.warn(`AutoDump не найден: ${dumperSource}/Scripts/main.lua — переиндексация будет недоступна`)
  }

  const libs = linkSharedLibs(cfg.configDir, cfg.modsRepo, cfg.ue4ssDir)
  if (libs.source) {
    console.log(`Библиотека модов: ${libs.namespaces.join(', ')} → Mods/shared (${libs.mode})`)
    console.log(`  источник: ${libs.source}`)
  } else {
    console.warn('lib/ не найден ни в репозитории модов, ни в data/lib — require("ww.*") в модах не заработает')
  }

  console.log('Перезапустите игру, затем проверьте ww_game_status')
}

main()

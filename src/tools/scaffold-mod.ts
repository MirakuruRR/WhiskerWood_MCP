import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { ServerConfig } from '../config'
import { GameContext, versionEchoFields } from '../utils/game-context'
import { renderAiText } from '../utils/ai-text'
import { PathSandboxError } from '../utils/path-sandbox'
import { MOD_ENTRY, MOD_MANIFEST, ModMeta, readModMeta, resolveModRoot } from '../utils/mod-project'

export const TEMPLATES = ['hook', 'ui', 'keybind', 'diagnostic'] as const
export type TemplateName = (typeof TEMPLATES)[number]

export interface ScaffoldModArgs {
  mod_root: string
  name?: string
  template: TemplateName
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export function handleScaffoldMod(ctx: GameContext, config: ServerConfig, args: ScaffoldModArgs): string {
  const echo = versionEchoFields(ctx)
  const fail = (status: string, extra: Record<string, string | number | boolean>) =>
    renderAiText({ reportType: 'mod_scaffold', fields: { ...echo, status, ...extra } })

  let root: string
  try {
    root = resolveModRoot(config, args.mod_root)
  } catch (e) {
    if (e instanceof PathSandboxError) {
      return fail('mod_root_rejected', {
        mod_root: args.mod_root,
        sandbox_roots: config.sandboxRoots.join('; '),
        error: 'mod_root обязан лежать внутри sandboxRoots (обычно modsRepo/mods/<имя>)',
      })
    }
    throw e
  }

  const name = args.name ?? basename(root)
  if (!NAME_RE.test(name)) {
    return fail('bad_name', {
      name,
      error: 'имя мода: латиница, цифры, дефис и подчёркивание, до 64 символов — оно же станет именем каталога в ue4ss/Mods',
    })
  }

  const existing = readModMeta(root)
  if (existing) {
    return fail('already_exists', {
      mod_root: root,
      name: existing.name,
      template: existing.template,
      hint: 'мод уже создан; правь Scripts/main.lua напрямую и проверяй через ww_validate_mod',
    })
  }

  const templatePath = `${config.configDir}/data/templates/${args.template}.lua`
  if (!existsSync(templatePath)) {
    return fail('unknown_template', { template: args.template, available: TEMPLATES.join(', ') })
  }
  const body = readFileSync(templatePath, 'utf8').replaceAll('{{NAME}}', name)

  const meta: ModMeta = {
    name,
    template: args.template,
    entry: MOD_ENTRY,
    created_at: new Date().toISOString(),
    game_version: ctx.gameVersion,
  }

  mkdirSync(`${root}/Scripts`, { recursive: true })
  const entryPath = `${root}/${MOD_ENTRY}`
  if (existsSync(entryPath)) {
    return fail('entry_exists', {
      entry: entryPath,
      hint: `${MOD_ENTRY} уже есть, а ${MOD_MANIFEST} отсутствует; перезаписывать чужой код инструмент не станет`,
    })
  }
  writeFileSync(entryPath, body, 'utf8')
  writeFileSync(`${root}/${MOD_MANIFEST}`, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')

  return renderAiText({
    reportType: 'mod_scaffold',
    fields: {
      ...echo,
      status: 'ok',
      name,
      template: args.template,
      mod_root: root,
      entry: entryPath,
      manifest: `${root}/${MOD_MANIFEST}`,
      lib_path: `${config.modsRepo}/lib`,
      next: 'ww_find_symbol/ww_get_function → ww_verify_hook → ww_generate_hook → правка main.lua → ww_validate_mod → ww_deploy_mod',
    },
  })
}

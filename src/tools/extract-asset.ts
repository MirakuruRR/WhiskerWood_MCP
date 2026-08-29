import { mkdirSync, writeFileSync } from 'node:fs'
import { GameContext, versionEchoFields } from '../utils/game-context'
import { renderAiText } from '../utils/ai-text'
import { ServerConfig } from '../config'
import { PathSandbox, PathSandboxError } from '../utils/path-sandbox'
import { pakReaderFor, resolveAssetInPak } from '../utils/asset-extract'
import { PakError } from '../utils/pak-reader'

export interface ExtractAssetArgs {
  asset_path: string
  dest_dir: string
}

export function handleExtractAsset(ctx: GameContext, config: ServerConfig, args: ExtractAssetArgs): string {
  const echo = versionEchoFields(ctx)
  const fail = (status: string, extra: Record<string, string | number | boolean>) =>
    renderAiText({ reportType: 'asset_extract', fields: { ...echo, status, asset_path: args.asset_path, ...extra } })

  let dest: string
  try {
    dest = new PathSandbox([config.extractRoot]).validateAndResolve(args.dest_dir)
  } catch (e) {
    if (e instanceof PathSandboxError) {
      return fail('dest_dir_rejected', {
        dest_dir: args.dest_dir,
        extract_root: config.extractRoot,
        error: 'dest_dir обязан лежать внутри extractRoot',
      })
    }
    throw e
  }

  const reader = pakReaderFor(config.pakPath)
  const resolved = resolveAssetInPak(reader, args.asset_path)
  if (resolved.status === 'ambiguous') {
    return fail('ambiguous', { candidates: (resolved.candidates ?? []).join('; ') })
  }
  if (resolved.status !== 'ok' || !resolved.files || resolved.files.length === 0) {
    const near = ctx.db
      .query('SELECT asset_path FROM assets WHERE name LIKE ? OR asset_path LIKE ? LIMIT 8')
      .all(`%${args.asset_path.split('/').pop()}%`, `%${args.asset_path}%`) as Array<{ asset_path: string }>
    return fail('not_found', { suggestions: near.length > 0 ? near.map((n) => n.asset_path).join('; ') : 'нет' })
  }

  mkdirSync(dest, { recursive: true })
  const written: Array<{ file: string; bytes: number }> = []
  for (const pakPath of resolved.files) {
    const name = pakPath.split('/').pop()!
    let payload: Buffer
    try {
      payload = reader.read(pakPath)
    } catch (e) {
      if (e instanceof PakError) {
        return fail('pak_entry_unreadable', { file: pakPath, error: e.message })
      }
      throw e
    }
    const target = `${dest}/${name}`
    writeFileSync(target, payload)
    written.push({ file: target, bytes: payload.length })
  }

  return renderAiText({
    reportType: 'asset_extract',
    fields: {
      ...echo,
      status: 'ok',
      asset_path: args.asset_path,
      pak_path: resolved.base!,
      dest_dir: dest,
    },
    results: written.map((w) => ({ fields: { file: w.file, bytes: w.bytes } })),
  })
}

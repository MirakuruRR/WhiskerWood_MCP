import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { requireConfig } from '../utils/cli-config'
import { ue4ssDllPath } from '../utils/mod-native'
import { parsePe } from '../utils/pe'

const REPO = 'UE4SS-RE/RE-UE4SS'
const OUT = `${import.meta.dir}/../../data/ue4ss-sdk`
const ROOTS = ['Mod/CppUserModBase.hpp', 'LuaMadeSimple/LuaMadeSimple.hpp', 'DynamicOutput/DynamicOutput.hpp']
// GUI.hpp тянет imgui, TextEditor и приватный Unreal; CppUserModBase держит вкладки через shared_ptr,
// поэтому раскладка класса от заглушки не меняется
const SHIMS: Record<string, string> = {
  'GUI/GUI.hpp': '#pragma once\n\n// ww-mcp: заглушка вместо UE4SS/include/GUI/GUI.hpp (imgui, TextEditor, Unreal)\n#include <String/StringType.hpp>\n',
}
const SYSTEM_H = /^(windows|winnt|winbase|psapi|intrin|immintrin|dbghelp|shlobj|objbase|combaseapi|assert|stdio|stdlib|string|stdint|stddef|limits|math|float|ctype|wchar|signal|setjmp|stdarg|time|errno|locale|malloc|memory|io|fcntl|direct)\.h$/i

interface TarFile {
  path: string
  data: Buffer
}

function untar(gz: ArrayBuffer): TarFile[] {
  const tar = Buffer.from(Bun.gunzipSync(gz))
  const out: TarFile[] = []
  let longName: string | null = null
  for (let off = 0; off + 512 <= tar.length; ) {
    const h = tar.subarray(off, off + 512)
    if (h.every((b) => b === 0)) break
    const str = (a: number, n: number): string => {
      const s = h.subarray(a, a + n)
      const z = s.indexOf(0)
      return s.toString('utf8', 0, z < 0 ? n : z)
    }
    const size = parseInt(str(124, 12).trim() || '0', 8)
    const type = String.fromCharCode(h[156] || 48)
    const data = tar.subarray(off + 512, off + 512 + size)
    off += 512 + Math.ceil(size / 512) * 512
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))
      if (m) longName = m[1]
      continue
    }
    if (type === 'g') continue
    const prefix = str(345, 155)
    const path = longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100))
    longName = null
    if (type === '0') out.push({ path, data: Buffer.from(data) })
  }
  return out
}

async function get(url: string): Promise<Response> {
  const res = await fetch(url, { headers: { 'User-Agent': 'ww-mcp-ue4ss-sdk' } })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res
}

function installedSha(ue4ssDir: string): { sha: string; version: string } | null {
  try {
    const m = /UE4SS - (v[^\r\n]*?) - Git SHA #([0-9a-f]+)/.exec(readFileSync(`${ue4ssDir}/UE4SS.log`, 'utf8'))
    return m ? { version: m[1], sha: m[2] } : null
  } catch {
    return null
  }
}

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

function resolveIncludes(files: Map<string, Buffer>, includeDirs: string[]): { picked: Map<string, Buffer>; unresolved: Map<string, string> } {
  const find = (name: string, fromDir: string): string | null => {
    for (const dir of [fromDir, ...includeDirs]) {
      const parts: string[] = []
      for (const seg of `${dir}/${name}`.split('/')) {
        if (seg === '..') parts.pop()
        else if (seg !== '.' && seg !== '') parts.push(seg)
      }
      const p = parts.join('/')
      if (files.has(p)) return p
    }
    return null
  }
  const rel = (p: string): string => {
    for (const dir of includeDirs) if (p.startsWith(`${dir}/`)) return p.slice(dir.length + 1)
    return p
  }
  const picked = new Map<string, Buffer>()
  const unresolved = new Map<string, string>()
  const queue: string[] = []
  for (const r of ROOTS) {
    const p = find(r, includeDirs[0])
    if (!p) throw new Error(`корневой заголовок ${r} не найден`)
    queue.push(p)
  }
  const seen = new Set<string>()
  while (queue.length > 0) {
    const p = queue.pop() as string
    const key = rel(p)
    if (seen.has(key)) continue
    seen.add(key)
    if (SHIMS[key]) {
      picked.set(key, Buffer.from(SHIMS[key], 'utf8'))
      continue
    }
    const data = files.get(p) as Buffer
    picked.set(key, data)
    const text = data.toString('utf8')
    const viaMacro = text.matchAll(/^\s*#\s*define\s+\w+\s+[<"]([^>"]+\.(?:h|hpp|hxx|inl))[>"]/gm)
    for (const m of [...text.matchAll(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm), ...viaMacro]) {
      const name = m[1]
      if (SHIMS[name]) {
        queue.push(name)
        continue
      }
      const hit = find(name, p.slice(0, p.lastIndexOf('/')))
      if (hit) queue.push(hit)
      else if (name.includes('.') && !SYSTEM_H.test(name) && !/^(ext|bits|sys|linux|mach)\//.test(name)) unresolved.set(name, key)
    }
  }
  return { picked, unresolved }
}

async function main(): Promise<void> {
  const cfg = requireConfig()
  const installed = installedSha(cfg.ue4ssDir)
  const want = argValue('--commit') ?? installed?.sha
  if (!want) throw new Error('коммит не задан и не найден в UE4SS.log: bun run ue4ss-sdk --commit <sha>')

  const commit = (await (await get(`https://api.github.com/repos/${REPO}/commits/${want}`)).json()) as {
    sha: string
    commit: { committer: { date: string } }
  }
  console.log(`UE4SS ${commit.sha} (${commit.commit.committer.date})`)
  const src = untar(await (await get(`https://codeload.github.com/${REPO}/tar.gz/${commit.sha}`)).arrayBuffer())
  const top = src[0].path.split('/')[0]
  const files = new Map(src.map((f) => [f.path.slice(top.length + 1), f.data]))

  const thirdCmake = files.get('deps/third/CMakeLists.txt')?.toString('utf8') ?? ''
  const fmtTag = /fmtlib\/fmt\.git\s+GIT_TAG\s+(\S+)/.exec(thirdCmake)?.[1]
  if (!fmtTag) throw new Error('в deps/third/CMakeLists.txt не найдена версия fmt')
  console.log(`fmt ${fmtTag}`)
  const fmtSrc = untar(await (await get(`https://codeload.github.com/fmtlib/fmt/tar.gz/refs/tags/${fmtTag}`)).arrayBuffer())
  const fmtTop = fmtSrc[0].path.split('/')[0]
  for (const f of fmtSrc) files.set(`fmt/${f.path.slice(fmtTop.length + 1)}`, f.data)

  const firstDirs = [...new Set([...files.keys()].map((p) => /^(deps\/first\/[^/]+\/include)\//.exec(p)?.[1]).filter((d): d is string => !!d))].sort()
  const includeDirs = ['UE4SS/include', ...firstDirs, 'fmt/include']
  const { picked, unresolved } = resolveIncludes(files, includeDirs)
  if (unresolved.size > 0) {
    for (const [name, from] of unresolved) console.error(`  не разрешён: ${name} <- ${from}`)
    throw new Error('в замыкании заголовков есть неразрешённые include: добавь заглушку в SHIMS')
  }

  rmSync(OUT, { recursive: true, force: true })
  for (const [rel, data] of picked) {
    const p = `${OUT}/include/${rel}`
    mkdirSync(p.slice(0, p.lastIndexOf('/')), { recursive: true })
    writeFileSync(p, data)
  }
  writeFileSync(`${OUT}/LICENSE-UE4SS`, files.get('LICENSE') as Buffer)
  const fmtLicense = files.get('fmt/LICENSE') ?? files.get('fmt/LICENSE.rst')
  if (fmtLicense) writeFileSync(`${OUT}/LICENSE-fmt`, fmtLicense)

  let def: { exports: number; ue4ss_dll_sha256: string } | null = null
  const dll = ue4ssDllPath(cfg.ue4ssDir)
  if (dll && installed && commit.sha.startsWith(installed.sha)) {
    const buf = readFileSync(dll)
    const names = parsePe(buf).exports
    writeFileSync(`${OUT}/UE4SS.def`, `LIBRARY UE4SS.dll\r\nEXPORTS\r\n${names.map((n) => `    ${n}\r\n`).join('')}`)
    def = { exports: names.length, ue4ss_dll_sha256: createHash('sha256').update(buf).digest('hex') }
    console.log(`UE4SS.def: ${names.length} экспортов из ${dll}`)
  } else {
    console.warn('UE4SS.def не создан: установленная UE4SS не этого коммита (или не найдена)')
  }

  const manifest = {
    ue4ss_commit: commit.sha,
    ue4ss_commit_date: commit.commit.committer.date,
    ue4ss_version: commit.sha.startsWith(installed?.sha ?? '-') ? installed?.version : undefined,
    fmt_tag: fmtTag,
    roots: ROOTS,
    shims: Object.keys(SHIMS),
    files: picked.size,
    def,
    build: {
      include: 'include',
      defines: ['FMT_HEADER_ONLY', '_SILENCE_CXX17_CODECVT_HEADER_DEPRECATION_WARNING'],
      msvc: ['/std:c++20', '/utf-8', '/EHsc', '/MD', '/permissive-', '/Zc:__cplusplus'],
      import_lib: 'lib /def:UE4SS.def /machine:x64 /out:UE4SS.lib',
    },
    generated_at: new Date().toISOString(),
  }
  writeFileSync(`${OUT}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`готово: ${picked.size} заголовков в ${OUT}`)
}

main().catch((e) => {
  console.error((e as Error).message)
  process.exit(1)
})

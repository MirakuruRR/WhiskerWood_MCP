import { Database } from 'bun:sqlite'
import { writeFileSync } from 'node:fs'
import { ConfigError, loadConfig, validateConfig } from '../config'
import { BridgeClient, BridgeResult, getBridge } from '../utils/bridge-client'
import { listProfiles, resolveProfile } from '../utils/game-registry'

const NL = String.fromCharCode(10)

function unwrap(res: BridgeResult): string {
  if (res.status === 'ok') return res.body
  if (res.status === 'error') return `ОШИБКА: ${res.body}`
  return `НЕТ ОТВЕТА: ${res.status}`
}

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
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }

  const bridge: BridgeClient = getBridge(cfg)
  const st = await bridge.readStatusStable()
  if (!bridge.isAlive(st)) {
    console.error('Мост не отвечает. Запустите игру с включённым WWBridge (bun run bridge:deploy) и загрузите уровень.')
    process.exit(2)
  }
  console.error(`мост жив: session=${st!.session} world=${st!.world || '<нет>'}`)

  const profile = resolveProfile(listProfiles(cfg.distDir))
  const db = new Database(`${profile.dir}/index.db`, { readonly: true })

  const out: string[] = []
  const say = (s: string) => {
    console.log(s)
    out.push(s)
  }

  say(`# Спайки фазы 2 — прогон ${new Date().toISOString()}`)
  say('')
  say(`Сессия моста: ${st!.session}, мир: ${st!.world || '<нет>'}`)
  say('')

  // Спайк 2 — исполняется ли ExecuteInGameThread синхронно
  say('## Спайк 2 — синхронность ExecuteInGameThread')
  const ev2 = await bridge.call('eval', 'return #FindAllOf("Actor")', 8000)
  say('```')
  say(`${unwrap(ev2)}${NL}exec=${ev2.status === 'ok' || ev2.status === 'error' ? ev2.exec : '?'}`)
  say('```')
  say(
    'game_thread_sync — коллбэк исполнился на месте; game_thread_async — отложен и результат ' +
      'забран следующим тиком; direct — ExecuteInGameThread недоступен.',
  )
  say('')

  // Спайк 3 — форма пути для UFunction в StaticFindObject
  say('## Спайк 3 — форма пути UFunction в StaticFindObject')
  const nativeFn = db
    .query(
      "SELECT hook_path FROM objects WHERE kind = 'Function' AND is_blueprint = 0 AND hook_path IS NOT NULL AND package = 'SystemCore' ORDER BY path LIMIT 5",
    )
    .all() as Array<{ hook_path: string }>
  say('```')
  say(unwrap(await bridge.call('probe', nativeFn.map((r) => r.hook_path).join(NL), 8000)))
  say('```')
  say('via=colon — работает форма с двоеточием, via=dot — с точкой, via=class_only — функции нет.')
  say('')

  // Спайк 4 — видит ли StaticFindObject незагруженные пакеты
  say('## Спайк 4 — видимость незагруженных объектов')
  const cold = db
    .query(
      "SELECT asset_path, name FROM assets WHERE class_name IN ('Texture2D','StaticMesh','SoundWave') ORDER BY asset_path LIMIT 8",
    )
    .all() as Array<{ asset_path: string; name: string }>
  say('Ассеты из AssetRegistry, которые в память сейчас загружены не все:')
  say('```')
  say(unwrap(await bridge.call('probe', cold.map((a) => `${a.asset_path}.${a.name}`).join(NL), 10000)))
  say('```')
  const menuBp = db
    .query(
      "SELECT hook_path FROM objects WHERE kind LIKE '%BlueprintGeneratedClass' AND hook_path LIKE '/Game/UI/MainMenu/%' LIMIT 5",
    )
    .all() as Array<{ hook_path: string }>
  const gameBp = db
    .query(
      "SELECT hook_path FROM objects WHERE kind LIKE '%BlueprintGeneratedClass' AND hook_path IS NOT NULL AND hook_path NOT LIKE '/Game/UI/MainMenu/%' ORDER BY random() LIMIT 10",
    )
    .all() as Array<{ hook_path: string }>
  say('BP-классы главного меню против BP-классов игрового уровня:')
  say('```')
  say(unwrap(await bridge.call('probe', [...menuBp, ...gameBp].map((r) => r.hook_path).join(NL), 12000)))
  say('```')
  say(
    'Если что-то отдаёт not_found — StaticFindObject видит только загруженные объекты, ' +
      'и live-негатив по BP-пути не окончателен: статус not_found_possibly_not_loaded обязателен.',
  )
  say('')

  // Спайк 1 — читаются ли поля StructProperty в параметрах хуков.
  // Функция вызывается из Lua намеренно: хук UE4SS срабатывает на вызове через
  // ProcessEvent, поэтому ждать случайного срабатывания незачем.
  say('## Спайк 1 — чтение полей StructProperty в параметрах хуков')
  const setup = [
    'for _, h in ipairs(_G.WWSPIKE1 or {}) do pcall(UnregisterHook, h[1], h[2], h[3]) end',
    '_G.WWSPIKE1, _G.WWSPIKE1REC = {}, {}',
    'local function probe(tag, v)',
    '  if v == nil then return tag .. "=nil" end',
    '  if type(v) ~= "userdata" then return tag .. "=" .. type(v) .. "(" .. tostring(v) .. ")" end',
    '  local okg, got = pcall(function() return v:get() end)',
    '  local tgt = okg and got or v',
    '  local parts = { tag .. ": get()=" .. tostring(okg) }',
    '  for _, f in ipairs({ "X", "Y", "Z" }) do',
    '    local okf, val = pcall(function() return tgt[f] end)',
    '    parts[#parts+1] = f .. "=" .. (okf and tostring(val) or "<err>")',
    '  end',
    '  return table.concat(parts, " ")',
    'end',
    'local path = "/Script/Engine.KismetMathLibrary:Add_VectorVector"',
    'local ok, pre, post = pcall(RegisterHook, path, function(ctx, a, b)',
    '  _G.WWSPIKE1REC[#_G.WWSPIKE1REC+1] = probe("A", a) .. " || " .. probe("B", b)',
    'end)',
    'if ok then _G.WWSPIKE1[#_G.WWSPIKE1+1] = { path, pre, post } end',
    'return "hook_registered=" .. tostring(ok)',
  ].join(NL)
  say('```')
  say(unwrap(await bridge.call('eval', setup, 10000)))

  const fire = [
    'local lib = StaticFindObject("/Script/Engine.Default__KismetMathLibrary")',
    'if not lib or not lib:IsValid() then return "CDO KismetMathLibrary не найден" end',
    'local ok, res = pcall(function() return lib:Add_VectorVector({X=1.5,Y=2.5,Z=3.5}, {X=10,Y=20,Z=30}) end)',
    'if not ok then return "вызов упал: " .. tostring(res) end',
    'return "вызов ок, результат " .. tostring(res.X) .. "," .. tostring(res.Y) .. "," .. tostring(res.Z)',
  ].join(NL)
  say(unwrap(await bridge.call('eval', fire, 10000)))

  const collect = [
    'if #(_G.WWSPIKE1REC or {}) == 0 then return "хук не сработал" end',
    'return table.concat(_G.WWSPIKE1REC, "|")',
  ].join(NL)
  say(unwrap(await bridge.call('eval', collect, 10000)))
  say('```')
  say('Ожидаем A: X=1.5 Y=2.5 Z=3.5 и B: X=10.0 Y=20.0 Z=30.0 — тогда поля структур читаются.')

  await bridge.call(
    'eval',
    'for _, h in ipairs(_G.WWSPIKE1 or {}) do pcall(UnregisterHook, h[1], h[2], h[3]) end _G.WWSPIKE1 = {} return "ok"',
    10000,
  )
  say('')

  const reportPath = `${cfg.stateDir}/bridge-spikes.md`
  writeFileSync(reportPath, out.join(NL), 'utf8')
  console.error(`отчёт записан: ${reportPath}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

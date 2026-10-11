import { ServerConfig } from '../config'
import { GameContext } from '../utils/game-context'
import { getBridge } from '../utils/bridge-client'
import { renderAiText, Scalar } from '../utils/ai-text'
import { modContainerSafety, modPathHint, parseModAssetPath } from '../utils/mod-asset'
import { bridgeFailureFields, echoFields } from './bridge-common'
import { luaStr, modClassSelectionChunk } from './common'

export interface ModStateArgs {
  object: string
  index?: number
  vars?: string[]
  depth?: number
  max_items?: number
}

const MAX_LINES = 3000

function selection(object: string, index: number | undefined): string {
  const ref = parseModAssetPath(object)
  if (ref) return modClassSelectionChunk(ref.classPath, index, 'o')
  return `local o = StaticFindObject(${luaStr(object.trim().replace(/^[^\s/]+\s+(?=\/)/, ''))})
local candidateCount = (o and o:IsValid()) and 1 or 0`
}

/**
 * Переменные экземпляра Loom/BP по рефлексии. Поля UserDefinedStruct в игре зовутся
 * Name_2_<GUID>: суффикс срезается. Тип элемента TMap/TSet из Lua не узнать —
 * элемент опознаётся по значению: строка, UObject или структура (у неё есть ForEachProperty).
 */
function chunk(args: ModStateArgs, depth: number, maxItems: number, safeContainers: string[]): string {
  const wanted = (args.vars ?? []).map((v) => v.trim().toLowerCase()).filter((v) => v.length > 0)
  return `
${selection(args.object, args.index)}
if not o or not o:IsValid() then return "not_found" .. string.char(10) .. tostring(candidateCount) end
local MAXD, MAXI, LIMIT = ${depth}, ${maxItems}, ${MAX_LINES}
local HEX = "_%d+_" .. string.rep("%x", 32) .. "$"
local WANT = {${wanted.map((w) => `[ ${luaStr(w)} ] = true`).join(', ')}}
local hasWant = ${wanted.length > 0 ? 'true' : 'false'}
-- TMap/TSet, у которых по паку мода все типы элементов читаемы; остальные не трогаем совсем
local SAFEC = {${safeContainers.map((n) => `[ ${luaStr(n)} ] = true`).join(', ')}}
local SCALAR = { IntProperty = 1, Int64Property = 1, Int16Property = 1, Int8Property = 1, UInt16Property = 1, UInt32Property = 1, UInt64Property = 1, FloatProperty = 1, DoubleProperty = 1, BoolProperty = 1, ByteProperty = 1, EnumProperty = 1 }
local TEXT = { StrProperty = 1, NameProperty = 1, TextProperty = 1 }
local OBJECT = { ObjectProperty = 1, ClassProperty = 1, ObjectPtrProperty = 1 }
local CONTAINER = { ArrayProperty = 1, MapProperty = 1, SetProperty = 1 }
-- Читаем значение только у этих видов: чтение soft-ссылки уронило игру нативным AV, pcall не спас
local function readable(kind) return SCALAR[kind] or TEXT[kind] or OBJECT[kind] or CONTAINER[kind] or kind == "StructProperty" end
local out, lines = {}, 0
local function emit(pad, text)
  if lines >= LIMIT then return end
  lines = lines + 1
  out[#out + 1] = pad .. text
end
local function clean(n) return (n:gsub(HEX, "")) end
local function kindOf(p)
  local k = "?"
  pcall(function() k = p:GetClass():GetFName():ToString() end)
  return k
end
local function objText(v)
  local s = "none"
  pcall(function()
    if v and v:IsValid() then s = v:GetClass():GetFName():ToString() .. " " .. v:GetFName():ToString() end
  end)
  return s
end
local function asText(v)
  local ok, s = pcall(function() return v:ToString() end)
  if ok and type(s) == "string" then return s end
  return nil
end
local function quoted(s) return '"' .. (s:gsub("[\\r\\n]+", " ")) .. '"' end
local fmtProp, fmtValue
local function structFields(v, depth, pad)
  local ok = pcall(function()
    v:ForEachProperty(function(f)
      local name = f:GetFName():ToString()
      local fk = kindOf(f)
      if not readable(fk) then emit(pad, clean(name) .. ": <" .. fk .. ", не читается>") return end
      local fv
      pcall(function() fv = v[name] end)
      fmtProp(f, fv, depth, pad, clean(name))
    end)
  end)
  if not ok then emit(pad, "<поля не читаются>") end
end
-- Элемент контейнера без FProperty: тип по самому значению
fmtValue = function(v, depth, pad, label)
  if type(v) ~= "userdata" then emit(pad, label .. ": " .. tostring(v)) return end
  local s = asText(v)
  if s then emit(pad, label .. ": " .. quoted(s)) return end
  -- значение структуры тоже отвечает на IsValid/GetClass, но его класс — сам UScriptStruct
  local okc, cname = pcall(function() return v:GetClass():GetFName():ToString() end)
  local isStruct = okc and type(cname) == "string" and cname:find("Struct$") ~= nil
  if not isStruct then
    local okv, valid = pcall(function() return v:IsValid() end)
    if okv then emit(pad, label .. ": " .. (valid and objText(v) or "none")) return end
  end
  if depth >= MAXD then emit(pad, label .. ": {…}") return end
  emit(pad, label .. ": {")
  structFields(v, depth + 1, pad .. "  ")
  emit(pad, "}")
end
local function container(v, depth, pad, label, kind, inner, pname)
  if kind ~= "ArrayProperty" and not SAFEC[pname] then
    emit(pad, label .. ": " .. (kind == "MapProperty" and "map" or "set") .. " <типы элементов неизвестны — не читаю>")
    return
  end
  local n = 0
  local items = {}
  local walked = pcall(function()
    if kind == "MapProperty" then
      v:ForEach(function(k, val)
        n = n + 1
        if n <= MAXI then items[#items + 1] = { k:get(), val:get() } end
      end)
    else
      v:ForEach(function(i, e)
        n = n + 1
        if n <= MAXI then items[#items + 1] = { nil, e:get() } end
      end)
    end
  end)
  local tag = kind == "MapProperty" and "map" or kind == "SetProperty" and "set" or "array"
  if not walked then emit(pad, label .. ": " .. tag .. " <обход из Lua не поддержан>") return end
  if n == 0 then emit(pad, label .. ": " .. tag .. "[0]") return end
  if depth >= MAXD then emit(pad, label .. ": " .. tag .. "[" .. n .. "] …") return end
  emit(pad, label .. ": " .. tag .. "[" .. n .. "]" .. (n > MAXI and (" (показано " .. MAXI .. ")") or ""))
  for i, it in ipairs(items) do
    local key = it[1] ~= nil and (asText(it[1]) or (type(it[1]) ~= "userdata" and tostring(it[1])) or objText(it[1])) or tostring(i)
    if inner then fmtProp(inner, it[2], depth + 1, pad .. "  ", "[" .. key .. "]")
    else fmtValue(it[2], depth + 1, pad .. "  ", "[" .. key .. "]") end
  end
end
fmtProp = function(p, v, depth, pad, label)
  local kind = kindOf(p)
  if v == nil then emit(pad, label .. ": nil") return end
  if SCALAR[kind] then emit(pad, label .. ": " .. tostring(v)) return end
  if TEXT[kind] then emit(pad, label .. ": " .. quoted(asText(v) or "?")) return end
  if OBJECT[kind] then emit(pad, label .. ": " .. objText(v)) return end
  if kind == "StructProperty" then
    if depth >= MAXD then emit(pad, label .. ": {…}") return end
    emit(pad, label .. ": {")
    structFields(v, depth + 1, pad .. "  ")
    emit(pad, "}")
    return
  end
  if kind == "ArrayProperty" or kind == "MapProperty" or kind == "SetProperty" then
    local inner
    if kind == "ArrayProperty" then pcall(function() inner = p:GetInner() end) end
    if inner and not readable(kindOf(inner)) then emit(pad, label .. ": array of <" .. kindOf(inner) .. ">, элементы не читаются") return end
    local pname = ""
    pcall(function() pname = p:GetFName():ToString():lower() end)
    container(v, depth, pad, label, kind, inner, pname)
    return
  end
  emit(pad, label .. ": <" .. kind .. ">")
end
local cls = o:GetClass()
local classes = {}
while cls and cls:IsValid() do
  local full = cls:GetFullName()
  if not full:find(" /Game/", 1, true) then break end
  classes[#classes + 1] = cls
  local nextCls
  pcall(function() nextCls = cls:GetSuperStruct() end)
  cls = nextCls
end
local shown = 0
for _, c in ipairs(classes) do
  local cname = c:GetFName():ToString()
  local header = false
  c:ForEachProperty(function(p)
    local name = p:GetFName():ToString()
    local key = clean(name):lower()
    if name:find("^UberGraphFrame") or name == "DefaultSceneRoot" then return end
    if hasWant and not WANT[key] then return end
    if not header then emit("", "# " .. cname) header = true end
    local kind = kindOf(p)
    local label = clean(name) .. " (" .. kind:gsub("Property$", "") .. ")"
    if not readable(kind) then
      emit("", label .. ": <не читается из Lua>")
    else
      local v
      pcall(function() v = o[name] end)
      fmtProp(p, v, 0, "", label)
    end
    shown = shown + 1
  end)
end
return "ok" .. string.char(10) .. tostring(candidateCount) .. string.char(10) .. o:GetFullName() .. string.char(10) .. shown .. string.char(10) .. tostring(lines >= LIMIT) .. string.char(10) .. table.concat(out, string.char(10))
`.trim()
}

export async function handleModState(ctx: GameContext | null, config: ServerConfig, args: ModStateArgs): Promise<string> {
  const depth = Math.min(Math.max(args.depth ?? 3, 1), 6)
  const maxItems = Math.min(Math.max(args.max_items ?? 20, 1), 200)
  const fields: Record<string, Scalar> = { ...echoFields(ctx), object: args.object, depth, max_items: maxItems }
  if (args.index !== undefined) fields.index = args.index
  if (args.vars && args.vars.length > 0) fields.vars = args.vars.join(', ')

  const ref = parseModAssetPath(args.object)
  const safety = ref ? modContainerSafety(config, ref) : { safe: [], unsafe: [], assets: 0 }
  if (safety.unsafe.length > 0) fields.containers_skipped = safety.unsafe.join(', ')
  if (!ref) fields.containers_note = 'не путь мода: типы элементов карт и множеств неизвестны, их содержимое не читается'
  const res = await getBridge(config).call('eval', chunk(args, depth, maxItems, safety.safe), 30_000)
  if (res.status === 'error') {
    return renderAiText({ reportType: 'mod_state', fields: { ...fields, status: 'lua_error' }, results: [{ fields: {}, blocks: { error: res.body } }] })
  }
  if (res.status !== 'ok') return renderAiText({ reportType: 'mod_state', fields: { ...fields, ...bridgeFailureFields(res) } })

  const lines = res.body.replace(/^exec=\w+\n/, '').split('\n')
  if (lines[0] === 'not_found') {
    return renderAiText({
      reportType: 'mod_state',
      fields: {
        ...fields,
        status: 'not_found',
        candidates: Number(lines[1] ?? 0),
        hint: parseModAssetPath(args.object)
          ? 'экземпляра класса мода нет в мире: мод не загружен (pak подхватывается при старте игры) или актор ещё не заспавнен; index — номер среди кандидатов'
          : `object — путь класса мода (${modPathHint()}) или полный путь экземпляра`,
      },
    })
  }
  const [, candidates, resolved, shown, cut, ...tree] = lines
  return renderAiText({
    reportType: 'mod_state',
    fields: {
      ...fields,
      status: 'ok',
      candidates: Number(candidates),
      resolved,
      vars_shown: Number(shown),
      ...(cut === 'true' ? { truncated_lines: MAX_LINES, hint: 'вывод упёрся в лимит строк: сузь vars или уменьши depth/max_items' } : {}),
      note: 'имена полей структур — без GUID-суффикса; регистр имени переменной — как в FName игры, он может отличаться от .lm',
    },
    results: [{ fields: {}, blocks: { state: tree.join('\n') } }],
  })
}

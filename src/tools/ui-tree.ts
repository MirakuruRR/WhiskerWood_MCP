import { ServerConfig } from '../config'
import { GameContext } from '../utils/game-context'
import { getBridge } from '../utils/bridge-client'
import { renderAiText, Scalar } from '../utils/ai-text'
import { bridgeFailureFields, echoFields } from './bridge-common'
import { luaStr } from './common'

export interface UiTreeArgs {
  root?: string
  object_path?: string
  index?: number
  field?: string
  depth?: number
  match_name?: string
}

// ESlateVisibility: 0 Visible, 1 Collapsed, 2 Hidden, 3 HitTestInvisible, 4 SelfHitTestInvisible
// SlateCore.EHorizontalAlignment / EVerticalAlignment, значения из индекса 0.7.200
function selectionChunk(root: string, objectPath: string | undefined, index: number | undefined): string {
  if (objectPath) {
    return `local owner = StaticFindObject(${luaStr(objectPath)})
local candidateCount = owner and 1 or 0
if not owner or not owner:IsValid() then return "root_not_found" end`
  }
  return `local candidates = FindAllOf(${luaStr(root)}) or {}
local candidateCount = #candidates
local owner = candidates[${index ?? 1}]
if not owner or not owner:IsValid() then return "root_not_found" end`
}

function chunk(
  root: string,
  objectPath: string | undefined,
  index: number | undefined,
  field: string | undefined,
  depth: number,
  matchName: string | undefined,
): string {
  const start = field
    ? `${selectionChunk(root, objectPath, index)}
local node = owner["${field}"]
if not node or not node:IsValid() then return "field_not_found" end`
    : `${selectionChunk(root, objectPath, index)}
local node = nil
pcall(function() node = owner.WidgetTree.RootWidget end)
if not node or not node:IsValid() then node = owner end`

  return `
${start}
local ownerFullName = "?"
pcall(function() ownerFullName = owner:GetFullName() end)
local geoLib = StaticFindObject("/Script/UMG.Default__SlateBlueprintLibrary")
local VIS = { [0] = "Visible", [1] = "Collapsed", [2] = "Hidden", [3] = "HitTestInvisible", [4] = "SelfHitTestInvisible" }
local HALIGN = { [0] = "Fill", [1] = "Left", [2] = "Center", [3] = "Right" }
local VALIGN = { [0] = "Fill", [1] = "Top", [2] = "Center", [3] = "Bottom" }
local matchLower = ${matchName ? luaStr(matchName.toLowerCase()) : 'nil'}
local function align(v, map)
  if type(v) == "number" then return map[v] end
  if type(v) == "string" then return v:gsub("^HAlign_", ""):gsub("^VAlign_", "") end
  return nil
end
local out = {}
local function describe(w)
  local bits = {}
  local cls = "?"
  pcall(function() cls = w:GetClass():GetFName():ToString() end)
  bits[#bits + 1] = cls
  pcall(function()
    local v = w:GetVisibility()
    bits[#bits + 1] = "vis=" .. (VIS[v] or tostring(v))
  end)
  pcall(function()
    local res = w.Brush.ResourceObject
    if res and res:IsValid() then bits[#bits + 1] = "tex=" .. res:GetFName():ToString() end
  end)
  pcall(function()
    local t = w:GetText():ToString()
    if t ~= "" then bits[#bits + 1] = "text='" .. t:gsub("[\\r\\n]+", " ") .. "'" end
  end)
  pcall(function()
    local s = w.Slot
    if s and s:IsValid() then
      bits[#bits + 1] = "slot=" .. s:GetClass():GetFName():ToString()
      local ha, va = align(s.HorizontalAlignment, HALIGN), align(s.VerticalAlignment, VALIGN)
      if ha then bits[#bits + 1] = "halign=" .. ha end
      if va then bits[#bits + 1] = "valign=" .. va end
    end
  end)
  -- GetCachedGeometry вне контекста живого Paint/Tick часто отдаёт нулевую геометрию —
  -- это не ошибка вызова, поэтому нулевой size/pos молча не печатаем, как и остальные поля.
  pcall(function()
    if not (geoLib and geoLib:IsValid()) then return end
    local geo = w:GetCachedGeometry()
    local size = geoLib:GetLocalSize(geo)
    local topleft = geoLib:GetLocalTopLeft(geo)
    if size.X ~= 0 or size.Y ~= 0 then
      bits[#bits + 1] = string.format("size=%.0fx%.0f", size.X, size.Y)
    end
    if topleft.X ~= 0 or topleft.Y ~= 0 then
      bits[#bits + 1] = string.format("pos=%.0f,%.0f", topleft.X, topleft.Y)
    end
  end)
  return table.concat(bits, " ")
end
local function walk(w, level)
  if not w or not w:IsValid() or level > ${depth} then return end
  local name = "?"
  pcall(function() name = w:GetFName():ToString() end)
  if not matchLower or name:lower():find(matchLower, 1, true) then
    out[#out + 1] = string.rep("  ", level) .. name .. " <" .. describe(w) .. ">"
  end
  local n = 0
  pcall(function() n = w:GetChildrenCount() end)
  for i = 0, n - 1 do
    local c
    pcall(function() c = w:GetChildAt(i) end)
    walk(c, level + 1)
  end
end
walk(node, 0)
return "candidates=" .. candidateCount .. "\\nresolved=" .. ownerFullName .. "\\n" .. table.concat(out, "\\n")
`.trim()
}

export async function handleUiTree(
  ctx: GameContext | null,
  config: ServerConfig,
  args: UiTreeArgs,
): Promise<string> {
  const root = args.root ?? 'PlayHud'
  const depth = Math.min(Math.max(args.depth ?? 6, 1), 20)
  const bridge = getBridge(config)
  const res = await bridge.call('eval', chunk(root, args.object_path, args.index, args.field, depth, args.match_name), 30_000)
  const fields: Record<string, Scalar> = { ...echoFields(ctx), root, depth }
  if (args.object_path) fields.object_path = args.object_path
  if (args.index !== undefined) fields.index = args.index
  if (args.field) fields.field = args.field
  if (args.match_name) fields.match_name = args.match_name

  if (res.status === 'ok') {
    const body = res.body.replace(/^exec=\w+\n/, '').trim()
    if (body === 'root_not_found' || body === 'field_not_found') {
      return renderAiText({ reportType: 'ui_tree', fields: { ...fields, status: body } })
    }
    // Дерево совпадений может быть пустым (match_name ничего не нашёл) — не завязываемся
    // на trailing-\n, которую съедает trim(), режем по первым двум строкам явно.
    const lines = body.split('\n')
    const candidates = Number((lines[0] ?? '').replace('candidates=', ''))
    const resolved = (lines[1] ?? '').replace('resolved=', '')
    const tree = lines.slice(2).join('\n')
    return renderAiText({
      reportType: 'ui_tree',
      fields: { ...fields, status: 'ok', candidates, resolved, lines: tree.length > 0 ? tree.split('\n').length : 0 },
      results: [{ fields: {}, blocks: { tree } }],
    })
  }
  if (res.status === 'error') {
    return renderAiText({
      reportType: 'ui_tree',
      fields: { ...fields, status: 'lua_error' },
      results: [{ fields: {}, blocks: { error: res.body } }],
    })
  }
  return renderAiText({ reportType: 'ui_tree', fields: { ...fields, ...bridgeFailureFields(res) } })
}

import { ServerConfig } from '../config'
import { GameContext } from '../utils/game-context'
import { getBridge } from '../utils/bridge-client'
import { renderAiText, Scalar } from '../utils/ai-text'
import { bridgeFailureFields, echoFields } from './bridge-common'

export interface UiTreeArgs {
  root?: string
  field?: string
  depth?: number
}

// ESlateVisibility: 0 Visible, 1 Collapsed, 2 Hidden, 3 HitTestInvisible, 4 SelfHitTestInvisible
// SlateCore.EHorizontalAlignment / EVerticalAlignment, значения из индекса 0.7.200
function chunk(root: string, field: string | undefined, depth: number): string {
  const start = field
    ? `local owner = FindFirstOf([[${root}]])
if not owner then return "root_not_found" end
local node = owner["${field}"]
if not node or not node:IsValid() then return "field_not_found" end`
    : `local owner = FindFirstOf([[${root}]])
if not owner then return "root_not_found" end
local node = nil
pcall(function() node = owner.WidgetTree.RootWidget end)
if not node or not node:IsValid() then node = owner end`

  return `
${start}
local VIS = { [0] = "Visible", [1] = "Collapsed", [2] = "Hidden", [3] = "HitTestInvisible", [4] = "SelfHitTestInvisible" }
local HALIGN = { [0] = "Fill", [1] = "Left", [2] = "Center", [3] = "Right" }
local VALIGN = { [0] = "Fill", [1] = "Top", [2] = "Center", [3] = "Bottom" }
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
  return table.concat(bits, " ")
end
local function walk(w, level)
  if not w or not w:IsValid() or level > ${depth} then return end
  local name = "?"
  pcall(function() name = w:GetFName():ToString() end)
  out[#out + 1] = string.rep("  ", level) .. name .. " <" .. describe(w) .. ">"
  local n = 0
  pcall(function() n = w:GetChildrenCount() end)
  for i = 0, n - 1 do
    local c
    pcall(function() c = w:GetChildAt(i) end)
    walk(c, level + 1)
  end
end
walk(node, 0)
return table.concat(out, "\\n")
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
  const res = await bridge.call('eval', chunk(root, args.field, depth), 30_000)
  const fields: Record<string, Scalar> = { ...echoFields(ctx), root, depth }
  if (args.field) fields.field = args.field

  if (res.status === 'ok') {
    const body = res.body.replace(/^exec=\w+\n/, '').trim()
    if (body === 'root_not_found' || body === 'field_not_found') {
      return renderAiText({ reportType: 'ui_tree', fields: { ...fields, status: body } })
    }
    return renderAiText({
      reportType: 'ui_tree',
      fields: { ...fields, status: 'ok', lines: body.split('\n').length },
      results: [{ fields: {}, blocks: { tree: body } }],
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

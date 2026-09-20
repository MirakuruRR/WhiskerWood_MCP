-- Сериализация значений живой игры в текст. Используется мостом (полный дамп eval)
-- и ww_trace_calls (сжатая однострочная форма для сэмплов аргументов).
local M = {}

local function describeUserdata(v)
  local ok, s = pcall(function()
    if v.ToString then return v:ToString() end
    if v.IsValid and v:IsValid() then return v:GetFullName() end
    return "<invalid>"
  end)
  return ok and tostring(s) or "<userdata>"
end
M.describeUserdata = describeUserdata

-- Многострочное дерево без ограничения по длине — для ww_game_eval и OPS.eval моста.
function M.serialize(v, depth, out)
  depth, out = depth or 0, out or {}
  local pad = string.rep("  ", depth)
  if depth > 4 then
    out[#out + 1] = pad .. "<max_depth>"
    return out
  end
  local t = type(v)
  if t == "userdata" then
    out[#out + 1] = pad .. describeUserdata(v)
  elseif t == "table" then
    local empty = true
    for k, sub in pairs(v) do
      empty = false
      out[#out + 1] = pad .. tostring(k) .. ":"
      M.serialize(sub, depth + 1, out)
    end
    if empty then out[#out + 1] = pad .. "<empty_table>" end
  else
    out[#out + 1] = pad .. tostring(v)
  end
  return out
end

local MAX_INLINE_STRING = 80
local MAX_INLINE_FIELDS = 8

-- Однострочная сжатая форма для трейса вызовов: глубина по умолчанию 2, строки
-- обрезаны, таблицы ограничены по числу полей — в горячем хуке это должно быть дёшево.
function M.inline(v, depth, maxDepth)
  depth, maxDepth = depth or 0, maxDepth or 2
  local t = type(v)
  if t == "userdata" then
    return describeUserdata(v)
  elseif t == "table" then
    if depth >= maxDepth then return "<table>" end
    local parts = {}
    for k, sub in pairs(v) do
      parts[#parts + 1] = tostring(k) .. "=" .. M.inline(sub, depth + 1, maxDepth)
      if #parts >= MAX_INLINE_FIELDS then
        parts[#parts + 1] = "..."
        break
      end
    end
    return "{" .. table.concat(parts, ", ") .. "}"
  elseif t == "string" then
    if #v > MAX_INLINE_STRING then return '"' .. v:sub(1, MAX_INLINE_STRING) .. '..."' end
    return '"' .. v .. '"'
  else
    return tostring(v)
  end
end

return M

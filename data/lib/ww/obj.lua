-- Безопасные обёртки поиска. FindAllOf при нуле совпадений возвращает nil, а не {}.
--
-- FindFirstOf/FindAllOf — линейный обход GUObjectArray, на игровом сейве это ~12 мс
-- на вызов. Всё, что опрашивается в цикле, обязано идти через *_cached.
local M = {}

-- кеш в _G, а не в модуле: WWBridge сбрасывает package.loaded["ww.*"] при каждой
-- dev-перезагрузке, а снять коллбэк NotifyOnNewObject нечем — подписка должна её пережить
local S = _G.__WW_OBJ_CACHE
if S == nil then
  S = { single = {}, found = {}, lists = {}, miss = {} }
  _G.__WW_OBJ_CACHE = S
end

local MISS_RETRY_S = 1.0

function M.is_valid(o)
  if o == nil then return false end
  local ok, valid = pcall(function() return o:IsValid() end)
  return ok and valid == true
end

function M.first_of(className)
  local ok, o = pcall(FindFirstOf, className)
  if ok and M.is_valid(o) then return o end
  return nil
end

function M.all_of(className)
  local ok, list = pcall(FindAllOf, className)
  local out = {}
  if not ok or list == nil then return out end
  for _, o in ipairs(list) do
    if M.is_valid(o) then out[#out + 1] = o end
  end
  return out
end

function M.find(fullPath)
  local ok, o = pcall(StaticFindObject, fullPath)
  if ok and M.is_valid(o) then return o end
  return nil
end

-- без этого промах стоил бы полного скана на каждом тике опроса: в главном меню
-- ни PlayHud, ни ArcoSystems не существуют
local function recent_miss(key)
  local t = S.miss[key]
  return t ~= nil and (os.clock() - t) < MISS_RETRY_S
end

local function remember(key, o)
  S.miss[key] = o == nil and os.clock() or nil
  return o
end

function M.first_of_cached(className)
  local o = S.single[className]
  if M.is_valid(o) then return o end
  local key = "c:" .. className
  if recent_miss(key) then return nil end
  o = M.first_of(className)
  S.single[className] = o
  return remember(key, o)
end

function M.find_cached(fullPath)
  local o = S.found[fullPath]
  if M.is_valid(o) then return o end
  local key = "f:" .. fullPath
  if recent_miss(key) then return nil end
  o = M.find(fullPath)
  S.found[fullPath] = o
  return remember(key, o)
end

-- список пересобирается только когда игра создала объект этого класса; снос отсеивается
-- проверкой валидности, она на порядки дешевле повторного скана
function M.all_of_cached(className, notifyPath)
  local e = S.lists[className]
  if e == nil then
    e = { items = M.all_of(className), dirty = false }
    S.lists[className] = e
    pcall(NotifyOnNewObject, notifyPath or className, function()
      local live = _G.__WW_OBJ_CACHE.lists[className]
      if live then live.dirty = true end
    end)
    return e.items
  end

  if e.dirty then
    e.items = M.all_of(className)
    e.dirty = false
    return e.items
  end

  local out, n = {}, 0
  for i = 1, #e.items do
    local o = e.items[i]
    if M.is_valid(o) then
      n = n + 1
      out[n] = o
    end
  end
  if n < #e.items then e.items = out end
  return e.items
end

function M.invalidate(className)
  S.single[className] = nil
  local e = S.lists[className]
  if e then e.dirty = true end
end

function M.name_of(o)
  if not M.is_valid(o) then return "<invalid>" end
  local ok, s = pcall(function() return o:GetFName():ToString() end)
  return ok and s or "<unnamed>"
end

function M.class_of(o)
  if not M.is_valid(o) then return "<invalid>" end
  local ok, s = pcall(function() return o:GetClass():GetFName():ToString() end)
  return ok and s or "<unknown>"
end

return M

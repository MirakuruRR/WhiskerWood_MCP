-- Регистрация хуков, переживающая холодный старт игры.
--
-- При загрузке из mods.txt блюпринтовые классы (/Game/...) ещё не существуют, а RegisterHook
-- на ненайденную UFunction не возвращает nil, а бросает ошибку — она обрывает весь main.lua,
-- и мод молча мёртв. В dev-цикле этого не видно: мост грузит мод в живую игру, где UI собран.
--
-- Путь, который не встал сразу, дорегистрируется короткой серией попыток после каждой
-- загрузки карты. Цена: одна попытка = поиск по хэшу имени, серия обрывается сразу,
-- как только незакрытых путей не осталось, — в установившемся кадре не остаётся ничего.
local M = {}

local FAST_MS = 500
local FAST_TRIES = 10
local SLOW_MS = 2000
local SLOW_TRIES = 30

-- состояние в _G: WWBridge сбрасывает package.loaded["ww.*"] на каждой dev-перезагрузке,
-- а подписку RegisterLoadMapPostHook снять нечем — она обязана пережить модуль
local S = _G.__WW_HOOK_STATE
if S == nil then
  S = { mods = {}, mapsub = false }
  _G.__WW_HOOK_STATE = S
end

local function attempt(name)
  local st = S.mods[name]
  if st == nil then return 0 end
  local rest = {}
  for i = 1, #st.pending do
    local h = st.pending[i]
    if pcall(st.register, h.path, h.pre, h.post) then
      st.bound = st.bound + 1
    else
      rest[#rest + 1] = h
    end
  end
  st.pending = rest
  return #rest
end

local function tick(name, gen)
  ExecuteInGameThread(function()
    local st = S.mods[name]
    if st == nil or st.gen ~= gen then return end
    if attempt(name) == 0 then
      st.ticking = false
      st.log.info("hooks bound: " .. st.bound)
      return
    end
    st.tries = st.tries + 1
    if st.tries >= FAST_TRIES + SLOW_TRIES then
      st.ticking = false
      local left = {}
      for i = 1, #st.pending do left[i] = st.pending[i].path end
      st.log.warn("хуки так и не встали: " .. table.concat(left, ", "))
      return
    end
    ExecuteWithDelay(st.tries < FAST_TRIES and FAST_MS or SLOW_MS, function() tick(name, gen) end)
  end)
end

local function kick(name)
  local st = S.mods[name]
  if st == nil or #st.pending == 0 then return end
  st.tries = 0
  if st.ticking then return end
  st.ticking = true
  local gen = st.gen
  ExecuteWithDelay(FAST_MS, function() tick(name, gen) end)
end

-- главный триггер: BP-классы UI подтягиваются вместе с картой, серия попыток после
-- её загрузки закрывает все пути и глохнет. Возврат в меню и новая загрузка — новая серия
local function subscribeMap()
  if S.mapsub then return end
  S.mapsub = true
  pcall(RegisterLoadMapPostHook, function()
    for name in pairs(S.mods) do kick(name) end
  end)
end

-- register захватывается здесь, а не в момент постановки хука: WWRegisterHook мост
-- обнуляет сразу после dofile, а отложенная регистрация обязана попасть в его реестр,
-- иначе dev-перезагрузка не снимет старый коллбэк
function M.for_mod(name, log)
  local prev = S.mods[name]
  S.mods[name] = {
    gen = (prev and prev.gen or 0) + 1,
    register = WWRegisterHook or RegisterHook,
    log = log or require("ww.log").for_mod(name),
    pending = {},
    bound = 0,
    tries = 0,
    ticking = false,
  }
  local gen = S.mods[name].gen
  subscribeMap()

  local api = {}

  function api.on(path, pre, post)
    local st = S.mods[name]
    if st == nil or st.gen ~= gen then return false end
    if pcall(st.register, path, pre, post) then
      st.bound = st.bound + 1
      return true
    end
    st.pending[#st.pending + 1] = { path = path, pre = pre, post = post }
    kick(name)
    return false
  end

  function api.pending()
    local st = S.mods[name]
    return st and #st.pending or 0
  end

  return api
end

return M

-- Подписка на создание объектов, переживающая dev-перезагрузку.
--
-- NotifyOnNewObject снять нечем — UE4SS не даёт отписаться. После dev-перезагрузки
-- (WWBridge сбрасывает package.loaded["ww.*"] и зовёт dofile заново) старая Lua-функция,
-- на которую был подписан движок, всё ещё лежит в диспетчере, но принадлежит уже мёртвому
-- поколению мода — вызывать её незачем, а лишний RegisterHook пути не даёт даже узнать об
-- этом: подписка просто продолжает призрачно висеть и совпадающие объекты обрабатываются
-- по два, по три раза за перезагрузку. Поэтому диспетчер на класс всего один на сессию,
-- а какие коллбэки ему сейчас звать — решает счётчик поколений мода.
local M = {}

-- состояние в _G: переживает package.loaded["ww.*"] = nil на каждой dev-перезагрузке
local S = _G.__WW_WATCH_STATE
if S == nil then
  S = { mods = {}, classes = {} }
  _G.__WW_WATCH_STATE = S
end

function M.for_mod(name)
  local prev = S.mods[name]
  local gen = (prev and prev.gen or 0) + 1
  S.mods[name] = { gen = gen }

  local api = {}

  function api.on(class, fn)
    local c = S.classes[class]
    if c == nil then
      c = { handlers = {} }
      S.classes[class] = c
      pcall(NotifyOnNewObject, class, function(obj)
        for _, h in ipairs(c.handlers) do
          local modSt = S.mods[h.mod]
          if modSt and modSt.gen == h.gen then
            local ok, err = pcall(h.fn, obj)
            if not ok then
              print("[" .. h.mod .. "] ERROR watch(" .. class .. "): " .. tostring(err) .. "\n")
            end
          end
        end
      end)
    else
      -- живая чистка при каждой новой подписке: хвосты прошлых поколений на этот
      -- класс дальше только занимают память и цикл диспетчера, звать их всё равно некому
      local kept = {}
      for _, h in ipairs(c.handlers) do
        local modSt = S.mods[h.mod]
        if modSt and modSt.gen == h.gen then kept[#kept + 1] = h end
      end
      c.handlers = kept
    end
    c.handlers[#c.handlers + 1] = { mod = name, gen = gen, fn = fn }
  end

  return api
end

return M

-- Периодическая проверка состояния в игровом потоке.
--
-- Счётчик поколений живёт в _G, а не в этом модуле: WWBridge сбрасывает
-- package.loaded["ww.*"] при каждой dev-перезагрузке, и цепочка ExecuteWithDelay
-- от прошлой загрузки иначе тикала бы вечно рядом с новой.
local M = {}

_G.__WW_POLL_GEN = _G.__WW_POLL_GEN or {}
local GEN = _G.__WW_POLL_GEN

function M.stop(modName)
  GEN[modName] = (GEN[modName] or 0) + 1
end

function M.every(modName, ms, fn)
  M.stop(modName)
  local gen = GEN[modName]

  local function tick()
    if GEN[modName] ~= gen then return end
    ExecuteInGameThread(function()
      if GEN[modName] ~= gen then return end
      local ok, err = pcall(fn)
      if not ok then
        print("[" .. tostring(modName) .. "] ERROR poll: " .. tostring(err) .. "\n")
      end
    end)
    ExecuteWithDelay(ms, tick)
  end

  ExecuteWithDelay(ms, tick)
  return function() M.stop(modName) end
end

return M

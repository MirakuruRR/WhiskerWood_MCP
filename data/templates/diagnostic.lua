-- {{NAME}} — разведка живой игры: что существует, сколько и как называется.
-- Одноразовый инструмент. Для разовых вопросов быстрее ww_game_eval, без мода вообще.

local MOD = "{{NAME}}"
local log = require("ww.log").for_mod(MOD)
local obj = require("ww.obj")

-- Короткие имена классов, как их принимает FindAllOf (не пути).
local WATCH = {
  "UnlockResearchComponent",
}

-- Отчёт разовый, поэтому некешированный obj.all_of здесь уместен. В периодическом
-- коде он стоил бы ~12 мс на класс — там нужен obj.all_of_cached.
local function report()
  for _, className in ipairs(WATCH) do
    local all = obj.all_of(className)
    log.info(className .. ": instances=" .. #all)
    local first = all[1]
    if first then
      log.info("  first = " .. first:GetFullName())
      log.info("  class = " .. first:GetClass():GetFName():ToString())
    end
  end
end

RegisterInitGameStatePostHook(function()
  ExecuteWithDelay(3000, function()
    ExecuteInGameThread(function()
      local ok, err = pcall(report)
      if not ok then log.error(tostring(err)) end
    end)
  end)
end)

log.info("loaded, watching " .. #WATCH .. " class(es)")

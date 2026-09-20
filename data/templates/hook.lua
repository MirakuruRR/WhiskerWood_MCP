-- {{NAME}} — перехват UFunction.
-- Пути хуков берутся ТОЛЬКО из ww_get_function / ww_verify_hook (поле hook_path).
-- Готовый скелет обработчика с реальной сигнатурой даёт ww_generate_hook.

local MOD = "{{NAME}}"
local log = require("ww.log").for_mod(MOD)

-- ww.hook закрывает оба режима загрузки: в dev-цикле (ww_deploy_mod mode=dev) снимает
-- хуки прошлой перезагрузки через мост, а на холодном старте из mods.txt дорегистрирует
-- блюпринтовые пути после загрузки карты — голый RegisterHook там бросает ошибку
-- на ещё не загруженном /Game/-классе и обрывает весь main.lua.
local hook = require("ww.hook").for_mod(MOD, log)

-- Путь строкой прямо в вызове: только так ww_validate_mod сверит его с индексом.
-- hook.on("/Script/Pkg.Class:Func", function(Context, arg1)
--   log.info("arg1 = " .. tostring(arg1:get()))
-- end)

-- Нужно поймать момент СОЗДАНИЯ объекта, а не вызов функции — это ww.watch,
-- аналог ww.hook поверх NotifyOnNewObject (который сам по себе не переживает
-- dev-перезагрузку):
-- local watch = require("ww.watch").for_mod(MOD)
-- watch.on("ShortClassName", function(obj)
--   log.info("created: " .. obj:GetFullName())
-- end)

log.info("loaded")

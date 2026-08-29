-- {{NAME}} — перехват UFunction.
-- Пути хуков берутся ТОЛЬКО из ww_get_function / ww_verify_hook (поле hook_path).
-- Готовый скелет обработчика с реальной сигнатурой даёт ww_generate_hook.

local MOD = "{{NAME}}"
local log = require("ww.log").for_mod(MOD)

-- В dev-цикле (ww_deploy_mod mode=dev) мост подменяет WWRegisterHook и снимает
-- хуки прошлой загрузки; в релизной загрузке глобали нет.
local register = WWRegisterHook or RegisterHook

-- Каждая запись: { path = "<hook_path из ww_verify_hook>", pre = fn, post = fn }
local HOOKS = {
  -- {
  --   path = "/Script/Pkg.Class:Func",
  --   post = function(Context, arg1)
  --     log.info("arg1 = " .. tostring(arg1:get()))
  --   end,
  -- },
}

local function install()
  local noop = function() end
  for _, h in ipairs(HOOKS) do
    local ok, err = pcall(register, h.path, h.pre or noop, h.post)
    if ok then
      log.info("hook: " .. h.path)
    else
      log.error("hook failed: " .. h.path .. " — " .. tostring(err))
    end
  end
end

install()
log.info("loaded, hooks=" .. #HOOKS)

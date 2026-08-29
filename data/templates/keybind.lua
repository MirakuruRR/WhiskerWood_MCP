-- {{NAME}} — действие по горячей клавише.
-- Коллбэк RegisterKeyBind исполняется НЕ в игровом потоке: всё, что трогает UObject,
-- оборачивается в ExecuteInGameThread.

local MOD = "{{NAME}}"
local log = require("ww.log").for_mod(MOD)

local KEY = Key.F8
local MODIFIERS = { ModifierKey.CONTROL }

local function action()
  log.info("triggered")
end

local function bind()
  if IsKeyBindRegistered and IsKeyBindRegistered(KEY, MODIFIERS) then
    log.warn("комбинация уже занята, повторная регистрация пропущена")
    return
  end
  RegisterKeyBind(KEY, MODIFIERS, function()
    ExecuteInGameThread(function()
      local ok, err = pcall(action)
      if not ok then log.error(tostring(err)) end
    end)
  end)
  log.info("bound Ctrl+F8")
end

bind()

-- Лог с префиксом мода. print в UE4SS не добавляет перевод строки.
local M = {}

function M.for_mod(name)
  local prefix = "[" .. tostring(name) .. "] "
  local function emit(level, msg)
    print(prefix .. level .. tostring(msg) .. "\n")
  end
  return {
    name = name,
    info = function(msg) emit("", msg) end,
    warn = function(msg) emit("WARN ", msg) end,
    error = function(msg) emit("ERROR ", msg) end,
  }
end

return M

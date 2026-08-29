-- {{NAME}} — реакция на состояние игры с показом в UI.
-- Прежде чем строить свой оверлей, проверь родные подсистемы игры:
--   ww_find_symbol("NotificationBoard"), ww_find_symbol("ProblemIndicator")
-- Самодельный UMG выглядит чужеродно и ломается при смене разрешения.
-- Текст берётся из ww_resolve_loc готовой строкой: Utf8String на 5.6 не работает.

local MOD = "{{NAME}}"
local log = require("ww.log").for_mod(MOD)
local obj = require("ww.obj")
local poll = require("ww.poll")

local CHECK_EVERY_MS = 2000
local shown = false

-- Возвращает true, когда состояние требует показа уведомления.
local function needsNotice()
  local comp = obj.first_of("ClassNameFromWwFindSymbol")
  if not comp then return false end
  return false
end

local function show()
  log.info("notice: on")
end

local function hide()
  log.info("notice: off")
end

-- Тело исполняется в игровом потоке: poll.every сам оборачивает в ExecuteInGameThread.
poll.every(MOD, CHECK_EVERY_MS, function()
  local want = needsNotice()
  if want == shown then return end
  shown = want
  if want then show() else hide() end
end)

log.info("loaded")

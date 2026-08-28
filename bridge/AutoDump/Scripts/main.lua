local DUMP_DELAY_MS = 60000
local LEVEL_MARKER = "ArcoPlay"
local MAIN_MENU_MARKER = "MainMenuBackdrop"

local scheduled = false
local done = false

local function log(msg)
    print("[AutoDump] " .. msg .. "\n")
end

local function currentLevelName()
    local worlds = FindAllOf("World")
    if not worlds then return nil end
    local fallback
    for _, w in ipairs(worlds) do
        if w and w:IsValid() then
            local ok, full = pcall(function() return w:GetFullName() end)
            if ok and full and full:find("/Game/Levels/", 1, true) then
                if full:find(LEVEL_MARKER, 1, true) then return full end
                fallback = fallback or full
            end
        end
    end
    return fallback
end

local function runDumps(trigger)
    if done then return end
    done = true
    local level = currentLevelName() or "<unknown>"
    local captured = level:find(MAIN_MENU_MARKER, 1, true) and "main_menu"
        or (level:find(LEVEL_MARKER, 1, true) and "in_level" or "unknown")
    log("capturing: world=" .. level .. " captured_at=" .. captured .. " trigger=" .. trigger)

    log("DumpUSMAP() ...")
    local ok, err = pcall(DumpUSMAP)
    log("DumpUSMAP done ok=" .. tostring(ok) .. " err=" .. tostring(err))

    log("DumpAllObjects() ...")
    ok, err = pcall(DumpAllObjects)
    log("DumpAllObjects done ok=" .. tostring(ok) .. " err=" .. tostring(err))

    log("GenerateUHTCompatibleHeaders() ...")
    ok, err = pcall(GenerateUHTCompatibleHeaders)
    log("UHT headers done ok=" .. tostring(ok) .. (ok and "" or " err=" .. tostring(err)))

    log("ALL DONE captured_at=" .. captured)
end

local function scheduleFromHook(where)
    if done or scheduled then return end
    local level = currentLevelName()
    if not level then
        log("skip " .. where .. ": world not determined")
        return
    end
    if not level:find(LEVEL_MARKER, 1, true) then
        log("skip " .. where .. ": " .. level)
        return
    end
    scheduled = true
    log("level detected via " .. where .. ": " .. level .. "; dumping in " .. DUMP_DELAY_MS .. "ms")
    ExecuteWithDelay(DUMP_DELAY_MS, function()
        scheduled = false
        -- мир мог смениться на меню, пока шёл таймер
        local recheck = currentLevelName()
        if not recheck or not recheck:find(LEVEL_MARKER, 1, true) then
            log("delayed capture aborted: world is now " .. tostring(recheck))
            return
        end
        runDumps(where)
    end)
end

local function armFromHook(where)
    ExecuteWithDelay(2000, function() scheduleFromHook(where) end)
end

RegisterInitGameStatePostHook(function() armFromHook("InitGameState") end)
RegisterLoadMapPostHook(function() armFromHook("LoadMap") end)

RegisterKeyBindAsync(Key.F9, {ModifierKey.CONTROL, ModifierKey.ALT}, function()
    log("manual dump requested")
    runDumps("manual")
end)

log("armed: InitGameState/LoadMap hooks, delay=" .. DUMP_DELAY_MS .. "ms, manual=Ctrl+Alt+F9")

local SCRIPT_DIR = debug.getinfo(1, "S").source:sub(2):gsub("main%.lua$", "")
local okCfg, cfg = pcall(dofile, SCRIPT_DIR .. "config.lua")
if not okCfg or type(cfg) ~= "table" or not cfg.root then
    print("[WWBridge] config.lua отсутствует или повреждён; запустите bun run bridge:deploy в WhiskerWood_MCP\n")
    return
end

local IN, OUT = cfg.root .. "/in", cfg.root .. "/out"
local STATUS = cfg.root .. "/bridge.status"
local QUEUE, QUEUE_WORK = IN .. "/queue", IN .. "/queue.work"
local POLL_MS = cfg.poll_ms or 120
local WORLD_REFRESH_TICKS = math.max(1, math.floor(5000 / POLL_MS))
local DEFAULT_TIMEOUT_MS = 5000

if cfg.mods_repo then
    package.path = cfg.mods_repo .. "/lib/?.lua;" .. cfg.mods_repo .. "/lib/?/init.lua;" .. package.path
end

local UEHelpers = require("UEHelpers")
local dump = require("ww.dump")

math.randomseed(os.time())
local SESSION = string.format("%06x", math.random(0, 0xffffff))
local STARTED = os.time()
local tick, busy = 0, ""
local world, lastError = "", ""
local hookRegistry = {}
local pending = {}

local function log(msg)
    print("[WWBridge] " .. msg .. "\n")
end

local function writeAtomic(path, text)
    local tmp = path .. ".tmp"
    local f = io.open(tmp, "wb")
    if not f then return false end
    f:write(text)
    f:close()
    os.remove(path)
    return os.rename(tmp, path)
end

local function writeStatus()
    writeAtomic(STATUS, string.format(
        "session=%s\ntick=%d\nts=%d\nstarted_ts=%d\nbusy=%s\nworld=%s\nlast_error=%s\n",
        SESSION, tick, os.time(), STARTED, busy, world, lastError))
end

local function setError(body)
    lastError = tostring(body):gsub("[\r\n]+", " "):sub(1, 200)
end

local function writeResult(id, ok, body, elapsedMs, exec)
    if not ok then setError(body) end
    writeAtomic(OUT .. "/" .. id .. ".res", string.format(
        "id=%s\nsession=%s\nok=%s\nelapsed_ms=%d\nexec=%s\n--result--\n%s",
        id, SESSION, tostring(ok and true or false), elapsedMs, exec or "", tostring(body)))
    os.remove(IN .. "/" .. id .. ".req")
    if busy == id then busy = "" end
end

-- Спайк 2 закрыт отрицательно: ExecuteInGameThread на этой сборке ставит коллбэк в
-- очередь, а не исполняет на месте. Поэтому ответ формируется коллбэком, а не сразу
-- после диспатча: опрос продолжает тикать, результат забирается следующим тиком.
local function dispatchGameThread(id, timeoutMs, fn)
    local rec = {
        t0 = os.clock(),
        deadline = os.time() + math.max(2, math.ceil(timeoutMs / 1000) + 1),
        done = false,
    }
    pending[id] = rec
    local dispatched = pcall(ExecuteInGameThread, function()
        if rec.done or rec.abandoned then return end
        local called, ok, body = pcall(fn)
        if called then
            rec.ok, rec.body = ok, body
        else
            rec.ok, rec.body = false, "game_thread_error: " .. tostring(ok)
        end
        rec.done = true
    end)
    if not dispatched then
        local called, ok, body = pcall(fn)
        rec.ok, rec.body = called and ok or false, called and body or tostring(ok)
        rec.done, rec.exec = true, "direct"
        return rec
    end
    rec.exec = rec.done and "game_thread_sync" or "game_thread_async"
    return rec
end

local function sweepPending()
    local now = os.time()
    for id, rec in pairs(pending) do
        if rec.done then
            pending[id] = nil
            writeResult(id, rec.ok, rec.body, math.floor((os.clock() - rec.t0) * 1000), rec.exec)
        elseif now > rec.deadline then
            rec.abandoned = true
            pending[id] = nil
            writeResult(id, false, "game_thread_timeout: коллбэк не исполнился в игровом потоке",
                math.floor((os.clock() - rec.t0) * 1000), rec.exec)
        end
    end
end

local function parseRequest(text)
    local head, payload = text:match("^(.-)\n%-%-payload%-%-\n(.*)$")
    head = head or text
    local req = { payload = payload or "" }
    for k, val in head:gmatch("([%w_]+)=([^\n]*)") do req[k] = val end
    return req
end

local function timeoutOf(req)
    return tonumber(req.timeout_ms) or DEFAULT_TIMEOUT_MS
end

local function refreshWorld()
    pcall(ExecuteInGameThread, function()
        local w = UEHelpers.GetWorld()
        world = (w and w:IsValid()) and w:GetFullName() or ""
    end)
end

local OPS = {}

function OPS.ping()
    return "done", true, string.format("session=%s\ntick=%d\nworld=%s", SESSION, tick, world), ""
end

function OPS.world(req, id)
    dispatchGameThread(id, timeoutOf(req), function()
        local w = UEHelpers.GetWorld()
        world = (w and w:IsValid()) and w:GetFullName() or ""
        return true, world ~= "" and world or "<no_world>"
    end)
    return "pending"
end

function OPS.eval(req, id)
    local chunk, err = load(req.payload, "@wwbridge_eval")
    if not chunk then return "done", false, "compile_error: " .. tostring(err), "" end
    dispatchGameThread(id, timeoutOf(req), function()
        local packed = table.pack(pcall(chunk))
        if not packed[1] then return false, tostring(packed[2]) end
        if packed.n <= 1 then return true, "<no_value>" end
        local out = {}
        for i = 2, packed.n do
            for _, line in ipairs(dump.serialize(packed[i])) do out[#out + 1] = line end
        end
        return true, table.concat(out, "\n")
    end)
    return "pending"
end

-- Хуковая форма пути использует ':' перед именем функции, объектная - '.'.
-- Принимать путь как есть нельзя: для существующей нативной функции одна из форм
-- даст ложный not_found. Пробуем обе и сообщаем, какая сработала (спайк 3).
function OPS.probe(req, id)
    dispatchGameThread(id, timeoutOf(req), function()
        local lines = {}
        for line in req.payload:gmatch("[^\n]+") do
            local classPart, funcPart = line:match("^(.-):([%w_]+)$")
            local found, via = false, "none"
            if funcPart then
                local direct = StaticFindObject(line)
                if direct and direct:IsValid() then
                    found, via = true, "colon"
                else
                    local dotted = StaticFindObject(classPart .. "." .. funcPart)
                    if dotted and dotted:IsValid() then
                        found, via = true, "dot"
                    else
                        local cls = StaticFindObject(classPart)
                        via = (cls and cls:IsValid()) and "class_only" or "no_class"
                    end
                end
            else
                local obj = StaticFindObject(line)
                if obj and obj:IsValid() then found, via = true, "object" end
            end
            lines[#lines + 1] = string.format("%s = %s via=%s", line, found and "found" or "not_found", via)
        end
        return true, table.concat(lines, "\n")
    end)
    return "pending"
end

-- Через KismetSystemLibrary, а не PlayerController:ConsoleCommand: PlayerController
-- здесь блюпринтовый (BP_PlayerController_Play_C), и вызов ConsoleCommand на нём падает
-- с "attempt to call a TrivialObject value". KSL работает на том же стенде.
function OPS.console(req, id)
    dispatchGameThread(id, timeoutOf(req), function()
        local command = req.payload:gsub("[\r\n]+", " "):gsub("^%s+", ""):gsub("%s+$", "")
        if command == "" then return false, "empty_command" end
        local world = UEHelpers.GetWorld()
        local ksl = UEHelpers.GetKismetSystemLibrary()
        if ksl and ksl:IsValid() and world and world:IsValid() then
            ksl:ExecuteConsoleCommand(world, command, nil)
            return true, "sent via=KismetSystemLibrary"
        end
        local pc = UEHelpers.GetPlayerController()
        if pc and pc:IsValid() then
            pc:ConsoleCommand(command, true)
            return true, "sent via=PlayerController"
        end
        return false, "no_console_target: ни KismetSystemLibrary, ни PlayerController недоступны"
    end)
    return "pending"
end

-- Заменяет недоступный снаружи hot-reload. Снимает хуки предыдущей загрузки:
-- иначе каждый повторный dofile регистрирует коллбэки поверх старых и после трёх
-- итераций правки уведомление срабатывает трижды.
function OPS.load_mod(req, id)
    local modPath = req.payload:gsub("%s+$", "")
    dispatchGameThread(id, timeoutOf(req), function()
        for _, h in ipairs(hookRegistry[modPath] or {}) do
            pcall(UnregisterHook, h.path, h.preId, h.postId)
        end
        hookRegistry[modPath] = {}

        for name in pairs(package.loaded) do
            if name:match("^ww%.") then package.loaded[name] = nil end
        end

        _G.WWRegisterHook = function(path, pre, post)
            local preId, postId = RegisterHook(path, pre, post)
            table.insert(hookRegistry[modPath], { path = path, preId = preId, postId = postId })
            return preId, postId
        end

        local ok, err = pcall(dofile, modPath)
        _G.WWRegisterHook = nil
        if not ok then return false, tostring(err) end
        return true, "loaded, hooks=" .. #hookRegistry[modPath]
    end)
    return "pending"
end

function OPS.unload_mod(req, id)
    local modPath = req.payload:gsub("%s+$", "")
    dispatchGameThread(id, timeoutOf(req), function()
        local n = 0
        for _, h in ipairs(hookRegistry[modPath] or {}) do
            pcall(UnregisterHook, h.path, h.preId, h.postId)
            n = n + 1
        end
        hookRegistry[modPath] = nil
        return true, "unloaded, hooks_removed=" .. n
    end)
    return "pending"
end

local function handleOne(id)
    local f = io.open(IN .. "/" .. id .. ".req", "rb")
    if not f then return end
    local req = parseRequest(f:read("a"))
    f:close()

    busy = id
    local handler = OPS[req.op or ""]
    if not handler then
        writeResult(id, false, "unknown_op: " .. tostring(req.op), 0, "")
        return
    end

    local t0 = os.clock()
    local called, mode, ok, body, exec = pcall(handler, req, id)
    if not called then
        pending[id] = nil
        writeResult(id, false, "handler_crash: " .. tostring(mode), 0, "")
        return
    end
    if mode == "pending" then return end
    writeResult(id, ok, body, math.floor((os.clock() - t0) * 1000), exec or "")
end

local function pollOnce()
    tick = tick + 1
    if tick % WORLD_REFRESH_TICKS == 1 then refreshWorld() end
    sweepPending()
    writeStatus()

    -- Атомарный перехват: всё, что сервер допишет после rename, попадёт в новый
    -- queue и обработается следующим тиком. Читать-и-удалять здесь нельзя - потеряем.
    -- Хвост от аварийного завершения снимаем заранее: на Windows rename поверх
    -- существующего файла не проходит и очередь встала бы навсегда.
    os.remove(QUEUE_WORK)
    if os.rename(QUEUE, QUEUE_WORK) then
        local ids = {}
        local q = io.open(QUEUE_WORK, "r")
        if q then
            for id in q:lines() do
                local trimmed = id:gsub("%s+$", "")
                if trimmed ~= "" then ids[#ids + 1] = trimmed end
            end
            q:close()
        end
        os.remove(QUEUE_WORK)
        for _, id in ipairs(ids) do handleOne(id) end
        sweepPending()
    end
end

local function poll()
    local ok, err = pcall(pollOnce)
    if not ok then
        setError(err)
        log("poll error: " .. lastError)
    end
    ExecuteWithDelay(POLL_MS, poll)
end

-- Файлы прошлой сессии исполнять нельзя: они относятся к другому запуску игры
-- и другому состоянию мира. Сервер их уже не ждёт.
os.remove(QUEUE)
os.remove(QUEUE_WORK)
writeStatus()

RegisterInitGameStatePostHook(function() ExecuteWithDelay(1000, refreshWorld) end)
RegisterLoadMapPostHook(function() ExecuteWithDelay(1000, refreshWorld) end)

log(string.format("started session=%s root=%s poll=%dms", SESSION, cfg.root, POLL_MS))
ExecuteWithDelay(500, poll)

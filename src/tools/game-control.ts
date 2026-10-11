import { ServerConfig } from '../config'
import { GameContext } from '../utils/game-context'
import { getBridge } from '../utils/bridge-client'
import { renderAiText, Scalar } from '../utils/ai-text'
import { bridgeFailureFields, echoFields } from './bridge-common'
import { luaStr } from './common'

export type GameControlAction = 'status' | 'pause' | 'resume' | 'speed' | 'end_day' | 'close_popup' | 'camera'

export interface GameControlArgs {
  action?: GameControlAction
  speed?: number
  pan_to?: { x: number; y: number }
  move?: { forward?: number; right?: number }
  zoom?: number
  zoom_by?: number
  rotate_by?: number
  focus?: string
}

// FHudAction из Lua в нативную функцию передавать нельзя: UE4SS роняет игру (AV 0x70) и с таблицей,
// и со структурой, прочитанной с живой кнопки. Поэтому жмём кнопки их собственными BP-обработчиками
// без аргументов — структуру внутри передаёт уже VM Blueprint.
const PRELUDE = `
local R = {}
local function put(k, v) R[#R + 1] = k .. "=" .. tostring(v) end
local function live(cls, needle, extra)
  for _, o in ipairs(FindAllOf(cls) or {}) do
    if o:IsValid() then
      local fn = o:GetFullName()
      if fn:find(needle, 1, true) and (not extra or extra(o, fn)) then return o end
    end
  end
end
local pc = live("PlayerController_Play", "PersistentLevel")
if not pc then return "error=no_player_controller" end
local hud = live("BP_PlayHud_C", "/Engine/Transient")
local tcb = live("TimeControlButtons_C", "/Engine/Transient", function(o, fn)
  return not fn:find("Preplace", 1, true) and o.btnPause:IsValid()
end)
local wt = live("WorldTime", "PersistentLevel")
local gs = StaticFindObject("/Script/Engine.Default__GameplayStatics")
local SPEED_BTN = { "btn_speed1", "btn_speed2", "btn_speed4" }
local function selectedSpeed()
  if not tcb then return 0 end
  for i, k in ipairs(SPEED_BTN) do
    if tcb[k].Selected then return i end
  end
  return 0
end
local function press(b)
  b:BndEvt__TimeButton_Button_67_K2Node_ComponentBoundEvent_1_OnButtonPressedEvent__DelegateSignature()
  b:BndEvt__TimeButton_Button_67_K2Node_ComponentBoundEvent_2_OnButtonReleasedEvent__DelegateSignature()
end
local function eodView()
  return live("Arcoview_EOD_EndOfDayReport_Summary_BP_C", "/Engine/Transient", function(o) return o:IsInViewport() end)
end
local function eodStage()
  local v = eodView()
  if v then return v.PlayerHasSigned and "report_signed" or "report", v end
  if hud then
    local vis = hud.endDayOverlay:GetVisibility()
    if vis ~= 1 and vis ~= 2 then return "day_over" end
  end
  return "none"
end
local function liveViews()
  local out = {}
  for _, w in ipairs(FindAllOf("ArcoView") or {}) do
    if w:IsValid() and w:GetFullName():find("/Engine/Transient", 1, true) then
      local ok, inVp = pcall(function() return w:IsInViewport() end)
      if ok and inVp then out[#out + 1] = w end
    end
  end
  return out
end
`

const STATE = `
local paused = gs:IsGamePaused(pc)
local sel = selectedSpeed()
if not paused and sel > 0 then WW_CTRL_LAST_SPEED = sel end
put("paused", paused)
put("speed", paused and 0 or sel)
put("last_speed", WW_CTRL_LAST_SPEED or 0)
put("time_dilation", string.format("%.2f", gs:GetGlobalTimeDilation(pc)))
put("time_buttons", tcb and "ok" or "missing")
if wt then
  put("day", wt.m_day)
  put("day_time_remaining_s", string.format("%.0f", wt:GetDayTimeRemaining()))
  put("day_phase", wt.m_currentPhase == 1 and "LATE_NIGHT" or "MID_DAY")
end
put("end_of_day", (eodStage()))
local views = {}
for _, w in ipairs(liveViews()) do
  local name = w:GetClass():GetFName():ToString()
  local okP, holds = pcall(function() return w.config.desirePauseGame end)
  views[#views + 1] = (okP and holds) and (name .. "(pause)") or name
end
put("open_views", #views > 0 and table.concat(views, ", ") or "none")
local pawn = pc.Pawn
if pawn:IsValid() then
  local p = pawn.m_desiredPanPos
  local r = pawn.m_desiredRot
  put("camera_x", string.format("%.0f", p.X))
  put("camera_y", string.format("%.0f", p.Y))
  put("camera_zoom", string.format("%.0f", pawn.m_desiredZoomDist))
  put("camera_zoom_range", string.format("%.0f..%.0f", pawn.m_config.minCamDist, pawn.m_config.maxCamDist))
  put("camera_yaw", string.format("%.1f", r.Yaw % 360))
end
return table.concat(R, "\\n")
`

function luaNum(v: number): string {
  return Number.isFinite(v) ? String(v) : '0'
}

function actionChunk(args: GameControlArgs, action: GameControlAction): string {
  switch (action) {
    case 'pause':
      return `
if not tcb then return "error=no_time_buttons" end
if gs:IsGamePaused(pc) then put("result", "already_paused") return table.concat(R, "\\n") end
local sel = selectedSpeed()
if sel > 0 then WW_CTRL_LAST_SPEED = sel end
press(tcb.btnPause)
put("result", gs:IsGamePaused(pc) and "paused" or "no_effect")
return table.concat(R, "\\n")`
    case 'resume':
    case 'speed': {
      const explicit = args.speed !== undefined ? String(args.speed) : 'nil'
      return `
if not tcb then return "error=no_time_buttons" end
local want = ${explicit}
local source = "arg"
if not want then
  if ${action === 'resume' ? 'true' : 'false'} then
    want = WW_CTRL_LAST_SPEED
    source = want and "last" or "default"
    want = want or 1
  end
end
if not want then return "error=speed_required" end
local wasPaused = gs:IsGamePaused(pc)
if not wasPaused and source ~= "arg" then put("result", "already_running") return table.concat(R, "\\n") end
if not wasPaused and selectedSpeed() == want then put("result", "already") put("speed_source", source) return table.concat(R, "\\n") end
local b = tcb[SPEED_BTN[want]]
if not b:GetIsEnabled() then return "error=button_disabled" end
press(b)
WW_CTRL_LAST_SPEED = want
put("speed_source", source)
put("result", (wasPaused and gs:IsGamePaused(pc)) and "no_effect" or "ok")
return table.concat(R, "\\n")`
    }
    case 'end_day':
      return `
local stage, v = eodStage()
put("stage_before", stage)
if stage == "day_over" then
  hud:BndEvt__BP_PlayHud_Arco_Button_CommonRound_K2Node_ComponentBoundEvent_0_OnClicked__DelegateSignature()
  put("result", "report_opened")
elseif stage == "report" then
  v:BndEvt__Arcoview_EOD_EndOfDayReport_Summary_BP_Arco_Button_CommonRound_K2Node_ComponentBoundEvent_0_OnClicked__DelegateSignature()
  put("result", "signed")
else
  put("result", stage == "report_signed" and "waiting" or "not_end_of_day")
end
return table.concat(R, "\\n")`
    case 'close_popup':
      return `
local MAIL = { [0] = "UNLOCK", "EMERGENCY_QUEST", "EMERGENCY_QUEST_FAILED", "EMERGENCY_QUEST_COMPLETED", "CLAWS_REWARD_SELECTION", "NOTIF" }
local closed, skipped = {}, {}
for _, w in ipairs(FindAllOf("Arcoview_Announcement_BP_C") or {}) do
  if w:IsValid() and w:GetFullName():find("/Engine/Transient", 1, true) and w:IsInViewport() then
    local t = w.m_notifInfo.NotifType
    if t == 4 then
      skipped[#skipped + 1] = MAIL[t]
    else
      w:Close()
      closed[#closed + 1] = MAIL[t] or tostring(t)
    end
  end
end
if #closed > 0 then put("closed", table.concat(closed, ", ")) end
if #skipped > 0 then put("needs_choice", table.concat(skipped, ", ")) end
put("result", #closed > 0 and "closed" or (#skipped > 0 and "needs_choice" or "nothing_to_close"))
return table.concat(R, "\\n")`
    case 'camera': {
      const lines: string[] = []
      if (args.focus) {
        lines.push(`
local target = StaticFindObject(${luaStr(args.focus)})
if not target or not target:IsValid() then
  for _, o in ipairs(FindAllOf(${luaStr(args.focus)}) or {}) do
    if o:IsValid() and not o:GetFullName():find("Default__", 1, true) then target = o break end
  end
end
if not target or not target:IsValid() then return "error=focus_not_found" end
local okLoc, loc = pcall(function() return target:K2_GetActorLocation() end)
if not okLoc or not loc then return "error=focus_not_actor" end
p.X = loc.X
p.Y = loc.Y
put("focused", target:GetFullName())`)
      }
      if (args.pan_to) lines.push(`p.X = ${luaNum(args.pan_to.x)}\np.Y = ${luaNum(args.pan_to.y)}`)
      if (args.rotate_by !== undefined) lines.push(`r.Yaw = r.Yaw + ${luaNum(args.rotate_by)}`)
      if (args.move) {
        lines.push(`
local yaw = math.rad(r.Yaw)
local f, rt = ${luaNum(args.move.forward ?? 0)}, ${luaNum(args.move.right ?? 0)}
p.X = p.X + f * math.cos(yaw) - rt * math.sin(yaw)
p.Y = p.Y + f * math.sin(yaw) + rt * math.cos(yaw)`)
      }
      if (args.zoom !== undefined) lines.push(`zoom = ${luaNum(args.zoom)}`)
      if (args.zoom_by !== undefined) lines.push(`zoom = zoom * ${luaNum(args.zoom_by)}`)
      return `
local pawn = pc.Pawn
if not pawn:IsValid() then return "error=no_camera_pawn" end
local p = pawn.m_desiredPanPos
local r = pawn.m_desiredRot
local cfg = pawn.m_config
local zoom = pawn.m_desiredZoomDist
${lines.join('\n')}
local clamped = math.max(cfg.minCamDist, math.min(cfg.maxCamDist, zoom))
if clamped ~= zoom then put("zoom_clamped", true) end
pawn.m_desiredZoomDist = clamped
put("result", "ok")
return table.concat(R, "\\n")`
    }
    default:
      return 'return ""'
  }
}

function parseKv(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of body.replace(/^exec=\w+\n/, '').split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

function scalar(v: string): Scalar {
  if (v === 'true') return true
  if (v === 'false') return false
  return /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v
}

const ERROR_HINTS: Record<string, string> = {
  no_player_controller: 'мир не загружен: управлять нечем, сначала загрузи сохранение (ww_game_process)',
  no_time_buttons: 'кнопки времени HUD не найдены: открыт экран без HUD (меню, катсцена) — проверь кадр ww_screenshot',
  button_disabled: 'кнопка скорости выключена игрой: обычно висит окно, которое держит паузу (отчёт конца дня, событие) — смотри end_of_day и кадр',
  speed_required: 'для action=speed укажи speed: 1, 2 или 3',
  no_camera_pawn: 'у контроллера нет пешки камеры: уровень ещё грузится',
  focus_not_found: 'focus не нашёлся ни как путь объекта, ни как класс для FindAllOf',
  focus_not_actor: 'focus найден, но это не актор: у него нет позиции в мире',
}

const RESULT_HINTS: Record<string, string> = {
  no_effect:
    'кнопка нажата, но состояние не сменилось: игру держит на паузе открытое окно (отчёт дня, событие, меню) — сними его, затем повтори',
  not_end_of_day: 'день ещё идёт: плашки «День N окончен» нет; сколько осталось — в day_time_remaining_s',
  waiting: 'отчёт уже подписан, игра доигрывает анимацию штампа и сама начнёт день',
  needs_choice: 'окно ждёт выбора награды когтей: закрыть его нельзя, выбор делай в окне (ww_ui_tree, ww_screenshot)',
  nothing_to_close:
    'всплывающих объявлений нет; если паузу держит другое окно — его класс в open_views, разбирай через ww_ui_tree и ww_screenshot',
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function handleGameControl(
  ctx: GameContext | null,
  config: ServerConfig,
  args: GameControlArgs,
): Promise<string> {
  const action = args.action ?? 'status'
  const fields: Record<string, Scalar> = { ...echoFields(ctx), action }
  const bridge = getBridge(config)

  const camArgs = args.pan_to || args.move || args.zoom !== undefined || args.zoom_by !== undefined || args.rotate_by !== undefined || args.focus
  if (action === 'camera' && !camArgs) {
    return renderAiText({
      reportType: 'game_control',
      fields: { ...fields, status: 'bad_request', hint: 'action=camera ждёт хотя бы одно из: pan_to, move, zoom, zoom_by, rotate_by, focus' },
    })
  }
  if (action !== 'camera' && camArgs) {
    return renderAiText({
      reportType: 'game_control',
      fields: { ...fields, status: 'bad_request', hint: 'параметры камеры работают только с action=camera' },
    })
  }

  const run = async (body: string) => bridge.call('eval', `${PRELUDE}\n${body}`, 15_000)

  const steps: string[] = []
  if (action !== 'status') {
    const rounds = action === 'end_day' ? 2 : 1
    for (let i = 0; i < rounds; i++) {
      const res = await run(actionChunk(args, action))
      if (res.status !== 'ok') return failure(fields, res)
      const kv = parseKv(res.body)
      if (kv.error) {
        return renderAiText({
          reportType: 'game_control',
          fields: { ...fields, status: kv.error, ...(ERROR_HINTS[kv.error] ? { hint: ERROR_HINTS[kv.error] } : {}) },
        })
      }
      for (const [k, v] of Object.entries(kv)) if (k !== 'result' && k !== 'stage_before') fields[k] = scalar(v)
      steps.push(kv.result ?? '?')
      if (action !== 'end_day' || kv.result !== 'report_opened') break
      await sleep(400)
    }
    if (action === 'end_day' && steps.at(-1) === 'signed') await sleep(2500)
    else await sleep(250)
  }

  const res = await run(STATE)
  if (res.status !== 'ok') return failure(fields, res)
  const kv = parseKv(res.body)
  if (kv.error) {
    return renderAiText({
      reportType: 'game_control',
      fields: { ...fields, status: kv.error, ...(ERROR_HINTS[kv.error] ? { hint: ERROR_HINTS[kv.error] } : {}) },
    })
  }
  const last = steps.at(-1)
  fields.status = 'ok'
  if (steps.length > 0) fields.result = steps.join(' -> ')
  for (const [k, v] of Object.entries(kv)) fields[k] = scalar(v)
  if (last && RESULT_HINTS[last]) fields.hint = RESULT_HINTS[last]
  else if (kv.paused === 'true' && kv.end_of_day !== 'none') fields.hint = 'игру держит конец дня: action=end_day'
  else if (kv.paused === 'true' && kv.open_views?.includes('Arcoview_Announcement_BP_C'))
    fields.hint = 'паузу держит всплывающее объявление: action=close_popup'
  else if (kv.paused === 'true' && kv.open_views?.includes('(pause)'))
    fields.hint = 'паузу держит открытое окно из open_views: закрой его в игре, resume его не пересилит'
  else if (action === 'status' && kv.paused === 'true') fields.hint = 'игра на паузе (в том числе автопауза от прибывшего корабля): action=resume'
  return renderAiText({ reportType: 'game_control', fields })
}

function failure(fields: Record<string, Scalar>, res: Awaited<ReturnType<ReturnType<typeof getBridge>['call']>>): string {
  if (res.status === 'ok') return renderAiText({ reportType: 'game_control', fields })
  if (res.status === 'error') {
    return renderAiText({
      reportType: 'game_control',
      fields: { ...fields, status: 'lua_error' },
      results: [{ fields: {}, blocks: { error: res.body } }],
    })
  }
  return renderAiText({ reportType: 'game_control', fields: { ...fields, ...bridgeFailureFields(res) } })
}

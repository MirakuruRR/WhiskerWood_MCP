// HudOverlay — вариант BP_MapLoad для мода с оверлеем в HUD. Брать ВМЕСТО BP_MapLoad.lm.tpl,
// а не вместе с ним: первая строка здесь тоже BP_MapLoad, два файла на один ассет не соберутся.
// Пара — WBP_<Мод>Overlay.lm.tpl: этот актор создаёт его через create_widget.
// Файлы: <кит>/Content/Mods/<Мод>/{BP_MapLoad.lm, WBP_<Мод>Overlay.lm}, <Мод> — имя папки мода.
//
// Зачем каждый кадр: BP_PlayHud.ImportantAgentModifiers при перестройке выбрасывает чужие
// виджеты. Свой виджет держат не в самом ряду, а в канвасе-родителе ряда, и возвращают туда
// каждый кадр — поэтому Tick, а не подписка.
//
// Грабли HUD, проверенные на порте:
// - клик по своему виджету вне ряда до контроллера не доходит: привяжи OnClicked и вызови
//   PlayerController_Play.HandleHudAction;
// - место слева от ряда общее: другой мод с таким же расчётом встанет туда же, и виджеты
//   перекроются — сверху тот, кого позже добавили в канвас. Если ставишь рядом с чужим модом, сдвинь Gap;
// - тултип игрового баннера задаётся привязкой по Problem Type, SetToolTip после
//   AddChildToCanvas её перебивает, а Slate берёт тултип самого глубокого виджета под курсором.

blueprint BP_MapLoad : Actor at /Game/Mods/<Мод>/BP_MapLoad

var Prefix: string = "<Мод>: "
var Ready: bool = false
var Overlay: WBP_<Мод>Overlay
var Gap: float = 6.0

// Пауза и поздняя группа: ряд HUD перестраивается в своём кадре, наш должен идти после него
default PrimaryActorTick.bTickEvenWhenPaused = true
default PrimaryActorTick.TickGroup = ETickingGroup.TG_PostUpdateWork

on ReceiveBeginPlay {
    let api = ModAPI.GetModAPI()
    api.onLoadingFinished.bind(Start)
    api.LogMessage(Prefix + "map load", false)
}

fn Start() {
    Ready = true
    ModAPI.GetModAPI().LogMessage(Prefix + "world ready", false)
}

on ReceiveTick(dt: float) {
    if !Ready {
        return
    }
    let hud = FindHud()
    if hud == none {
        return
    }
    let row = hud.ImportantAgentModifiers
    if row == none {
        return
    }
    let canvas = cast(row.GetParent(), CanvasPanel)
    if canvas == none {
        return
    }
    if Overlay == none {
        Overlay = create_widget(WBP_<Мод>Overlay)
        if Overlay == none {
            return
        }
    }
    // виджет выбросили при перестройке ряда — возвращаем; если он на месте, ничего не меняем
    if Overlay.GetParent() != canvas {
        let added = canvas.AddChildToCanvas(Overlay)
        added.SetAutoSize(true)
        added.SetAlignment(Vector2D(X: 0.5, Y: 0.0))
    }
    Place(row)
}

fn FindHud() -> BP_PlayHud {
    let pc = cast(GameplayStatics.GetPlayerController(0), PlayerController_Play)
    if pc != none {
        let own = cast(pc.m_playHud, BP_PlayHud)
        if own != none {
            return own
        }
    }
    let found = WidgetBlueprintLibrary.GetAllWidgetsOfClass(BP_PlayHud, false)
    if found.FoundWidgets.Length() == 0 {
        return none
    }
    return cast(found.FoundWidgets[0], BP_PlayHud)
}

// ряд растёт от якоря в обе стороны: своё место считаем от позиции, размера и выравнивания слота ряда
fn Place(row: Widget) {
    let rowSlot = cast(row.Slot, CanvasPanelSlot)
    let ownSlot = cast(Overlay.Slot, CanvasPanelSlot)
    if rowSlot == none || ownSlot == none {
        return
    }
    let rowSize = row.GetDesiredSize()
    let rowPos = rowSlot.GetPosition()
    let rowAlign = rowSlot.GetAlignment()
    let ownWidth = Overlay.GetDesiredSize().X
    ownSlot.SetAnchors(rowSlot.GetAnchors())
    ownSlot.SetPosition(Vector2D(X: rowPos.X - rowSize.X * rowAlign.X - Gap - ownWidth / 2.0, Y: rowPos.Y - rowSize.Y * rowAlign.Y))
}

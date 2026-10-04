// BP_MapLoad — игра сама спавнит актор с этим именем при загрузке сохранения.
// Он спавнится во время загрузочного экрана, поэтому мир трогаем только после
// делегата onLoadingFinished: до него объектов карты ещё нет.
// Файл: <кит>/Content/Mods/<Мод>/BP_MapLoad.lm, <Мод> — имя папки мода.
//
// Если моду нужен оверлей в HUD, вместо этого файла возьми HudOverlay.lm.tpl: там тот же
// BP_MapLoad плюс возврат своего виджета в ряд игры каждый кадр.

blueprint BP_MapLoad : Actor at /Game/Mods/<Мод>/BP_MapLoad

var Prefix: string = "<Мод>: "
var Ready: bool = false
var Since: float = 0.0
var ReportEvery: float = 10.0

// В Blueprint нет хуков: реакция на состояние мира — Tick. Пауза и поздняя группа нужны,
// чтобы кадр мода шёл после перестройки HUD и работал на паузе.
default PrimaryActorTick.bTickEvenWhenPaused = true
default PrimaryActorTick.TickGroup = ETickingGroup.TG_PostUpdateWork

on ReceiveBeginPlay {
    let api = ModAPI.GetModAPI()
    api.onLoadingFinished.bind(Start)
    api.onBuildingSpawned.bind(TrackBuilding)
    api.onDayStart.bind(OnDayStart)
    api.LogMessage(Prefix + "map load", false)
}

fn Start() {
    Ready = true
    ModAPI.GetModAPI().LogMessage(Prefix + "world ready", false)
}

// onBuildingSpawned отдаёт каждого появившегося актора: здесь его отбирают по классу
fn TrackBuilding(actor: Actor) {
    ModAPI.GetModAPI().LogMessage(Prefix + "spawned " + string(actor), false)
}

fn OnDayStart(day: int) {
    ModAPI.GetModAPI().LogMessage(Prefix + "day " + string(day), false)
}

on ReceiveTick(dt: float) {
    if !Ready {
        return
    }
    Since = Since + dt
    if Since < ReportEvery {
        return
    }
    Since = 0.0
    ModAPI.GetModAPI().LogMessage(Prefix + "alive", false)
}

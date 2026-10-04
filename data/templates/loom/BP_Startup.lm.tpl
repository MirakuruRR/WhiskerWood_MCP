// BP_Startup — игра сама спавнит актор с этим именем один раз, при первом входе в главное меню.
// Здесь правят DataTable и объявляют опции мода. Путь в первой строке обязан совпадать
// с расположением файла: <кит>/Content/Mods/<Мод>/BP_Startup.lm.
// Везде ниже замени <Мод> именем папки мода — тем же, что у .uplugin, PAL_<Мод> и остальных .lm.
//
// Чего этот шаблон не делает: PAL_<Мод>.uasset и <Мод>.uplugin создаёт ww_loom_new_mod или
// «New mod...» в редакторе — без PAL у мода не будет chunk id и .pak не соберётся.
// Проверяет всё это ww_loom_validate, а компилирует исходник loom.exe (ww_loom_build / loom check).
//
// Грабли: перевод строки в значении переменной по умолчанию UE не разбирает — строки собирай в коде.

blueprint BP_Startup : Actor at /Game/Mods/<Мод>/BP_Startup

var Prefix: string = "<Мод>: "
// id опции держи с префиксом мода: пространство опций общее с игрой и другими модами
var OptionId: string = "<Мод>.notify"
var OptionTitle: string = "<Мод>: Notify on idle research"
var OptionValues: array<string> = ["Always", "Never"]
var OptionFallback: string = "Always"
// Таблица называется так, как её видит ModAPI, а не как лежит ассет: список даёт
// ModAPI.ListDataTables() или ww_get_datatable.
var TableName: name = "<Мод>.Tuning"
var TableRow: name = "example.row"
var TableColumn: name = "Value"

on ReceiveBeginPlay {
    let api = ModAPI.GetModAPI()
    api.LogMessage(Prefix + "startup", false)
    api.onOptionChanged.bind(OnOptionChanged)

    api.RegisterModOptions(OptionId, OptionTitle, OptionValues, OptionFallback, "Shown in the Mod tab of the settings menu")
    let chosen = api.ReadModOptionValue(OptionId, OptionFallback)
    api.LogMessage(Prefix + "option " + OptionId + " = " + chosen, false)

    // DataTable правится здесь, до того как игра её прочитает: BP_Startup заходит в меню первым
    if api.HasDataTable(TableName) {
        api.AddDataTableRow(TableName, TableRow)
        let written = api.WriteDataTableValue(TableName, TableRow, TableColumn, "42")
        api.LogMessage(Prefix + "write " + string(TableName) + " -> " + string(written), false)
    } else {
        api.LogMessage(Prefix + "no table " + string(TableName), false)
    }
}

fn OnOptionChanged(optionId: string, value: string) {
    if optionId != OptionId {
        return
    }
    ModAPI.GetModAPI().LogMessage(Prefix + "option changed: " + value, false)
}

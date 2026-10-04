// BP_MainMenuLoad — игра сама спавнит актор с этим именем при каждом входе в главное меню.
// Здесь обновляют строки локализации и всё, что должно пережить возврат в меню и новую игру.
// Файл: <кит>/Content/Mods/<Мод>/BP_MainMenuLoad.lm, <Мод> — имя папки мода.
//
// Опции и DataTable объявляет BP_Startup: он входит в меню первым, и повторять это здесь не надо.

blueprint BP_MainMenuLoad : Actor at /Game/Mods/<Мод>/BP_MainMenuLoad

var Prefix: string = "<Мод>: "
var TitleKey: string = "<Мод>.title"

on ReceiveBeginPlay {
    ModAPI.GetModAPI().LogMessage(Prefix + "main menu", false)
    EnsureStrings()
}

// Таблица строк перечитывается при смене языка: свои строки добавляем заново на каждом входе
fn EnsureStrings() {
    let api = ModAPI.GetModAPI()
    if LocManager.HasKey(name(TitleKey)) {
        return
    }
    for lang in api.ListLanguageIds() {
        let strings: map<name, string> = {}
        strings.Add(name(TitleKey), "<Мод>")
        api.AddNewStrings(lang, strings)
    }
}

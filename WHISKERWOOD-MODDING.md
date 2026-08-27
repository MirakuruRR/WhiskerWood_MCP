# Whiskerwood — техническая справка и стек для ИИ-моддинга

Рабочий документ. Всё, что ниже, проверено на установленной копии игры
(`D:\Steam\steamapps\common\Whiskerwood`, Steam AppID **2489330**).
Непроверенные утверждения помечены явно.

---

## 1. Что за игра технически

| | |
|---|---|
| Движок | Unreal Engine **5.6** (`5.6.0-0+UE5`) |
| Разработчик | Minakata Dynamics Co. |
| Версия проекта | 0.6.190.0 |
| Исполняемый файл | `Whiskerwood/Binaries/Win64/Whiskerwood-Win64-Shipping.exe`, 157 МБ |
| Защита | **отсутствует** — ни Denuvo, ни VMProtect; обычные секции MSVC, полный `.pdata` |
| GameMode | `/Script/ProjectArco.ProjectArcoGameModeBase` |
| Уровни | `/Game/Levels/ArcoPlay`, `/Game/Levels/MainMenuBackdrop` |

### C++ модули

Из `Whiskerwood.uproject` (лежит прямо внутри пака):

| Модуль | Классы | Функции | Структуры | Енумы |
|---|---|---|---|---|
| `ProjectArco` — основной игровой | 264 | 550 | 400 | 87 |
| `SystemCore` — системный слой | 179 | 812 | 302 | 68 |
| `LowCore` | 29 | 80 | 21 | 6 |
| `NauticalKit` — морская часть | 10 | 18 | 43 | 6 |
| `ShaderCore` | 2 | 2 | 2 | 2 |

Внутренняя кодовая база называется **Arco** (`E:\projects\arco\scratcharea\Source\ProjectArco\...`).
Из строк `check()`-макросов в exe восстанавливается 111 путей к исходникам, из них
95 файлов `ProjectArco` — включая `JobSystem.cpp`, `Pathfinder.cpp`, `PipeSystem.cpp`,
`Policies.cpp`, `QuestTracker.cpp`, `WorldTime.cpp`, каталог `GridActorComponents\`
(Industry, ResearchLab, House, TaxOffice, FarmBuilding, TradePort…) и каталог `Ui\`.
Это неполный список (только файлы с ассертами), но карта архитектуры по нему читается.

---

## 2. Упаковка контента

```
Whiskerwood/Content/Paks/Whiskerwood-Windows.pak
  4 018 677 232 байта · PakFile v11 · 14 860 файлов · MountPoint ../../../
  шифрование : НЕТ  (EncryptionKeyGuid = нули, bEncryptedIndex = 0)
  сжатие     : НЕТ  (таблица методов пустая)
  IoStore    : НЕТ  (bUseIoStore=False → классические .uasset/.uexp, без .ucas/.utoc)
```

Это лучший из возможных раскладов: AES-ключ не нужен, Oodle не нужен, читается любым инструментом.

**Важно:** все пакеты имеют флаги `Cooked | UnversionedProperties | FilterEditorOnly`
(`0x80002200`). Из-за `UnversionedProperties` без файла **`.usmap`** ни FModel, ни
CUE4Parse не прочитают *значения* полей — видна только таблица имён. Маппинги у нас есть
(см. §6).

Полезное внутри пака:

* `Whiskerwood/Whiskerwood.uproject` — список модулей и плагинов
* `Whiskerwood/AssetRegistry.bin` — 13 241 имя, полный реестр ассетов
* `Whiskerwood/Config/Default*.ini` — конфигурация проекта

### Раскладка `Whiskerwood/Content/`

| Каталог | Файлов | Что там |
|---|---|---|
| `ThirdParty` | 4160 | покупные ассеты |
| `Assets` | 4068 | меши, текстуры, персонажи |
| `Audio` | 1230 | звук |
| `UI` | 844 | виджеты UMG |
| `Material` | 619 | материалы |
| `Code` | 479 | **блюпринты-логика** |
| `GridActors` | 470 | здания/объекты сетки |
| `Data` | 122 | **DataTable — весь баланс** |
| `Levels` | 4 | уровни |

`Content/Code/` делится на `Systems` (201), `Experimental` (84), `Nautical` (70),
`UnrealComponents` (42), `PlayerTools` (36), `Cutscenes` (22).

### Данные (`Content/Data/`)

Всё, что стоит трогать для баланс-модов:

```
GameTuning · SystemTunes · TechUnlocksV2 · SeasonDefs · TaxPaymentThresholds
DiplomacyUpgrades · ClawsGiftPools · AgentModifiers_New · AgentThoughts
HarvestCampResourceGroups · ResourceCategoryInfo · ProblemIndicatorMessages
ToolbarDefinitions · TooltipTags · MailManLetters · AchievementsTables
AssetLookups/{IndustryRecipes, Crops, Meals_Lookup, Drinks_Lookup, PoliciesLookup,
              Quests_Lookup, WhiskerTraitsLookup, WhiskerGuildsLookup, Scenarios,
              TimelineEventTemplates, ResourceLookup, TechUnlocksV2}
```

### Локализация

Сделана **не через `.locres`**, а собственными DataTable:

* row-структура `LocDataRowBase` из `/Script/SystemCore`
* таблицы `Data/TextDB/Loc_En`, `Loc_Ru`, `Loc_De`, `Loc_Zh`, `Loc_Ja`, … (18 языков)
* ~2296 ключей на язык, строки UTF-16 в `.uexp`
* ключи человекочитаемые: `action.doubletime`, `mod.desc.starvation`, `approval.policy.negative`

Русский в игре уже есть и корректно читается.

---

## 3. Штатная мод-система игры

Игра **имеет собственный мод-API** — это не реверс, а задокументированное поведение
(игра сама создаёт `ModdingInstructions.txt`).

```
%LOCALAPPDATA%\Whiskerwood\Saved\mods\
├── ModdingInstructions.txt
└── <ModName>\
    ├── <ModName>.pak      → монтируется в /Game/Mods/<ModName>/
    └── <ModName>.uplugin  → {Name, Description, Version, CreatedBy}
```

Точки входа — блюпринты с зарезервированными именами, которые игра выполняет сама:

| Блюпринт | Диспетчер в exe |
|---|---|
| `BP_Startup` | `TriggerStartupMods` |
| `BP_MainMenuLoad` | — |
| `BP_MapLoad` | `TriggerMapMods` |

Дополнительно: Blueprint-функции `MountPakFile` / `MountPakFileEasy` / `UnmountPakFile`,
раздел настроек `settings.mods`, интеграция Steam Workshop
(`ESteamWorkshopDownloadStatus`, `OpenWorkshop`, `workshopId`, `\workshop\content\`).

### Почему этот путь не подходит для ИИ

Загрузчик принимает **только паки с блюпринтами**; DLL он не грузит (секции `Modules`
в `.uplugin` нет). А блюпринт — это бинарный `BlueprintGeneratedClass` с сериализованным
Kismet-байткодом, а не текст. ИИ его не напишет, не прочитает и не отревьюит diff.

Отсюда развилка:

| | Штатный путь (BP-мод) | UE4SS + Lua |
|---|---|---|
| Формат | бинарный граф | **текст** |
| ИИ может писать | нет | **да** |
| Нужен UE-редактор 5.6 | да | нет |
| Зависимость у игрока | нет | надо поставить UE4SS |
| Steam Workshop | да | нет |
| Hot-reload при разработке | нет | **да** |

**Для ИИ-моддинга выбираем UE4SS + Lua.**

---

## 4. UE4SS: блокер UE 5.6 и его починка

### Проблема

UE4SS (сборка `v3.0.1-1092-g0c5bff75`, ветка `experimental-latest`) корректно определяет
UE 5.6 и находит `GUObjectArray`, `GMalloc`, `FName::ToString`, `GNatives`,
`ConsoleManagerSingleton`, `GameEngineTick` — но падает на одном резолвере:

```
[PS] Failed to find StaticConstructObject_Internal
[PS] Scan failed        ×151
Fatal Error: PS scan timed out
```

Это **известный баг апстрима, ломающий все UE 5.6 игры**: issues
[#1197](https://github.com/UE4SS-RE/RE-UE4SS/issues/1197),
[#1204](https://github.com/UE4SS-RE/RE-UE4SS/issues/1204),
[#1248](https://github.com/UE4SS-RE/RE-UE4SS/issues/1248),
[#1289](https://github.com/UE4SS-RE/RE-UE4SS/issues/1289).
Готовой сигнатуры ни в одном треде нет.

**Исходники UE4SS править не нужно** — предусмотрен штатный обход через свой AOB.

### Решение

`ue4ss/UE4SS_Signatures/StaticConstructObject.lua`:

```lua
function Register()
    return "4C 8B DC 55 53 41 56 49 8D AB ? ? ? ? 48 81 EC ? ? ? ? 48 8B 05 ? ? ? ? 48 33 C4 48 89 85 ? ? ? ? 8B 41"
end

function OnMatchFound(MatchAddress)
    return MatchAddress
end
```

`StaticConstructObject_Internal` = RVA **`0x15BDC70`** (ImageBase `0x140000000` → VA `0x1415BDC70`).

После установки скан проходит с первой попытки, ноль фатальных ошибок,
все Lua-моды стартуют, хуки `LoadMap` / `InitGameState` / `BeginPlay` / `EndPlay` /
`ProcessLocalScriptFunction` встают.

### Как функция была найдена (воспроизводимо после патчей игры)

Частотная эвристика не работает: функция вызывается «всего» 864 раза и в топ по вызовам
не попадает. Работает детерминированный обход по указателям:

1. UE хранит на класс статическую таблицу пар `{const char* Name, FNativeFuncPtr}` для
   `StaticRegisterNatives`. Строка `SpawnObject` в exe **ровно одна**.
2. Найти указатель на эту строку в `.rdata` → соседний qword есть `execSpawnObject`.
3. `execSpawnObject` в хвосте зовёт функцию, вызываемую **ровно один раз во всём
   бинарнике** — это `UGameplayStatics::SpawnObject`.
4. Её хвост — это `FStaticConstructObjectParameters` на стеке (`Outer` в `+0x38`,
   `Name` в `+0x40`, флаги `0x1000000` в `+0x48`) и сразу за ним искомый вызов.

Подтверждения корректности:

* 864 из 864 call-сайтов предварены `lea rcx,[rsp+..]` — передача структуры по ссылке;
* 743 различных вызывающих функции;
* чтение поля `[rcx+0x70]` в прологе;
* форма пролога совпадает с **официальной сигнатурой Drainsim** из `zCustomGameConfigs`
  самого UE4SS;
* маска с вайлдкардами даёт **одно** совпадение на весь файл.

Маска, вероятно, переживёт мелкие патчи. Она же, по-видимому, годится для других UE 5.6
игр из перечисленных issues — материал для контрибьюта в апстрим.

---

## 5. Что даёт UE4SS

### Lua API (проверено на бандл-модах и своим кодом)

```lua
RegisterHook("/Script/Pkg.Class:Function", preFn, postFn)  -- перехват UFunction
RegisterKeyBind(Key.X, {ModifierKey.CONTROL}, fn)          -- хоткеи
StaticFindObject("/Script/Engine.UserWidget")              -- поиск по пути
FindFirstOf("ClassName") / FindAllOf("ClassName")          -- живые инстансы
ForEachUObject(fn)                                          -- обход GUObjectArray
NotifyOnNewObject("Class", fn)                              -- на создание объекта
ExecuteInGameThread(fn) / ExecuteWithDelay(ms, fn)          -- потокобезопасность
StaticConstructObject(Class, Outer, ...)                    -- создание объектов
obj:IsValid() / obj:GetFName():ToString() / obj:GetFullName() / obj:IsA(Cls)
```

Рантайм-UMG собирается через `StaticConstructObject`: находим класс `UserWidget`,
конструируем `WidgetTree`, `CanvasPanel` корнем, дальше дочерние виджеты. Всё текстом,
без единого ассета. Работает благодаря починенной сигнатуре из §4.

### Дамперы (глобальные Lua-функции, GUI не нужен)

```lua
DumpUSMAP()                      -- .usmap для декодирования ассетов
GenerateSDK()                    -- C++ заголовки с офсетами
DumpAllObjects()                 -- дамп объектов
GenerateUHTCompatibleHeaders()
DumpAllActors() / DumpStaticMeshes() / DumpJMAP()
```

Хоткеи по умолчанию: `Ctrl+J` дамп объектов, `Ctrl+H` CXX, `Ctrl+Num6` usmap.
Для автоматизации проще мини-мод с `ExecuteWithDelay(20000, DumpUSMAP)`.

### Бандл-моды, которые стоит держать включёнными

`ConsoleEnablerMod` (консоль UE), `CheatManagerEnablerMod`, `ConsoleCommandsMod`,
`BPModLoaderMod`, `Keybinds`.

### Встроенные отладочные команды игры

В шиппинг-сборке остались exec-команды — готовый инструмент тестирования модов:

```
Arco_GiveResource · Arco_GiveScience · Arco_GiveInfluence · Arco_GiveDiplomacy
Arco_GiveUnlock · Arco_UnlockAll · Arco_RevokeUnlock · Arco_NoCost
Arco_SetTimeOfDay · Arco_SetDayPhase · Arco_PauseDayCycle · Arco_SetWeatherVisual
Arco_SpawnShip · Arco_SpawnAgentsAtDock · Arco_SpawnAgentsAtCursor
Arco_SpawnWorldEffect · Arco_RemoveWorldEffect · Arco_KillSelectedWhisker
Arco_CreateDebt · Arco_AchievementDebugger · Arco_DebugHighlightCell
```

---

## 6. Имеющиеся артефакты

| Файл | Что это |
|---|---|
| `dumps/GObjects-Dump.txt` (7,7 МБ) | 80 502 объекта: 4455 классов, **15 817 функций**, 5523 структуры, 1795 енумов, 5421 пакет |
| `dumps/GObjects-Dump-WithProperties.txt` (14,4 МБ) | то же + офсеты, типы полей, **параметры и возвраты функций** |
| `Whiskerwood-5.6.0-0+UE5-a1e7f571.usmap` (2,4 МБ) | маппинги; magic `0x30c4`, версия 4 → DataTable читаются в JSON |
| `StaticConstructObject.lua` | сигнатура из §4 |
| `wwpak.py` | распаковщик пака без зависимостей |

`wwpak.py`:

```bash
python wwpak.py info   <file.pak>
python wwpak.py list   <file.pak> [regex]
python wwpak.py unpack <file.pak> <outdir> [regex]
```

Читает индекс v11 напрямую. Основной пак распаковывает; мод-паки (UnrealPak жмёт Oodle
по умолчанию) читает индекс и честно сообщает, что записи сжаты.

---

## 7. Главный урок: строки в exe ≠ вызываемый API

Имена, вытащенные `strings` из бинарника, **не обязаны быть UFunction**. Реальный пример
из этого проекта: `startResearch`, `cancelResearch`, `canResearch`, `isResearchActive`
выглядят как идеальные точки зацепа — и **в рефлексии отсутствуют**. Это внутренние
C++-методы или ключи данных, хукнуть их нельзя.

Настоящий API исследований (из дампа, с типами):

```
SystemCore.UnlockResearchComponent.SetResearchTopic(Name unlockId) -> Bool
SystemCore.UnlockResearchComponent.IsResearched(Name unlockId)     -> Bool
SystemCore.UnlockResearchComponent.ReportLinkage(Object building)
SystemCore.UnlockResearchComponent.GetResearchTopic / GetResearchPoints
                                 / GetResearchPointsRequired / GetResearchRate
                                 / GetResearchRatio
SystemCore.UnlockTreeUi.CalcResearch()                             -> Struct
ProjectArco.ArcoGameInstance.GetUnlockResearchPrerequisite
ProjectArco.ResearchLab.GlobalResearchStateChanged
ProjectArco.TechResearchChanged__DelegateSignature                 (без параметров)
```

Производственные цепочки — у игры есть готовый обратный запрос по графу:

```
ProjectArco.ArcoGameInstance.GetRecipesWithOutput(Object Context, Name outputResource) -> Array
ProjectArco.ArcoGameInstance.GetIndustriesWithRecipe(Object Context, Name recipeKey)   -> Array
ProjectArco.ArcoGameInstance.GetIndustryRecipe(Object Context, Name Name)              -> Struct
ProjectArco.ArcoGameInstance.GetResourceCategory(Object Context, ...)
```

**Вывод, определяющий смысл MCP:** без заземления на дамп ИИ пишет хуки на несуществующие
функции. Задача MCP — сделать такую ошибку невозможной.

---

## 8. Архитектура MCP

### Пайплайн

```
UE4SS дамперы ──> .usmap + GObjects-дампы + (опц.) CXX-заголовки
                        │
                        ├── CUE4Parse + .usmap ──> DataTable как JSON
                        ├── wwpak.py ────────────> файлы из пака
                        └── AssetRegistry.bin ───> реестр ассетов
                        │
                        ▼
                  индекс MCP-сервера
                        │
                        ▼
        ИИ пишет Lua с настоящими именами и сигнатурами
                        │
                        ▼
              hot-reload в запущенной игре (Ctrl+R)
```

### Источники данных для индекса

1. **`GObjects-Dump-WithProperties.txt`** — ядро. Парсится построчно:
   `[offset] {addr} Kind Package.Class.Member` + вложенные свойства с офсетами и типами.
   Даёт классы, функции, параметры, возвраты, поля, структуры, енумы, делегаты.
2. **`.usmap` + CUE4Parse** — значения строк DataTable.
3. **`AssetRegistry.bin`** — пути и имена ассетов (парсер таблицы имён: заголовок
   `FNameBatch`, header по 2 байта `len = ((b0 & 0x7f) << 8) | b1`, флаг UTF-16 в `b0 & 0x80`).
4. **`Loc_*` таблицы** — ключ → текст на 18 языках.
5. **Карта исходников из exe** — 111 путей, архитектурный контекст.

### Инструменты, которые стоит выставить

| Инструмент | Назначение |
|---|---|
| `find_function(pattern, module?)` | поиск UFunction по маске имени |
| `get_class(name)` | поля, офсеты, методы, родитель |
| `get_function(path)` | **точная сигнатура**: параметры, типы, возврат |
| `verify_hook(path)` | существует ли функция — защита от галлюцинаций |
| `get_datatable(name)` | строки таблицы как JSON |
| `patch_datatable(name, rows)` | правка и сборка обратно |
| `resolve_loc_key(key, lang)` | текст по ключу |
| `find_asset(pattern)` | поиск по реестру ассетов |
| `extract_asset(path)` | вытащить файл из пака |
| `lua_api(symbol)` | справка по UE4SS Lua API |
| `write_mod(name, code)` / `reload_mods()` | запись Lua-мода и hot-reload |

`verify_hook` — ключевой. Он превращает «ИИ угадал» в «ИИ проверил», и именно он
предотвращает ошибку из §7.

### Заметки по реализации

* Дампы статичны — индексировать один раз при старте сервера, держать в памяти или
  SQLite/FTS. 15 817 функций — это мало, полнотекстовый поиск мгновенный.
* Ключ инвалидации — версия игры (`5.6.0-0+UE5` + `ProjectVersion` из `DefaultGame.ini`).
  После патча: пересобрать дампы и `.usmap` одним прогоном AutoDump-мода.
* Возвращать ИИ не «похожие» имена, а точные совпадения плюс явный признак
  «не найдено» — иначе он додумает.

---

## 9. Подводные камни

* **Строки ≠ функции.** См. §7. Всегда сверяться с дампом.
* **`Utf8String` не поддержан** в UE4SS на UE 5.6. Для модов с русским текстом проверять
  заранее.
* **Переноса зданий в игре нет.** Нативной функции не существует — подтверждено и по
  строкам, и по рефлексии. Есть только `EnterMode_Bulldoze`, `placeBuilding`, `CanPlace`,
  `GetGridActorCost`, `constructionSiteTemplate`. Перенос придётся эмулировать
  сносом и постановкой, со всеми краевыми случаями (возврат ресурсов, жильцы, содержимое
  склада, назначения рабочих, привязки труб и дорог).
* **`GenerateSDK()` у Dumper-7 уронил игру** на середине генерации. Дампы объектов при
  этом записались. Через UE4SS не проверялось.
* **Мод-паки сжаты Oodle** — `wwpak.py` их не распакует, нужен UnrealPak / repak / FModel.
* Штатные BP-моды и UE4SS-моды — параллельные миры. Через UE4SS Workshop-мод не
  распространить.

---

## 10. Порядок установки с нуля

1. Скачать UE4SS `experimental-latest` (нужен именно он — в стабильном 3.0.1 нет 5.6).
2. `dwmapi.dll` и папку `ue4ss/` положить в `Whiskerwood/Binaries/Win64/`.
3. Создать `ue4ss/UE4SS_Signatures/StaticConstructObject.lua` с сигнатурой из §4.
   **Без этого шага игра не запустится с UE4SS.**
4. В `UE4SS-settings.ini`: `ConsoleEnabled = 1`, `GuiConsoleEnabled = 1`,
   `EnableHotReloadSystem = 1`.
5. Запустить, проверить `ue4ss/UE4SS.log` — должно быть
   `StaticConstructObject_Internal address: 0x... <- Lua Script` и ноль `Scan failed`.
6. Снять `.usmap` мини-модом с `ExecuteWithDelay(20000, DumpUSMAP)`.

---

## 11. Текущее состояние стенда

* UE4SS установлен и **работает**, сигнатура на месте.
* Мод `AutoDump` присутствует, но выключен (`AutoDump : 0`) — включить, если после патча
  игры понадобится свежий `.usmap`.
* Блокеров нет: и read-слой, и modify-слой MCP реализуемы полностью.

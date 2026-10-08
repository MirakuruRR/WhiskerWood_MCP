# Инструменты

43 инструмента, 4 промпта и ресурсы — шаблоны `.lm`. Полные описания и схемы аргументов
приходят в MCP-клиент вместе со списком tools — здесь карта: что для чего и в каком порядке
вызывать.

Инструменты делятся на два контура. **Индексные** работают всегда и отвечают из локального
SQLite. **Живые** требуют запущенной игры с мостом WWBridge и помечены ниже как «живой».

Инструменты собраны в группы, и группы включаются ключом `toolsets` в конфиге: `recon` (15),
`live` (11), `lua` (6), `memory` (4), `loom` (7). По умолчанию включены все. В Loom-режиме
набор `lua` обычно выключают — остаётся 37 инструментов: pak-мод не перехватывает функции, ему
нужны `recon` (в том числе `ww_lua_api` и `ww_verify_hook` — на них опираются `ww_game_eval` и
трейс), `live`, `memory` и `loom`: `"toolsets": ["recon", "live", "memory", "loom"]`. Промпты и
ресурсы подчиняются тем же группам.

## Порядок работы над модом

```
ww_memory_wakeup → ww_memory_search     что уже выяснено до вас
ww_index_status  → ww_game_status       свежий ли профиль, запущена ли игра
ww_find_symbol   → ww_get_type          разведка API
                 → ww_get_function      точная сигнатура и hook_path
                 → ww_find_callers      кто вызывает — если неясно, откуда дёргают
                 → ww_get_bytecode      что внутри — без запущенной игры
ww_resolve_loc   → ww_get_datatable     тексты и числа
ww_lua_api                              грабли UE4SS по нужному механизму
ww_verify_hook                          ВСЕ пути будущего мода одним вызовом
ww_scaffold_mod  → ww_generate_hook     каркас и код хуков
ww_deploy_mod    → ww_game_log          живая проверка
ww_validate_mod                         перед сдачей, до нуля ошибок
ww_memory_add                           записать то, что нельзя вывести из кода
ww_package_mod   → ww_install_mod       релизный zip → поставить его в игру
```

Мод на Loom (`.pak`, без UE4SS) идёт другим путём:

```
ww_loom_status                          кит, types.json, редактор, расхождения с игрой
ww_find_symbol / ww_find_asset → ww_lift как игра это делает — уже на языке Loom
ww_event_surface                        на что подписаться и что переопределить
ww_get_function (loom_call, bp)         готовый вызов и доступность из Blueprint
ww_call bp_only / ww_trace_calls        проверить цепочку вживую за секунды
ww_loom_new_mod action=create           папка мода: PAL с chunk id, .uplugin, заготовки .lm
ww://templates/loom/* → .lm             заготовки .lm — ресурсы сервера
loom docs → .lm → ww_loom_validate       check + правила игры, до нуля
ww_loom_build → ww_loom_install          Blueprint → .pak: start → status → install
ww_game_process restart save=…           pak подхватывается только при старте игры
ww_game_log source=modlog / ww_ui_tree   сработало ли, что на экране
```

Готовые промпты: `ww:new-mod`, `ww:fix-after-patch`, `ww:new-loom-mod`, `ww:port-to-loom`.

## Разведка API

| Инструмент | Зачем |
|---|---|
| `ww_find_symbol` | Первый вызов, когда точное имя неизвестно. Полнотекстовый поиск по индексу рефлексии |
| `ww_search_members` | Обратный поиск: в каком классе есть поле или метод с таким именем |
| `ww_get_type` | Class / ScriptStruct / Enum целиком: поля с офсетами, родитель, методы, наследники |
| `ww_get_function` | Точная сигнатура: параметры, типы с источником, out-параметры, и всегда — готовый `hook_path` |
| `ww_find_callers` | Обратный статический xref: кто вызывает функцию/класс из BP-байткода cooked-сборки (сайдкар WwParse) |
| `ww_get_bytecode` | Линейный дизасм тела функции (`ScriptBytecode`) — без запущенной игры, в отличие от `ww_trace_calls`. Сначала пробуй `ww_lift`: он даёт то же тело читаемым Loom |
| `ww_verify_hook` | **Ключевой.** Батч-проверка путей хуков до записи кода. Вызывать со всеми путями сразу |
| `ww_index_status` | Версия игры и профиля, свежесть по отпечатку, покрытие BP-классов |
| `ww_index_release` | Закрыть дескрипторы index.db перед `bun run setup --force` на той же версии |
| `ww_diff_versions` | Что исчезло, появилось и сменило сигнатуру между двумя профилями. Первый шаг после патча |

> Инструменты разведки знают про Blueprint-слой: у функции есть поле `bp` (`callable`, `pure`,
> `latent`, `world_context`, `internal`, `deprecated`, `editor_only`, `not_callable`,
> `not_in_types`), у параметра — `dir`, у поля — `read | read_only | edit_only | hidden`. Это
> ответ на вопрос «дотянется ли до этого Loom»: `not_callable` — есть в типах кита, но
> Blueprint её не зовёт; `not_in_types` — в типах нет, и для игрового BP это значит «LoomBuild
> подгрузит его при сборке», а не «нельзя». Готовый вызов Loom лежит в `loom_call`
> (`ww_get_function`): копируй его целиком, не собирай сам — хвост `-> T` это пометка «что
> вызов даёт», а не синтаксис языка.
>
> Графа Blueprint-нод и пинов (`UEdGraph`) в индексе нет и не будет: это редакторские
> данные, в cooked-сборке игры их не существует физически — в паке лежит только
> скомпилированный байткод (`ScriptBytecode`). Не ищи дамп BP-графа, его негде взять.
> Эквивалент запроса — статический xref (`ww_find_callers`) и `ww_get_bytecode`;
> читаемый вид того же тела даёт `ww_lift`.

## Данные игры

| Инструмент | Зачем |
|---|---|
| `ww_get_datatable` | Баланс из `Content/Data`: список таблиц, строки, поиск по шаблону ключа |
| `ww_resolve_loc` | Ключ локализации → текст. В Whiskerwood это таблицы `Loc_*` на 18 языков, а не `.locres` |
| `ww_find_asset` | Поиск по реестру ассетов: путь `/Game/...`, имя, класс |
| `ww_extract_asset` | Достаёт `.uasset` и спутников из пака на диск. Единственный инструмент, пишущий за пределы репозитория модов |

## Живая игра

| Инструмент | Зачем |
|---|---|
| `ww_game_status` | Запущена ли игра, жив ли мост, загружен ли уровень. **Вызывать перед любым живым инструментом** |
| `ww_game_process` | Запуск через Steam, kill, перезапуск, автономная загрузка сохранения |
| `ww_capture_dumps` | Снять .usmap/ObjectDump/UHTHeaderDump из запущенной игры через мост, без AutoDump (живой) |
| `ww_game_eval` | Выполнить чанк Lua в процессе игры и получить результат (живой) |
| `ww_ui_tree` | Дамп поддерева UMG: классы, видимость, текст, кисти, слоты, где доступно — size/pos; адресация инстанса через `object_path`/`index` (живой) |
| `ww_trace_calls` | Кто и как часто дёргает функцию: счётчик и сэмплы всех аргументов с t_ms; `action=start/read/stop` — неблокирующий режим (живой) |
| `ww_call` | Вызвать UFunction по индексному пути на найденном объекте с аргументами по именам; арность и типы проверяются до вызова, в ответе — return и out-параметры (живой) |
| `ww_game_console` | Команда в консоль игры; требует загруженного уровня (живой) |
| `ww_screenshot` | Кадр из игры прямо в ответ MCP — визуальная проверка правок (живой) |
| `ww_game_log` | Лог: `source=ue4ss` — `UE4SS.log` с фильтрами по времени, уровню и моду; `source=modlog` — `<saved>/Logs/modlog.txt`, единственный канал из shipping-игры для pak-мода: строки `ModAPI.LogMessage`, сообщения загрузчика («Not loading mod» — почему pak не поднялся). У modlog нет меток времени у строк мода, `since=session` режет по офсету старта игры |
| `ww_crash_report` | Разбор краша: сначала отчёт WWCrashGuard из `Saved/Crashes/wwguard` (виновный мод, строка Lua, стеки); `engine: true` — дамп UECC, код исключения, хвост лога, список модов. Работает при выключенной игре |

> Если `ww_trace_calls` за время сессии не даёт ни одного срабатывания — функция либо не
> вызывается тем путём, который вы предполагали, либо вызов целиком в C++ и до BP-слоя не
> доходит (в BP-байткоде его тогда и не будет — это данные не CUE4Parse, а UE4SS). Нативных
> C++→C++ call-site'ов в индексе нет и не будет: UE4SS отдаёт рефлексию, а не дизассемблер
> exe. Что делать вместо трейса: `ww_find_callers` — статический xref по BP-байткоду, найти
> ближайшую `BlueprintCallable`-границу выше по стеку и хукнуть её; либо подписаться на
> создание нужного объекта через `ww.watch` (`data/lib/ww/watch.lua`) и ловить результат
> постфактум, а не сам вызов.

> `ww_game_eval` исполняет код в процессе игры. Нативный access violation `pcall` не
> ловит — игра просто падает. Проверяйте гипотезы по одной, а не пачкой.

## Сборка Lua-мода

Набор `lua`: он про UE4SS-моды с хуками. Мод на Loom собирается иначе — см. раздел «Loom».

| Инструмент | Зачем |
|---|---|
| `ww_scaffold_mod` | Каркас мода: `mod.json`, `Scripts/main.lua` из шаблона (hook / ui / keybind / diagnostic) |
| `ww_generate_hook` | Готовый `RegisterHook` с реальной сигнатурой и распаковкой каждого параметра |
| `ww_validate_mod` | Разбирает `.lua` из `Scripts/` в AST и сверяет каждый путь (литерал или строковую константу) с индексом; у мода с DLL проверяет и её. Зовётся перед сдачей; находки одного кода сворачиваются, грабли из памяти идут отдельным блоком `memory_hints`. Принятое гасится `-- ww:ignore <code\|pit-id>`, `-- ww:ignore-file …` или `validate_ignore` в `mod.json`; повторный прогон — `since_last: true` |
| `ww_deploy_mod` | Dev-деплой: Lua — горячо через мост, со снятием прошлых хуков; DLL — подмена в каталоге игры (живой) |
| `ww_package_mod` | Релизный zip: библиотека вендорится внутрь, чтобы мод работал у игрока без этого репозитория; версию игры в `mod.json` и в инструкции проставляет из профиля индекса |
| `ww_install_mod` | Ставит релиз в `<ue4ssDir>/Mods/<Имя>` из каталога или zip, с бэкапом прошлой версии и правкой mods.txt |

Что попадает в пакет и в каталог игры, решает и `.gitignore` репозитория модов: файл, который мод
пишет сам во время игры (сохранённое состояние, кэш), занесите туда. Тогда `ww_package_mod` его не
упакует, а `ww_install_mod` при переустановке не сотрёт копию игрока.
| `ww_lua_api` | Сигнатуры, примеры и грабли UE4SS Lua API по механизмам |

### Мод с нативной частью (Lua + DLL)

UE4SS-мод может нести C++-часть: `dlls/main.dll` рядом со `Scripts/main.lua` или вместо него;
её исходники лежат в `native/` и собираются вне сервера. Инструменты различают части сами
(поле `parts`: `lua`, `dll`, `lua+dll`), а правило у частей разное:

- **Lua** перезагружается на горячую: `ww_deploy_mod` грузит её мостом из каталога разработки.
- **DLL** в живом процессе не перезагружается. `ww_deploy_mod` кладёт её в
  `<ue4ssDir>/Mods/<Имя>/dlls/` (занятую игрой старую — переименовывает в `*.ww-old`) и включает
  мод в mods.txt. Если в запущенной игре DLL не та, ответ — `restart_required`, и Lua не грузится:
  она могла бы звать функции, которых в старой DLL нет. Дальше `ww_game_process action=restart
  wait_for=world` и снова `ww_deploy_mod`.

Dev-раскладка в каталоге игры — **только `dlls/`**: Lua-копия рядом загрузилась бы из mods.txt
вторым экземпляром поверх мостовой (`warning_double_load`). Её даёт и `ww_install_mod
dll_only: true`. Релизная раскладка (`ww_install_mod` без флага, zip из `ww_package_mod`) — обе
части; `native/` и мусор сборки (`.pdb`, `.obj`, `.lib`) в неё не попадают.

В dev-цикле Lua исполняется в Lua-стейте моста WWBridge, а не в стейте своего мода. C++-часть,
которая отдаёт функции в Lua через `on_lua_start(mod_name, …)`, должна регистрировать их и для
`WWBridge` — иначе мостовая загрузка их не увидит.

```
правка Lua  → ww_deploy_mod                                           горячо
правка C++  → сборка native/  → ww_deploy_mod
            → restart_required → ww_game_process action=restart → ww_deploy_mod
перед сдачей → ww_validate_mod (в том числе dll_stale)
```

`ww_validate_mod` и `ww_deploy_mod` сверяют таблицу импорта DLL с экспортом установленной
`UE4SS.dll`. Если UE4SS не экспортирует хоть один символ, который берёт мод (DLL собрана под
другую версию UE4SS), `LoadLibrary` откажет, и C++-часть молча не стартует. Это ловит ошибка
`dll_missing_ue4ss_symbols`.

Заголовки для сборки C++-части лежат в `data/ue4ss-sdk/` и привязаны к коммиту установленной
UE4SS (`manifest.json`). В гит каталог не входит: на новой машине его один раз создаёт
`bun run ue4ss-sdk`, коммит берётся из `UE4SS.log`. Это замыкание `#include` от `Mod/CppUserModBase.hpp`,
`LuaMadeSimple/LuaMadeSimple.hpp` и `DynamicOutput/DynamicOutput.hpp`, плюс fmt той версии, что
вкомпилирована в UE4SS. `GUI/GUI.hpp` заменён заглушкой: оригинал тянет imgui и приватный
Unreal, а раскладку `CppUserModBase` заглушка не меняет. `UE4SS.lib` собирается из `UE4SS.def`
командой из манифеста. fmt из `UE4SS.dll` не экспортируется, поэтому моду нужен
`FMT_HEADER_ONLY`; остальные флаги — в `manifest.json`. После обновления UE4SS `bun run doctor`
предупредит о расхождении коммитов, тогда снимок пересобирается `bun run ue4ss-sdk`.

## Loom

Кит Loom (`kitDir` в конфиге) превращает `.lm` в Blueprint, а `Cook & Install` — в `.pak`,
который игроку не требует UE4SS. Эти инструменты работают с китом, а не с живой игрой.

| Инструмент | Зачем |
|---|---|
| `ww_loom_status` | Кит и его расхождения с игрой: движок (по `EngineAssociation` через реестр), `loom.exe`, `types.json`, редактор, версия Loom против плагина и главное — сверка `types.json` с индексом. **Первый вызов**, если мод на Loom не собирается или после патча |
| `ww_lift` | Cooked Blueprint → читаемый `.lm`: сайдкар отдаёт JSON пакета, `loom.exe lift` поднимает его в скретч-проект. Отказы добиваются фолбэками, каждое заглушённое место помечено `// not lifted` с причиной и подсказкой на `ww_get_bytecode`. Режим `pattern` — поиск по коду всей игры (функция, строка, сниппет) по поднятым на шаге `index-lift` исходникам |
| `ww_event_surface` | Что можно переопределить и на что подписаться: делегаты ModAPI, `BlueprintAssignable`-диспетчеры, переопределяемые события, и только потом Tick. Заменяет вопрос «что хукнуть», которого в Blueprint не существует |
| `ww_loom_new_mod` | Новый мод без интерфейса редактора — то же, что «New mod...» плагина WWModTools: папка `<кит>/Content/Mods/<Мод>/`, `PAL_<Мод>` (первый свободный ChunkId 1..300 по существующим PAL и `pakchunk<N>-Windows.pak`, `AlwaysCook`, метит всю папку), `<Мод>.uplugin` в формате плагина с `EngineVersion` движка кита и по `templates` — заготовки `.lm` с подставленным именем. `create → status`, `cancel`: PAL сохраняет `UnrealEditor-Cmd -run=pythonscript` джобом (~30 с, `.uproject` не трогается), `create` ждёт его до `wait_ms` и отвечает `created` с `chunk`, `files` и `next`, иначе `running` с `job_id`. До запуска отказывает: `bad_mod_name`, `bad_args` (HudOverlay вместе с BP_MapLoad или без WBP_Overlay), `mod_exists` (ничего не перезаписывает), `busy`, `editor_open` — тогда мод создают «New mod...» в открытом редакторе. Если PAL не создан, папка мода убирается целиком |
| `ww_loom_validate` | `loom check` плюс правила игры: заголовок и путь файла, PAL, имя `.uplugin` и будущего `.pak`, `LogMessage` без префикса, `\n` в значении по умолчанию, наследование от игрового виджета, override с возвратом, `DeprecateSlateVector2D`, мир до `onLoadingFinished`, BOM. Вызывать после каждой правки `.lm` |
| `ww_loom_build` | Сборка Blueprint: `action=build` — редактор открыт: плагин собирает сам по DirectoryWatcher, закрыт: headless `UnrealEditor-Cmd -run=LoomBuild` джобом с `job_id`. `action=status` читает `report.json`, хвост `LogLoomBuild` и джоб (`job_id` — конкретный). `action=cancel` снимает headless-сборку деревом процессов |
| `ww_loom_install` | `Cook & Install` без редактора, `start → status → install`. `start` — RunUAT BuildCookRun джобом; `status` только читает: прогресс, найденный среди `pakchunk<N>` пак мода, итог проверок и `ready_to_install` / `installed` по сравнению с `<saved>/mods/<Мод>/`; `install` — единственное копирующее действие, с бэкапом прежней версии, повтор отвечает `already_installed`. На джоб смотрят только при явном `job_id`: `status` и `install` с одним `mod_name` работают по паку, который уже лежит в `pakchunk`, как `start` с `skip_cook`, и упавший или отменённый прошлый cook им не мешает; если cook этого мода идёт сейчас — `busy` с его `job_id`. `cancel` снимает cook: по `job_id`, по `mod_name` (идущий или последний cook этого мода) или любой идущий. Pak подхватывается только при старте игры |

> Мод на Loom — это папка `<кит>/Content/Mods/<Мод>/`: `<Мод>.uplugin`, `PAL_<Мод>.uasset`
> (без него пак не соберётся) и `.lm` рядом с будущими `.uasset`. Папка, `.uplugin` и `.pak`
> делят одно имя; `EngineVersion` — «5.8». Файлы `.lm` пишутся **без BOM**: парсер Loom
> спотыкается на первом же символе. PAL и `.uplugin` создаёт `ww_loom_new_mod` или, при
> открытом редакторе, «New mod...» в нём, а `ww_loom_validate` проверяет, что всё сошлось.
>
> Долгие операции (сборка, cook, создание PAL) идут джобами: `state/jobs/<id>.log` и `<id>.json`, один джоб
> на кит. Джоб переживает перезапуск MCP-сервера, `cancel` снимает всё дерево процессов. Каждый
> инструмент владеет своими джобами: сборку ведёт `ww_loom_build`, cook — `ww_loom_install`,
> создание мода — `ww_loom_new_mod`.

### Ресурсы: шаблоны `.lm`

Заготовки `.lm` — не инструмент, а MCP-ресурсы группы `loom` (`resources/list`,
`resources/read`, `text/plain`); на них ссылаются промпты `ww:new-loom-mod` и `ww:port-to-loom`,
а `ww_loom_new_mod` раскладывает их в папку нового мода по аргументу `templates`.

| URI | Что внутри |
|---|---|
| `ww://templates/loom/BP_Startup` | актор первого входа в меню: DataTable, `RegisterModOptions` |
| `ww://templates/loom/BP_MapLoad` | актор загрузки сохранения: `onLoadingFinished`, Tick |
| `ww://templates/loom/BP_MainMenuLoad` | актор каждого входа в меню: строки локализации |
| `ww://templates/loom/HudOverlay` | вариант `BP_MapLoad` для оверлея в ряду HUD — вместо `BP_MapLoad`, в паре с `WBP_Overlay` |
| `ww://templates/loom/WBP_Overlay` | свой `UserWidget` оверлея (`WBP_<Мод>Overlay.lm`) |

`<Мод>` в шаблоне заменяется именем папки мода, файл называется по строке `blueprint` внутри.
Источник — `data/templates/loom/*.lm.tpl`: содержимое читается при каждом запросе, а список
шаблонов строится при старте сервера — новый файл появится после перезапуска.

## Память

| Инструмент | Зачем |
|---|---|
| `ww_memory_wakeup` | Первый вызов в сессии: решения, грабли, предпочтения, незакрытые todo |
| `ww_memory_search` | Полнотекстовый поиск. Спрашивать до того, как выяснять заново |
| `ww_memory_add` | Батч-запись по итогам работы: `decision`, `pitfall`, `preference`, `todo`, `note` |
| `ww_memory_invalidate` | Мягкое гашение записи, ставшей неверной. История сохраняется |

Записи из общей базы помечены в выдаче полем `origin: seed` — это знание сообщества, а не
проверенное на вашем стенде. Подробнее про обмен: [MEMORY.md](MEMORY.md).

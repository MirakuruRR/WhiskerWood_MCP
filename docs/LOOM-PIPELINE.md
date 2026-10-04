# Пайплайн Blueprint-модов через Loom

Как делаются Blueprint-моды Whiskerwood на Loom, без UE4SS у игрока: компоненты, устройство
мода, путь от `.lm` до Workshop и найденные грабли. Документ написан по итогам порта Lua-мода
на Loom. Инструменты этого MCP для пайплайна — в [TOOLS.md](TOOLS.md), план и замеры — в
[PLAN-loom.md](PLAN-loom.md).

## Обозначения

| Имя | Что это | Пример на стенде автора |
|---|---|---|
| `<kit>` | мод-кит Whiskerwood (UE 5.8, cooked editor), git `Whiskerwood-Modding/Whiskerwood-Project`, ветка `5.8` | `D:\Whiskerwood_IO\WhiskerWood_Mods_LOOM\Whiskerwood-Project` |
| `<engine>` | кастомная сборка UE 5.8 под кит | `D:\Whiskerwood_IO\WhiskerWood_Mods_LOOM\Engine` |
| `<loom-src>` | исходники Loom, git `pierrekin/loom` — чужой проект | `D:\Whiskerwood_IO\Loom` |
| `<game>` | установка игры (её путь кит берёт из `<kit>/GameInstallDirectory.txt`) | `D:\Steam\steamapps\common\Whiskerwood` |
| `<saved>` | `%LOCALAPPDATA%\Whiskerwood\Saved` | |

## Компоненты

- **Loom** — текстовый язык (`.lm`), который компилируется в обычные Blueprint-ассеты.
  - `<kit>/Plugins/LoomEditor/` — плагин редактора: применяет операции к Blueprint'ам.
  - `Binaries/ThirdParty/Loom/Win64/loom.exe` — компилятор.
  - `loom-mcp.exe` — MCP-сервер Loom.
  - Плагин в ките — продукт сборки `cargo xtask plugin` из `<loom-src>`. Править надо в
    `<loom-src>/plugin/LoomEditor/`, копия в `<kit>` перезаписывается.
- **WWModTools** — плагин кита `<kit>/Plugins/WWModTools`. Даёт меню Mod Tools и команды
  в правом клике по папке мода: `Cook & Install`, `Install`, `Uninstall`, `New mod...`,
  `Launch Whiskerwood` (через `steam://rungameid/2489330`).
- **ModAPI** — C++ API игры для модов: `ModAPI.GetModAPI()`. Описано в `<kit>/README.md`.
  Полезное:
  - `LogMessage` — пишет в modlog;
  - `AddNewStrings(langId, map<name,string>)` — добавляет строки локализации;
  - `ListLanguageIds`, `RegisterModOptions` / `ReadModOptionValue`;
  - работа с DataTable;
  - делегаты `onLoadingFinished`, `onBuildingSpawned`, `onWhiskerSpawned`,
    `onOptionChanged`, `onDayStart`.

## Устройство мода

```
<kit>/Content/Mods/<Mod>/
  <Mod>.uplugin            Name / Description / Version / CreatedBy / EngineVersion "5.8"
  PAL_<Mod>.uasset         Primary Asset Label с уникальным chunk id (1..300), без него нет .pak
  BP_MapLoad.lm            исходники Loom; .uasset рядом создаёт сборка
  BP_MapLoad.uasset
```

Игра сама спавнит акторы с фиксированными именами:
- `BP_Startup` — один раз, при первом входе в главное меню. Здесь правят DataTable и
  вызывают `RegisterModOptions`.
- `BP_MapLoad` — при загрузке сейва. Спавнится во время загрузочного экрана, поэтому к миру
  обращаются только после делегата `onLoadingFinished`.
- `BP_MainMenuLoad` — при каждом входе в главное меню.

Первая строка `.lm`: `blueprint BP_X : Parent at /Game/Mods/<Mod>/BP_X`. Путь обязан
совпадать с расположением файла.

## Пайплайн по шагам

1. **Справка.** Синтаксис берётся из `loom-mcp`: `docs`, `docs_search`. Классы и сигнатуры —
   из `types`.
2. **Проверка без Unreal.** `loom-mcp check` → `loom.exe` компилирует все `.lm` проекта
   по `<kit>/Intermediate/Loom/types.json`. Проверяется только исходник; проблемы применения
   к Blueprint `check` не видит.
3. **Сборка Blueprint'ов (LoomBuild).** Запускается сама при сохранении `.lm`, если открыт
   редактор: плагин следит за `Content` через DirectoryWatcher. Без редактора — headless,
   и только когда редактор закрыт:
   `<engine>/Binaries/Win64/UnrealEditor-Cmd.exe <kit>/Whiskerwood.uproject -run=LoomBuild -unattended -nosplash -nullrhi -nopause -stdout`.
   Внутри (`LoomBuild.cpp`):
   1. `loom sources --json` — список исходников.
   2. Загружаются Blueprint'ы из папок исходников и из папок, указанных в `use`.
   3. Типы дампятся в `Intermediate/Loom/types.json`.
   4. `loom build --out-dir Intermediate/Loom/ops --json`.
   5. Если компилятор вернул `missing` — имена игровых классов, которых нет в типах, —
      плагин подгружает их (`LoadNamed`: по имени и имени `_C`, либо по пути `/Game/...`),
      снова дампит типы и пересобирает. Цикл идёт, пока подгружается что-то новое.
   6. Операции из `ops/` применяются к Blueprint'ам (`LoomApplier.cpp`), Blueprint
      компилируется и сохраняется.
   7. Итог пишется в `Intermediate/Loom/report.json`: `ok`, `errors[]`,
      `blueprints[].status` (`built` / `unchanged` / `failed` / `skipped`). Строки лога —
      `LogLoomBuild` / `LogLoom` в `<kit>/Saved/Logs/Whiskerwood.log`, ошибки в редакторе —
      Message Log → Loom.

   Из MCP сборку ведёт `ww_loom_build`: при открытом редакторе ждёт её по DirectoryWatcher,
   при закрытом сам запускает headless LoomBuild; итог читает из `report.json`.
4. **Упаковка.** В редакторе: правый клик по `Content/Mods/<Mod>` → `Cook & Install`.
   Результат — `<saved>/mods/<Mod>/<Mod>.pak` и `<Mod>.uplugin`. Без редактора то же делает
   `ww_loom_install`: RunUAT BuildCookRun и копирование в `<saved>/mods`.
   - Имя `.pak` обязано совпадать с именем папки мода.
   - В `.pak` попадает всё, что лежит в папке мода, включая ассеты, у которых удалён исходник.
   - Содержимое можно проверить: `<engine>/Binaries/Win64/UnrealPak.exe <pak> -List`.
5. **Загрузка игрой.** Игра берёт моды из `<saved>/mods/<Mod>/` и из
   `steamapps/workshop/content/2489330/<id>/`. Отключённые моды лежат с суффиксом `.wwoff`,
   в modlog это строки `Not loading mod ...`.
6. **Обратная связь.** Единственный канал из игры — `<saved>/Logs/modlog.txt` (а не
   `Logs/modlog.txt`, как написано в README кита). Туда пишут `ModAPI.LogMessage` и загрузчик
   модов. Игра собрана в shipping, лога движка нет. Ошибки Blueprint во время выполнения
   (`Accessed None` и т. п.) глушатся молча, и мод просто «не работает».
7. **Публикация в Workshop.** Встроенного загрузчика у игры нет, публикуют через SteamCMD.
   - Содержимое публикации — плоская папка `<Mod>.pak` + `<Mod>.uplugin`.
   - Описание публикации — `.vdf`: `appid` 2489330, `publishedfileid` (0 при первой загрузке),
     `contentfolder`, `previewfile`, `visibility` (0 — публичная, 2 — скрытая), `title`,
     `description`, `changenote`.
   - Загрузка: `steamcmd +login <user> +workshop_build_item <vdf> +quit`. После первой
     загрузки id мода записывается в `.vdf`.
   - Готовый пример: `<kit>/Workshop/research_notifier/`. `sync.bat` копирует файлы из
     `<saved>/mods`, `upload.bat` запускает загрузку.

## loom-mcp

Исходник — `<loom-src>/packages/loom-mcp/src/main.rs`: 144 строки на Rust, библиотека
`rmcp`. Логика — в `<loom-src>/packages/loom/src/` (`project.rs`, `docs.rs`, `types.rs`).
В Claude Code он подключён в `~/.claude.json` → `mcpServers.loom` как
`loom-mcp.exe --project <kit>`.

| Инструмент | Что делает | Ограничения |
|---|---|---|
| `docs` / `docs_search` | справочник языка; примеры в нём проверены тестами | — |
| `types` | класс, структура, enum или функция из `types.json`: флаги (`pure`, `static`, `world_context`, `event`), направления параметров, поля, `super` | на промахе предлагает до 20 имён типов, содержащих запрос; поиска по членам нет. Игровые BP есть, только если их уже подгрузила сборка. Игровой BP называется по имени ассета без `_C` (`BP_PlayHud`); в исходнике можно писать и путь `/Game/UI/BP_PlayHud.BP_PlayHud_C` |
| `check` | компиляция всех исходников без Unreal | не видит ошибок применителя, компилятора Blueprint и выполнения |

Чего нет: запуска сборки и чтения её отчёта, подгрузки игрового класса в типы по запросу,
поиска по членам классов, любой связи с запущенной игрой. Эти пробелы закрывает наш MCP:
сборку с подгрузкой игровых BP и её отчёт — `ww_loom_build`, состояние `types.json` и кита —
`ww_loom_status`, поиск по членам — `ww_find_symbol` / `ww_search_members` с колонкой `bp`,
связь с игрой — живые инструменты.

## Найденные грабли

Ошибки Loom (версия 0.1.0) — чинить в `<loom-src>/plugin`:
- **Корневой канвас в каждом виджете.** Любой виджет-Blueprint получает корневой
  `CanvasPanel` `Loom_Canvas` (`LoomApplier.cpp`, создание `UCanvasPanel`). У наследника
  игрового виджета это перекрывает дерево родителя: в игре виджет пустой, размер 0, `check`
  и сборка при этом проходят. Обход: не наследоваться, а `create_widget(ИгровойКласс)` и
  настраивать экземпляр снаружи.
- **Override функции с возвращаемым значением не собирается** (`cannot link ... would break
  the target's other links`). Редактор сам подключает вызов родителя к return-узлу, а
  применитель рвёт только exec-связи.
- **Падение редактора после неудачной сборки.** Недособранный Blueprint остаётся в памяти,
  и следующая сборка падает на assert `FindObject<UBlueprint>(...) == 0` (`Kismet2.cpp`).
  Перед перезапуском нужно удалить его автосейв из `<kit>/Saved/Autosaves`. Неудача на
  уровне компиляции исходника (`failed, N errors, 0 Blueprints`) безопасна.
- **Перевод строки `\n` в значении переменной по умолчанию** — UE не разбирает его при
  импорте, компилятор выдаёт предупреждение, а Loom считает любое предупреждение провалом.
  Обход: собирать строки в коде.
- **`DeprecateSlateVector2D`** (например `SlateBrush.ImageSize`) не присваивается: Loom
  собирает его через `MakeVector2D`, и тип не совпадает.

Особенности игры и UE, выяснены при порте:
- В Blueprint нет хуков. Реакцию на события игры заменяет `ReceiveTick` с
  `PrimaryActorTick.bTickEvenWhenPaused = true` и `TickGroup = TG_PostUpdateWork`.
- HUD (`BP_PlayHud.ImportantAgentModifiers`) при перестройке выбрасывает чужие виджеты.
  Свой виджет держат в канвасе-родителе ряда и возвращают каждый кадр.
- `Image.SetDesiredSizeOverride` на иконках баннера не действует: их растягивает слот.
  Масштаб задают через `SetRenderScale`.
- Тултип игрового баннера задаётся привязкой по `Problem Type`. `SetToolTip` после
  `AddChildToCanvas` её перебивает. Slate берёт тултип самого глубокого виджета под курсором.
- Штатный клик по баннеру вне ряда до контроллера не доходит. Нужно привязать
  `OnClicked` и вызвать `PlayerController_Play.HandleHudAction`.

## Что закрывает этот MCP

Как и почему — в [PLAN-loom.md](PLAN-loom.md), карточки инструментов — в [TOOLS.md](TOOLS.md).
`docs`, `types` и `check` не дублируются: они остаются за `loom-mcp`.

- **Логи и статус сборки.** `ww_game_log source=modlog` — modlog с офсета старта игры
  (`since=session`), строки загрузчика отдельно. `ww_loom_build` — сборка, `report.json` с хвостом `LogLoom*`
  и рецепт для известных провалов.
- **Живые инструменты для pak-модов.** Мосту UE4SS `.pak`-мод не мешает. `ww_ui_tree`,
  `ww_call`, `ww_trace_calls` принимают пути `/Game/Mods/<Mod>/…`, `ww_call bp_only`
  проверяет цепочку, которую Loom повторит один в один.
- **Разведка игровых BP.** `ww_lift` поднимает cooked-BP игры и воркшоп-модов в `.lm`.
  Слой Blueprint в индексных инструментах (`bp`, `loom_call`, фильтр `bp_only`) показывает,
  что из найденного Loom сможет вызвать. `ww_event_surface` отвечает, на что подписаться и
  что переопределить вместо хука.
- **Память.** Грабли из этого документа записаны в память без `mod_name`.

Публикация в Workshop отложена (раздел «Отложено и не делаем» плана): загрузку через
`steamcmd` с логином и Steam Guard всё равно запускает человек.

Lua-инструменты (`scaffold`, `generate_hook`, `validate_mod`, `deploy_mod`, `package_mod`,
`install_mod`) к этому пайплайну не относятся. В Loom-режиме их выключают, убрав группу
`lua` из ключа `toolsets` конфига.

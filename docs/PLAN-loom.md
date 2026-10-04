# План: MCP под Loom-пайплайн

Рабочий документ, не часть публичной доки. Источник — [LOOM-PIPELINE.md](LOOM-PIPELINE.md) и
эксперименты 2026-10-03 на игре 0.7.209.0, Loom 0.1.0 и ките на патче 29. Замеры привязаны к
этим версиям: после патча их переснимают, а не цитируют.

## Состояние

Пункты 0 и A–K реализованы 2026-10-03/04. Отступления от плана:
- D: `.lm` разбирается структурно (`src/utils/lm-parser.ts`), а не грамматикой tree-sitter-loom —
  её нечем собрать; на 45 `.lm` корпуса Loom разметка совпала с грамматикой.
- E: у `ww_loom_build` есть `cancel`; F: копирование в `<saved>/mods` — отдельный `install`,
  `status` только читает.
- J: фолбэки одиночного и пакетного подъёма — один модуль `src/utils/lift-fallback.ts`.

Замеры после доводки: `ww_lift` на 17 трудных BP поднимает 16 (было 9), подъём всей игры в
`setup` — 917 из 932 BP, 2959 тел, 1053 заглушки, около 40 с. Шаблоны `.lm` собираются
LoomBuild (5 из 5 `built`). Pak-мод проходит цикл cook → install → игра → modlog.

Осталось за человеком: проверка шаблонов в игре (PAL создаёт только редактор), регистрация
сервера на уровне пользователя (`/ww-setup`), пулл-реквесты в Loom (раздел ниже).

## Концепция

UE4SS и этот MCP остаются на стенде моддера: разведка игры и живая отладка. Сам мод
собирается на Loom в обычный `.pak`, игроку UE4SS не нужен.

Относительно LOOM-PIPELINE.md смещены три акцента:

1. **Разведка выдаёт результат на Loom.** `loom lift` поднимает cooked-Blueprint из JSON
   CUE4Parse обратно в `.lm`, а CUE4Parse уже есть в сайдкаре. ИИ читает логику игры на том же
   языке, на котором пишет мод.
2. **Вместо «что хукнуть» — «на что подписаться или что переопределить».** Хуков в Blueprint
   нет, и `ww_verify_hook` отвечает на вопрос, который в Loom не возникает. Без своего
   инструмента разведка кончается опросом в Tick.
3. **UE4SS — единственный отладчик pak-мода.** Игра собрана в shipping, лога движка нет,
   ошибки BP глушатся. Цикл «собрал → поставил → перезапустил с сейвом → прочитал лог»
   закрывается без кликов в редакторе.

| | Отвечает за |
|---|---|
| loom-mcp | язык: `docs`, `types`, `check`. Не дублируем |
| этот MCP | знание об игре (индекс, lift, память), сборка и установка мода, живая проверка |
| UE4SS + мост | разведка и отладка на стенде моддера |

Наши инструменты зовут `loom.exe` напрямую, а не через loom-mcp: у `check`, `sources` и
`build` есть `--json`, у `lift` — текстовый вывод.

## Что проверено до планирования

Эксперименты — одноразовым экспортёром на той же CUE4Parse 1.2.2, что в сайдкаре, и
`loom.exe` из кита.

| Что | Результат |
|---|---|
| lift всех BP игры как есть | 166 из 930 (18%). Отказы почти все не в логике: дерево виджетов с вложенными user-виджетами (205 BP), дефолты классов и компонентов, неподдержанные EX-токены |
| lift с препроцессингом и деградацией (пункт A) | читаемый `.lm` не меньше чем у 820 из 930 (88%). Выгрузка всех BP в JSON — 10 с, lift как есть — 16 с в 12 процессов, проход с деградацией — около 30 с |
| функции с токенами, которых lift не умеет | 666 из 4429 (15%): `EX_SwitchValue` 395, `EX_VectorConst` 278, `EX_RotationConst` 40, `EX_CallMulticastDelegate` 36, `EX_TransformConst` 8. Из-за них 191 из 521 event graph не поднимается целиком |
| крупные UI-BP | `BP_PlayHud` поднимается только с заглушками, пустых тел 42 из 60: пока это скелет, тела берутся из `ww_get_bytecode` |
| lift против дизасма | `ProblemSummaryBannerWidget.GetToolTipWidget`: в `ww_get_bytecode` 8000 символов EX_* с обрезкой и `Problem Type` байтами 0..14; после lift около 80 строк с `EProblemSummaryType.*` и ключами тултипов |
| `ReadScriptData` | без `provider.ReadScriptData = true` CUE4Parse не кладёт байткод в JSON, и lift молча отдаёт пустые тела |
| воркшоп-моды | lift работает: `BP_Startup` одного мода дал 144 строки с опциями, правкой DataTable и ссылками на классы. Моды со старого кита собраны на 5.6: CUE4Parse нужен `GAME_UE5_6`, в их `.uplugin` нет `EngineVersion` |
| BP-доступность | 160 из 1431 функции SystemCore/ProjectArco нет в `types.json`: UE4SS их зовёт, Loom нет. `AgentEnterable.AssignWorkerToSlot` — `UFUNCTION()` без BlueprintCallable; `ArcoHUD.DrawArcPlan` в дампе UE4SS BlueprintCallable, а в стабах кита отсутствует |
| кит против индекса | 1271 функция кита совпадает с индексом 0.7.209.0 по составу параметров, расхождений 0 |
| покрытие `types.json` | нет 46 из 940 BP реестра: главное меню, `Config_*Mule`, `BP_ArcoGameInstance`. Их подгрузит сборка, но `check` до неё их не видит |
| Cook & Install | RunUAT BuildCookRun с фиксированными аргументами (`<kit>/…/WWModTools/Private/ModActions.cpp`) и копия `pakchunk<Id>-Windows.pak`. Скриптуется без UI |
| сборка из редактора | `ULoomLibrary.BuildBlueprints(bForce)` возвращает JSON-отчёт, доступна из Python и Remote Control. Оба плагина есть в движке кита, в `.uproject` не включены |
| modlog | строки `LogMessage` идут без меток времени, они есть только у строк загрузчика. Сессию отрезать можно только по смещению |
| `loom types` | при промахе подсказывает до 20 имён типов с подстрокой; поиска по членам нет (поправка к LOOM-PIPELINE.md) |
| подключение | сервер whiskerwood прописан только в `.mcp.json` этого репозитория с относительным путём; в сессии, открытой в ките, его нет |

## Порядок работ

| Очередь | Пункты | Почему так |
|---|---|---|
| 0 | 0 (фундамент) | общие решения для всех пунктов: без них каждый пункт придумает своё |
| 1 | A (lift), B (BP-слой) | дёшево: сайдкар уже читает байткод, `types.json` готов. Качество разведки меняется сильнее всего |
| 2 | E (сборка), G (modlog), D (валидация) | обратная связь без чтения логов руками |
| 3 | F (установка), C (живая проверка) | автономный цикл и отладка мода |
| 4 | H (точки реакции) | самый ценный по смыслу, но данные из трёх источников надо сводить аккуратно |
| 5 | I (снимки), J (lift всей игры), K (наборы, промпты, подключение) | страховка и удобство. Подключение из K дешёвое, его можно сделать в любой момент |

---

## 0. Фундамент: общие решения для всех пунктов

**Проблема.** Пункты A–K опираются на одно и то же: где лежат кит и движок, как запускать внешние
программы, что делать с операциями на минуты, как сводить формы путей и куда разрешено писать.
Если не решить это заранее, каждый пункт придумает своё.

**Правка.**
1. **Конфиг и поиск кита.**
   - Новый ключ `kitDir` — корень кита с `.uproject`. Необязательный: без него Loom-инструменты
     отвечают `kit_not_configured` с подсказкой про `/ww-setup`, остальное работает как раньше.
   - Движок находится без конфига: GUID из `EngineAssociation` в `.uproject` кита →
     `reg query "HKCU\Software\Epic Games\Unreal Engine\Builds" /v <GUID>` → корень сборки;
     `<engine>` — его подкаталог `Engine`. Ключ `engineDir` — только ручное переопределение.
   - `savedDir` по умолчанию `%LOCALAPPDATA%/<basename(gameDir)>/Saved` — тем же правилом, что
     уже даёт `saveDir`.
   - Производные пути — в одном месте: `loom.exe`
     (`<kit>/Plugins/LoomEditor/Binaries/ThirdParty/Loom/Win64/`), `UnrealEditor-Cmd.exe` и
     `UnrealPak.exe` (`<engine>/Binaries/Win64/`), `RunUAT.bat` (`<engine>/Build/BatchFiles/`),
     `types.json` и `report.json` (`<kit>/Intermediate/Loom/`), лог редактора
     `<kit>/Saved/Logs/Whiskerwood.log`, `<saved>/Logs/modlog.txt`, `<saved>/mods/`.
   - `doctor` показывает раздел Loom: что из этого найдено и как найден движок (реестр или ключ).
     Нет кита — предупреждение, а не ошибка.
   - `/ww-setup` спрашивает путь к киту и пишет `kitDir`.
2. **`utils/loom.ts` — единственное место, где запускаются внешние программы** (`loom.exe`,
   `UnrealEditor-Cmd`, `RunUAT`, `UnrealPak`): таймаут, по истечении — убить дерево процессов
   (`taskkill /T /F`), разбор JSON, ошибки вида `not_configured | not_found | timeout |
   exit_code | crash` с хвостом stderr.
   - `loom check --json` и `loom build --json` при провале печатают JSON и выходят с кодом 1:
     это результат, а не сбой запуска.
   - `loom lift` печатает текст (`wrote …`, `could not lift …`) и при отказе выходит с 1; при
     переполнении стека процесс падает без вывода — это отдельный исход `crash`.
3. **Долгие операции — задачи.** Cook и headless-сборка идут минуты, первый cook — дольше любого
   разумного таймаута вызова. Поэтому задачи, а блокирующий вызов — только для коротких операций
   (lift, check, status).
   - `utils/jobs.ts` и `scripts/job-runner.ts`: инструмент запускает раннер отвязанным процессом,
     раннер запускает программу, пишет её вывод в `state/jobs/<id>.log`, а код выхода и время —
     в `state/jobs/<id>.json`. Задача переживает перезапуск MCP-сервера, статус читается из файла.
   - Задачей владеет сам инструмент: `action: start | status | cancel` и `job_id`, как
     `session_id` у `ww_trace_calls`. `status` разбирает прогресс из лога, как `ParseUATLine` в
     WWModTools.
   - Одна задача на кит за раз: cook и headless-сборка пишут в один проект. Второй `start`
     отвечает `busy` с id идущей задачи.
   - `cancel` — `taskkill /T /F` по раннеру: RunUAT порождает AutomationTool и UnrealEditor-Cmd.
   - Хранятся последние N задач, как `LOG_KEEP` у логов.
4. **Пути.** Одно отображение между формами:
   - индексная (`SystemCore.ModAPI.WriteDataTableValue`,
     `ProblemSummaryBannerWidget.ProblemSummaryBannerWidget_C.GetToolTipWidget`);
   - `hook_path` (`/Script/SystemCore.ModAPI:WriteDataTableValue`);
   - Loom: путь типа в `types.json` (`/Script/SystemCore.ModAPI`,
     `/Game/UI/BP_PlayHud.BP_PlayHud_C`) и короткое имя в исходнике (`ModAPI`, `BP_PlayHud`:
     `_C` отбрасывается, когда остаток совпадает с именем ассета, — правило `short_name` из
     `project.rs` Loom);
   - путь ассета (`/Game/UI/BP_PlayHud`) и путь в паке для CUE4Parse
     (`Whiskerwood/Content/UI/BP_PlayHud.uasset`).

   Расширить `scripts/parsers/path-forms.ts` и `findObject` в `tools/common.ts`, а не писать
   своё в каждом инструменте. Пути `/Game/Mods/…` распознаются отдельно и в индексе не ищутся:
   их разрешают живые инструменты (пункт C). Короткое имя бывает неоднозначным — тогда список
   кандидатов, а не первое совпадение.
5. **Наборы инструментов.** У каждого `registerTool` и промпта — группа: `recon` (15
   инструментов, включая `ww_lua_api` и `ww_verify_hook`), `live` (11), `lua` (6), `memory` (4),
   `loom` (новые). `createServer` регистрирует только группы, включённые в `toolsets` конфига. По
   умолчанию включены все, существующие установки не меняются. Какие группы нужны Loom-режиму —
   пункт K.
6. **Границы записи.** Новые зоны записи сервера: `state/lift/`, `state/jobs/`, `state/backup/`
   (внутри песочницы) и `<saved>/mods/<Mod>` — отдельным `PathSandbox` только для
   `ww_loom_install`, с проверкой, что цель — ровно папка текущего мода. В `<kit>/Content` и
   `<kit>/Plugins` сервер не пишет никогда. Отдельная категория — процессы, которые сервер
   запускает: LoomBuild и RunUAT пишут в кит (`Content/Mods`, `Intermediate`, `Saved`,
   `Windows`). Всё это — одной правкой раздела «Границы» в ARCHITECTURE.md.
7. **Формат и обёртки.** Новые инструменты отвечают через `renderAiText` / `errorText`
   (`utils/ai-text.ts`), как остальные. Инструментам, которым индекс не нужен (сборка, установка,
   статус кита), — обёртка без падения на устаревшем профиле, как `wrapBridge`. Lift и BP-слой —
   через обычную: им нужна текущая версия игры, а `.usmap` от прошлой версии молча даёт пустые
   или неверные данные.

**Проверка.**
- `bun run typecheck`, `bun run doctor`: раздел Loom с найденными путями; без `kitDir` —
  предупреждение.
- `bun run smoke` со стандартным конфигом — те же 36 инструментов; с `toolsets` без `lua` — 30.
- `loom sources --project <kit> --json` через `utils/loom.ts` возвращает исходники кита.
- Задача на безобидной команде (ожидание несколько секунд): `start`, `status` во время работы,
  `status` после перезапуска сервера, `cancel`.
- `findObject` сводит `ModAPI`, `/Script/SystemCore.ModAPI` и `SystemCore.ModAPI` к одному
  объекту индекса; путь `/Game/Mods/…` помечается как путь мода.

**Файлы.** `config.ts`, `wwmcp.config.example.json`, `utils/loom.ts` (новый), `utils/jobs.ts`
(новый), `scripts/job-runner.ts` (новый), `scripts/parsers/path-forms.ts`, `tools/common.ts`,
`server.ts`, `prompts.ts`, `scripts/doctor.ts`, `.claude/skills/ww-setup/SKILL.md`,
`docs/SETUP.md`, `docs/ARCHITECTURE.md`, `docs/TOOLS.md`.

**Риск.** Отвязанный процесс на Windows: проверить, что cook переживает перезапуск MCP-сервера,
а `cancel` убивает всё дерево. Поиск движка через реестр работает только на Windows, как и
остальной сервер (`taskkill`, снимки окна игры).

## A. `ww_lift`: BP игры или воркшоп-мода → `.lm`

**Проблема.** Логика игровых BP сейчас видна только как дизасм EX_* из `ww_get_bytecode`:
длинно, обрезано, енумы — числами. ИИ переводит это в Loom в уме и ошибается.

**Правка.**
1. Глагол `json` в сайдкаре: `WwParse json --paks <dir> --usmap <file> --asset <vfs> --out <file>`.
   Внутри `provider.ReadScriptData = true` и `JsonConvert.SerializeObject(package.GetExports())`.
   Версия движка для игры — по имени `.usmap`, как в `EngineOf`; для воркшоп-мода — по
   `EngineVersion` в его `.uplugin`, без него `GAME_UE5_6`.
2. Временный Loom-проект `state/lift/<версия игры>/`: `Lift.uproject` с `{}` и копия
   `<kit>/Intermediate/Loom/types.json`. Запуск `loom.exe lift <json> --project <проект>`,
   результат в его `Content/`. **В `<kit>/Content` не поднимать никогда:** LoomBuild соберёт
   такой исходник поверх игрового BP в ките.
3. Препроцессинг JSON: убрать ключи `Hex` (CUE4Parse пишет их в цвета, лифтер отвергает),
   занулить float с модулем меньше 1e-4 (принтер Loom печатает их в экспоненте, а парсер
   такое не читает).
4. Деградация в цикле до успеха, лимит около 40 итераций. Заглушка функции —
   `ScriptBytecode = [EX_Return, EX_EndOfScript]`.
   - до первого прогона глушить функции, где в байткоде есть `EX_SwitchValue`,
     `EX_VectorConst`, `EX_RotationConst`, `EX_TransformConst`, `EX_CallMulticastDelegate`;
   - `reading the widget tree` или переполнение стека → удалить
     `WidgetTree.Properties.RootWidget`;
   - `function X:` или `event X:` → заглушить X. События, которые входят в заглушенный
     ubergraph, падают с `an event graph with no entry jump` и глушатся так же;
   - `reading the event graph` → заглушить `ExecuteUbergraph_*`;
   - `component C's F` → удалить F у экспорта `C_GEN_VARIABLE`;
   - `default X` или `a default for X` → удалить X у CDO;
   - `the lifted source does not parse: L:C` → по напечатанному тексту (он идёт в ошибке)
     найти объемлющий `fn | on | event` и заглушить его.
5. Каждую заглушенную функцию пометить в выдаче: `// not lifted: <причина> → ww_get_bytecode <путь>`.
   Иначе ИИ поверит, что тело действительно пустое. Если убрано дерево виджетов — отметить,
   что раскладку показывает `ww_ui_tree`.
6. Кеш по паре (версия игры, ассет), сбрасывается вместе с профилем.
7. `ww_get_bytecode` остаётся запасным путём; его описание отсылает сначала к `ww_lift`.

**Файлы.** `sidecar/WwParse/Program.cs`, `tools/lift.ts` (новый), `utils/loom.ts` (из пункта 0),
`server.ts`, `docs/TOOLS.md`.

**Риск.** Lift 0.1.0 работает по принципу «всё или ничего» на пакет — отсюда деградация.
Крупные UI-BP до поддержки `EX_SwitchValue` в апстриме дают в основном скелет. Поднятые
воркшоп-моды — локальный справочник: в сид не отдавать, чужой код не распространять.

## B. Слой доступности из BP в индексных инструментах

**Проблема.** UE4SS видит и зовёт всё, Loom — только то, что доступно Blueprint. ИИ находит
функцию через индекс или `ww_game_eval`, пишет Loom и узнаёт о тупике на `check`, а то и позже.
В LOOM-PIPELINE.md подтверждение через `loom types` — ручной шаг, его забывают.

**Правка.**
1. `utils/loom-types.ts`: чтение `<kit>/Intermediate/Loom/types.json` (около 10 МБ, 11 тысяч
   классов) с кешем по mtime; соответствие путей индекса и Loom (`SystemCore.ModAPI` ↔
   `/Script/SystemCore.ModAPI`, `X_C` ↔ `/Game/.../X.X_C`).
2. `ww_get_function`: поле `bp` (`callable | pure | latent | world_context | internal |
   deprecated | editor_only | not_callable | not_in_types`), `dir` у параметров
   (`in | ref | out`) и `loom_call` — готовая строка вызова на Loom:
   - статические функции — через имя класса;
   - методы экземпляра — через статический геттер класса, если он есть (`ModAPI.GetModAPI()`),
     иначе `<объект>.Метод(...)`;
   - WorldContext и скрытые пины убраны, out-параметры — поля результата, имена с пробелами —
     в обратных кавычках.

   Пример: `ModAPI.GetModAPI().WriteDataTableValue(datatableName, rowId, ColumnName, valueStringified) -> bool`.
   В описание инструмента — правило «вызов не собирай сам, копируй `loom_call`», как для
   `hook_path`.
3. `ww_get_type`: у полей `bp: read | read_only | edit_only | hidden`, у методов — статус из
   п. 2. Игровой BP, которого нет в `types.json`, помечается «подгрузится при сборке».
4. `ww_find_symbol`, `ww_search_members`: колонка `bp` и фильтр `bp_only`.
5. Нет `types.json` (кит не настроен или ни разу не собирался) — поля нет, есть подсказка,
   инструмент не падает.

**Файлы.** `utils/loom-types.ts` (новый), `tools/get-function.ts`, `tools/get-type.ts`,
`tools/find-symbol.ts`, `tools/search-members.ts`, `server.ts`.

**Риск.** `types.json` — снимок того, что было загружено в редакторе кита. Для игровых BP «нет
в types» не значит «нельзя вызвать»: `not_in_types` и `not_callable` должны различаться.

## C. Живая проверка в терминах BP

**Проблема.** Cook с перезапуском — минуты, живой вызов — секунды. Но цепочку, проверенную в
Lua, Loom может не повторить.

**Правка.**
1. `ww_call` с `bp_only: true` отказывает в функциях со статусом, отличным от
   `callable | pure`, и печатает в ответе тот же вызов на Loom. Цепочку вида
   `GetArcoSys → GetResearchInfo → ResearchState.activeResearch` проверяют вживую и переносят в
   мод один к одному.
2. `ww_game_eval`: после выполнения — предупреждение со списком членов из чанка, недоступных
   из BP (имена из текста чанка сверяются по пункту B).
3. Пути `/Game/Mods/<Mod>/...` в `ww_trace_calls`, `ww_call`, `ww_ui_tree`. В индексе игры их
   нет, поэтому сигнатуру брать вживую через мост (рефлексия UFunction) или из cooked-pak мода
   через глагол `json`. Путь — только полный: `BP_MapLoad_C` есть у каждого мода.

**Файлы.** `tools/call-function.ts`, `tools/trace-calls.ts`, `tools/ui-tree.ts`,
`tools/game-eval.ts`, `tools/common.ts`, `bridge/WWBridge/Scripts/main.lua` (если для живой
сигнатуры понадобится команда моста).

**Риск.** Хуки на BP-функции мода через этот мост ещё не проверялись. Сначала спайк, по одному
вызову за раз.

## D. `ww_loom_validate`: check + проверка под игру

**Проблема.** `check` видит только исходник. Грабли кита и игры проявляются уже в игре, где мод
«просто не работает».

**Правка.**
1. Запуск `loom.exe check --project <kit> --json` и перевод ошибок. `missing` с игровыми BP —
   не ошибка: LoomBuild их подгрузит.
2. Проверка `.lm` мода; разбор — грамматикой tree-sitter-loom из `<loom-src>`, а не самописным
   парсером:
   - заголовок `blueprint X : P at /Game/Mods/<Mod>/X` совпадает с файлом; папка, `.uplugin` и
     будущий pak названы одинаково; есть `PAL_<Mod>`;
   - `LogMessage` без префикса мода;
   - `\n` в значении переменной по умолчанию;
   - наследование от игрового виджета (пустой `Loom_Canvas` поверх дерева родителя);
   - override функции с возвращаемым значением;
   - присваивание полей `DeprecateSlateVector2D` (`SlateBrush.ImageSize`);
   - обращения к миру в `ReceiveBeginPlay` у `BP_MapLoad` до `onLoadingFinished`;
   - pitfall-записи памяти с тегами — триггеры, тем же механизмом, что в `ww_validate_mod`.
3. Сверка ссылок на классы, функции и поля игры с индексом: есть в ките, но нет в игре — дрейф
   стабов после патча.

**Файлы.** `tools/loom-validate.ts` (новый), `utils/loom.ts`, `utils/lm-parser.ts` (новый,
tree-sitter-loom), `tools/memory-common.ts`, `server.ts`.

## E. `ww_loom_build`: сборка и отчёт

**Проблема.** Итог сборки лежит в `report.json` и `Whiskerwood.log`, их никто не читает
автоматически. Неудачная сборка может уронить редактор на следующей.

**Правка.**
1. `action: status` — последний `report.json` и хвост `LogLoomBuild` / `LogLoom` из
   `<kit>/Saved/Logs/Whiskerwood.log`, без сборки.
2. `action: build`.
   - Редактор с китом открыт: сборку запускает сохранение `.lm` (DirectoryWatcher, 0,5 с). ИИ
     сохраняет файл сам, инструмент ждёт свежий `report.json` с mtime позже старта.
   - Редактор закрыт: `UnrealEditor-Cmd <uproject> -run=LoomBuild -unattended -nosplash
     -nullrhi -nopause -stdout [-force] -report=<файл>`. Запуск редактора без UI занимает
     минуты, поэтому это задача из пункта 0.
   - Процесс редактора с этим `.uproject` в командной строке проверяется до запуска: две
     сборки одного проекта недопустимы.
3. Известные провалы сразу дают рецепт:
   - `failed` у применителя: следующая сборка может упасть на assert `FindObject<UBlueprint>`,
     сначала удалить автосейв из `<kit>/Saved/Autosaves`;
   - `failed, N errors, 0 Blueprints` — провал на уровне исходника, безопасен.
4. Потом, если в ките включить Remote Control или Python: прямой вызов
   `ULoomLibrary.BuildBlueprints(bForce)` с синхронным отчётом, в том числе `force` при
   открытом редакторе. Включение плагинов — правка `.uproject` кита, решение пользователя.

**Файлы.** `tools/loom-build.ts` (новый), `utils/loom.ts`, `server.ts`.

## F. `ww_loom_install`: cook → `Saved/mods`

**Проблема.** Cook & Install есть только в контекстном меню редактора, и цикл требует человека
на каждой итерации.

**Правка.**
1. RunUAT с аргументами WWModTools: `BuildCookRun -project=<uproject> -platform=Win64
   -clientconfig=Shipping -build -cook -stage -pak -archive -archivedirectory=<kit>
   -nocompileeditor -installed -iterativecooking -cookincremental -nop4 -utf8output -unattended
   -WaitForUATMutex`. Cook идёт минуты — это задача из пункта 0
   (`action: start | status | install | cancel`; `status` только читает, копирует `install`).
2. Chunk мода без редактора: тот `pakchunk<N>-Windows.pak` в
   `<kit>/Windows/Whiskerwood/Content/Paks`, где лежит `/Game/Mods/<Mod>/` (`UnrealPak -List`
   или CUE4Parse).
3. Копия в `<saved>/mods/<Mod>/<Mod>.pak` и `.uplugin` из `Content/Mods/<Mod>/`; прошлая версия
   — в `state/backup/`, как у `ww_install_mod`.
4. Проверки: в pak только `/Game/Mods/<Mod>/…`; размер меньше 123 999 999 байт (лимит
   загрузчика, есть в памяти); имена `.uplugin`, папки и pak совпадают; `EngineVersion` = `5.8`.
5. В ответе — что установлено, и подсказка `ww_game_process restart save=… wait_for=world`:
   pak-моды грузятся только при старте игры.

**Файлы.** `tools/loom-install.ts` (новый), `utils/loom.ts`, `server.ts`, `docs/ARCHITECTURE.md`.

**Риск.** Новая граница записи `<saved>/mods/<Mod>` — того же рода, что `<ue4ssDir>/Mods` у
`ww_install_mod`.

## G. modlog в `ww_game_log`

**Проблема.** modlog — единственный канал из игры. Строки `LogMessage` без меток времени,
сессию по времени не отрезать, а провалы загрузчика (`Not loading mod`, лимит размера) теряются
среди строк модов.

**Правка.**
1. `source: ue4ss | modlog`; modlog — `<saved>/Logs/modlog.txt` (не `Logs/modlog.txt`, как в
   README кита).
2. `ww_game_process` при старте пишет размер modlog в `ProcessState`, `since: session` читает с
   этого смещения. Файл игры не ротировать.
3. Строки загрузчика — отдельным блоком предупреждений; фильтр `mod` — по префиксу `<Mod>:`,
   принятому в ките.

**Файлы.** `tools/game-log.ts`, `utils/mod-log.ts` (новый), `utils/game-process.ts`,
`tools/game-process.ts`, `server.ts`.

## H. `ww_event_surface`: на что подписаться и что переопределить

**Проблема.** В Blueprint нет хуков. Вопрос «что хукнуть», на который отвечает
`ww_verify_hook`, для Loom превращается в «на что подписаться или что переопределить». Без
инструмента ответ — опрос в Tick, как в порте из LOOM-PIPELINE.md.

**Правка.** Для класса или подсистемы — точки реакции по убыванию предпочтения:
1. делегаты ModAPI (`onLoadingFinished`, `onBuildingSpawned`, `onWhiskerSpawned`,
   `onOptionChanged`, `onDayStart`) с сигнатурой для `bind`;
2. диспетчеры `BlueprintAssignable` самого класса и объектов из его полей, с сигнатурой
   (`multicast_delegate` и `signature` в `types.json`);
3. события, переопределяемые в наследнике (флаг `event` в `types.json`), и ответ, заспавнит ли
   игра наследника. Для этого — где класс упомянут в `datatable_rows` и в рёбрах `ref` xref.
   Ссылка из DataTable значит, что класс подменяется через `ModAPI.WriteDataTableValue`: так
   делают с `GridActor` в `GridactorDefs_Sync`, запись есть в памяти;
4. последний вариант — опрос в Tick с `bTickEvenWhenPaused` и `TG_PostUpdateWork`.

К каждой точке — подсказка для живой проверки: `ww_trace_calls` на UFunction события
показывает, срабатывает ли оно и когда.

**Файлы.** `tools/event-surface.ts` (новый), `utils/loom-types.ts`, `server.ts`, `docs/TOOLS.md`.

**Риск.** Граф объектов из полей быстро разрастается — глубина 1 и лимит. Поиск класса в
`datatable_rows` идёт по подстроке, поэтому такие находки — кандидаты, а не факт.

## I. Сверка трёх снимков игры

**Проблема.** Индекс снят с живой игры, стабы кита — с патча, который выбрали мейнтейнеры,
`types.json` — из редактора кита. Если после патча кит отстанет, Loom соберёт мод по старым
сигнатурам, и сломается он уже у игрока. Это тот же принцип, что «профиль привязан к версии
игры» в ARCHITECTURE.md.

**Правка.**
1. `ww_loom_status` (или раздел `ww_index_status`) и `doctor`:
   - `GameInstallDirectory.txt` кита указывает на `gameDir`;
   - mtime `types.json` против mtime пака игры;
   - версия Loom в `<kit>/Intermediate/Loom/ops/build.json` (поле `version`, пишет `loom build`)
     против `VersionName` плагина в `<kit>/Plugins/LoomEditor/LoomEditor.uplugin`; у `loom.exe`
     нет `--version`;
   - открыт ли редактор, последний `report.json`.
2. Дифф `types.json` ↔ индекс по нативным классам: что есть в ките и нет в игре, и
   BlueprintCallable по дампу UE4SS, которого нет в ките. Номер версии кита взять неоткуда
   (только коммиты вида «Update to patch 29»), поэтому опора на дифф, а не на номер.
3. В промпт `ww:fix-after-patch` — шаг этого диффа для Loom-модов.

**Файлы.** `tools/loom-status.ts` (новый) или `tools/index-status.ts`, `scripts/doctor.ts`,
`prompts.ts`.

## J. Lift всей игры при сборке индекса и поиск по коду

**Проблема.** Lift по запросу отвечает «что делает BP X», но не «где в игре делается Y».

**Правка.**
1. Шаг `bun run setup` после xref: выгрузка всех BP в JSON и lift одним пакетом, чтобы BP видели
   друг друга, с деградацией из пункта A. Около минуты.
2. Результат — в `dist/games/<версия>/lift/`, плюс FTS-таблица по функциям: путь, имя, текст.
   В `profile_meta` — sha `types.json`, по которому поднимали.
3. У `ww_lift` режим `pattern` — поиск по коду игры: функция, строка, фрагмент.
4. Без кита шаг пропускается с пометкой в `profile_meta`, приёмочные проверки профиля от него не
   зависят.

**Файлы.** `scripts/setup.ts`, `scripts/index-lift.ts` (новый), `schema.ts` (таблица,
`INDEX_SCHEMA_VERSION`), `tools/lift.ts`.

## K. Наборы инструментов, промпты, подключение

**Правка.**
1. Состав наборов для Loom-режима (механизм — в пункте 0): выключить `lua`, то есть
   `ww_scaffold_mod`, `ww_generate_hook`, `ww_validate_mod`, `ww_deploy_mod`, `ww_package_mod`,
   `ww_install_mod`. Иначе вместе с loom-mcp модель видит под 50 инструментов. `ww_lua_api` и
   `ww_verify_hook` остаются в `recon`: они нужны `ww_game_eval` и трейсу.
2. Промпты: `ww:new-loom-mod` (порядок работы ниже) и `ww:port-to-loom` (каждый `RegisterHook`
   Lua-мода → точка реакции через `ww_event_surface` → Loom).
3. Шаблоны `.lm` — ресурсом и в промпте, без отдельного инструмента: `BP_Startup` (DataTable,
   опции), `BP_MapLoad` (`onLoadingFinished`, Tick), оверлей в HUD с возвратом виджета каждый
   кадр, `BP_MainMenuLoad`. PAL создаёт только редактор («New mod...»), согласованность
   проверяет `ww_loom_validate`.
4. Подключение: `/ww-setup` предлагает прописать сервер whiskerwood на уровне пользователя с
   абсолютными путями и `WWMCP_CONFIG`, рядом с loom-mcp в `~/.claude.json`. Иначе в сессии,
   открытой в ките, его нет.

**Файлы.** `server.ts`, `config.ts`, `prompts.ts`, `data/templates/loom/` (новый),
`.claude/skills/ww-setup/SKILL.md`, `docs/SETUP.md`.

---

## Порядок работы ИИ над Loom-модом

```
ww_memory_wakeup → ww_memory_search        что уже выяснено, включая грабли Loom
ww_loom_status                             кит, types.json, версии, редактор
ww_find_symbol / ww_find_asset → ww_lift   как это делает игра — сразу на Loom
ww_event_surface                           на что подписаться, что переопределить
ww_get_function (loom_call) / loom types   точный вызов и доступность из BP
ww_call bp_only / ww_trace_calls           проверить цепочку вживую за секунды
loom docs → .lm → ww_loom_validate         check + проверка под игру, до нуля
ww_loom_build → ww_loom_install            Blueprint → .pak в Saved/mods
ww_game_process restart save=…             pak грузится только при старте
ww_game_log modlog / ww_ui_tree / trace    сработал ли мод, его функции
ww_memory_add                              решения и грабли
```

## Апстрим в Loom

Loom — публичное зеркало, PR принимают туда (`CONTRIBUTING.md` в `<loom-src>`). По убыванию
пользы:
1. `EX_SwitchValue`, константы Vector / Rotator / Transform и `EX_CallMulticastDelegate` в
   lift — 15% функций и 37% event graph игры;
2. пользовательские виджеты в дереве (`native_class` ищет только среди классов движка) — не
   меньше 205 BP;
3. заглушка с пометкой для одной функции вместо отказа на весь пакет;
4. ошибки печати: float в экспоненте, выражение отдельной строкой
   (`an expression on its own does nothing`);
5. переполнение стека на части деревьев виджетов;
6. ключ `Hex` в цветах из JSON CUE4Parse;
7. пять граблей применителя и компилятора из LOOM-PIPELINE.md.

## Отложено и не делаем

- **Публикация в Workshop** (папка, `.vdf`, проверка pak) — пока не нужна. Загрузку через
  steamcmd с логином и Steam Guard в любом случае запускает человек.
- **`ww_loom_eval`** (перевод Loom-фрагмента в Lua для живого запуска) — out-параметры,
  структуры и касты не переводятся один к одному. Основной сценарий закрывает `ww_call bp_only`.
- **Горячая перезагрузка pak-мода** — pak монтируется при старте, BP-классы в shipping не
  перегружаются. Цикл — перезапуск с сейвом.
- **Синтез записей `types.json` для недостающих игровых BP** — LoomBuild подгружает их сам через
  `missing`, а формат файла может меняться между версиями Loom.

## Хвосты, общие для всех пунктов

- Счётчик «36 инструментов» — `docs/ARCHITECTURE.md:22`, `docs/TOOLS.md:3`; после пункта 0 —
  с разбивкой по наборам.
- `docs/TOOLS.md`: карточки новых инструментов и Loom-блок в «Порядке работы». Заметка «графа
  BP-нод нет и не будет» остаётся верной; рядом — что читаемое тело даёт `ww_lift`.
- LOOM-PIPELINE.md: поправка про подсказки `loom types` при промахе; раздел «Чем этот MCP может
  закрыть пробелы» — ссылкой на этот план.
- Память: грабли из LOOM-PIPELINE.md и из этого плана (`ReadScriptData`, `Hex`, экспонента, 5.6
  у старых модов, функции без BP-доступа) — через `ww_memory_add`, без `mod_name`, с тегами. В
  тексте не упоминать конкретные моды: в сид такие записи не уходят.
- J требует пересборки индекса: `ww_index_release`, затем `bun run setup --force`.
- Перед сдачей каждого пункта: `bun run typecheck` и `bun run doctor`.

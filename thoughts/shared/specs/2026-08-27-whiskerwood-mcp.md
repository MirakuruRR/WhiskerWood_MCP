# Whiskerwood MCP — спецификация и план реализации

Дата: 2026-08-27
Статус: спецификация утверждена в интервью, реализация не начата
Входные документы: `WHISKERWOOD-MODDING.md` (техническая база), `BannerlordSage_ARCHITECTURE.md` (источник паттернов)

---

## 1. Резюме

MCP-сервер, который позволяет ИИ-агенту писать рабочие моды для Whiskerwood под UE4SS+Lua,
не выдумывая API. Единственный потребитель — ИИ-агент; единственный оператор — владелец машины.

Три контура вместо двух у BannerlordSage:

```
┌─ BUILD (редко, минуты) ─────────────────────────────────────────────┐
│ дампы UE4SS + pak + .usmap  →  парсеры  →  SQLite-профиль версии    │
└─────────────────────────────────────────────────────────────────────┘
                            ↓ dist/games/whiskerwood-0.6.190.0/
┌─ READ (интерактивно, миллисекунды) ─────────────────────────────────┐
│ MCP stdio → 24 инструмента → SQLite (readonly) + файлы профиля      │
└─────────────────────────────────────────────────────────────────────┘
                            ↕ файловый IPC
┌─ RUNTIME (только когда игра запущена) ──────────────────────────────┐
│ WWBridge (Lua-мод в UE4SS) ← eval / probe / console / log           │
└─────────────────────────────────────────────────────────────────────┘
```

Третий контур — принципиальное отличие от BannerlordSage. Bannerlord-мод компилируется
и его корректность частично проверяется компилятором; Lua-мод не проверяется ничем до
запуска игры. Bridge возвращает агенту то, чего его лишает динамическая типизация:
обратную связь.

---

## 2. Постановка задачи

Проблема сформулирована в §7 входного документа и воспроизводима: имена `startResearch`,
`cancelResearch`, `canResearch`, `isResearchActive` присутствуют в бинарнике как строки,
выглядят идеальными точками зацепа и **отсутствуют в рефлексии**. Агент, работающий по
`strings`, пишет хуки на несуществующие функции и получает молчаливо неработающий мод.

Настоящий API исследований называется иначе — `SystemCore.UnlockResearchComponent.SetResearchTopic`,
`IsResearched`, `GetResearchTopic`. Найти его без дампа нельзя.

Второй, менее очевидный слой той же проблемы: агент не знает о существовании родных
подсистем игры. Проверка при подготовке этой спецификации показала наличие
`SystemCore.NotificationBoard`, `SystemCore.NotificationWidgetBase`,
`ProjectArco.NotificationSystem`, `ProjectArco.ProblemIndicatorWidget` — то есть готового
механизма уведомлений. Агент без индекса построит самодельный UMG-оверлей поверх игры,
который будет выглядеть чужеродно и ломаться при смене разрешения.

**Задача MCP: сделать первую ошибку невозможной, а вторую — маловероятной.**

---

## 3. Критерий приёмки

Агент с нуля, без правок человеком, создаёт мод **Research Notifier**: если активное
исследование не выбрано, в HUD справа появляется уведомление-подсказка.

Мод выбран потому, что задействует все подсистемы сервера сразу:

| Что проверяется | Через что |
|---|---|
| Рефлексия и точность сигнатур | найти `UnlockResearchComponent.GetResearchTopic() -> FName` |
| Понимание семантики игры | понять, что «нет активного исследования» = `NAME_None` из `GetResearchTopic` |
| Обнаружение родных подсистем | найти `NotificationBoard` / `ProblemIndicatorWidget` вместо самодельного оверлея |
| DataTable как справочник | взять текст из `TechUnlocksV2` / `ProblemIndicatorMessages` |
| Локализация | резолвить ключ через `Loc_Ru`, а не хардкодить строку |
| Lua API | периодическая проверка состояния без утечки хуков |
| Bridge | убедиться в живой игре, что компонент найден и виджет создан |
| Валидация | все пути хуков сверены с индексом до запуска |

Дополнительный смоук-критерий на каждой фазе указан в §12.

---

## 4. Решения, принятые в интервью

| Решение | Выбор | Обоснование |
|---|---|---|
| Аудитория | только машина владельца | Нет установщика, нет автодетекта игры, пути через конфиг. Экономия ~30% работы |
| Границы записи | scaffold + validate + deploy | Агент и так умеет писать файлы. Ценность MCP — в скаффолде, валидации и деплое, не в «записать байты» |
| Runtime bridge | полный: eval + probe + console + log | Проверено: `io.open`/`io.lines`/`require` работают в UE4SS на этом стенде — файловый IPC без единой новой зависимости |
| Роль DataTable | только чтение | Моды через UE4SS — это Lua-хуки; подменить `.uasset` в паке ими нельзя. Баланс меняется пост-хуком на аксессор, а таблица нужна как справочник ключей и базовых чисел |
| Стек | Bun + TypeScript | Прямой перенос паттернов BannerlordSage. .NET нужен только как sidecar на этапе build |
| Пробел в типах | переснять дампы (фаза 0) | `dumps/CppSDK/SDK/` пуст — Dumper-7 упал. Без типов главная цель не достигается |
| Версионирование | профили + `diff_versions` | Early Access, частые патчи. После патча агент должен сам найти, что сломалось |
| Домены индекса | рефлексия + DataTable + локализация + AssetRegistry + Lua API + память | Выбраны все |
| Глубина валидации | AST + проверка в живой игре | Регекс пропускает динамику; статика пропускает BP-классы |
| Справочник Lua API | курируемый YAML в репо | Машиночитаемого описания UE4SS API не существует |
| Организация модов | монорепо `mods/<name>/` | См. §10 |
| Поверхность | 24 инструмента, сгруппированы | См. §9 |

---

## 5. Что переносится из BannerlordSage

### Берём

| Паттерн | Раздел ревью | Как применяем |
|---|---|---|
| Index-first retrieval | 2.1 | Дампы → SQLite один раз, не grep по 14 МБ на каждый вопрос |
| Полиглотный конвейер с sidecar | 2.2 | CUE4Parse (.NET) вызывается только на build; сервер в рантайме от .NET не зависит |
| Профили версий как first-class | 2.3 | `dist/games/whiskerwood-<ProjectVersion>/`, `profile.json` пишется последним как маркер готовности, `INDEX_SCHEMA_VERSION` в контракте |
| Fail-fast резолюция версии | 2.4 | Расхождение версии игры и профиля → жёсткая ошибка со списком, а не тихий фолбэк. Здесь это критичнее, чем в Bannerlord: неверный офсет в Lua — краш игры |
| Явный `GameContext` | 2.5 | Каждый инструмент принимает `ctx` первым аргументом; вложенный вызов не может уехать в другой профиль |
| Атомарная публикация staging→swap→trash | 2.6 | Профиль либо целый, либо отсутствует. Плюс `renameWithRetry` — тот же Windows, тот же антивирус |
| Инкрементальная сборка по fingerprint | 2.7 | size+mtime → md5 → пересборка. Дампы большие, пересобирать зря дорого |
| LRU-пулы соединений и файлов | 2.9 | 14 МБ дампа не переоткрывать на каждый вызов |
| Гибридный поиск FTS5 + взвешенный BM25 | 2.10 | Вес: имя символа ×8, путь ×4, пакет ×2, вид ×1 |
| Материализованные предметные проекции | 2.11 | `function_params`, `properties`, `datatable_rows` — плоские таблицы вместо джойнов на чтении |
| Токен-ориентированный плоский вывод | 2.12 | С исправлением дефекта, см. §11.1 |
| Descriptions как промпт | 2.14 | «Prefer X over Y», явный порядок вызовов, `readOnlyHint`/`openWorldHint` |
| Проектная память с soft-delete | 2.15 | Общая на игру, не на воркспейс — критично при монорепо и множестве модов |
| Ленивая переиндексация исходников мода | 2.16 | Lua-файлы меняются сотни раз за сессию |
| Песочница путей | 2.17 | С исправлением: `realpath` + посегментное сравнение + регистронезависимость на Windows |

### Берём с исправлением найденных в ревью дефектов

| Дефект в оригинале | Раздел | Что делаем |
|---|---|---|
| Нет юнит-тестов на чистые функции | 4.3 | `bun test` с первой фазы: парсер дампа, `compareVersions`, `buildFtsQuery`, `PathSandbox`, рендер вывода, экранирование |
| `db.query<any, any>` в read path | 4.7 | Row-типы объявляются рядом со схемой и экспортируются; `SELECT *` запрещён |
| Глобальный синглтон `server` на импорте | 4.8 | `createServer(config)`; синглтон только в `stdio.ts`. Открывает интеграционные тесты через `InMemoryTransport` |
| Ручная синхронизация FTS памяти | 2.15 | FTS5 external-content + триггеры `AFTER INSERT/UPDATE/DELETE` |
| Нет миграций схемы | 4.9 | Аддитивные изменения через `ALTER TABLE` + минорная версия схемы. Полный ресет дорог не по времени, а по ручным действиям: требует запущенной игры для переснятия дампов |
| Формат вывода без экранирования | 2.12 | Явные блочные маркеры для многострочных значений, см. §11.1 |
| Гейтинг работает вхолостую | 4.2 | Гейтинга не будет вообще: 24 инструмента, сгруппированы по смыслу |
| **Pull-based инвалидация не переносится дёшево** | 2.8 | В BannerlordSage `Version.xml` лежал на диске — «прочитать маленький файл перед каждым запросом» стоило ничего. Здесь `ProjectVersion` находится **внутри пака на 4 ГБ**, а `exe_sha256` считается по файлу на 157 МБ; ни то, ни другое нельзя делать на каждый вызов. Заменяем на двухуровневый fingerprint, см. §8.2 |

### Не берём

| Паттерн | Почему |
|---|---|
| `outputSchema` / `structuredContent` (реком. 4.1) | Рекомендация ревью правильна для сервера с программными потребителями. Здесь потребитель ровно один — ИИ-агент. Дублирование ответа в JSON удвоило бы токены ради клиента, которого нет. **Пересмотреть, если появится не-LLM потребитель** |
| MCP Resources (4.4) | `ResourceTemplates` полезны, когда человек выбирает файл в UI. Здесь человека в цикле нет |
| Streamable HTTP (4.6) | Сервер привязан к локальной установке игры и к локальному IPC с процессом игры. Удалённый доступ бессмысленен |
| Стратегия `GameProfile` с 9 методами (2.18) | В оригинале работает вхолостую при одной игре. Здесь игра тоже одна, а detect-логика тривиальна (путь из конфига) |
| Тяжёлый AST-сайдкар уровня Roslyn (2.2) | C# нет. Lua парсится `luaparse` — чистый JS, без нативных зависимостей |

### Добавляем сверх BannerlordSage

| Механизм | Зачем |
|---|---|
| **Runtime bridge** | Lua не компилируется. Единственный способ отличить рабочий мод от правдоподобного — запустить |
| **MCP Prompts** (4.4 признана верной) | Воркфлоу «новый мод» и «мод сломался после патча» — как slash-команды в протоколе, а не в `AGENTS.md`, который клиент может не прочитать |
| **Детект коллизий хуков** | Два мода на одну UFunction UE4SS сцепляет молча. Harmony хотя бы упорядочивает патчи |
| **`diff_versions`** | Bannerlord патчится раз в месяцы, Whiskerwood в EA — часто |

---

## 6. Источники данных

| # | Источник | Что даёт | Чем читаем | Статус |
|---|---|---|---|---|
| 1 | `UE4SS_ObjectDump.txt` (57,6 МБ, in-level) | 308 319 строк с адресом: 15 664 `Function`, 5523 `ScriptStruct`, 4455 `Class`, 835 BP-классов, 108 687 свойств. **Полные `/Script/`- и `/Game/`-пути** и **конкретные типы свойств** через теги `[pc:]`/`[ss:]`/`[ai:]`. **Членов енумов не содержит** | свой построчный парсер, грамматика §14.1 | **фаза 0, снят и проверен** |
| 1a | `GObjects-Dump-WithProperties.txt` (14,4 МБ, меню, Dumper-7) | 80 502 объекта, 859 BP-классов. Второй снимок для union по BP-классам. `/Game`-путей и типов не содержит | парсер старой грамматики §14.1 | есть, проверен |
| 2 | `Whiskerwood-5.6.0-0+UE5-a1e7f571.usmap` (2,4 МБ) | **Типы** свойств (включая вложенные, ссылки на структуры и енумы), **иерархию классов** (`superIndex`), **1834 енума с именами и значениями членов**. 10 874 схемы — больше, чем `Class`+`ScriptStruct` в дампе (9978), т.к. включает BP-типы | CUE4Parse sidecar (или свой парсер, §6.3) | есть, **разобран при подготовке спеки** |
| 3 | UHT-совместимые заголовки | Конкретные типы параметров функций, `out`/`const` квалификаторы | `GenerateUHTCompatibleHeaders()` | **фаза 0, проверено**: типы/`const`/родители да, `out` — через не-const ссылки; вывод в `ue4ss/UHTHeaderDump/` |
| 4 | `Content/Data/**.uasset` (122 таблицы) | Весь баланс: рецепты, техи, политики, сезоны, тюнинг | CUE4Parse + usmap → JSON | есть в паке |
| 5 | `Data/TextDB/Loc_*` (18 языков × ~2296 ключей) | Ключ → текст | там же | есть в паке |
| 6 | `Whiskerwood/AssetRegistry.bin` | 13 241 путь ассетов. **Обязателен в фазе 1**, а не в фазе 3: без него не построить хуковые пути BP-классов (§6.2) | свой парсер `FNameBatch` | есть в паке |
| 7 | `Whiskerwood/Config/DefaultGame.ini` | `ProjectVersion=0.6.190.0` — **ключ профиля** | `wwpak.py` | **проверено при подготовке спеки** |
| 8 | exec-команды из exe | 19 команд `Arco_*` для тестирования модов | список в §5 входного документа | есть |
| 9 | Пути исходников из `check()` в exe | 111 путей, архитектурная карта | список в §1 входного документа | есть |
| 10 | Курируемый `lua-api.yaml` | Сигнатуры UE4SS Lua API, примеры, грабли | пишется вручную | нет |

### 6.1. Пробел в типах параметров

Дамп даёт **имя и вид** параметра, но не конкретный тип:

```
[00004EF1] {0x7ff485118910} Function ProjectArco.ArcoGameInstance.GetRecipesWithOutput
[00000000] {0x29a4234e880}     ObjectProperty Context
[00000008] {0x29a42352ee0}     NameProperty outputResource
[00000010] {0x29a4234e900}     ArrayProperty ReturnValue      ← массив ЧЕГО?
```

`dumps/CppSDK/SDK/` пуст — Dumper-7 упал на середине генерации (зафиксировано в §9
входного документа). Поэтому канонический источник типов определяется в фазе 0 по цепочке
фолбэков:

1. **`UE4SS_ObjectDump.txt`** — теги `[pc:]`/`[ss:]`/`[ai:]` дают конкретные типы свойств и параметров, включая BP. Проверено в фазе 0. Квалификаторов `out`/`const` не даёт.
2. **`GenerateUHTCompatibleHeaders()`** через UE4SS — типы, квалификаторы и родители, **только для нативных модулей**. Проверено в фазе 0: работает.
3. **`.usmap`** — закрывает типы **свойств** классов и структур, **иерархию классов** и **члены енумов**, но **не содержит UFunction**. Гарантированно работает: файл снят и разобран.
4. **Bridge** — `probe` резолвит тип структуры в живой игре по фактическому объекту.
5. **Явный `unknown`** — если тип неизвестен, индекс возвращает `type_name: unknown` и `type_source: none`. Никаких догадок.

Каждая строка `function_params` несёт поле `type_source` (`objdump` / `uht` / `usmap` / `runtime` / `none`),
и агент видит, насколько можно доверять сигнатуре.

**Что именно закрывает каждый источник** (без этого разделения цепочка фолбэков вводит в заблуждение):

| Сущность | Дамп | `.usmap` | UHT | Bridge |
|---|---|---|---|---|
| Список классов, структур, функций | **да** | да (10 874 схемы) | только нативные | — |
| Типы **свойств** классов и структур | **да** (`[pc:]`/`[ss:]`/`[ai:]`) | **да** | только нативные | да |
| Иерархия классов (`super`) | **да** (`[sps:]`) | **да** | только нативные | да |
| **Члены енумов** (имя + значение) | **нет** | **да (1834 енума)** | да | да |
| **Типы параметров UFunction** | **да** (`[pc:]`/`[ss:]`/`[ai:]`) | **нет** | только нативные | частично |
| `out` / `const` у параметров | нет | нет | **да, только нативные** | нет |
| `/Game`-путь BP-класса для `hook_path` | **да** | нет | нет | да |

**Уточнено в фазе 0.** Новый формат `UE4SS_ObjectDump.txt` резолвит тип свойства и
параметра по адресу из тегов `[pc:]` (класс `ObjectProperty`), `[ss:]` (структура
`StructProperty`), `[ai:]` (inner `ArrayProperty`) через карту адрес→путь из того же файла.
Пример выше разрешается: `ai:` ведёт на `NameProperty` → `TArray<FName>`.

UHT, в свою очередь, покрывает **только нативные типы** — по логу прогона
`4454 native classes / 5462 native structs / 1796 native enums`, ни одного BP.
Для 4055 BP-функций дамп остаётся **единственным** источником типов параметров, поэтому
`type_source` получает значение `objdump` (§7.2); ставить им `none` при фактически
известном типе — врать в консервативную сторону на блюпринтовой половине игры.

Практический вывод: провал UHT понижает точность только по `out`/`const` у нативных
параметров. Типы свойств, типы параметров и иерархия закрыты дампом и `.usmap` безусловно.

### 6.2. Хуковые пути BP-классов

Игровая логика в значительной части блюпринтовая: `Content/Code` — 479 BP, `Content/UI` — 844.
В дампе они есть (в меню-снимке 437 + 420 = 857 классов и 4055 BP-функций;
в in-level снимке 428 + 407 = 835), но **в рефлекшн-форме**:

```
[00007E2E] {0x29a64fd13c0} WidgetBlueprintGeneratedClass MouseMessageBlip.MouseMessageBlip_C
[00007E32] {0x29a6538c900} Function MouseMessageBlip.MouseMessageBlip_C.Construct
```

`RegisterHook` для BP требует **полный ассетный путь**:
`/Game/UI/.../MouseMessageBlip.MouseMessageBlip_C:Construct`.

**Пересмотрено в фазе 0.** Приведённый выше пример — из дампа Dumper-7, где строка `/Game`
встречается ноль раз. В новом `UE4SS_ObjectDump.txt` она встречается 153 980 раз, и
BP-классы идут уже в хуковой форме:

```
[00000255E7F61BA0] WidgetBlueprintGeneratedClass /Game/UI/DebugUI_Components/MouseMessageBlip.MouseMessageBlip_C ...
[00000255EBA83900] Function /Game/UI/DebugUI_Components/MouseMessageBlip.MouseMessageBlip_C:Construct ...
```

`hook_path` для BP строится **прямо из дампа**, без джойна. `AssetRegistry.bin` остаётся
в фазе 1, но в другой роли: он даёт знаменатель для `coverage_bp_ratio` (13 241 ассет
против 835 классов, загруженных на момент снимка) и перекрёстную проверку путей. Джойн
через `bp_classes` — фолбэк для классов, чей путь в дампе не полон или неоднозначен.

Правила нормализации и таблица `bp_classes` — в §7.1 и §9.1.

### 6.3. Дамп — снимок памяти, а не статический артефакт

Хвост файла — `MainMenuBackdrop.MainMenuBackdrop.PersistentLevel.*`: дамп снят **в главном
меню**. Всё, что подгружается только на игровом уровне (стримящиеся классы, часть квестовых
акторов), в нём отсутствует, и `ww_verify_hook` даст `not_found` для существующих функций.

Отсюда два обязательных требования, которых не было в первой редакции:

1. **Переснять дамп из загруженного игрового уровня**, а не из меню. `AutoDump` расширяется
   хуком на `LoadMap`/`InitGameState` с задержкой, а не фиксированным `ExecuteWithDelay` от старта.
2. **Проверка покрытия** как шаг сборки: список BP-ассетов из `AssetRegistry` сверяется
   с проиндексированными `_C`-классами; доля несовпадения пишется в
   `profile_meta.coverage_bp_ratio` и отдаётся в `ww_index_status`. Низкое покрытие —
   не ошибка сборки, а явное предупреждение агенту.

`.usmap`, в отличие от дампа, снимается из реестра типов, а не из живых объектов, и
включает BP-типы (`Including Blueprint-generated types in mappings` в логе) — 10 874 схемы
против 9978 `Class`+`ScriptStruct` в дампе. Для иерархии и свойств он полнее.

---

## 7. Схема данных

Два файла БД. Индекс — read-only, версионируется вместе с профилем. Память — writable,
общая на игру, переживает пересборку индекса.

### 7.1. Политика фильтрации объектов

Индексировать дамп целиком нельзя. Из 80 502 объектов рефлексн-ядро — **33 870**; остальные
46 632 это живые инстансы уровня, компоненты и слоты виджетов. В дампе **5308 различных
`kind`**, потому что `kind` объекта — это имя его класса: `HorizontalBoxSlot` (2162 шт.),
`StaticMeshComponent` (5835), `SCS_Node` (7536), `AudioComponent` с путями вида
`MainMenuBackdrop.PersistentLevel.X.AudioComponent_2147481673`. Отдельно — **6117 CDO**
(`Default__*`). Ни то, ни другое хукать нельзя, а в FTS они утопят полезные символы.

**Правило приёма в `objects`:**

```
indexable(kind, name) =
      kind ∈ {Package, Class, ScriptStruct, Enum, Function}
   OR kind LIKE '%BlueprintGeneratedClass'        -- Blueprint|WidgetBlueprint|AnimBlueprint...
  AND NOT name LIKE 'Default__%'                  -- CDO
```

Всё остальное в индекс не попадает. Счётчики `objects_total`, `objects_indexed`,
`objects_skipped_by_kind` пишутся в `profile_meta` и отдаются `ww_index_status` — политика
должна быть видимой, а не молчаливой.

CDO содержат **значения свойств по умолчанию** и потенциально полезны, но для v1 это не
нужно: базовые числа берутся из DataTable. Явно вне скоупа (§15).

### 7.2. Индекс: `dist/games/whiskerwood-<version>/index.db`

```sql
PRAGMA journal_mode = WAL;

-- ── Профиль и происхождение ───────────────────────────────────────────
CREATE TABLE profile_meta (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);
-- schema_version, game_version, engine_version, exe_sha256, exe_size,
-- dump_sha256, usmap_sha256, built_at, ue4ss_version, type_source_primary,
-- dump_captured_at ('main_menu' | 'in_level'), coverage_bp_ratio,
-- objects_total, objects_indexed, objects_skipped_by_kind

-- ── Рефлексия ─────────────────────────────────────────────────────────
CREATE TABLE objects (
  path          TEXT PRIMARY KEY,          -- ProjectArco.ArcoGameInstance  (индексная форма)
  kind          TEXT NOT NULL,             -- Class|ScriptStruct|Enum|Function|Package|*BlueprintGeneratedClass
  package       TEXT NOT NULL,             -- ProjectArco
  outer_path    TEXT,                      -- для Function: путь класса
  name          TEXT NOT NULL,             -- ArcoGameInstance
  dump_index    INTEGER,                   -- [00004EF1]
  super_path    TEXT,                      -- из .usmap, NULL если неизвестен
  is_blueprint  INTEGER NOT NULL DEFAULT 0,
  -- Готовый путь для RegisterHook/StaticFindObject. Собирается индексатором,
  -- НИКОГДА не собирается агентом. NULL = построить нельзя (см. hook_path_status).
  hook_path     TEXT,
  hook_path_status TEXT NOT NULL DEFAULT 'ok'  -- ok|bp_asset_unresolved|bp_asset_ambiguous
);
CREATE INDEX objects_kind_idx    ON objects(kind);
CREATE INDEX objects_package_idx ON objects(package, kind);
CREATE INDEX objects_outer_idx   ON objects(outer_path);
CREATE INDEX objects_name_idx    ON objects(name COLLATE NOCASE);
CREATE INDEX objects_super_idx   ON objects(super_path);
CREATE INDEX objects_hook_idx    ON objects(hook_path);

-- Джойн «BP-класс из дампа → ассетный путь из AssetRegistry».
-- После фазы 0: hook_path берётся из дампа напрямую (§6.2), таблица нужна для
-- coverage_bp_ratio и как фолбэк при неполном/неоднозначном пути.
CREATE TABLE bp_classes (
  path          TEXT PRIMARY KEY,          -- MouseMessageBlip.MouseMessageBlip_C
  package       TEXT NOT NULL,             -- MouseMessageBlip
  kind          TEXT NOT NULL,             -- BlueprintGeneratedClass|WidgetBlueprintGeneratedClass
  asset_path    TEXT,                      -- /Game/UI/Blips/MouseMessageBlip
  object_path   TEXT,                      -- /Game/UI/Blips/MouseMessageBlip.MouseMessageBlip_C
  resolution    TEXT NOT NULL,             -- ok|not_found|ambiguous
  candidates    TEXT                       -- при ambiguous: пути-кандидаты через '\n'
);
CREATE INDEX bp_classes_asset_idx ON bp_classes(asset_path);

CREATE TABLE properties (
  owner_path    TEXT NOT NULL,
  ordinal       INTEGER NOT NULL,
  offset        INTEGER NOT NULL,
  prop_kind     TEXT NOT NULL,             -- ObjectProperty|StructProperty|...
  name          TEXT NOT NULL,
  type_name     TEXT,                      -- FIndustryRecipe / UUnlockResearchComponent
  inner_type    TEXT,                      -- для Array/Map/Set
  type_source   TEXT NOT NULL,             -- objdump|uht|usmap|runtime|none
  PRIMARY KEY (owner_path, ordinal)
);
CREATE INDEX properties_name_idx ON properties(name COLLATE NOCASE);
CREATE INDEX properties_type_idx ON properties(type_name);

CREATE TABLE function_params (
  function_path TEXT NOT NULL,
  ordinal       INTEGER NOT NULL,
  offset        INTEGER NOT NULL,
  prop_kind     TEXT NOT NULL,
  name          TEXT NOT NULL,
  type_name     TEXT,
  inner_type    TEXT,
  type_source   TEXT NOT NULL,             -- objdump|uht|usmap|runtime|none
  is_return     INTEGER NOT NULL DEFAULT 0,
  is_out        INTEGER NOT NULL DEFAULT 0, -- достоверно только при type_source='uht';
                                            -- для BP-функций всегда 0: источника нет
  PRIMARY KEY (function_path, ordinal)
);

-- Источник — ТОЛЬКО .usmap (1834 енума). В дампе членов енумов нет вообще.
CREATE TABLE enum_values (
  enum_path     TEXT NOT NULL,             -- имя из .usmap, сматченное с objects.path
  ordinal       INTEGER NOT NULL,
  name          TEXT NOT NULL,             -- Info
  value         INTEGER NOT NULL,          -- 0   (usmap v4 хранит значения явно)
  PRIMARY KEY (enum_path, ordinal)
);

-- ── Данные игры ───────────────────────────────────────────────────────
CREATE TABLE datatables (
  name          TEXT PRIMARY KEY,          -- TechUnlocksV2
  asset_path    TEXT NOT NULL,             -- /Game/Data/AssetLookups/TechUnlocksV2
  row_struct    TEXT,                      -- FTechUnlockRow
  row_count     INTEGER NOT NULL,
  -- Добавлено в фазе 3: в Content/Data лежат не только DataTable.
  -- datatable | loc (строки уходят в loc_entries) | data_asset (не DataTable, напр. ArcoGameTunes)
  kind          TEXT NOT NULL DEFAULT 'datatable'
);
CREATE TABLE datatable_rows (
  table_name    TEXT NOT NULL,
  row_name      TEXT NOT NULL,
  row_json      TEXT NOT NULL,
  PRIMARY KEY (table_name, row_name)
);
CREATE INDEX datatable_rows_name_idx ON datatable_rows(row_name COLLATE NOCASE);

CREATE TABLE loc_entries (
  key           TEXT NOT NULL,
  lang          TEXT NOT NULL,             -- En|Ru|De|...
  text          TEXT NOT NULL,
  PRIMARY KEY (key, lang)
);
CREATE INDEX loc_lang_idx ON loc_entries(lang);

CREATE TABLE assets (
  asset_path    TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  class_name    TEXT,
  in_pak        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX assets_name_idx  ON assets(name COLLATE NOCASE);
CREATE INDEX assets_class_idx ON assets(class_name);

-- ── Знание об инструментарии ──────────────────────────────────────────
CREATE TABLE lua_api (
  symbol        TEXT PRIMARY KEY,          -- RegisterHook
  signature     TEXT NOT NULL,
  category      TEXT NOT NULL,             -- hooks|search|threading|ui|dump
  summary       TEXT NOT NULL,
  example       TEXT,
  pitfalls      TEXT,
  status        TEXT NOT NULL              -- ok|broken_on_5_6|unverified
);
CREATE TABLE exec_commands (
  name          TEXT PRIMARY KEY,          -- Arco_GiveResource
  args          TEXT,
  summary       TEXT
);
CREATE TABLE source_paths (
  path          TEXT PRIMARY KEY,          -- Source/ProjectArco/JobSystem.cpp
  module        TEXT NOT NULL
);

-- ── Полнотекстовый поиск ──────────────────────────────────────────────
-- ВАЖНО: external-content, а не content=''. Из contentless-таблицы FTS5 нельзя
-- прочитать значения колонок и нельзя вызвать snippet() — только rowid, чего для
-- сборки ответа ww_find_symbol недостаточно.
CREATE TABLE objects_fts_src (                -- rowid-носитель для external-content
  rowid   INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  path    TEXT NOT NULL,
  package TEXT NOT NULL,
  kind    TEXT NOT NULL
);
CREATE VIRTUAL TABLE symbols_fts USING fts5(
  name, path, package, kind,
  content='objects_fts_src', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
-- запрос: bm25(symbols_fts, 8.0, 4.0, 2.0, 1.0)
-- наполнение: INSERT в objects_fts_src + INSERT INTO symbols_fts(rowid, ...) в одной
-- транзакции индексатора; индекс read-only, поэтому триггеры здесь не нужны
-- (в отличие от writable памяти в §7.3, где они обязательны).

CREATE VIRTUAL TABLE loc_fts USING fts5(
  key, text, content='loc_entries', content_rowid='rowid'
);
```

### 7.3. Память: `dist/games/whiskerwood-memory.db`

Схема BannerlordSage без изменений по смыслу, с исправлением дефекта ручной синхронизации
FTS (раздел 2.15 ревью) — external-content с триггерами:

```sql
CREATE TABLE project_memories (
  id                  INTEGER PRIMARY KEY,
  public_id           TEXT NOT NULL UNIQUE,
  category            TEXT NOT NULL,       -- decision|pitfall|preference|todo|note
  summary             TEXT NOT NULL,
  body                TEXT NOT NULL,
  tags                TEXT NOT NULL DEFAULT '',
  mod_name            TEXT,                -- к какому моду относится, NULL = общее
  importance          INTEGER NOT NULL DEFAULT 3,
  status              TEXT NOT NULL DEFAULT 'active',
  invalidation_reason TEXT,
  invalidated_at      TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE VIRTUAL TABLE project_memories_fts USING fts5(
  public_id, category, summary, body, tags, mod_name,
  content='project_memories', content_rowid='id'
);
CREATE TRIGGER pm_ai AFTER INSERT ON project_memories BEGIN
  INSERT INTO project_memories_fts(rowid, public_id, category, summary, body, tags, mod_name)
  VALUES (new.id, new.public_id, new.category, new.summary, new.body, new.tags, new.mod_name);
END;
CREATE TRIGGER pm_ad AFTER DELETE ON project_memories BEGIN
  INSERT INTO project_memories_fts(project_memories_fts, rowid, public_id, category, summary, body, tags, mod_name)
  VALUES ('delete', old.id, old.public_id, old.category, old.summary, old.body, old.tags, old.mod_name);
END;
CREATE TRIGGER pm_au AFTER UPDATE ON project_memories BEGIN
  INSERT INTO project_memories_fts(project_memories_fts, rowid, public_id, category, summary, body, tags, mod_name)
  VALUES ('delete', old.id, old.public_id, old.category, old.summary, old.body, old.tags, old.mod_name);
  INSERT INTO project_memories_fts(rowid, public_id, category, summary, body, tags, mod_name)
  VALUES (new.id, new.public_id, new.category, new.summary, new.body, new.tags, new.mod_name);
END;
```

Ранжирование: `bm25(project_memories_fts, 0.2, 1.0, 2.0, 1.0, 1.0, 0.5)`,
затем `ORDER BY rank ASC, importance DESC, updated_at DESC`.

Поле `mod_name` — добавление относительно оригинала. При монорепо память должна уметь
отвечать и «что мы решали вообще», и «что мы решали в этом моде».

---

## 8. Раскладка репозиториев

```
WhiskerWood_MCP/                       ← сервер (этот репозиторий)
├── src/
│   ├── stdio.ts                       ← единственный синглтон
│   ├── server.ts                      ← createServer(config), без побочных эффектов импорта
│   ├── tools/                         ← по инструменту на файл
│   ├── utils/
│   │   ├── game-context.ts            ← GameContext
│   │   ├── game-registry.ts           ← профили, резолюция версии, fail-fast
│   │   ├── profile-publish.ts         ← staging → swap → trash
│   │   ├── runtime-revision.ts        ← pull-based инвалидация
│   │   ├── db.ts                      ← LRU-пул read-only соединений
│   │   ├── path-sandbox.ts            ← с realpath и посегментной проверкой
│   │   ├── ai-text.ts                 ← формат вывода
│   │   ├── bridge-client.ts           ← IPC с игрой
│   │   └── lua-analyzer.ts            ← luaparse + сверка с индексом
│   └── scripts/
│       ├── setup.ts                   ← оркестратор build-контура
│       ├── index-reflection.ts        ← дамп + usmap + UHT → SQLite
│       ├── index-gamedata.ts          ← DataTable + Loc + AssetRegistry
│       └── verify-*.ts
├── sidecar/WwParse/                   ← .NET 8 + CUE4Parse, вызывается только на build
├── data/lua-api.yaml                  ← курируемый справочник
├── bridge/WWBridge/                   ← Lua-мод, деплоится в ue4ss/Mods
├── wwmcp.config.json                  ← конфигурация, §8.1
├── state/                             ← НЕ версионируется, НЕ в git
│   ├── game-fingerprint.json          ← кэш дешёвой проверки версии, §8.2
│   └── bridge/                        ← IPC с игрой, §11.2
├── dist/games/whiskerwood-0.6.190.0/  ← опубликованный профиль
└── thoughts/shared/specs/             ← этот документ

WhiskerWood_Mods/                      ← монорепо модов (отдельный репозиторий)
├── CLAUDE.md
├── .mcp.json
├── lib/                               ← общий Lua: log, serialize, safe-hook
└── mods/
    ├── research-notifier/
    │   ├── mod.json                   ← имя, версия, описание, целевая версия игры
    │   └── Scripts/main.lua
    └── production-tuner/
```

### 8.1. Конфигурация сервера

Всё, что зависит от машины, живёт в одном файле. Резолюция: переменная `WWMCP_CONFIG` →
`./wwmcp.config.json` → **жёсткая ошибка с готовым шаблоном**, а не догадки о путях.

```jsonc
{
  "gameDir":   "D:/Steam/steamapps/common/Whiskerwood",
  // Ниже — выводимые из gameDir значения; задаются явно только при нестандартной раскладке
  "exePath":   "{gameDir}/Whiskerwood/Binaries/Win64/Whiskerwood-Win64-Shipping.exe",
  "pakPath":   "{gameDir}/Whiskerwood/Content/Paks/Whiskerwood-Windows.pak",
  "ue4ssDir":  "{gameDir}/Whiskerwood/Binaries/Win64/ue4ss",

  "stateDir":  "./state",                    // fingerprint + bridge IPC
  "distDir":   "./dist/games",               // профили
  "dumpsDir":  "./dumps",                    // вход сборки

  "modsRepo":  "D:/Whiskerwood_IO/WhiskerWood_Mods",

  "sandboxRoots": ["{modsRepo}", "{stateDir}", "{distDir}"],  // куда разрешена запись
  "extractRoot":  "{stateDir}/extracted",                     // потолок для ww_extract_asset
  "defaultLangs": ["En", "Ru"],
  "bridgePollMs": 120,
  "bridgeTimeoutMs": 5000
}
```

Проверка на старте: каждый путь существует и читается; `ue4ssDir/UE4SS.log` доступен;
`sandboxRoots` резолвятся через `realpath`. Любой промах — ошибка при запуске сервера
с указанием конкретного ключа, а не при первом вызове инструмента.

Отдельно: `ww_extract_asset` — **единственный инструмент, пишущий за пределы `modsRepo`**.
Его `dest_dir` обязан лежать внутри `extractRoot`; произвольный путь отвергается.

### 8.2. Дешёвая проверка свежести профиля

В BannerlordSage `Version.xml` лежал на диске, и «прочитать маленький файл перед каждым
запросом» (ревью 2.8) стоило ничего. Здесь дешёвого маркера нет: `ProjectVersion` находится
внутри пака на 4 ГБ, `exe_sha256` считается по файлу на 157 МБ. Читать их на каждый вызов
нельзя, а отказаться от проверки — значит вернуть тихий фолбэк, ради устранения которого
и берётся паттерн 2.4.

Двухуровневая схема:

```
state/game-fingerprint.json
{ "exeSize": 157757440, "exeMtimeMs": ..., "pakSize": 4018677232, "pakMtimeMs": ...,
  "projectVersion": "0.6.190.0", "exeSha256": "...", "computedAt": "..." }
```

| Уровень | Когда | Стоимость |
|---|---|---|
| 1. `statSync` по exe и паку, сверка size+mtime с кэшем | **на каждый вызов инструмента** | два системных вызова |
| 2. Чтение `ProjectVersion` из пака + sha256 exe, перезапись кэша | только когда уровень 1 разошёлся | секунды, раз в патч |

Расхождение `projectVersion` с `profile_meta.game_version` → fail-fast с инструкцией из §12
(фаза 0), а не тихое чтение устаревшего индекса.

---

## 9. Каталог инструментов

24 инструмента, семь групп. Все принимают необязательный `version`; ответ всегда эхом
несёт `game_version` и `index_revision`.

### 9.1. Формы путей и правила нормализации

Единственная причина, по которой это вынесено в отдельный подраздел: **агент не должен
собирать путь хука сам ни при каких условиях.** Сервер отдаёт готовый `hook_path`, агент
копирует. Формы различаются, и ошибка на любом стыке даёт молча неработающий мод.

| Форма | Пример | Где применяется |
|---|---|---|
| Индексная (из дампа) | `SystemCore.UnlockResearchComponent.SetResearchTopic` | `objects.path`, ключ внутри БД |
| Хуковая, нативная | `/Script/SystemCore.UnlockResearchComponent:SetResearchTopic` | `RegisterHook` |
| Объектная, нативная | `/Script/SystemCore.UnlockResearchComponent` | `StaticFindObject` |
| Хуковая, BP | `/Game/UI/Blips/MouseMessageBlip.MouseMessageBlip_C:Construct` | `RegisterHook` |
| Объектная, BP | `/Game/UI/Blips/MouseMessageBlip.MouseMessageBlip_C` | `StaticFindObject` |

Преобразования, выполняемые **индексатором** при сборке `objects.hook_path`:

```
нативный класс     Pkg.Class            → /Script/Pkg.Class
нативная функция   Pkg.Class.Func       → /Script/Pkg.Class:Func
BP-класс           Asset.Asset_C        → <bp_classes.asset_path>.Asset_C
BP-функция         Asset.Asset_C.Func   → <bp_classes.asset_path>.Asset_C:Func
```

Разделитель перед именем функции — **двоеточие**, а не точка. Джойн `asset_path` берётся
из `bp_classes` (§7.2) по имени пакета; при `resolution != 'ok'` поле `hook_path`
остаётся `NULL`, а `hook_path_status` объясняет причину. Молча подставлять точку вместо
двоеточия или угадывать `/Game`-путь запрещено.

### 9.2. Рефлексия — 5

| Инструмент | Сигнатура | Назначение |
|---|---|---|
| `ww_find_symbol` | `(pattern, kind?, package?, limit?)` | Первый вызов при незнании точного имени. FTS5+BM25 по именам классов, функций, структур, енумов, exec-команд |
| `ww_search_members` | `(pattern, member_kind?, limit?)` | Обратный поиск: «какой класс содержит поле/метод с таким именем». Закрывает сценарий «знаю что ищу, не знаю где» |
| `ww_get_type` | `(path)` | Class / ScriptStruct / Enum: поля с офсетами и типами, родитель, список методов, наследники |
| `ww_get_function` | `(path)` | Точная сигнатура: параметры по порядку, типы, `type_source`, что возвращает. **Всегда отдаёт готовый `hook_path`** — агент не собирает его сам |
| `ww_verify_hook` | `(paths[], live?)` | **Ключевой.** Батч-проверка. Принимает путь в любой из форм §9.1, нормализует и сверяет. `live: true` дополнительно пробивает через bridge |

`ww_verify_hook` принимает массив, а не строку, намеренно: агент проверяет все пути мода
одним вызовом перед записью файла, а не по одному после каждой строки.

**Состояния ответа.** Двух состояний (`found`/`not_found`) недостаточно: `not_found` для
незагруженного BP-класса означает совсем не то же, что `not_found` для опечатки, и агент,
получив одинаковый ответ, начнёт «чинить» работающий код.

| Статус | Значение | Что делать агенту |
|---|---|---|
| `found` | Есть в индексе; `hook_path` приложен | Использовать |
| `found_hook_path_unavailable` | Символ есть, но ассетный путь BP не разрезолвился (`bp_asset_unresolved` / `ambiguous`) | Не хукать; спросить через `live`-probe или разрешить неоднозначность вручную |
| `not_found` | Нет ни в индексе, ни (при `live`) в игре | Реальная ошибка. Приложен список похожих **как подсказка** |
| `not_found_possibly_not_loaded` | Нет в индексе, но это BP-путь, а дамп снят вне уровня (`dump_captured_at != 'in_level'`) либо `live`-probe выполнен до загрузки уровня | **Не считать ошибкой.** Перепроверить `live` при загруженном уровне |

Похожие имена всегда идут отдельным полем `suggestions:` после `status:` — подставлять их
вместо найденного запрещено (§8 входного документа).

### 9.3. Данные игры — 4

| Инструмент | Сигнатура | Назначение |
|---|---|---|
| `ww_get_datatable` | `(name?, row?, row_pattern?, limit?)` | Без аргументов — список таблиц. С `name` — строки. С `row_pattern` — поиск ключа по всем таблицам |
| `ww_resolve_loc` | `(key_or_pattern, lang?)` | Ключ → текст. `lang` по умолчанию `En,Ru` |
| `ww_find_asset` | `(pattern, class?, limit?)` | Поиск по 13 241 пути AssetRegistry |
| `ww_extract_asset` | `(asset_path, dest_dir)` | Достать файл из пака (порт `wwpak.py`) |

### 9.4. Знание об инструментарии — 1

| Инструмент | Сигнатура | Назначение |
|---|---|---|
| `ww_lua_api` | `(symbol?, category?)` | Сигнатуры UE4SS Lua API с примерами и граблями. Без аргументов — оглавление по категориям |

### 9.5. Авторинг — 4

| Инструмент | Сигнатура | Назначение |
|---|---|---|
| `ww_scaffold_mod` | `(mod_root, name, template)` | Структура мода, `mod.json`, `Scripts/main.lua` из шаблона, ссылка на `lib/`. Шаблоны: `hook`, `ui`, `keybind`, `diagnostic` |
| `ww_generate_hook` | `(function_path, kind)` | Готовый скелет хука с **реальной** сигнатурой из индекса и правильной распаковкой параметров. Аналог `generate_harmony_patch` |
| `ww_validate_mod` | `(mod_root, live?)` | AST-анализ + сверка с индексом + детект коллизий + линт граблей. См. §11.3 |
| `ww_deploy_mod` | `(mod_root, mode)` | `mode: "dev"` — зарегистрировать в bridge для `dofile` прямо из `mod_root`. `mode: "release"` — junction/копия в `ue4ss/Mods/<Name>` + запись в `mods.txt` |

### 9.6. Runtime bridge — 4

| Инструмент | Сигнатура | Назначение |
|---|---|---|
| `ww_game_status` | `()` | Запущена ли игра, жив ли bridge, загружен ли уровень, аптайм, последняя ошибка |
| `ww_game_eval` | `(lua, timeout_ms?)` | Выполнить чанк в игровом потоке, вернуть сериализованный результат |
| `ww_game_console` | `(command)` | exec-команда игры или UE-консоли: `Arco_GiveResource`, `Arco_UnlockAll`, `stat fps` |
| `ww_game_log` | `(since?, level?, mod?, limit?)` | Разобранный `UE4SS.log`: только строки после метки, только ошибки, только конкретного мода |

### 9.7. Профили — 2

| Инструмент | Сигнатура | Назначение |
|---|---|---|
| `ww_index_status` | `()` | Версия игры и профиля, свежесть по fingerprint (§8.2), `type_source_primary`, `dump_captured_at`, `coverage_bp_ratio`, счётчики фильтрации. При устаревании — **готовая пошаговая инструкция для человека**, а не просто флаг |
| `ww_diff_versions` | `(from, to, kind?)` | Что исчезло / добавилось / сменило сигнатуру между версиями игры |

### 9.8. Память — 4

`ww_memory_wakeup()`, `ww_memory_search(query, mod_name?, category?)`,
`ww_memory_add(entries[], mod_name?)` (батч, как `capture_session` в оригинале),
`ww_memory_invalidate(public_id, reason)`.

### 9.9. MCP Prompts — 2

| Prompt | Что делает |
|---|---|
| `ww:new-mod` | `memory_wakeup` → уточнить цель → `find_symbol`/`get_function` → `verify_hook` → `scaffold_mod` → написать → `validate_mod` → `deploy_mod dev` → `game_eval` → `memory_add` |
| `ww:fix-after-patch` | `index_status` → **если профиль устарел: остановиться и передать управление человеку** → после пересборки `diff_versions` → `validate_mod` по всем модам → починка сломанных путей |

Перенос дисциплины в протокол вместо `AGENTS.md` — реализация рекомендации 4.4 ревью.

**Про передачу управления в `ww:fix-after-patch`.** Пересборка профиля — это BUILD-контур:
она требует запущенной игры, снятия дампов и запуска `bun run setup`. Среди 24 инструментов
триггера сборки нет и **не будет**: MCP-сервер не должен уметь запускать игру и перезаписывать
собственный индекс под собой во время работы. Поэтому промпт обязан явно останавливаться и
выдавать человеку последовательность:

```
1. Запустить игру с включённым AutoDump (mods.txt: AutoDump : 1)
2. Загрузить сохранение и дождаться в UE4SS.log строк
   "DumpUSMAP done ok=true" и "UHT headers done"        ← дамп из уровня, а не из меню (§6.3)
3. Выйти из игры
4. bun run setup
5. Вернуться в эту сессию и повторить ww:fix-after-patch
```

Без этого агент будет пытаться сделать невозможное и зациклится на `index_status`.

---

## 10. Организация модов: почему монорепо

В Bannerlord репозиторий на мод оправдан: мод — это C#-проект с `.csproj`, ссылками на
сборки и шагом компиляции; изоляция навязана самим тулчейном. В Whiskerwood ни одного из
этих оснований нет.

| | Bannerlord | Whiskerwood |
|---|---|---|
| Единица мода | C#-проект, компиляция в DLL | папка с `Scripts/main.lua` |
| Типичный объём | сотни-тысячи строк | 50–400 строк |
| Менеджер зависимостей | NuGet, ссылки на сборки | нет; только `package.path` + `require` из `Mods/shared` |
| Дистрибуция | Workshop / Nexus как Module | zip вручную; через UE4SS в Workshop не попасть (§9 входного документа) |
| Конфликт двух модов на одну цель | Harmony упорядочивает патчи | два `RegisterHook` сцепляются молча |

Отсюда два довода за монорепо, специфичных именно для этой игры:

**Детект коллизий хуков.** Все моды бьют по одному набору UFunction. В одном дереве
`ww_validate_mod` видит, что `research-notifier` и `production-tuner` оба вешают post-hook
на `GetIndustryRecipe`, и предупреждает. Через границу репозиториев это невидимо, а UE4SS
о конфликте не сообщит.

**Рабочие примеры как контекст.** Готовый мод под текущую версию игры — самый ценный
материал для агента, ценнее любой документации. Проектная память хранит решения, но не
работающий код. В монорепо перекрёстные примеры бесплатны.

**Обратимость.** `git log -- mods/<name>/` даёт историю одного мода; теги неймспейсятся
(`research-notifier/v1.2.0`); `git subtree split -P mods/<name> -b split/<name>` выделяет
ветку с историей только этого мода, готовую к пушу в отдельный репозиторий. Монорепо →
отдельные репо разворачивается одной командой; обратная сборка N репозиториев мучительна.
Это решение с меньшим сожалением.

**Архитектурное следствие.** Все авторинг-инструменты принимают `mod_root` — каталог
конкретного мода, а не корень репозитория. С точки зрения сервера монорепо и репо-на-мод
неотличимы, и организацию git можно поменять, не трогая сервер.

---

## 11. Три механизма, которых нет в оригинале

### 11.1. Формат вывода

Плоский текст в стиле `ai-text`, с исправлением дефекта отсутствия экранирования
(отмечен в ревью 2.12). Многострочные значения выносятся в явный блок:

```
report_type: function_signature
game_version: 0.6.190.0
index_revision: 3f2a1c
result_count: 1

[result_1]
path: SystemCore.UnlockResearchComponent.GetResearchTopic
class: SystemCore.UnlockResearchComponent
param_count: 0
returns: NameProperty
returns_type: FName
type_source: usmap
<<<example
local comp = FindFirstOf("UnlockResearchComponent")
local topic = comp:GetResearchTopic()
example>>>
```

Скаляр с переносом строки — ошибка рендерера, а не молчаливая порча вывода: рендерер
проверяет и бросает. Правило покрывается юнит-тестом.

Жёсткие лимиты как в оригинале: `MAX_RESULTS = 200`, `LIMIT 10` для FTS, обрезка длинных
тел. Явные поля `truncated`, `total_found`, `limit`. Отдельно — **явный `not_found`**: при
отсутствии символа сервер пишет `status: not_found` и лишь затем `suggestions:`, никогда
не выдавая похожее за найденное. Это прямое требование §8 входного документа.

### 11.2. Runtime bridge

**Транспорт.** Файловый IPC с атомарной подменой через `rename`. Обоснование: проверено,
что в UE4SS на этом стенде работают `io.open`, `io.lines`, `package.path`, `require` —
их используют штатные бандл-моды (`BPModLoaderMod`, `ConsoleCommandsMod`). Сокеты не нужны,
новых зависимостей ноль.

**Почему не UE4SS hot-reload.** Штатный hot-reload висит на хоткее внутри игры и снаружи
недёргаем. Bridge решает это иначе: он постоянный тонкий мод, а код разрабатываемого мода
он загружает по запросу через `dofile` абсолютного пути в `mod_root`. Игровая установка
почти не трогается, а цикл правки замыкается полностью.

**Раскладка.**

```
state/bridge/
├── bridge.status          ← heartbeat: session, tick, ts, busy
├── in/<reqid>.req         ← MCP: запись во временный + rename
├── in/queue               ← список готовых id (см. «Очередь»)
├── in/queue.work          ← атомарно перехваченная копия, читает только bridge
└── out/<reqid>.res        ← bridge: запись во временный + rename
```

**Формат.** Без JSON — в Lua его нет из коробки, а вендорить парсер ради этого незачем:

```
id=7f3a
op=eval
timeout_ms=5000
--payload--
local c = FindFirstOf("UnlockResearchComponent")
return c and c:GetResearchTopic():ToString() or "<none>"
```

```
id=7f3a
session=a41f9c
ok=true
elapsed_ms=12
--result--
tech_sawmill
```

**Очередь.** Стандартный Lua не умеет листать каталоги, а на `io.popen` в шиппинг-процессе
полагаться нельзя, поэтому список запросов передаётся файлом. Наивная схема «один id в
`in/index` на вызов» теряет запросы: два параллельных tool-call'а — нормальная ситуация для
MCP-клиента — и второй файл затирает первый, а первый висит до таймаута. Плюс гонка на
стороне Lua: между чтением и `os.remove` сервер может дописать новый id, который будет
удалён непрочитанным.

Обе проблемы закрываются двумя правилами:

1. **Сериализация на клиенте.** Запись `in/queue` идёт под мьютексом (цепочка промисов);
   id **дописывается** к содержимому, а не заменяет его. Порядок неизменен: сначала
   `in/<id>.req`, только потом `in/queue` — bridge не может увидеть id без тела.
2. **Атомарный перехват на bridge.** Вместо «прочитать и удалить» — `os.rename(queue → queue.work)`.
   Всё, что сервер запишет после переименования, попадёт в новый `queue` и будет
   обработано на следующем тике; потерять уже записанное невозможно.

**Сессия.** `bridge.status` несёт `session` — случайный идентификатор, генерируемый при
старте моста. При старте bridge **подчищает `in/` и `out/`** от файлов прошлой сессии:
иначе запрос, записанный в момент падения игры, будет честно исполнен при следующем запуске
— в другой сессии, без ведома клиента. Клиент запоминает `session` на момент отправки; если
в ответе или в статусе она изменилась, результат отбрасывается со статусом `session_changed`,
а не принимается за свой.

**Потоки и heartbeat.** Опрос построен на рекурсивном `ExecuteWithDelay(120, poll)` — именно
этот примитив подтверждён рабочим на стенде модом `AutoDump`. Работа с UObject обёрнута в
`ExecuteInGameThread`.

Отсюда следствие, которое нельзя игнорировать: **`poll` и исполнение чанка идут в одном
потоке**, поэтому долгий `eval` (например, обход 80 тыс. объектов) останавливает запись
`bridge.status`, и наивная проверка «статус старше 3 секунд → игра мертва» даст ложный
`game_not_running` — причём клиент оборвёт **собственный успешно идущий вызов**. Решение:
перед диспатчем bridge пишет в статус `busy=<reqid>`; клиент, ожидающий именно этот id,
не считает устаревание статуса признаком смерти. Для чужого id или при отсутствии `busy`
правило трёх секунд действует как раньше.

От чанка с бесконечным циклом файловый протокол не защищает в принципе — это подвесит игру.
Опциональный предохранитель: `debug.sethook` со счётчиком инструкций, прерывающий чанк по
лимиту. Включается конфигом, по умолчанию выключен, потому что сам по себе замедляет
исполнение.

**Уборка.** Клиент удаляет свой `.res` после чтения (это есть) и при старте сервера сметает
осиротевшие `.req`/`.res`. Bridge делает то же при старте сессии. Без этого каталог `out/`
растёт неограниченно после каждого таймаута.

**Деградация.** Инструменты bridge возвращают явный статус (`game_not_running`,
`session_changed`, `timeout`), а не висят и не падают. Read-контур от bridge не зависит
вообще: сервер полностью работоспособен при выключенной игре.

### 11.3. `ww_validate_mod`

Парсер: `luaparse` (чистый JS, без нативных зависимостей, синтаксис Lua 5.3).

| Проверка | Что ловит |
|---|---|
| Синтаксис | ошибка с точной строкой и колонкой |
| Литеральные аргументы `RegisterHook` / `WWRegisterHook` / `StaticFindObject` / `FindFirstOf` / `FindAllOf` / `NotifyOnNewObject` / `StaticConstructObject` | сверка каждого пути с индексом — **основная защита** |
| Форма пути | точка вместо двоеточия перед именем функции; `/Game`-путь, собранный вручную вместо взятого из `hook_path` (§9.1) |
| Арность коллбэка хука | `RegisterHook` отдаёт `(Context, ...params)`; сверка с сигнатурой из индекса |
| Динамическая сборка пути | `RegisterHook("/Script/" .. x)` — верифицировать нельзя, помечается явно как непроверенное, а не пропускается молча |
| Прямой `RegisterHook` в dev-цикле | мод, загружаемый через `load_mod`, обязан использовать `WWRegisterHook`, иначе хуки накапливаются при каждой перезагрузке (§14.2) |
| Коллизии | два мода в `mods/` на одну UFunction |
| Линт граблей | `Utf8String` (не поддержан на 5.6), `FindFirstOf` на этапе загрузки скрипта до появления объектов, мутация UObject вне `ExecuteInGameThread`, попытка «переноса здания» — нативной функции не существует |
| `live: true` | каждый путь дополнительно пробивается через bridge — ловит BP-классы и состояние, зависящее от загруженного уровня |

Грабли берутся из §9 входного документа и пополняются из проектной памяти: когда агент
через `ww_memory_add` записывает pitfall, он попадает в линт.

---

## 12. План реализации

Порядок выбран по отношению «отдача / трудозатраты». Обоснование — после таблицы фаз.

### Фаза 0 — Основание: закрыть пробел в типах

Без запущенной игры не делается, поэтому идёт первой.

- [x] Включить `AutoDump : 1`, расширить мод: `GenerateUHTCompatibleHeaders()`, `DumpAllObjects()`, `DumpUSMAP()` — каноническая копия `bridge/AutoDump/Scripts/main.lua`, прогон 2026-08-28
- [x] **Снимать дамп из загруженного игрового уровня, а не из главного меню** — пост-хуки `InitGameState`/`LoadMap` + задержка 60 с + повторная проверка мира; меню пропускается
- [x] Прогнать, зафиксировать результат и стабильность — один прогон, все дамперы `ok=true`, UHT 21 с без падения; лог `dumps/phase0-UE4SS.log`
- [x] Оценить, есть ли в UHT-заголовках конкретные типы параметров, `out`, `const` и родители классов — типы/const/родители да; `out` — через не-const ссылки (`UPARAM` не эмитируется); детали в `2026-08-28-phase0-results.md`
- [x] Через `wwpak.py` извлечь `Content/Data/**`, `Data/TextDB/Loc_*`, `AssetRegistry.bin`, `Config/Default*.ini` — `dumps/pak/`
- [x] **Решение и запись в `profile_meta.type_source_primary`:** `uht` (зафиксировано в `2026-08-28-phase0-results.md`; в БД запишется фазой 1)
- [x] Записать `dump_captured_at` = `in_level` | `main_menu` — `in_level`; плюс union со старым меню-дампом (835 BP-классов в уровне против 859 в меню)

**Готово, когда:** дамп снят из уровня, и либо есть артефакт с конкретными типами параметров
для `ProjectArco` и `SystemCore`, либо зафиксировано его отсутствие и активирована цепочка
фолбэков из §6.1. Архитектура рассчитана на оба исхода — провал UHT понижает точность только
по параметрам функций; свойства, иерархия и енумы закрыты `.usmap` безусловно.

**Статус 2026-08-28: завершена.** Дамп снят из `ArcoPlay`, UHT-артефакт есть
(`dumps/UHTHeaderDump/`, 22 063 заголовка) → `type_source_primary = uht`,
`dump_captured_at = in_level`. Подробности и грамматика нового формата дампа —
в `2026-08-28-phase0-results.md`.

### Фаза 1 — Read-ядро

- [x] `wwmcp.config.json` + валидация всех путей на старте (§8.1) — **первое, во что упирается фаза**
- [x] Каркас: `createServer(config)`, `GameContext`, `PathSandbox` (с `realpath`), `ai-text`
- [x] Реестр профилей: `profile.json` как маркер, `INDEX_SCHEMA_VERSION`, fail-fast резолюция, atomic publish
- [x] Двухуровневый fingerprint версии (§8.2): `ProjectVersion` из `DefaultGame.ini` (**проверено: `0.6.190.0`**) за кэшем `size+mtime` — читается из пака TS-портом `wwpak.py`
- [x] Парсер `UE4SS_ObjectDump.txt` (грамматика в §14.1, **включая безадресные inner-строки**) + **политика фильтрации** (§7.1)
- [x] Парсер `.usmap`: типы свойств, `super_path`, **1834 енума** (раскладка в §14.6; подтверждена по исходникам `USMapGenerator` UE4SS, включая расширение `PPTH`)
- [x] Резолв типов свойств и параметров по карте адрес→путь (`[pc:]`/`[ss:]`/`[ai:]`), `type_source = 'objdump'`
- [x] **Парсер `AssetRegistry.bin` и таблица `bp_classes`** — остаётся в фазе 1, но как знаменатель `coverage_bp_ratio` и перекрёстная проверка: `hook_path` для BP берётся из дампа напрямую (§6.2); формат реверс-инжинирен, 6 534 записи ассетов
- [x] Сборка `objects.hook_path` по правилам §9.1 + `hook_path_status`
- [x] Проверка покрытия: BP-ассеты из AssetRegistry против проиндексированных `_C` → `coverage_bp_ratio` (0.9988)
- [x] Слияние источников типов с проставлением `type_source` (uht → objdump → usmap → none)
- [x] `ww_find_symbol`, `ww_search_members`, `ww_get_type`, `ww_get_function`, `ww_verify_hook`, `ww_index_status`
- [ ] Юнит-тесты: парсер дампа, парсер usmap, нормализация путей, `compareVersions`, `buildFtsQuery`, `PathSandbox`, рендер вывода — **снято `CLAUDE.md` («не пишем тесты»)**; заменено смоком `src/scripts/smoke-client.ts`

**Готово, когда** выполняются оба условия:

1. `ww_verify_hook(["SystemCore.UnlockResearchComponent.startResearch", "SystemCore.UnlockResearchComponent.SetResearchTopic"])`
   возвращает `not_found` для первого и полную сигнатуру со `hook_path` для второго. Это
   буквальное воспроизведение §7 — ошибки, ради которой строится сервер.
2. `ww_get_function("MouseMessageBlip.MouseMessageBlip_C.Construct")` возвращает
   `hook_path: /Game/…/MouseMessageBlip.MouseMessageBlip_C:Construct` — то есть BP-джойн
   работает, а не просто объявлен.

**Статус 2026-08-29: завершена.** Оба приёмочных условия выполнены; детали, числа сборки
и реверс форматов — в `2026-08-29-phase1-results.md`.

### Фаза 2 — Runtime bridge

- [x] Lua-мод `WWBridge`: очередь через `rename(queue → queue.work)`, session-id, `busy`-статус, sweep прошлой сессии, реестр хуков `mod → hookIds` (скелет в §14.2) — `bridge/WWBridge/Scripts/main.lua`
- [x] `bridge-client.ts`: мьютекс на дозапись очереди, проверка сессии, busy-осведомлённое ожидание, `sweepOrphans` на старте (§14.3)
- [x] `ww_game_status`, `ww_game_eval`, `ww_game_console`, `ww_game_log`
- [x] Расширение `ww_verify_hook` параметром `live` и статусом `not_found_possibly_not_loaded`
- [x] Развёртывание моста: `bun run bridge:deploy` — junction в `ue4ss/Mods/WWBridge`, `config.lua`, строка в `mods.txt`
- [x] **Спайк 1:** поля `StructProperty` в параметрах хуков **читаются** — `:get()` даёт `UScriptStruct`, поля берутся по имени
- [x] **Спайк 2:** `ExecuteInGameThread` **асинхронный** → `OPS.eval` переделан на коллбэк-модель, как и предписано этим пунктом
- [x] **Спайк 3:** работает форма **с двоеточием**; записано в `profile_meta.hook_path_separator = colon`
- [x] **Спайк 4:** `StaticFindObject` **видит только загруженное** → live-негатив по BP-пути не окончателен; записано в `profile_meta.static_find_object_sees = loaded_only`

**Готово, когда** выполняются три условия:

1. `ww_game_eval("return #FindAllOf('UnlockResearchComponent')")` возвращает число из живой
   игры быстрее чем за 2 секунды.
2. `ww_game_status` при выключенной игре отвечает `game_not_running` мгновенно, без таймаута.
3. Два параллельных `ww_game_eval` оба возвращают свой результат, а `load_mod` трижды подряд
   даёт `hooks=N` с одинаковым `N`, а не растущим. Это регрессия на баги очереди и накопления
   хуков — без неё они всплывут в фазе 4 как «мод срабатывает трижды».

**Статус 2026-08-29: фаза завершена, все три условия выполнены на живой игре.**
Условие 1: `ww_game_eval("return #FindAllOf('Actor')")` → `6497` за 248 мс (пример из условия
использует `UnlockResearchComponent`, у которого на этом сохранении нет инстансов, а `FindAllOf`
при нуле совпадений возвращает `nil`). Условие 2: `game_not_running` мгновенно, без таймаута.
Условие 3: 20 параллельных `eval` — все корректны; `load_mod` трижды подряд → `hooks=2`,
`unload_mod` снимает ровно 2. Детали — в `2026-08-29-phase2-results.md`.

### Фаза 3 — Данные игры

- [x] Sidecar `WwParse` на **.NET 10** + CUE4Parse `1.2.2.202608`: `.uasset` + `.usmap` → JSONL — `sidecar/WwParse/`; net8.0 отпал, пакет CUE4Parse собран только под net10.0
- [x] Индексация DataTable и `Loc_*` — **59 таблиц** (из 61 `.uasset` в `Content/Data`), 19 из них `Loc_*`; 1779 строк данных + **39 009 записей локализации**. AssetRegistry уже проиндексирован в фазе 1
- [x] Порт `wwpak.py` на TypeScript для `ww_extract_asset` + ограничение `dest_dir` пределами `extractRoot` (§8.1) — `PakReader` из фазы 1 + `PathSandbox([extractRoot])`, статус `dest_dir_rejected`
- [x] `ww_get_datatable`, `ww_resolve_loc`, `ww_find_asset`, `ww_extract_asset`

**Готово, когда:** `ww_get_datatable("TechUnlocksV2")` отдаёт строки с реальными ключами,
а `ww_resolve_loc("mod.desc.starvation", "Ru")` — русский текст.

**Статус 2026-08-29: завершена.** Оба условия выполнены: `TechUnlocksV2` — 174 строки
(`unlock.lumbermill` со `associatedGridActor: lumbermill`, `childUnlocks: [unlock.industry]`),
`mod.desc.starvation` [Ru] → «Скоро умрет без еды!». Детали, отклонения от спеки и разбор
двух не-DataTable ассетов — в `2026-08-29-phase3-results.md`.

### Фаза 4 — Авторинг и приёмка

- [x] Наполнить `data/lua-api.yaml` (~40 символов UE4SS API + грабли из §9) — **50 записей**,
  14 категорий, поле `verified` (stand/doc/upstream) и `status` (ok/caution/broken/absent);
  читается сервером на лету по mtime, а не запекается в профиль версии
- [x] `lua-analyzer.ts` на `luaparse` — плюс разрешение алиасов
  (`local register = WWRegisterHook or RegisterHook`) и обёрток `lib/ww/obj.lua`, без чего
  рекомендуемая же идиома выводила все хуки из-под проверки
- [x] `ww_scaffold_mod`, `ww_generate_hook`, `ww_validate_mod`, `ww_deploy_mod` — плюс
  `ww_lua_api` из §9.4; всего в сервере 19 инструментов
- [x] Монорепо `WhiskerWood_Mods`: `CLAUDE.md`, `.mcp.json`, `lib/ww/{log,obj,poll}.lua`
- [x] MCP Prompts `ww:new-mod`, `ww:fix-after-patch`

**Готово, когда:** агент с нуля собирает Research Notifier из §3 — без правок человеком,
с прохождением `ww_validate_mod` и подтверждением работы через bridge.

**Статус 2026-08-29: инструменты готовы и проверены на живой игре, приёмка НЕ закрыта.**

Закрыто: мод `mods/research-notifier` собран целиком через инструменты сервера
(`find_symbol` → `get_type` → `get_function` → `resolve_loc` → `verify_hook` →
`scaffold_mod` → `generate_hook`), проходит `ww_validate_mod` с нулём ошибок и
предупреждений, разворачивается в запущенную игру через `ww_deploy_mod mode=dev`
(`hooks=1`, три перезагрузки подряд без накопления) и корректно читает живое состояние:
`ProjectArco.ArcoSystems.GetResearchInfo().ResearchState.activeResearch = None` при двух
активных лабораториях — совпало с фактическим состоянием игры.

Не закрыто: **уведомления в HUD нет**. Родная подсистема `SystemCore.NotificationBoard`
принимает элемент (`PushItem` со структурой из Lua-таблицы работает, кириллица проходит
round-trip), но в 0.6.190.0 её никто не разбирает: хуки на `PushItem`,
`RetrievePendingItem` и `HasPendingItem` дают ноль вызовов со стороны игры, живых
`NotificationWidgetBase` нет. Мод сообщает о состоянии только в лог. До появления рабочего
канала показа критерий §3 не выполнен.

Побочно: `SystemCore.UnlockResearchComponent`, на который опиралась первая версия мода,
в сессии не инстанцируется вовсе — только CDO. Это ловится исключительно мостом и является
самой наглядной иллюстрацией §12 «фаза 2 раньше данных». Детали, включая краш игры от
`ForEachUObject`, — в `2026-08-29-phase4-results.md`.

### Фаза 5 — Долговременная эксплуатация

- [ ] Память: 4 инструмента, FTS5 external-content с триггерами
- [ ] `ww_diff_versions`
- [ ] Прогон полного цикла на следующем патче игры

**Готово, когда:** после реального патча Whiskerwood `ww:fix-after-patch` находит сломанные
пути в существующих модах.

### Почему такой порядок

Фаза 0 первая **только потому, что требует запущенной игры** и определяет точность всего
остального; отложить её — значит переиндексировать позже.

Фаза 1 даёт основную ценность — защиту от §7 — при наименьших затратах. `AssetRegistry.bin`
и `bp_classes` остаются в ней, но после фазы 0 роль изменилась: `/Game`-путь для
`hook_path` даёт сам дамп (§6.2), а AssetRegistry нужен ради `coverage_bp_ratio` — без него
агент не узнаёт, что «не найдено» может означать «ассет не был загружен на момент снимка».
Отдать это в фазу 3 значило бы три фазы подряд молча смешивать два разных «not_found»
по блюпринтовой половине игры.

Фаза 2 идёт **раньше данных**, вопреки интуиции. Две причины: bridge является фолбэком для
типов из фазы 0, то есть повышает качество уже построенного индекса; и он превращает
разработку всех последующих фаз в проверяемую — включая проверку самих гипотез о том, как
устроен игровой UI.

Фаза 3 тяжёлая (сайдкар на .NET) и после переноса AssetRegistry в фазу 1 ничего не блокирует:
для хуков нужен индекс рефлексии, а не таблицы баланса.

Фаза 4 зависит от всех предыдущих и заканчивается приёмкой.

---

## 13. Риски

| Риск | Вероятность | Влияние | Реакция |
|---|---|---|---|
| **BP-ассет не резолвится в `/Game`-путь** (неоднозначное имя, ассет вне AssetRegistry) | **низкая после фазы 0** — дамп несёт `/Game`-путь сам (§6.2) | **высокое** | `hook_path_status` + статус `found_hook_path_unavailable` (§9.2). Доля нерезолвленных — метрика приёмки фазы 1, а не скрытая деталь |
| `ExecuteWithDelay` исполняет коллбэк отложенно, а не в игровом потоке синхронно | средняя | **высокое** | Спайк 2 фазы 2. При подтверждении `OPS.eval` переделывается на коллбэк-модель: чанк отдаёт результат через callback, а не через `return` |
| UE4SS на 5.6 плохо работает со `StructProperty` в параметрах хуков | **высокая** | **высокое** | Спайк 1 фазы 2 до написания приёмочного мода. Если подтвердится — мод строится на скалярных сигнатурах (`GetResearchTopic() -> FName` как раз такая) |
| `GenerateUHTCompatibleHeaders()` падает как Dumper-7 | средняя | **низкое** (пересмотрено) | Влияет только на типы параметров функций. Свойства, иерархия и енумы закрыты `.usmap` безусловно (§6.1) |
| Дамп снят вне уровня и неполон | **подтверждено для текущего дампа** | среднее | Переснятие из уровня в фазе 0 + `coverage_bp_ratio` + статус `not_found_possibly_not_loaded` |
| `Utf8String` не поддержан (§9 входного документа) | подтверждено | среднее | Линт в `ww_validate_mod`; локализация резолвится на сервере, в Lua уходит готовая строка |
| Патч игры инвалидирует дампы | высокая | среднее | Профили + двухуровневый fingerprint (§8.2) + `ww:fix-after-patch` с явной передачей управления человеку |
| Долгий `eval` выглядит как смерть игры | средняя | среднее | `busy=<reqid>` в heartbeat; клиент не обрывает собственный идущий вызов (§11.2) |
| Чанк с бесконечным циклом подвешивает игру | низкая | **высокое** | Файловый протокол от этого не защищает. Опциональный `debug.sethook` со счётчиком инструкций; по умолчанию выключен |
| CUE4Parse расходится с конкретной 5.6.x | низкая | низкое | Версия sidecar пинуется; `.usmap` снят с самой игры и разбирается своим парсером (§14.6), CUE4Parse нужен только для DataTable |
| Junction/symlink на Windows требует прав | низкая | низкое | `mode: "dev"` через `dofile` вообще не требует деплоя; `release` — junction, при отказе копия |

Снят из списка: «`NotificationBoard` управляется блюпринтом» — проверено, все пять
классов приёмочного мода нативные (§16).

---

## 14. Скелеты кода

### 14.1. Грамматика дампа и парсер

Форматов два. Основной — `UE4SS_ObjectDump.txt` (фаза 0, in-level), по нему пишется парсер.
Старый Dumper-7 разбирается вторым парсером только ради union по BP-классам (§6, источник 1a).

#### Основной формат: плоский, связи по адресу

Каждая строка самостоятельна, вложенности нет. Связь член→владелец — через `[owr:]`,
объект→outer — через `[or:]`:

```
[00007FF3F0890070] Class /Script/CoreUObject.Object [n: 20B] [c: ...] [or: 00007FF3F0ABDA38] [sps: 0000000000000000]
[00007FF3F0F18910] Function /Script/ProjectArco.ArcoGameInstance:GetRecipesWithOutput [n: 7252C] [c: ...] [or: 00007FF3F09D75C0] [f: ...]
[00000255C7CFF880] ArrayProperty /Script/ProjectArco.ArcoGameInstance:GetRecipesWithOutput:ReturnValue [o: 10] [n: ...] [c: ...] [owr: 00007FF3F0F18910] [ai: 00000255C7CE4920]
[00000255C7CE4920] NameProperty ReturnValue./Script/ProjectArco.ArcoGameInstance:GetRecipesWithOutput:ReturnValue [o: 0] [n: ...] [c: ...] [owr: 00000255C7CFF880]
```

| Тег | Значение |
|---|---|
| `[o:]` | офсет свойства |
| `[or:]` | адрес outer-объекта |
| `[sps:]` | адрес super-класса |
| `[owr:]` | адрес владельца члена |
| `[pc:]` | адрес класса у `ObjectProperty` |
| `[ss:]` | адрес структуры у `StructProperty` |
| `[ai:]` | адрес inner-типа у `ArrayProperty` — **отдельная строка** |
| `[fm:]` / `[bm:]` | маска `BoolProperty` |

Разбор в два прохода: первый строит карту `адрес → путь`, второй резолвит `[pc:]`/`[ss:]`/
`[ai:]`/`[sps:]` в конкретные типы. Так закрываются типы свойств и параметров, включая
BP-функции, — `type_source = 'objdump'` (§7.2).

**Ловушка: 120 inner-строк идут без адресного префикса.** Все — `DoubleProperty`:

```
[00000255C77DFD80] ArrayProperty /Script/Landscape.LandscapeComponent:MipToMipMaxDeltas [o: 608] ... [ai: 00000255C77B9930]
DoubleProperty MipToMipMaxDeltas./Script/Landscape.LandscapeComponent:MipToMipMaxDeltas
```

Строгий regex такую строку не уронит — **молча пропустит**, и `[ai:]` повиснет на адрес,
которого нет в карте, а тип массива станет `unknown` без единой ошибки в логе. Парсер обязан
принимать обе формы, а нерезолвленные `[ai:]`/`[pc:]`/`[ss:]` **считать и писать счётчик
в `profile_meta`**, а не глотать.

Вторая ловушка того же места: имя inner-строки имеет вид `<PropName>.<полный путь владельца>`,
то есть точка внутри — не разделитель пути. Наивный `split('.')` даёт мусорный `package`.

#### Старый формат Dumper-7 (только для union)

Объект — без отступа, член — с отступом ровно в 4 пробела, принадлежит последнему объекту.
`/Game`-путей и конкретных типов не содержит:

```
[00004EF1] {0x7ff485118910} Function ProjectArco.ArcoGameInstance.GetRecipesWithOutput
[00000000] {0x29a4234e880}     ObjectProperty Context
[00000008] {0x29a42352ee0}     NameProperty outputResource
[00000010] {0x29a4234e900}     ArrayProperty ReturnValue
```

```ts
// src/scripts/parse-gobjects.ts
const OBJECT_RE = /^\[([0-9A-F]{8})\] \{(0x[0-9a-f]+)\} (\w+) (.+)$/
const MEMBER_RE = /^\[([0-9A-F]{8})\] \{(0x[0-9a-f]+)\}     (\w+) (.+)$/

export type DumpMember = {
  offset: number; propKind: string; name: string; ordinal: number
}
export type DumpObject = {
  dumpIndex: number; addr: string; kind: string
  path: string; package: string; name: string; outerPath: string | null
  members: DumpMember[]
}

export function* parseGObjectsDump(lines: Iterable<string>): Generator<DumpObject> {
  let current: DumpObject | null = null
  for (const line of lines) {
    const m = MEMBER_RE.exec(line)
    if (m && current) {
      current.members.push({
        offset: parseInt(m[1], 16), propKind: m[3], name: m[4],
        ordinal: current.members.length,
      })
      continue
    }
    const o = OBJECT_RE.exec(line)
    if (!o) continue                      // шапка дампа и пустые строки
    if (current) yield current
    const path = o[4]
    const firstDot = path.indexOf('.')
    const lastDot = path.lastIndexOf('.')
    current = {
      dumpIndex: parseInt(o[1], 16), addr: o[2], kind: o[3], path,
      package: firstDot === -1 ? path : path.slice(0, firstDot),
      name: path.slice(lastDot + 1),
      outerPath: lastDot === -1 ? null : path.slice(0, lastDot),
      members: [],
    }
  }
  if (current) yield current
}
```

Для `kind === 'Function'` члены — параметры в порядке объявления; параметр с именем
`ReturnValue` помечается `is_return`. Отличить `out`-параметр от входного по дампу
невозможно (`GetMealDefForResource_outParam` несёт `outDef` и `ReturnValue` без пометок) —
достоверный `is_out` появляется только при `type_source = 'uht'`, то есть **только для
нативных функций**: `UPARAM(out)` генератор не эмитирует, признаком служит параметр-ссылка
`T&` без `const`. Для BP-функций источника нет, `is_out` остаётся 0.

### 14.2. Bridge — Lua

```lua
-- bridge/WWBridge/Scripts/main.lua
local CFG_PATH = debug.getinfo(1, "S").source:sub(2):gsub("main%.lua$", "config.lua")
local cfg = dofile(CFG_PATH)            -- { root = "D:/.../state/bridge", poll_ms = 120 }

local IN, OUT = cfg.root .. "/in", cfg.root .. "/out"
local STATUS  = cfg.root .. "/bridge.status"
local QUEUE, QUEUE_WORK = IN .. "/queue", IN .. "/queue.work"

math.randomseed(os.time())
local SESSION = string.format("%06x", math.random(0, 0xffffff))
local tick, busy = 0, ""
local hookRegistry = {}                 -- modPath -> { {path, preId, postId}, ... }

local function writeAtomic(path, text)
    local tmp = path .. ".tmp"
    local f = io.open(tmp, "wb"); if not f then return false end
    f:write(text); f:close()
    os.remove(path)                     -- Windows: rename поверх существующего не проходит
    return os.rename(tmp, path)
end

-- Плоская сериализация: тот же формат, что у сервера, без JSON
local function serialize(v, depth, out)
    depth, out = depth or 0, out or {}
    if depth > 4 then out[#out+1] = "<max_depth>"; return out end
    local t = type(v)
    if t == "userdata" and v.IsValid and v:IsValid() then
        out[#out+1] = string.rep("  ", depth) .. v:GetFullName()
    elseif t == "table" then
        for k, sub in pairs(v) do
            out[#out+1] = string.rep("  ", depth) .. tostring(k) .. ":"
            serialize(sub, depth + 1, out)
        end
    else
        out[#out+1] = string.rep("  ", depth) .. tostring(v)
    end
    return out
end

local function parseRequest(text)
    local head, payload = text:match("^(.-)\n%-%-payload%-%-\n(.*)$")
    head = head or text
    local req = { payload = payload or "" }
    for k, val in head:gmatch("(%w+)=([^\n]*)") do req[k] = val end
    return req
end

local OPS = {}

function OPS.eval(req)
    local chunk, err = load(req.payload, "@wwbridge_eval")
    if not chunk then return false, "compile_error: " .. tostring(err) end
    local packed
    local ok, e = pcall(function()
        ExecuteInGameThread(function() packed = table.pack(pcall(chunk)) end)
    end)
    if not ok then return false, tostring(e) end
    if not packed then return false, "no_result: game thread did not run" end
    if not packed[1] then return false, tostring(packed[2]) end
    return true, table.concat(serialize(packed[2]), "\n")
end

-- Пробивает и объекты, и функции. Хуковая форма использует ':' перед именем функции,
-- объектная — '.', поэтому принимать путь «как есть» нельзя: для существующей нативной
-- функции это дало бы not_found. Пробуем обе формы и сообщаем, какая сработала —
-- ответ на открытый вопрос §16 п.4 фиксируется первым же прогоном.
function OPS.probe(req)
    local lines = {}
    for line in req.payload:gmatch("[^\n]+") do
        local classPart, funcPart = line:match("^(.-):([%w_]+)$")
        local found, via = false, "none"
        ExecuteInGameThread(function()
            if funcPart then
                local direct = StaticFindObject(line)                  -- '/Pkg.Class:Func'
                if direct and direct:IsValid() then found, via = true, "colon"
                else
                    local dotted = StaticFindObject(classPart .. "." .. funcPart)
                    if dotted and dotted:IsValid() then found, via = true, "dot"
                    else
                        local cls = StaticFindObject(classPart)        -- класс есть, функции нет
                        via = (cls and cls:IsValid()) and "class_only" or "no_class"
                    end
                end
            else
                local obj = StaticFindObject(line)
                if obj and obj:IsValid() then found, via = true, "object" end
            end
        end)
        lines[#lines+1] = string.format("%s = %s via=%s", line,
            found and "found" or "not_found", via)
    end
    return true, table.concat(lines, "\n")
end

function OPS.console(req)
    local pc = UEHelpers and UEHelpers.GetPlayerController()
    if not pc or not pc:IsValid() then return false, "no_player_controller" end
    ExecuteInGameThread(function() pc:ConsoleCommand(req.payload, true) end)
    return true, "sent"
end

-- Заменяет недоступный снаружи hot-reload. Снимает хуки предыдущей загрузки,
-- иначе каждый повторный dofile регистрирует коллбэки ПОВЕРХ старых и после трёх
-- итераций правки уведомление срабатывает трижды — агент получает искажённую
-- обратную связь от самого инструмента, созданного ради её точности.
function OPS.load_mod(req)
    local modPath = req.payload
    for _, h in ipairs(hookRegistry[modPath] or {}) do
        pcall(UnregisterHook, h.path, h.preId, h.postId)
    end
    hookRegistry[modPath] = {}

    -- require из lib/ кэшируется в package.loaded; без сброса правки в общей
    -- библиотеке не подхватятся
    for name in pairs(package.loaded) do
        if name:match("^ww%.") then package.loaded[name] = nil end
    end

    -- Мод регистрирует хуки через эту обёртку, а не напрямую
    _G.WWRegisterHook = function(path, pre, post)
        local preId, postId = RegisterHook(path, pre, post)
        table.insert(hookRegistry[modPath], {path = path, preId = preId, postId = postId})
        return preId, postId
    end

    local ok, err = pcall(dofile, modPath)
    _G.WWRegisterHook = nil
    return ok, ok and ("loaded, hooks=" .. #hookRegistry[modPath]) or tostring(err)
end

local function handleOne(id)
    local f = io.open(IN .. "/" .. id .. ".req", "rb")
    if not f then return end
    local req = parseRequest(f:read("a")); f:close()

    busy = id                            -- клиент, ждущий именно этот id, не сочтёт
    writeAtomic(STATUS, string.format(   -- застывший heartbeat признаком смерти игры
        "session=%s\ntick=%d\nts=%d\nbusy=%s\n", SESSION, tick, os.time(), busy))

    local t0 = os.clock()
    local handler = OPS[req.op or ""]
    local ok, body
    if handler then ok, body = handler(req)
    else ok, body = false, "unknown_op: " .. tostring(req.op) end

    writeAtomic(OUT .. "/" .. id .. ".res", string.format(
        "id=%s\nsession=%s\nok=%s\nelapsed_ms=%d\n--result--\n%s",
        id, SESSION, tostring(ok), math.floor((os.clock() - t0) * 1000), body))
    os.remove(IN .. "/" .. id .. ".req")
    busy = ""
end

local function poll()
    tick = tick + 1
    writeAtomic(STATUS, string.format(
        "session=%s\ntick=%d\nts=%d\nbusy=%s\n", SESSION, tick, os.time(), busy))

    -- Атомарный перехват: всё, что сервер допишет после rename, попадёт в новый
    -- queue и обработается следующим тиком. Читать-и-удалять здесь нельзя — потеряем.
    if os.rename(QUEUE, QUEUE_WORK) then
        local q = io.open(QUEUE_WORK, "r")
        if q then
            for id in q:lines() do
                if id ~= "" then handleOne(id) end
            end
            q:close()
        end
        os.remove(QUEUE_WORK)
    end
    ExecuteWithDelay(cfg.poll_ms, poll)
end

-- Файлы прошлой сессии исполнять нельзя: они относятся к другому запуску игры
-- и другому состоянию мира. Сервер их уже не ждёт.
local function sweepPreviousSession()
    os.remove(QUEUE); os.remove(QUEUE_WORK)
    -- каталог не листается: сервер при старте сам сметает осиротевшие .req/.res
end

sweepPreviousSession()
print(string.format("[WWBridge] started session=%s root=%s\n", SESSION, cfg.root))
ExecuteWithDelay(1000, poll)
```

Мод, загружаемый через `load_mod`, обязан вешать хуки через `WWRegisterHook`, а не через
`RegisterHook`. Это проверяет `ww_validate_mod` (§11.3): прямой `RegisterHook` в файле,
предназначенном для dev-цикла, — предупреждение с указанием строки.

### 14.3. Bridge — клиент на стороне сервера

```ts
// src/utils/bridge-client.ts
import { randomBytes } from 'node:crypto'
import {
  appendFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'

const HEARTBEAT_STALE_MS = 3000

export type BridgeResult =
  | { status: 'ok'; body: string; elapsedMs: number }
  | { status: 'error'; body: string }
  | { status: 'game_not_running' }
  | { status: 'session_changed' }
  | { status: 'timeout'; waitedMs: number }

type Status = { session: string; ts: number; busy: string; freshMs: number }

export class BridgeClient {
  /** Сериализует дозапись в in/queue: два параллельных tool-call'а иначе теряют запрос. */
  private queueLock: Promise<void> = Promise.resolve()

  constructor(private readonly root: string) {}

  readStatus(): Status | null {
    const p = `${this.root}/bridge.status`
    if (!existsSync(p)) return null
    const t = readFileSync(p, 'utf8')
    return {
      session: /^session=(\w*)$/m.exec(t)?.[1] ?? '',
      ts: Number(/^ts=(\d+)$/m.exec(t)?.[1] ?? 0),
      busy: /^busy=(\w*)$/m.exec(t)?.[1] ?? '',
      freshMs: Date.now() - statSync(p).mtimeMs,
    }
  }

  async call(op: string, payload: string, timeoutMs = 5000): Promise<BridgeResult> {
    const start = this.readStatus()
    if (!start || start.freshMs >= HEARTBEAT_STALE_MS) return { status: 'game_not_running' }
    const session = start.session
    const id = randomBytes(4).toString('hex')
    const req = `id=${id}\nop=${op}\ntimeout_ms=${timeoutMs}\n--payload--\n${payload}`

    // Порядок обязателен: тело раньше очереди — bridge не увидит id без .req.
    // Дозапись в queue под мьютексом и через append, а не через перезапись.
    await (this.queueLock = this.queueLock.then(() => {
      writeFileSync(`${this.root}/in/${id}.req.tmp`, req)
      renameSync(`${this.root}/in/${id}.req.tmp`, `${this.root}/in/${id}.req`)
      appendFileSync(`${this.root}/in/queue`, `${id}\n`)
    }))

    const res = `${this.root}/out/${id}.res`
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (existsSync(res)) {
        const text = readFileSync(res, 'utf8')
        unlinkSync(res)
        const [head, body = ''] = text.split('\n--result--\n')
        if ((/^session=(\w*)$/m.exec(head)?.[1] ?? '') !== session) {
          return { status: 'session_changed' }
        }
        const ok = /^ok=true$/m.test(head)
        const elapsedMs = Number(/^elapsed_ms=(\d+)$/m.exec(head)?.[1] ?? 0)
        return ok ? { status: 'ok', body, elapsedMs } : { status: 'error', body }
      }

      const st = this.readStatus()
      if (!st) return { status: 'game_not_running' }
      if (st.session !== session) return { status: 'session_changed' }
      // Застывший heartbeat при busy===наш id означает, что игровой поток занят
      // ИМЕННО нашим чанком. Обрывать здесь — значит убивать успешный вызов.
      if (st.freshMs >= HEARTBEAT_STALE_MS && st.busy !== id) {
        return { status: 'game_not_running' }
      }
      await new Promise(r => setTimeout(r, 25))
    }
    return { status: 'timeout', waitedMs: timeoutMs }
  }

  /** Вызывается при старте сервера: чужие .req/.res от прошлых запусков не наши. */
  sweepOrphans(): void { /* readdir по in/ и out/, удалить всё */ }
}
```

### 14.4. Анализатор Lua

```ts
// src/utils/lua-analyzer.ts
import { parse } from 'luaparse'

const VERIFIABLE = new Set([
  'RegisterHook', 'StaticFindObject', 'FindFirstOf', 'FindAllOf',
  'NotifyOnNewObject', 'StaticConstructObject',
])

export type Reference = {
  fn: string
  arg: string | null      // null = путь собран динамически, верификации не подлежит
  line: number
  column: number
}

export function collectReferences(
  source: string,
): { refs: Reference[]; syntaxError?: string } {
  let ast: any
  try {
    ast = parse(source, { locations: true, luaVersion: '5.3' })
  } catch (e: any) {
    return { refs: [], syntaxError: `${e.message} (line ${e.line}, col ${e.column})` }
  }

  const refs: Reference[] = []
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') return
    if (
      node.type === 'CallExpression' &&
      node.base?.type === 'Identifier' &&
      VERIFIABLE.has(node.base.name)
    ) {
      const a = node.arguments?.[0]
      refs.push({
        fn: node.base.name,
        arg: a?.type === 'StringLiteral' ? a.value : null,   // конкатенация → null
        line: node.loc.start.line,
        column: node.loc.start.column,
      })
    }
    for (const key of Object.keys(node)) {
      const v = node[key]
      if (Array.isArray(v)) v.forEach(walk)
      else walk(v)
    }
  }
  walk(ast)
  return { refs }
}
```

Дальше каждый `arg !== null` сверяется с индексом; `arg === null` попадает в отчёт как
`unverifiable_dynamic_path` с номером строки — умолчать об этом нельзя, иначе валидация
даёт ложное чувство безопасности.

### 14.5. Разметка `lua-api.yaml`

```yaml
- symbol: RegisterHook
  category: hooks
  signature: RegisterHook(path: string, preFn: function, postFn?: function) -> (preId, postId)
  summary: Перехват UFunction. Коллбэк получает (Context, ...параметры функции).
  status: ok
  example: |
    RegisterHook("/Script/SystemCore.UnlockResearchComponent:SetResearchTopic",
      function(Context, unlockId)
        print("topic -> " .. unlockId:get():ToString() .. "\n")
      end)
  pitfalls: |
    Путь через двоеточие перед именем функции, а не через точку.
    Параметры приходят обёрнутыми: обязателен :get().
    Хук на несуществующую функцию не выбрасывает ошибку — мод молча ничего не делает.

- symbol: ExecuteInGameThread
  category: threading
  signature: ExecuteInGameThread(fn: function)
  summary: Единственный безопасный способ трогать UObject из асинхронного контекста.
  status: ok
  pitfalls: |
    Работа с UObject вне игрового потока — краш без внятного стека,
    воспроизводящийся не каждый раз.
```

### 14.6. Разбор `.usmap` — раскладка, проверенная на файле

Файл **не сжат** (`compression=0`), поэтому парсер нужен только для тела; CUE4Parse требуется
дальше — для DataTable, но не для схем и енумов.

```
Заголовок (16 байт):
  u16 magic = 0x30C4
  u8  version = 4                 ← ExplicitEnumValues
  u32 hasVersioning = 0
  u8  compressionMethod = 0       ← None
  u32 compressedSize   = 2 395 788
  u32 decompressedSize = 2 395 788

Тело (с офсета 16):
  u32 nameCount = 53 973
  nameCount × { u16 len; utf8[len] }        ← u16, т.к. version >= 2 (LongFName)

  u32 enumCount = 1834
  enumCount × {
      i32 nameIdx                            ← имя енума
      u16 valueCount                         ← u16, т.к. version >= 3 (LargeEnums)
      valueCount × { i64 value; i32 nameIdx } ← значение ПЕРЕД именем; version >= 4
  }

  u32 schemaCount = 10 874                   ← классы и структуры: super, свойства, типы
```

Контрольный вывод этого парсера на текущем файле:

```
EAutomationEventType: Info=0, Warning=1, Error=2, EAutomationEventType_MAX=3
ERangeBoundTypes:     Exclusive=0, Inclusive=1, Open=2, ERangeBoundTypes_MAX=3
EInterpCurveMode:     CIM_Linear=0, CIM_CurveAuto=1, CIM_Constant=2, ...
```

Порядок `value` перед `nameIdx` внутри записи — неочевидная деталь, на которой парсер
молча разъезжается, выдавая правдоподобные, но чужие имена. Она закрывается юнит-тестом
на трёх енумах выше.

---

## 15. Явно вне скоупа

- **Запись `.uasset` и пересборка паков.** Моды доставляются как Lua; подмена ассетов — отдельная задача с другим тулчейном (UAssetAPI + repak)
- **Штатные BP-моды и Steam Workshop.** Параллельный мир, из UE4SS недостижимый (§9 входного документа)
- **Автоустановка UE4SS и сигнатуры `StaticConstructObject`.** Стенд уже настроен, аудитория — одна машина
- **Streamable HTTP, OAuth, мультиклиент**
- **Эмуляция переноса зданий.** Нативной функции нет; сносом-и-постановкой это делается с полудюжиной краевых случаев (возврат ресурсов, жильцы, содержимое склада, назначения рабочих, привязки труб и дорог) — материал для отдельного мода, а не для сервера
- **Векторный поиск в памяти.** Ломает offline-first; при необходимости — `sqlite-vec` с локальной моделью
- **Индексация CDO (`Default__*`, 6117 шт.).** Содержат значения свойств по умолчанию, но для v1 базовые числа берутся из DataTable

---

## 16. Открытые вопросы к реализации

Закрыто при подготовке ревизии документа:

- ~~`SystemCore.NotificationBoard` — C++ или BP?~~ **Нативный.** Все пять классов приёмочного мода имеют `kind = Class`: `NotificationBoard`, `NotificationWidgetBase`, `ProjectArco.NotificationSystem`, `ProblemIndicatorWidget`, `UnlockResearchComponent`. Но сами виджеты уведомлений блюпринтовые (`EventNotif_C`, `TimePausedStatusNotification_C`, `EmergencyQuestNotif_C`), поэтому мод всё равно упрётся в BP-пути на слое виджета — см. §6.2
- ~~Содержит ли `.usmap` члены енумов?~~ **Да, 1834 енума с явными значениями** (§14.6)

Остаются открытыми:

1. Что именно выдаёт `GenerateUHTCompatibleHeaders()` на этой сборке — фаза 0. Влияние понижено до низкого (§6.1)
2. Насколько UE4SS на 5.6 позволяет читать поля `StructProperty` в параметрах хуков — спайк 1 фазы 2
3. Исполняет ли `ExecuteWithDelay` коллбэк в игровом потоке синхронно — спайк 2 фазы 2. При отрицательном ответе `OPS.eval` требует переделки на коллбэк-модель
4. Какая форма пути работает в `StaticFindObject` для UFunction — с `:` или с `.` — спайк 3. `OPS.probe` пробует обе и сообщает `via=`, так что вопрос закрывается первым же прогоном
5. Виден ли `StaticFindObject` BP-класс, чей ассет не загружен — спайк 4. От этого зависит, отличим ли `not_found` от `not_found_possibly_not_loaded` в live-режиме
6. Насколько полон `hook_path` из дампа: сколько из 835 BP-классов дадут пригодный путь без джойна и сколько потребуют фолбэка через AssetRegistry. Метрика приёмки фазы 1
7. Возвращает ли `GetResearchTopic()` при отсутствии активного исследования `NAME_None` или пустую строку — один `ww_game_eval`
8. Стабильность AOB-сигнатуры `StaticConstructObject` между патчами игры. Если поплывёт — `ww_index_status` должен это диагностировать, а не оставлять игру незапускаемой

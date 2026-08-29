# Фаза 4 — результаты (Авторинг и приёмка)

Дата: 2026-08-29, игра 0.6.190.0, профиль `dist/games/whiskerwood-0.6.190.0/`.
Спецификация: `2026-08-27-whiskerwood-mcp.md` §9.4–9.5, §9.9, §10, §11.3, §14.4–14.5, §12 «Фаза 4».

## Состояние

**Инструменты фазы готовы и проверены на живой игре; приёмка §12 не закрыта.**
Зарегистрировано 19 инструментов (было 14) и 2 промпта, все пять новых отработали в бою,
включая `ww_deploy_mod mode=dev`. Приёмочный мод собран инструментами сервера, проходит
`ww_validate_mod` вчистую, загружается в запущенную игру и **корректно читает живое
состояние мира**, но требование §3 «в HUD справа появляется уведомление» **не выполнено**:
родная очередь уведомлений в 0.6.190.0 принимает элемент и никем не разбирается.
Подробности — в «Прогон на живой игре» и «Что осталось».

## Что собрано

```
data/lua-api.yaml              ← 50 записей UE4SS API, 14 категорий
data/templates/{hook,ui,keybind,diagnostic}.lua
src/utils/lua-api.ts           ← загрузка YAML с кэшем по mtime
src/utils/lua-analyzer.ts      ← luaparse: ссылки, алиасы, линты
src/utils/mod-project.ts       ← mod_root в песочнице, mod.json, соседние моды
src/utils/ue4ss-deploy.ts      ← junction/копия + строка в mods.txt (общее с bridge:deploy)
src/tools/lua-api.ts | scaffold-mod.ts | generate-hook.ts | validate-mod.ts | deploy-mod.ts
src/prompts.ts                 ← ww:new-mod, ww:fix-after-patch
```

Монорепозиторий `D:/Whiskerwood_IO/WhiskerWood_Mods`:

```
CLAUDE.md              правила работы агента над модами
.mcp.json              подключение сервера whiskerwood через bun
lib/ww/log.lua         префиксованный лог с обязательным "\n"
lib/ww/obj.lua         first_of / all_of / find с проверкой валидности
lib/ww/poll.lua        периодическая проверка в игровом потоке
mods/research-notifier приёмочный мод
```

## Отступления от спеки и их причины

**`lua-api.yaml` читается на лету, а не индексируется в профиль.** В §7.2 под него есть
таблица `lua_api`, но справочник описывает UE4SS, а не версию игры: запекание в профиль
означало бы, что правка граблей требует пересборки индекса (а та — запущенной игры и
снятия дампов). Загрузка кэшируется по mtime. Таблица `lua_api` в схеме осталась
неиспользованной; трогать её — значит поднимать `INDEX_SCHEMA_VERSION` и вынуждать
пересборку, что дороже пустой таблицы.

**Анализатор разрешает алиасы и обёртки — этого в §14.4 не было, и без этого он бесполезен.**
Скелет §14.4 ловит только `RegisterHook("...")` с базой-идентификатором. Но правильная
идиома, которую предписывает сама спека (§14.2, dev-цикл), выглядит как
`local register = WWRegisterHook or RegisterHook` — и все хуки мода уходили из-под проверки:
первый прогон приёмочного мода дал `hook_paths_checked: 0` при статусе `ok`. Добавлены:

- пред-проход по AST, собирающий `local X = <verifiable>` и `local X = A or B`;
- распознавание обёрток `lib/ww/obj.lua` (`obj.first_of` → `FindFirstOf`,
  `obj.all_of` → `FindAllOf`, `obj.find` → `StaticFindObject`) по тому, из какого модуля
  пришла переменная.

Без второго пункта общая библиотека скрывала бы от валидации имена классов, то есть делала
бы `lib/` вредным.

**`luaparse` парсится без `encodingMode`.** С `pseudo-latin1`/`x-user-defined` он падает на
любой кириллице в исходнике (`code unit U+043F is not allowed`), а без режима не заполняет
`value` строковых литералов. Значение декодируется из `raw` своей функцией `luaStringValue`
(кавычки, экранирование, длинные скобки `[[...]]`).

**`ww_lua_api` добавлен в этой фазе, а не отдельно.** В §9 он числится группой 9.4, но его
единственный источник данных — `lua-api.yaml` из этой же фазы.

**Шаблоны без готовых путей хуков.** `hook.lua` отдаёт пустую таблицу `HOOKS`, а не пример с
выдуманным путём: свежий скаффолд обязан проходить `ww_validate_mod` начисто, иначе агент
привыкает к «фоновым» ошибкам.

## Проверки линтера §11.3

Тестовый мод с намеренными дефектами (6 ошибок, 8 предупреждений) — сработали все проверки
из таблицы §11.3:

| Дефект | Код | Результат |
|---|---|---|
| `RegisterHook(":startResearch")` | `hook_path_not_found` | error, буквальное воспроизведение §7 |
| точка вместо двоеточия | `hook_path_separator` | error + `expected:` с верной формой |
| хук на класс, а не функцию | `hook_target_not_function` | error + `object_path` |
| `obj.first_of("NoSuchComponentClass")` | `unknown_class_name` | error, сквозь обёртку lib |
| `StaticFindObject("/Script/SystemCore.NoSuchThing")` | `object_path_not_found` | error |
| `Utf8String(...)` | `utf8string` | error |
| коллбэк на 4 аргумента при сигнатуре из 1 параметра | `hook_callback_arity` | warn, «отдаёт 2» |
| второй мод на ту же UFunction | `hook_collision` | warn с именем мода и строкой |
| `RegisterHook("/Script/" .. x)` | `unverifiable_dynamic_path` | warn, а не молчание |
| `FindFirstOf` в теле скрипта | `lookup_at_load_time` | warn |
| `print` без `\n` | `print_without_newline` | warn |
| `SetVisibility` внутри `ExecuteWithDelay` | `mutation_outside_game_thread` | warn |
| прямой `RegisterHook` без `WWRegisterHook` | `direct_register_hook` | warn |

`ww_deploy_mod mode=release` проверен на временном дереве `Mods/`: junction создаётся
(`isSymbolicLink: true`, точка входа видна сквозь него), строка вставляется после
`BPModLoaderMod`, повторный вызов даёт «уже включён», `research-notifier : 0` переводится
в `: 1`. Игровой `mods.txt` при этом не трогался.

## Приёмочный мод Research Notifier

Собран целиком через инструменты сервера, без ручного поиска по дампам:

1. `ww_get_type SystemCore.UnlockResearchComponent` → 7 полей, 8 методов.
2. `ww_get_function GetResearchTopic` → `() -> FName`, `type_source: uht`.
3. `ww_find_symbol NotificationBoard` → **родная подсистема найдена**:
   `PushItem(FNotificationItem)`, `HasPendingItem`, `RetrievePendingItem`;
   `FNotificationItem` = `{ Priority: ENotificationPriority, Title: FString, Desc: FString }`,
   `ENotificationPriority.Medium = 1`. Самодельный UMG-оверлей не понадобился.
4. `ww_resolve_loc industrystate.noactiveresearch` → «Нет активных исследований» / «No active research».
5. `ww_verify_hook` по всем четырём путям → `found` с готовыми `hook_path`.
6. `ww_scaffold_mod` (шаблон `ui`) → `ww_generate_hook SetResearchTopic post` → правка `main.lua`.
7. `ww_validate_mod` → `status: ok`, `errors: 0`, `warnings: 0`, `hook_paths_checked: 1`.

Логика мода: опрос раз в 5 с в игровом потоке (`ww.poll`) плюс post-хук на
`SetResearchTopic` для мгновенной реакции; переход в состояние «тема = `None`» отдаёт
уведомление в `NotificationBoard`, обратный переход — снимает флаг.

## Прогон на живой игре 2026-08-29

Две сессии: `30011e` — закончилась крашем от диагностического обхода объектов; `ffd13c` —
рабочая. Обе на уровне `ArcoPlay`, реальная колония с двумя лабораториями.

### Сессия ffd13c: инструменты фазы проверены в бою

| Проверка | Результат |
|---|---|
| `ww_deploy_mod mode=dev` | `loaded, hooks=1` за 123 мс; строка мода с кириллицей в `UE4SS.log` |
| Перезагрузка мода ×3 подряд | `hooks=1` каждый раз — накопления хуков нет и в авторинге |
| `ww_validate_mod live=true` | `status: ok`, 0 ошибок, 0 предупреждений, `level_loaded: true` |
| `PushItem` со структурой из Lua | **принят**: `pushed=true`, `HasPendingItem` → true |
| Кириллица через структуру | round-trip: `title=Нет активных исследований`, `prio=2` |

Открытый вопрос фазы 2 закрыт положительно: **структура передаётся в UFunction Lua-таблицей**
(`board:PushItem({ Priority = 1, Title = "…", Desc = "…" })`), включая строки с кириллицей.
Направление «Lua → StructProperty» работает так же, как проверенное спайком 1 чтение.

### Что делает мод и чего он не делает

Лог живой игры после `ww_deploy_mod mode=dev`:

```
20:33:33 [research-notifier] loaded, опрос ArcoSystems.GetResearchInfo каждые 5000 мс
20:33:38 [research-notifier] WARN Нет активных исследований (…) активных лабораторий: 2
20:33:38 [research-notifier] NotificationBoard: PushItem принят
```

Это доказывает: код мода исполняется в игровом потоке, читает **живое** состояние мира и
делает по нему верный вывод — активной темы нет, лабораторий две (человек подтвердил, что
тема действительно не выбрана). **Это не доказывает главного требования §3: уведомления в
HUD нет.** Элемент лёг в очередь `NotificationBoard` и там остался — см. ниже.

### Где на самом деле лежит состояние исследований

Первая версия мода опиралась на `SystemCore.UnlockResearchComponent` — и не работала бы:
живого инстанса нет, в массиве объектов только два CDO
(`Default__UnlockResearchComponent`, `Default__HoldingsRelay:research`), актора
`HoldingsRelay` в мире тоже нет. Настоящий источник найден по индексу
(`function_params.type_name = 'ResearchSummaryState'`, `properties.type_name = 'ResearchState'`)
и подтверждён на живой игре:

```
ProjectArco.ArcoSystems                       живой инстанс ArcoSystems_Configured_C
  :GetResearchInfo() -> ResearchSummaryState  { nLabs, nActiveLabs, progress, ResearchState, … }
  .m_researchState : ResearchState            { activeResearch: FName, activeResearchTier, … }
```

Живое чтение: `active=None tier=-1 labs=2 activeLabs=2 progress=0.0`. Работают оба пути —
и вызов `GetResearchInfo()`, и прямое чтение поля. События смены темы в рефлексии нет,
поэтому опрос остаётся опросом. Мод переписан на этот источник.

### NotificationBoard: очередь есть, потребителя нет

`PushItem` принимает элемент, `HasPendingItem` подтверждает, что он в очереди — и всё.
Хуки на `PushItem`, `RetrievePendingItem` и `HasPendingItem` за время наблюдения дали
**ноль вызовов со стороны игры**; живых `NotificationWidgetBase` в мире нет; отправленный
элемент так и висит непрочитанным. В 0.6.190.0 подсистема подключена, но не используется.

Практический вывод: родное уведомление показать через неё нельзя, основной канал мода —
лог. `ScienceSummaryWidget_C:SetData` живой (142 вызова на трёх виджетах внутри
`ArcoView_TechTree2_C`), но работает только при открытом дереве технологий.

### Сессия 30011e: что установлено до краша

**`UnlockResearchComponent` не инстанцирован.** Полный обход
объектов нашёл ровно два вхождения, и оба — CDO:
`/Script/SystemCore.Default__UnlockResearchComponent` и
`/Script/SystemCore.Default__HoldingsRelay:research`. Актора `HoldingsRelay` в мире тоже нет
(проверка `IsA` по всему массиву дала только CDO), при том что `ResearchLab` живых два —
это компоненты зданий `researchBuilding_C` в PersistentLevel.

Значит источник данных приёмочного мода на этом сохранении пуст: `GetResearchTopic` вызывать
не на чем, и мод молча не сработает. Индекс рефлексии здесь ни при чём — он честно описывает
класс, который в игре существует; вопрос «а есть ли живой инстанс» закрывается только мостом.
Ровно ради этого фаза 2 шла раньше данных.

Побочно подтверждены две грабли, записанные в `lua-api.yaml`:

- `FindFirstOf` при отсутствии инстансов возвращает **не nil**, а обёртку вокруг nullptr:
  `if comp then` проходит, первый же вызов метода падает с
  `Tried calling a member function but the UObject instance is nullptr`. Проверка обязана
  быть `comp and comp:IsValid()` — как и сделано в `lib/ww/obj.lua`.
- `FindAllOf` не показывает CDO: `nil` означает именно «инстансов в мире нет».
- Наследники **учитываются**: `FindFirstOf("ArcoSystems")` находит `ArcoSystems_Configured_C`,
  `FindAllOf("Actor")` даёт 6497. Первая редакция этой заметки утверждала обратное —
  исправлено после проверки на живой игре.

### Краш и его причина

Игра упала с fatal error после серии `ForEachUObject` по ~150 000 объектов. Один из проходов
(`IsA` на каждом объекте) занял 10.3 с игрового потока, следующий такой же проход убил
процесс. В `UE4SS.log` записей о падении нет — лог обрывается на строках старта.

Причина почти наверняка в самом обходе: в массиве есть объекты, помеченные к сборке мусора,
и `GetFullName`/`IsA` на таком объекте читает освобождённую память. `ForEachUObject` в
`lua-api.yaml` переведён в `status: broken` с явным запретом на использование; разведка
делается через `FindAllOf` по конкретному классу или через хук.

## Что осталось

**Уведомление в HUD — главное невыполненное требование §3.** Мод определяет состояние и
пишет в лог, но на экране ничего не появляется: родная очередь `NotificationBoard` в этой
сборке не разбирается никем. Варианты, ни один пока не проверен: найти потребителя очереди
в BP-слое; подменять данные живого `ScienceSummaryWidget_C:SetData`; собрать рантайм-UMG
(то, чего §2 просила избегать). Это доработка мода, а не инструментов сервера.

**Обратный переход мода не наблюдался** — состояние «тема выбрана → лог `исследование
выбрано: <id>`» требует, чтобы человек выбрал технологию при загруженном моде. Подтверждён
только прямой переход.

**Пополнение линта из проектной памяти.** §11.3 предполагает, что грабли из
`ww_memory_add` попадают в валидацию. Память — фаза 5; пока набор правил зашит в
`lua-analyzer.ts`, точка расширения — `MUTATING_NAMES` / `LOAD_TIME_LOOKUP` и
`data/lua-api.yaml`.

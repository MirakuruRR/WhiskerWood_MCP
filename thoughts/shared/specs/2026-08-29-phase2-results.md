# Фаза 2 — результаты (Runtime bridge)

Дата: 2026-08-29, игра 0.6.190.0, профиль `dist/games/whiskerwood-0.6.190.0/`.
Спецификация: `2026-08-27-whiskerwood-mcp.md` §11.2, §14.2–14.3, §12 «Фаза 2».

## Состояние

Фаза завершена. Код развёрнут и прогнан на живой игре (уровень `ArcoPlay`), все четыре спайка
закрыты, все три приёмочных условия §12 выполнены. Спайк 2 оказался отрицательным, из-за чего
мост переписан на коллбэк-модель — см. ниже.

## Приёмка §12 на живой игре

| Условие | Результат |
|---|---|
| 1. Число из живой игры быстрее 2 с | `#FindAllOf('Actor')` → **6497 за 248 мс**, `#FindAllOf('ActorComponent')` → 49174 за 223 мс |
| 2. `ww_game_status` при выключенной игре — мгновенно, без таймаута | `game_not_running` / `bridge_not_installed` сразу, как и `ww_game_eval`/`ww_game_console` |
| 3. Параллельные `eval` и неизменный `hooks=N` | 2 параллельных за 251 мс; **20 параллельных за 278 мс, все 20 корректны**; `load_mod` ×3 → `hooks=2` каждый раз, `unload_mod` снял ровно 2 |

Буквальный пример условия 1 из §12 использует `UnlockResearchComponent`, у которого на текущем
сохранении **нет ни одного инстанса** (живые компоненты с «Research» в имени класса — только
`ResearchLab`, 2 шт.), а `FindAllOf` при нуле совпадений возвращает `nil`. Ошибка «attempt to get
length of a nil value» — про состояние мира, а не про мост.

Прогон всех десяти инструментов через настоящий MCP-сервер (`bun run smoke`) на запущенной игре:
`ww_game_status` → `running`, `level_loaded: true`; `ww_game_eval` → 6497 за 120 мс;
`ww_game_log` разбирает текущую сессию; `ww_verify_hook(live: true)` даёт по четырём путям
`found/live=found via=colon`, `not_found/live_via=class_only` (буквальное воспроизведение §2:
класс есть, функции нет — подтверждено живой игрой), `found` по BP-функции и
`not_found_possibly_not_loaded` по выдуманному BP-пути.

## Что собрано

```
bridge/WWBridge/Scripts/main.lua   ← мост (config.lua генерируется деплоем, в git не идёт)
src/utils/bridge-client.ts         ← файловый IPC: мьютекс очереди, сессия, busy-ожидание, sweep
src/utils/ue4ss-log.ts             ← разбор UE4SS.log
src/tools/bridge-common.ts         ← общие поля ответов, детект загруженного уровня
src/tools/game-status.ts | game-eval.ts | game-console.ts | game-log.ts
src/tools/verify-hook.ts           ← + live-проба
src/scripts/deploy-bridge.ts       ← bun run bridge:deploy
src/scripts/bridge-spikes.ts       ← bun run bridge:spikes (требует запущенной игры)
```

Инструментов в сервере: 10 (`ww_game_status`, `ww_game_eval`, `ww_game_console`, `ww_game_log`
сверх шести из фазы 1).

## Ответы спайков (живая игра, 2026-08-29)

### Спайк 2 — `ExecuteInGameThread` асинхронный. Модель переделана

Коллбэк **не исполняется на месте**: сразу после диспатча счётчик равен 0, а к следующему
запросу (один тик опроса, ≤120 мс) — уже 1. `OPS.eval` из скелета §14.2 вернул бы `no_result`
на любом вызове. Спека предписывала в этом случае переделку на коллбэк-модель — она сделана:

- `dispatchGameThread(id, timeout, fn)` регистрирует запись в `pending[id]` и ставит коллбэк;
- `.res` пишется не после диспатча, а когда коллбэк отработал, — забирает его `sweepPending()`
  на следующем тике `poll`;
- если коллбэк не исполнился за `timeout_ms + 1 с`, запись помечается `abandoned` и клиент
  получает `game_thread_timeout`, а не молчание;
- поле `exec` в заголовке ответа: `game_thread_sync` | `game_thread_async` | `direct`
  (последнее — только если `ExecuteInGameThread` вообще недоступен).

Цена — до одного тика опроса (120 мс) на вызов. Выигрыш — чанк действительно исполняется в
игровом потоке, а не на потоке Lua: мутация UObject снаружи игрового потока в UE — источник
случайных крашей, и мост, созданный ради достоверной обратной связи, не может быть их причиной.

### Спайк 3 — двоеточие

`StaticFindObject("/Script/SystemCore.ActivityTracker:ComputeShowState")` → `via=colon`.
Форма с точкой не понадобилась ни разу. Записано в `profile_meta.hook_path_separator = colon`;
индексатор уже собирал `hook_path` именно так (§9.1), теперь это подтверждено, а не постулировано.

### Спайк 4 — `StaticFindObject` видит только загруженное

Отрицательный ответ, и он важен:

```
/AudioWidgets/Resources/ScrubHandleDown_Clamped...  = found     via=object
/ControlRig/Controls/ControlRig_Arrow2_1mm...       = not_found via=none   (×7)
/Game/UI/MainMenu/NewGameEmbark.NewGameEmbark_C     = not_found via=none
14 из 15 случайных BP-классов игрового уровня        = found     via=object
```

Виджет главного меню не находится при загруженном игровом уровне, хотя в индексе он есть.
Значит **live-негатив по BP-пути не окончателен никогда**, даже при загруженном уровне.
`ww_verify_hook` исправлен: BP-путь, не найденный live-пробой, даёт
`not_found_possibly_not_loaded`, а не `not_found`. Записано в
`profile_meta.static_find_object_sees = loaded_only`.

### Спайк 1 — поля `StructProperty` читаются

```
A: get()=true X=1.5 Y=2.5 Z=3.5 || B: get()=true X=10.0 Y=20.0 Z=30.0
```

Хук на `/Script/Engine.KismetMathLibrary:Add_VectorVector`, вызов из Lua с двумя векторами.
Параметр приходит userdata-обёрткой; `:get()` даёт `UScriptStruct`, поля читаются по имени.
Ограничение по 5.6 не подтвердилось.

Побочная находка, важная для фазы 4: хуки на `UMG.UserWidget:Tick`, `OnMouseMove`,
`Engine.Actor:K2_SetActorLocation` и подобные **не сработали за 12 с игры**, тогда как тот же
механизм мгновенно сработал на функции, вызванной из Lua. Похоже, `RegisterHook` ловит вызовы,
идущие через `ProcessEvent`, а не нативные C++→C++. Это кандидат в грабли `lua-api.yaml`, но
отдельно не проверялось и как факт не фиксируется.

## Отступления от скелета §14.2/§14.3 и их причины

- **Коллбэк-модель вместо возврата сразу после диспатча** — см. «Спайк 2» выше.
- **Заголовок запроса разбирается по `([%w_]+)=`, а не `(%w+)=`.** В скелете `timeout_ms=5000`
  распознавался как ключ `ms`: `%w` не включает подчёркивание.
- **`pcall` вокруг обработчика и вокруг тела `poll`.** В скелете необработанная ошибка внутри
  `OPS.*` рвала цепочку `ExecuteWithDelay` — мост замолкал до перезапуска игры, а клиент видел
  только таймауты.
- **`os.remove(QUEUE_WORK)` перед `os.rename`.** На Windows `rename` поверх существующего файла
  не проходит; `queue.work`, оставшийся от аварийного завершения, заклинил бы очередь навсегда.
- **`readStatusStable()` с ретраями на клиенте.** `writeAtomic` подменяет `bridge.status` через
  `remove` + `rename`, и попадание чтения в это окно давало бы ложный `game_not_running`.
- **`world` в heartbeat.** `ww_game_status` обязан отвечать «загружен ли уровень», а спрашивать
  это отдельным запросом при выключенной игре нельзя. Мост обновляет имя мира раз в ~5 с и по
  пост-хукам `InitGameState`/`LoadMap`.
- **`sweepOrphans` реализован** (в скелете был заглушкой) плюс троттлящаяся уборка `.res`
  старше 60 с и удаление своего `.req` при таймауте.
- **Консоль через `KismetSystemLibrary`, а не `PlayerController`** — см. отдельный раздел.
- **Bridge-инструменты не падают из-за сломанного индекса** (`wrapBridge`): именно при
  разъехавшемся после патча профиле живая игра и нужна для диагностики. `game_version` в эхе
  тогда `unknown`.

## Протокол

Статус (`state/bridge/bridge.status`):

```
session=a41f9c
tick=1234
ts=1788008533
started_ts=1788008401
busy=
world=World /Game/Levels/ArcoPlay.ArcoPlay
last_error=
```

Ответ (`state/bridge/out/<id>.res`):

```
id=7f3a
session=a41f9c
ok=true
elapsed_ms=12
exec=game_thread_async
--result--
tech_sawmill
```

Операции моста: `ping`, `world`, `eval`, `probe`, `console`, `load_mod`, `unload_mod`.
`load_mod`/`unload_mod` нужны фазе 4, но живут здесь же — реестр хуков `mod → hookIds` часть
моста, а не авторинга.

## Офлайн-проверка на Lua-VM

Настоящий `main.lua` исполнен на Lua-VM (fengari, Lua 5.3) с эмуляцией `ExecuteWithDelay`,
`ExecuteInGameThread`, `StaticFindObject`, `RegisterHook`/`UnregisterHook`, `UEHelpers` и
файлового io; против него работал настоящий `BridgeClient`. Проверено:

| Проверка | Результат |
|---|---|
| синтаксис и загрузка мода | ок |
| `eval` со значением, без значения, с ошибкой рантайма, с ошибкой компиляции | ок / `<no_value>` / `error` / `compile_error` |
| `probe` трёх форм пути | `via=colon`, `via=no_class`, `via=object` |
| `console` | команда дошла до `ConsoleCommand` |
| 3 параллельных `eval` | все три вернули свой результат |
| **25 параллельных `eval`** | 25 из 25 корректны, потерь очереди нет |
| **`load_mod` трижды подряд** | `hooks=2` каждый раз, живых хуков в эмуляторе 2, а не 6 |
| `eval` при синхронном игровом потоке | `exec=game_thread_sync` |
| `eval` при отложенном игровом потоке | `exec=game_thread_async`, результат забран следующим тиком |
| неизвестная операция | `unknown_op` |

Проверено на реальном сервере при выключенной игре: `ww_game_status` → `bridge_not_installed`
(до деплоя) мгновенно; `ww_game_eval` и `ww_game_console` → `game_not_running` мгновенно, без
таймаута — приёмочное условие 2 выполнено. `ww_game_log` разбирает `UE4SS.log` и при выключенной
игре: 766 записей, фильтры по сессии, уровню и моду работают. `ww_verify_hook(live: true)` при
мёртвом мосте отдаёт ответ по индексу с пометкой `live: game_not_running`, а не падает.

## Развёртывание

`bun run bridge:deploy` выполнен:

- junction `ue4ss/Mods/WWBridge` → `bridge/WWBridge` (правки в репозитории видны игре сразу)
- `bridge/WWBridge/Scripts/config.lua` с `root=state/bridge`, `poll_ms=120`, `mods_repo`
- строка `WWBridge : 1` добавлена в `mods.txt` после `BPModLoaderMod`

Откат: удалить junction, снять строку из `mods.txt`.

## Повторный прогон спайков

`bun run bridge:spikes` при запущенной игре с загруженным уровнем закрывает все четыре одним
проходом и кладёт отчёт в `state/bridge-spikes.md`. Спайк 1 не ждёт случайного срабатывания:
он вешает хук на `KismetMathLibrary:Add_VectorVector` и сам вызывает функцию из Lua.

## `ww_game_console`: PlayerController не подходит

`UEHelpers.GetPlayerController()` отдаёт **блюпринтовый** `BP_PlayerController_Play_C`, и
`pc:ConsoleCommand(...)` на нём падает: `attempt to call a TrivialObject value`. Рабочий путь —
`KismetSystemLibrary.ExecuteConsoleCommand(world, command, nil)`; проверено по наблюдаемому
эффекту, а не по коду возврата:

```
TimeDilation=1.0  →  slomo 2  →  TimeDilation=2.0  →  slomo 1  →  TimeDilation=1.0
```

`OPS.console` переписан на KSL с фолбэком на PlayerController. Мод в игре подхватит правку при
следующем запуске игры — на момент прогона в памяти была версия до фикса.

## Находки, полезные фазе 4

- `FindAllOf(name)` при нуле совпадений возвращает **nil, а не пустую таблицу**: `#FindAllOf(...)`
  падает с `attempt to get length of a nil value`.
- `FindFirstOf(name)` при отсутствии инстансов возвращает **невалидный объект, а не nil**:
  проверять надо `o and o:IsValid()`, а не `o ~= nil`.
- `UnlockResearchComponent` на текущем сохранении инстансов не имеет (живых компонентов с
  «Research» в имени класса — только `ResearchLab`, 2 шт.). Приёмочный пример §12 «Фаза 2»
  возвращает не число, а ошибку длины nil — по причине, лежащей в игре, а не в мосте.
- `RegisterHook`, по-видимому, ловит вызовы через `ProcessEvent`; хуки на часто вызываемые
  нативные функции (`UserWidget:Tick`, `Actor:K2_SetActorLocation`) за 12 с не сработали ни разу.

## Открытые вопросы, оставшиеся после фазы

- Предохранитель `debug.sethook` от бесконечного цикла в чанке (§11.2, «опционально, по
  умолчанию выключен») не реализован: чанк с `while true` подвесит игру.
- `elapsed_ms` меряется `os.clock()` — это процессорное время; для чанка, который ждёт, а не
  считает, оно занижено.
- Гипотеза про `ProcessEvent` не проверена отдельным экспериментом.

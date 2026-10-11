# Предложения по правкам MCP

Источник: [REVIEW-TOOLS.md](REVIEW-TOOLS.md) (ревью 2026-10-11, ревизия `7615498`). Здесь только
предложения: что менять, где, зачем и с каким риском. Доказательства и замеры — в отчётах
`state/review/recon.md`, `live.md`, `lua-loom.md`, `usage.md`, `verify.md`.

## Шаг 1. Без изменения состава инструментов и поведения

| # | Правка | Где | Эффект | Риск |
|---|---|---|---|---|
| 1.1 | Сжать описание параметра `version` до строки «Профиль индекса (версия игры)» | `src/server.ts:153-156` (+ перенести семантику «по умолчанию старший готовый профиль» в доки) | ≈ −3,6 КБ постоянно (36 инструментов × ~100 Б) | минимальный: текст, поведение не меняется |
| 1.2 | `ww_index_status`: добавить `detail: 'summary' \| 'full'` (по умолчанию `summary`), в `summary` — только `game_version`, `index_revision`, `profile_id`, `built_at`, `fingerprint` + `meta_coverage_bp_*`, `meta_dump_captured_at`, `meta_engine_version`, `meta_schema_version` | `src/tools/index-status.ts:6-21`, `src/server.ts:283-295` | −4,4 КБ на каждом вызове (57 вызовов в 51 сессии); все 91 поле остаются за `detail='full'` | низкий |
| 1.3 | Поглотить `ww_index_release`: `action: 'status' \| 'release'` в `ww_index_status`, убрать отдельный инструмент | `src/tools/index-release.ts`, `src/server.ts:296-306`, `src/toolsets.ts:12` | −638 Б постоянно; 3 вызова за историю | низкий: `closeIndexDbs()` вызывается как есть, внутренние читатели `profile_meta` ходят в БД напрямую (`src/tools/verify-hook.ts:58-60`) |
| 1.4 | Сжать `description` у `ww_loom_install`: оставить контракт (`action*`, коды `game_running` / `ready_to_install` / `already_installed`), прозу убрать | `src/server.ts:1002-1035` | ≈ −2,5 КБ — самое длинное описание каталога (4 767 Б) | средний: карточка перестаёт сама объяснять `start → status → install`; компенсируется промптом `ww:new-loom-mod` |
| 1.5 | Смоук: считать пропущенный `call()` ошибкой (`failures.push`), а не молчаливым «пропущен» | `src/scripts/smoke-client.ts:38-42` | переименование инструмента перестаёт проходить незамеченным | низкий |
| 1.6 | Поправить разъехавшиеся доки: «из 43 инструментов» → 47; вернуть строку `ww_lua_api` в таблицу | `docs/SETUP.md:177`, `docs/TOOLS.md:140-143` | — | нет |

## Шаг 2. Найденные дефекты

| # | Правка | Где | Эффект | Риск |
|---|---|---|---|---|
| 2.1 | Задать таймаут cook-джобу (30–60 мин; измеренный максимум — 63 с), согласовать политику с `loom-build` (30 мин) и `loom-new-mod` (10 мин) | `src/tools/loom-install.ts:978` (`timeoutMs: 0`), `src/scripts/job-runner.ts:89` | снимается залипание единственного слота кита: сейчас зависший cook держит `busy` для всех Loom-инструментов | низкий |
| 2.2 | `ww_screenshot`: возвращать нативный размер окна и масштаб вложения (`window=WxH`, `attach_scale`, `attach_size`); в описании связать координаты `ww_click` с масштабом и уточнить, что `crop` — в нативных пикселях | `src/tools/screenshot.ts:154-165`, `src/utils/screenshot.ts:160-186`, `src/server.ts:563,689` | цикл «кадр → клик» перестаёт промахиваться на окнах >1920 px (20 кадров 2560×1440 ужимаются ×0.75) | низкий (дефолт масштаба не меняем) |
| 2.3 | `ww_get_datatable`: применить `limit` в режиме списка таблиц (сейчас SQL без LIMIT) и отдавать `total_found` | `src/tools/get-datatable.ts:42-58` | список перестаёт всегда стоить ~8 КБ вместо запрошенных строк | низкий |
| 2.4 | Один `findGameProcess` на вызов: общий хелпер полей моста + передача уже найденного `ProcInfo` | `src/tools/game-process.ts:245-258`, `src/utils/session.ts:51-52`, `src/tools/click.ts:23-30`, `src/tools/bridge-common.ts` | ≈ −0.23 с на `status`/`click`; `ww_game_process` начинает различать «мост не установлен» и «игра закрыта» | низкий |
| 2.5 | `ww_capture_dumps`: считать `settle_ms` от аптайма моста (порог 2–5 мин) вместо слепых 60 с; `uptime_s` уже в ответе | `src/tools/capture-dumps.ts:83`, `src/tools/bridge-common.ts:37` | до −60 с на каждом снятии дампа | средний: порог — предложение, не замер |
| 2.6 | `ww_loom_validate`: добавить фильтры `detail`, `codes`, `file`, `since_last` — паритет с `ww_validate_mod` | `src/server.ts:1083-1087`, `src/tools/loom-validate.ts` (образец — `validate-mod.ts`) | отчёт по моду с десятком `.lm` можно сузить | низкий (поля аддитивные) |
| 2.7 | Вынести `ww_game_log` и `ww_crash_report` из группы `live` (они читают только файлы) | `src/toolsets.ts:31-32`, `docs/ARCHITECTURE.md:99-105`, `docs/TOOLS.md:10-14`, `src/config.ts:4` | диагностика доступна без запущенной игры и без группы `live` | средний: конфиг без `recon` потеряет эти два инструмента (в репозитории таких нет) |
| 2.8 | Дописать в промпты невидимые инструменты: `ww_mod_state`, `ww_screenshot`/`ww_click`, `ww_capture_dumps`, `ww_crash_report` | `src/prompts.ts:19-22,38-40,117-120,169-183` | 6 из 14 инструментов группы `live` сейчас не упомянуты ни в одном промпте | низкий |

## Шаг 3. Объединения (отдельное решение, средний риск)

| # | Правка | Где | Эффект | Условие корректности |
|---|---|---|---|---|
| 3.1 | `ww_find_symbol` + `ww_search_members` → одна схема `scope: 'symbols' \| 'members' \| 'both'` (+ `member_kind`, `kind`) | `src/server.ts:158-196`, `src/tools/find-symbol.ts`, `src/tools/search-members.ts`, `src/toolsets.ts:4-5` | −1 421 Б, снимается вопрос «какой из двух звать» | обязателен отдельный бюджет для секции `members` и правило подсчёта `total_found`: сейчас LIKE-ветка `find_symbol` получает только остаток бюджета (`src/tools/find-symbol.ts:74-76`) и при полном FTS не выполняется |
| 3.2 | `ww_get_type` + `ww_get_function` → `ww_get_reflection(path, section: 'auto' \| 'type' \| 'function')`; `section='auto'` решает по `obj.kind`, тексты ответов (`report_type`) сохраняются | `src/server.ts:198-227`, `src/tools/get-type.ts`, `src/tools/get-function.ts`, `src/toolsets.ts:6-7` | −2 682 Б | это самые горячие инструменты (795 + 334 вызова); выгода — контекст, а не раунды (промахов по виду пути всего 32 за историю), поэтому делать отдельно и с прогоном замеров |

## Не вносить (проверено и отклонено)

- `ww_lua_api` → группа `lua`: ломает Loom-режим, где Lua пишут через `ww_game_eval` (самый вызываемый инструмент).
- Слияние `ww_game_status` и `ww_game_process action=status`: дублируется код, а не инструмент; верная правка — п. 2.4.
- `ww_loom_job`: либо дублирование остаётся и появляется 48-й инструмент, либо теряется разбор `report.json` и проверок пака. Нужен общий рендер job-статуса **без** нового инструмента.
- Слияния `ww_game_eval` / `ww_call` / `ww_trace_calls`, `ww_screenshot` + `ww_click`, `ww_find_asset` + `ww_extract_asset`.
- Удаление инструментов «по нулю вызовов»: три нулевых добавлены в день замера и прогонялись обвязкой.

## Чек-лист при любом переименовании или смене группы

1. `src/server.ts` — регистрация; `src/toolsets.ts` — `TOOL_GROUPS` (источник правды для смоука и гейта групп).
2. `src/scripts/smoke-client.ts` — литералы `call('…')` (86 вызовов, 31 имя; устаревшие молча выпадают — см. п. 1.5).
3. `docs/TOOLS.md` (`:3`, `:10-14`, карты порядка работ `:19-53`) и `docs/ARCHITECTURE.md` (`:99-105`).
4. `src/prompts.ts` — все четыре промпта; `.claude/skills/*` — скиллы, перечисляющие инструменты; `.claude/hooks/crash-watch.ts` — `ww_crash_report`.
5. `data/templates/**` и справка `data/lua-api.yaml`; `data/memory-seed.jsonl` — **не руками**, через `bun run memory:export`.
6. Репозиторий модов: `CLAUDE.md`, `thoughts/`, `lib/ww/*.lua`.

## Проверка после каждого шага

```
bun run typecheck && bun run doctor && bun run smoke
```

Плюс замер поверхности до/после (`.scratch/review-measure.ts`, вывод — байты `tools/list`), чтобы
выигрыш был измерен, а не заявлен. Смоук дёргает только 31 инструмент из 47, поэтому при
переименовании или объединении в п. 3 нужно добавить вызовы новых имён — иначе покрытие тихо
потеряется.
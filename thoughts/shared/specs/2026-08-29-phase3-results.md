# Фаза 3 — результаты (Данные игры)

Дата: 2026-08-29, игра 0.6.190.0, профиль `dist/games/whiskerwood-0.6.190.0/`.
Спецификация: `2026-08-27-whiskerwood-mcp.md` §6 (источники 4–5), §7.2, §9.3, §12 «Фаза 3».

## Состояние

Фаза завершена. Оба приёмочных условия §12 выполнены, проверка встроена в `bun run setup`
и падает с кодом 3, если данные не собрались.

| Условие | Результат |
|---|---|
| `ww_get_datatable("TechUnlocksV2")` отдаёт строки с реальными ключами | **174 строки**, ключи `unlock.lumbermill`, `unlock.brickmaker`, `unlock.fishery`… |
| `ww_resolve_loc("mod.desc.starvation", "Ru")` — русский текст | **«Скоро умрет без еды!»** |

## Что собрано

```
sidecar/WwParse/                   ← .NET 10 + CUE4Parse 1.2.2.202608, .uasset+.usmap → JSONL
src/scripts/index-gamedata.ts      ← запуск сайдкара, разбор JSONL, наполнение SQLite
src/utils/asset-extract.ts         ← резолв /Game-пути в путь внутри пака + кэш PakReader
src/tools/get-datatable.ts | resolve-loc.ts | find-asset.ts | extract-asset.ts
```

Инструментов в сервере: **14** (было 10).

## Числа сборки

| Метрика | Значение |
|---|---|
| `gamedata_assets_scanned` | 61 (`.uasset` в `Whiskerwood/Content/Data/**`) |
| `gamedata_tables` | 59 |
| `gamedata_data_assets` | 1 |
| `gamedata_rows` | 1779 (без локализации) |
| `loc_tables` | 19 |
| `loc_entries` | 39 009 |
| `loc_rows_without_text` | 0 |
| `gamedata_failed_assets` | 0 |
| Время работы сайдкара | ~0,7 с; полная сборка профиля — 4,4 с |

Локализация: 19 таблиц `Loc_*` — 17 живых языков плюс `Loc_Root` (44 ключа) и `Loc_Dev`
(11 ключей). На язык ~2300 ключей, row-структура `LocDataRowBase` с единственным полем `Value`.

## Уточнения к спецификации

**«122 DataTable» — это 122 файла, а не 122 таблицы.** В `Content/Data/**` лежит 61 `.uasset`
и 61 `.uexp`; DataTable из них — 59. Число из входного документа считало файлы.

**Два `.uasset` — не DataTable:**

| Ассет | Что там | Как поступили |
|---|---|---|
| `Data/GameTuning` | `ArcoGameTunes` (наследник `PrimaryDataAsset`). В рефлексии у класса **ноль свойств**, в ассете ноль сериализованных значений — контейнер пуст, баланс лежит в `SystemTunes` (146 строк) | Индексируется как `kind = data_asset`, одна строка с фактическим содержимым. `ww_get_datatable("GameTuning")` отвечает правдой, а не `not_found` |
| `Data/Books/AssetBook_Ui` | `BlueprintGeneratedClass` + его CDO — карта «сущность → виджет» | Пропущено: CDO и generated-классы отфильтрованы (та же политика, что §7.1) |

**Колонка `datatables.kind`** — добавление относительно §7.2 (внесено и в спеку). Без неё
`ww_get_datatable` пришлось бы угадывать по `asset_path` и `row_struct`, что такое `GameTuning`
и почему у `Loc_Ru` нет строк в `datatable_rows`.

**`.NET 8` → `.NET 10`.** Пакет `CUE4Parse 1.2.2.202608` в NuGet собран только под `net10.0`
(`NU1202` на net8.0). SDK 10.0.400 и рантайм 10.0.11 на стенде есть. Сайдкар — build-контур,
на работу сервера при выключенном .NET не влияет.

**`INDEX_SCHEMA_VERSION` поднят 2 → 3.** Профиль, собранный до фазы 3, имеет пустые
`datatables`/`loc_entries`, и молча отдавать по нему «таблиц нет» — ровно тот тихий фолбэк,
против которого написана спека. Старый профиль теперь отвергается с требованием `bun run setup`.

## Решения

**Строки локализации не дублируются в `datatable_rows`.** 39 009 записей живут только в
`loc_entries` (+ `loc_fts`). `ww_get_datatable("Loc_Ru")` отвечает `status: loc_table` и
отправляет в `ww_resolve_loc` — вместо того чтобы отдать 2300 однополевых JSON-строк.

**Пак добавлен во входы сборки по `size+mtime`, без md5.** Хешировать 4 ГБ на каждую сверку
свежести нельзя; `fingerprintInput` получил флаг `hash`. Хотфикс пака без смены `ProjectVersion`
теперь всё равно вызывает пересборку.

**Сайдкар запускается на каждую сборку, без кэша по входам.** 0,7 с — дешевле, чем класс
ошибок «устаревший JSONL остался от прошлого патча».

**Сайдкар пишет JSONL в файл, а не в stdout.** `dotnet build` печатает в тот же поток;
файл через `--out` снимает вопрос смешивания. В stderr уходит только строка итогов.

## Инструменты

`ww_get_datatable(name?, row?, row_pattern?, limit?)`

| Вызов | Ответ |
|---|---|
| без аргументов | `datatable_list`, 60 таблиц с `row_count` и `kind` |
| `name` | строки таблицы, `row_json` в блоке, `truncated`/`total_found`/`limit` |
| `name` + `row` | одна строка целиком (лимит тела 20 000 символов) |
| `name` + `row_pattern` | строки таблицы по шаблону ключа |
| `row_pattern` | поиск ключа по всем таблицам: `lumbermill` → `GridactorDefs_Sync`, `Icons_Buildings`, `IndustryRecipes/recipe.lumbermill`, `TechUnlocksV2/unlock.lumbermill` |
| `name` не найден | `not_found` + `suggestions`, как в §11.1 |

`ww_resolve_loc(key_or_pattern, lang?, limit?)` — четыре режима с явным `mode:` в ответе:
`exact_key`, `key_pattern`, `text_search` (FTS5 по `loc_fts`), плюс отдельный статус
`lang_not_found` со списком `available_langs` — чтобы «нет перевода на этот язык» не выглядело
как «нет такого ключа». Языки: по умолчанию `defaultLangs` из конфига (`En,Ru`), можно список
через запятую или `all`. Текст всегда уходит блоком `<<<text_<Lang>` — в строках локализации
бывают переносы, а скаляр с переносом рендерер отвергает (§11.1).

`ww_find_asset(pattern, class?, limit?)` — 5536 ассетов из AssetRegistry, точное совпадение
имени поднимается наверх.

`ww_extract_asset(asset_path, dest_dir)` — единственный инструмент, пишущий за пределы
`modsRepo`. `dest_dir` проверяется `PathSandbox([extractRoot])`; `./dist/hack` → статус
`dest_dir_rejected` с указанием `extract_root`. Принимает `/Game`-путь, путь внутри пака,
объектный путь с `.Class_C` и просто имя ассета (при неоднозначности — статус `ambiguous`
со списком кандидатов). Тянет весь комплект файлов: `TechUnlocksV2` → `.uasset` + `.uexp`.
Сжатую или зашифрованную запись пака не глотает молча — `pak_entry_unreadable` с причиной.

## Проверено

`bun run setup --force` — сборка целиком, обе приёмки (фазы 1 и 3) зелёные.
`bun run smoke` — 14 инструментов, 37 вызовов, включая негативные: несуществующая таблица,
несуществующий ключ локализации, язык без перевода, запись вне `extractRoot`, отсутствующий
ассет. Единственный `server_error` в прогоне — намеренный запрос профиля версии `9.9.9`
из фазы 1.

## Открытые вопросы

- `ww_get_datatable` отдаёт `row_json` как есть, вложенные ссылки на объекты — в форме
  CUE4Parse (`{"ObjectName":…,"ObjectPath":…}`). Приводить их к `/Game`-путям имеет смысл
  тогда, когда появится реальный сценарий; сейчас это была бы догадка о нуждах фазы 4
- Правка DataTable (`patch_datatable` из входного документа) остаётся вне скоупа (§15):
  моды доставляются как Lua, запись `.uasset` требует другого тулчейна

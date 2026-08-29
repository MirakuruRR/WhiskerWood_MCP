# Фаза 1 — результаты (Read-ядро)

Дата сборки: 2026-08-29, игра 0.6.190.0, профиль `dist/games/whiskerwood-0.6.190.0/`.
Спецификация: `2026-08-27-whiskerwood-mcp.md` §12 «Фаза 1».

## Приёмочные критерии (§12) — выполнены

1. `ww_verify_hook(["SystemCore.UnlockResearchComponent.startResearch", "SystemCore.UnlockResearchComponent.SetResearchTopic"])`:
   `startResearch` → `not_found` (строка существует в бинарнике, в рефлексии отсутствует — ровно ошибка из §2);
   `SetResearchTopic` → `found`, `hook_path: /Script/SystemCore.UnlockResearchComponent:SetResearchTopic`.
2. `ww_get_function("MouseMessageBlip.MouseMessageBlip_C.Construct")` →
   `hook_path: /Game/UI/DebugUI_Components/MouseMessageBlip.MouseMessageBlip_C:Construct` — BP-джойн работает.

Прогон: `bun run src/scripts/smoke-client.ts` (клиент и сервер в одном процессе через InMemoryTransport;
запуск дочерних процессов из-под песочницы недоступен, поэтому смоук не спавнит сервер отдельно).

## Что собрано

```
src/
├── stdio.ts, server.ts (createServer, 6 инструментов), config.ts, contract.ts, schema.ts
├── utils/  ai-text, db (LRU readonly), fts, game-context, game-fingerprint,
│           game-registry, pak-reader (порт wwpak.py), path-sandbox, profile-publish, version
├── tools/  find-symbol, search-members, get-type, get-function, verify-hook, index-status, common
└── scripts/
    ├── setup.ts                 ← оркестратор: отпечаток → парсеры → staging → publish
    ├── index-reflection.ts      ← слияние источников в index.db
    ├── smoke-client.ts
    └── parsers/ object-dump, gobjects (union), usmap, uht, asset-registry, path-forms
```

Инструменты: `ww_find_symbol`, `ww_search_members`, `ww_get_type`, `ww_get_function`,
`ww_verify_hook` (без live — live в фазе 2), `ww_index_status`. Описания в форме
«когда применять», `readOnlyHint`, эхо `game_version`/`index_revision` в каждом ответе.

## Ключевые числа сборки

| Метрика | Значение |
|---|---|
| строк в дампе / объектов всего | 308 439 / 187 143 |
| проиндексировано (политика §7.1) | 33 837 (пропущено по kind: 147 350, CDO: 6 020) |
| функции / классы / структуры / енумы | 15 786 / 4 454 / 5 522 / 1 794 |
| BP-классы: из дампа с /Game-путём / через реестр / неразрешено | 830 / 19 / 3 |
| union со старым меню-дампом | +22 класса, +122 функции |
| coverage_bp_ratio | 0.9988 (849/850) |
| енумы из usmap сматчены с дампом | 1 794 из 1 834 (40 не были загружены) |
| кросс-проверка значений енумов дамп↔usmap | 1 537 сверено, 0 расхождений |
| строк дампа в счётчике неразобранных | 1 923 (значения енумов без префикса `Enum::`) |
| параметров функций слито с UHT (type_source=uht) | 1 194 + 775 возвратов, 35 out-параметров |
| ассетов из AssetRegistry | 5 536 (BP-ассетов: 850) |
| неразрешённые ссылки [ai:]/[pc:]/[ss:]/[em:]/[kp:][vp:]/[sps:]/[owr:] | все 0 |

## Решения и находки

- **Формат `AssetRegistry.bin` реверс-инжинирен целиком** (готового парсера не существует):
  заголовок (GUID, version=21, nameCount=13 241, blobSize), таблица имён
  (8-байтовые хэши + 2-байтовые заголовки `len=((b0&0x7f)<<8)|b1`, флаг UTF-16 `b0&0x80`,
  блоб строк), далее массив из 6 534 записей ассетов по 44 байта
  `{родительский путь, пакет класса, класс, путь пакета (бит 31 — флаг), имя ассета, теги…}`
  с редкими записями переменной длины (обход через ресинк). Имя ассета + класс берутся из
  записи; при дубле «ассет + сгенерированный класс» приоритет у не-генерированного класса.
- **Секция схем `.usmap` подтверждена по исходникам `USMapGenerator` UE4SS**: супер-класс —
  индекс ИМЕНИ (не схемы); после схем идёт расширение `CEXT` → `PPTH` с путями
  (`/Script/<модуль>`) для каждого енума/схемы — использовано для точного матчинга
  енумов на `objects.path`. Ветка добора супер-классов из usmap написана, но на этой
  сборке не срабатывает ни разу (`super_from_usmap = 0`): все 7 398 схем с супером
  ложатся на объекты, у которых `super_path` уже пришёл из дампа (`[sps:]`), а остальные
  833 схемы — блюпринтовые и не матчатся по имени+модулю. На данных код не проверен.
- **120 безадресных inner-строк** (все `DoubleProperty` + значения карт) резолвятся через
  близость: безадресная строка привязывается к последней висящей ссылке `[ai:]`/`[kp:]`/`[vp:]`
  в предыдущих 8 строках. Счётчик `dump_inner_no_addr=120` в `profile_meta`; после фикса
  все `unresolved_*` = 0.
- **`dump_unparsed_lines = 1923` — не потери данных.** В счётчик неразобранных строк
  попадают значения енумов в неквалифицированной форме (`[0000…] CIM_Linear [n: A651F]
  [v: 0]`, без префикса `Enum::`) — они не проходят `ENUM_VALUE_RE`. На индекс это не
  влияет: значения енумов берутся из `.usmap`. Единственное следствие — кросс-сверка
  дамп↔usmap идёт по 1 537 енумам из 1 794, для остальных в дампе нет сопоставимых строк.
- **Отпечаток версии (§8.2)**: уровень 1 — `statSync` exe+пака на каждый вызов инструмента;
  уровень 2 — `ProjectVersion` читается из пака TS-портом `wwpak.py` (`utils/pak-reader.ts`,
  без Python) + sha256 exe. Кэш — `state/game-fingerprint.json`.
- **Приоритет типов**: `type_source=uht` для нативных функций пяти игровых модулей
  (включая `is_out` по не-const ссылкам), иначе `objdump` (адресная карта `[pc:]`/`[ss:]`/…),
  остаток добирается из usmap (`usmap_filled_types=26`), иначе `none`.
- `ww_find_symbol`: FTS5+BM25 (8/4/2/1) в первую очередь; при нуле — LIKE-фолбэк
  (префиксный FTS не матчит середину слова: «research topic» → `SetResearchTopic`).
- Инкрементальная сборка: `state/build-fingerprint.json` (size+mtime→md5 входов);
  повторный `bun run setup` без `--force` пропускает сборку.

## Отклонения от плана

- **Юнит-тесты не писались** — правило `CLAUDE.md` («не пишем тесты») перекрывает пункт
  плана. Чистые функции (парсеры, нормализация путей, `compareVersions`, `buildFtsQuery`,
  рендер вывода) остаются без тестов; вместо них — смоук `smoke-client.ts` и приёмочные
  проверки в `setup.ts` (падают со статусом 2).
- `ww_verify_hook` принимает `live`, но проба в живой игре — фаза 2 (возвращает явную пометку).

## Что дальше (фаза 2)

Мост `WWBridge` + `bridge-client.ts`; расширение `ww_verify_hook` живой пробой и статусом
`not_found_possibly_not_loaded`; спайки 1–4 из §12.

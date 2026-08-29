# `object_path` в схеме индекса — часть B

Дата: 2026-08-29. Статус: ~~отложено, делать **вместе с фазой 3**~~ **сделано 2026-08-29**
(до фазы 3: индекс пересобран через `bun run setup --force`, схема 2, все критерии
готовности проверены). Источник: ревью фазы 1, баг 4. Часть A (слой вывода) уже сделана.

## Проблема

Индексатор проставляет `objects.hook_path` для енумов и структур:

```ts
if (row.kind === 'Enum' || row.kind === 'ScriptStruct') {
  row.hookPath = row.gameFullPath ?? `/Script/${row.path}`
  continue
}
```
— `src/scripts/index-reflection.ts`, ветка сборки хуковых путей.

По §9.1 спеки `hook_path` определён только для классов и функций: это путь для
`RegisterHook`. Для структуры и енума `/Script/Pkg.Name` — объектный путь
(`StaticFindObject`), хукать его нельзя. Сейчас в индексе 1 794 енума и 5 522 структуры
лежат с заполненным `hook_path` и `hook_path_status = 'ok'`.

## Что закрыла часть A

Слой вывода: `isHookable(kind)` в `src/tools/common.ts`, и все инструменты отдают такой
путь под именем `object_path`, а `ww_verify_hook` — со статусом `found_not_hookable`.
Агент больше не получает структуру как готовую цель хука.

**Чего часть A не закрывает:** в самой БД `hook_path` у структур остаётся. Любой будущий
код, который сверяет пути мода запросом `WHERE hook_path = ?`, примет структуру за
легальную цель. Ближайший такой потребитель — `ww_validate_mod` из фазы 4 (§11.3).

## Что надо сделать

1. **`src/schema.ts`**: `INDEX_SCHEMA_VERSION` 1 → 2. В таблицу `objects` добавить
   `object_path TEXT` и индекс `objects_object_path_idx ON objects(object_path)`.

2. **`src/scripts/index-reflection.ts`**, ветка сборки хуковых путей:
   - `Enum` / `ScriptStruct` → писать только `objectPath`, `hookPath` оставить `NULL`;
   - `Class`, `Function`, `*BlueprintGeneratedClass` → `hookPath` как сейчас, плюс
     `objectPath` (для класса совпадает с `hook_path`, для функции — путь с двоеточием,
     он валиден для `StaticFindObject`);
   - `Package` → оба `NULL`, как сейчас.
   Заодно завести счётчик в `profile_meta` — сколько объектов получили только
   `object_path`.

3. **`src/tools/common.ts`**, `findObject`: фолбэк по `gameFullPath` сейчас ищет строго
   по `hook_path`. Добавить поиск по `object_path`, иначе перестанут находиться
   BP-структуры и енумы, заданные в форме `/Game/...`.

4. **Упростить часть A**: `pathFields(kind, path)` вычисляет имя поля из `kind`. После
   правки схемы имя поля берётся из того, какая колонка непустая; `isHookable` остаётся
   нужен только для статуса `found_not_hookable` в `ww_verify_hook`.

5. **Пересборка**: бамп `INDEX_SCHEMA_VERSION` заставит `validateContract` отвергнуть
   текущий профиль с требованием пересобрать. Значит `bun run setup --force` обязателен —
   поэтому работа и привязана к фазе 3, где индекс пересобирается в любом случае
   (`datatables`, `loc_entries`, наполнение `assets`).

## Критерий готовности

- `SELECT COUNT(*) FROM objects WHERE kind IN ('Enum','ScriptStruct') AND hook_path IS NOT NULL` → `0`;
- `ww_verify_hook(["CoreUObject.EAutomationEventType"])` → `found_not_hookable` + `object_path`;
- `ww_verify_hook(["SystemCore.UnlockResearchComponent.SetResearchTopic"])` → `found` + `hook_path`
  (приёмка фазы 1 не должна деградировать);
- `ww_get_type` для BP-структуры, заданной путём `/Game/...`, по-прежнему её находит.

## Почему не сейчас

Отдельная пересборка индекса ради одной колонки — оплата той же работы дважды.
Риск отсрочки закрыт частью A: до фазы 4 единственный потребитель `hook_path` — вывод
инструментов, а он уже различает хукуемое и нехукуемое.

# Фаза 0 — результаты

Дата прогона: 2026-08-28, игра 0.6.190.0, UE4SS v3.0.1-1092 (experimental-latest).
Спецификация: `2026-08-27-whiskerwood-mcp.md` §12 «Фаза 0».

## Решения

- `profile_meta.type_source_primary` = **`uht`**. `GenerateUHTCompatibleHeaders()` отработал
  за 21 с без падения (Dumper-7 на этой игре падал; генератор UE4SS — нет). Оговорка: UHT
  покрывает только нативные модули, поэтому для BP-функций канонический источник типов —
  сам дамп (`type_source = 'objdump'`, см. ниже).
- `profile_meta.dump_captured_at` = **`in_level`** (мир `World /Game/Levels/ArcoPlay.ArcoPlay`,
  сохранение загружено человеком).

## Что сделано

1. Мод `AutoDump` расширен и задеплоен в `ue4ss/Mods/AutoDump/`, в `mods.txt` включён
   (`AutoDump : 1`). Каноническая копия — `bridge/AutoDump/Scripts/main.lua`.
   Логика: пост-хуки `RegisterInitGameStatePostHook` / `RegisterLoadMapPostHook`; при
   обнаружении мира с маркером `ArcoPlay` — отложенный на 60 с прогон трёх дамперов
   (USMAP → объекты → UHT) с повторной проверкой мира перед захватом; ручной триггер
   Ctrl+Alt+F9. Меню (`MainMenuBackdrop`) пропускается.
2. Прогон: старт → меню (хуки корректно скипнули) → загрузка сохранения →
   `level detected` → все три дампера `ok=true`, маркер `ALL DONE captured_at=in_level`.
   Логи прогона — `dumps/phase0-UE4SS.log`. Стабильность: один прогон, ноль падений;
   игра закрыта штатно после захвата.
3. `wwpak.py`: извлечено в `dumps/pak/` — `Content/Data/**` (122 файла: 61 таблица ×
   `.uasset`+`.uexp`, включая `TextDB/Loc_*` — 19 файлов: 17 языков плюс `Loc_Root`
   и `Loc_Dev`), `Whiskerwood/AssetRegistry.bin`, `Whiskerwood/Config/Default*.ini`
   (5 файлов).
4. Артефакты скопированы в репо:
   - `dumps/UE4SS_ObjectDump.txt` — дамп объектов **из уровня** (57,6 МБ);
   - `dumps/Whiskerwood-5.6.0-0+UE5-a1e7f571.in_level.usmap` — usmap из уровня;
   - `dumps/UHTHeaderDump/` — 22 063 файла (12 029 `.h`, 9 845 `.cpp`, 189 `.Build.cs`),
     12,8 МБ, 189 модулей: `ProjectArco` (1450 файлов), `SystemCore` (1051), `LowCore`,
     `NauticalKit`, `ShaderCore` — 2735 файлов игровых модулей, остальные 19 328 движковые.
     Только **нативные** типы: по логу `4454 native classes / 5462 native structs /
     1796 native enums`, BP-классов в UHT нет;
   - старые `dumps/GObjects-Dump*.txt` (меню) оставлены как второй снимок для union.

## Оценка UHT (пункт плана «оценить, есть ли типы, out, const, родители»)

| Вопрос | Ответ | Пример |
|---|---|---|
| Конкретные типы параметров | **да** | `static TArray<FWorkerSlot> GetWorkerInfoFromPrefab(const UObject* Context, FName prefabKey)` |
| Конкретные типы возвратов/массивов | **да** | `TArray<FName> GetUnlockPrerequisites(...)`, `FName GetResearchTopic() const` |
| `const` | **да** | `bool IsResearched(FName unlockId) const`; 69 const-методов в ProjectArco |
| Родители классов | **да** | `UArcoGameInstance : public UBackbone`, `UUnlockResearchComponent : public UActorComponent` |
| `out` | **частично**: `UPARAM(out)` не эмитируется (0 вхождений), но out-параметры видны как не-const lvalue-ссылки | `bool GetTechUnlock_outParam(const UObject* Context, FName Key, FTechUnlock_V2& outDef)` |

Параметр `Context` в статических функциях — артефакт генератора (Blueprint-функции);
`const UObject*` у него — надёжный маркер «это контекст, а не реальный аргумент».
Правило для фазы 1: `is_out = 1` для параметра-ссылки `T&` без `const`.

**Область действия UHT — только нативные модули.** Для 4055 BP-функций он не даёт ничего:
ни типов, ни `out`, ни `const`. Там источник типов — сам дамп (ниже), а `is_out` остаётся
недостоверным и пишется как 0.

## Снятие дампа из уровня: что изменилось против меню

- Строк с адресом: **308 319**, из них 108 687 — `*Property`; не-property объектов
  **199 632** (в меню 80 502) — добавились живые инстансы уровня. Плюс 120 строк без
  адресного префикса (см. ловушку ниже). Итоговые `objects_total` / `objects_indexed`
  считает парсер фазы 1, а не этот документ.
- `Function`: 15 664 (в меню 15 817); `Class`: 4455 (то же); `ScriptStruct`: 5523 (то же).
- BP-классы: **835** (428 `BlueprintGeneratedClass` + 407 `WidgetBlueprintGeneratedClass`)
  против 859 в меню. Часть меню-виджетов в уровне не загружена, часть level-only классов
  появилась только здесь. **Фаза 1: индексировать оба дампа union-ом**, покрытие считать
  против AssetRegistry (`coverage_bp_ratio`), статус `not_found_possibly_not_loaded`
  остаётся обязательным.

## ВАЖНО для фазы 1: формат дампа объектов изменился

Старая грамматика §14.1 описывает `GObjects-Dump-WithProperties.txt` (индентация,
короткие пути). Текущий UE4SS пишет `UE4SS_ObjectDump.txt` — плоский формат, полные
`/Script/`-пути, связь член→владелец через адрес:

```
[00007FF3F0890070] Class /Script/CoreUObject.Object [n: 20B] [c: 00007FF3F0892FC0] [or: 00007FF3F0ABDA38] [sps: 0000000000000000]
[00007FF3F0C30170] Function /Script/CoreUObject.Object:ExecuteUbergraph [n: 35B] [c: ...] [or: 00007FF3F0890070] [f: ...]
[00000255B39E08D0] IntProperty /Script/CoreUObject.Object:ExecuteUbergraph:EntryPoint [o: 0] [n: A7834] [c: ...] [owr: 00007FF3F0C30170]
```

Теги: `[o:]` офсет, `[or:]` outer, `[sps:]` super, `[owr:]` владелец члена, `[pc:]` класс
ObjectProperty, `[ss:]` структура StructProperty, `[ai:]` inner ArrayProperty (указывает
на отдельную строку inner-типа), `[fm:]/[bm:]` маска BoolProperty. Типы резолвятся по
адресу `[pc:]/[ss:]` через карту адрес→путь из того же файла — конкретные типы свойств
теперь есть **прямо в дампе**, usmap для свойств остаётся перекрёстной проверкой.
Парсер фазы 1 писать под этот формат; старый файл парсится по грамматике §14.1 для union.

### Ловушка: 120 inner-строк без адресного префикса

Inner-тип `ArrayProperty`, на который указывает `[ai:]`, обычно лежит отдельной полноценной
строкой. Но в 120 случаях (все — `DoubleProperty`) префикс с адресом отсутствует:

```
[00000255C77DFD80] ArrayProperty /Script/Landscape.LandscapeComponent:MipToMipMaxDeltas [o: 608] ... [ai: 00000255C77B9930]
DoubleProperty MipToMipMaxDeltas./Script/Landscape.LandscapeComponent:MipToMipMaxDeltas
```

Строгий regex такую строку не уронит — **молча пропустит**. Дальше `[ai:]` повиснет на
адрес, которого нет в карте, и тип массива станет `unknown` без единой ошибки в логе.
Требования к парсеру:

1. Принимать обе формы inner-строки.
2. Помнить, что имя inner-строки — это `<PropName>.<полный путь владельца>`; точка внутри
   **не разделитель пути**, наивный `split('.')` даёт мусорный `package`.
3. Считать нерезолвленные `[ai:]`/`[pc:]`/`[ss:]` и писать счётчик в `profile_meta` —
   молчаливое проглатывание здесь неотличимо от корректной работы.

## Существенное для фазы 1: два допущения плана больше не верны

**1. `/Game`-пути есть прямо в дампе — 153 980 вхождений.** §6.2 плана обосновывал перенос
`AssetRegistry.bin` в фазу 1 тем, что строка `/Game` встречается в дампе ноль раз. Для
Dumper-7 это так; для нового дампа — нет:

```
[00000255E7F61BA0] WidgetBlueprintGeneratedClass /Game/UI/DebugUI_Components/MouseMessageBlip.MouseMessageBlip_C ...
[00000255EBA83900] Function /Game/UI/DebugUI_Components/MouseMessageBlip.MouseMessageBlip_C:Construct ...
```

Это готовый `hook_path` в форме §9.1, без джойна. AssetRegistry остаётся в фазе 1, но как
знаменатель `coverage_bp_ratio` (13 241 ассет против 835 загруженных классов) и
перекрёстная проверка, а не как блокер. Риск №1 из §13 понижается до низкого.

Побочное следствие для union со старым дампом: BP-классы, найденные **только** в
меню-снимке, придут без `/Game`-пути и всё равно получат `found_hook_path_unavailable`.
Выигрыш union — 24 класса; стоит взвесить против цены второго парсера, альтернатива —
второй прогон в новом формате из меню.

**2. Типы параметров функций резолвятся из дампа, и для BP это единственный источник.**
Пример из §6.1 («`ArrayProperty ReturnValue` — массив ЧЕГО?») закрывается:

```
[00000255C7CFF880] ArrayProperty ...:GetRecipesWithOutput:ReturnValue [ai: 00000255C7CE4920]
[00000255C7CE4920] NameProperty  ReturnValue./Script/ProjectArco.ArcoGameInstance:GetRecipesWithOutput:ReturnValue
```

→ `TArray<FName>`. Поскольку UHT покрывает только нативные типы, а `.usmap` не содержит
UFunction вовсе, для 4055 BP-функций дамп — единственный источник. Отсюда правка схемы:
enum `type_source` расширяется значением **`objdump`** (`objdump|uht|usmap|runtime|none`).
Ставить `none` при фактически известном типе значит врать в консервативную сторону на
блюпринтовой половине игры.

## Замечания по стенду (воспроизводимость прогона)

- Аргумент командной строки с картой (`/Game/Levels/ArcoPlay`) игра **игнорирует** —
  всегда стартует в `MainMenuBackdrop`; для in-level захвата нужна загрузка сохранения.
- Процесс, запущенный из-под песочницы агента, наследует ограничение записи и падает с
  `UE4SS.log | error: [0x5] Access is denied`. Запуск игры — только вне песочницы.
- Выход UHT — `ue4ss/UHTHeaderDump/<Module>/Public/*.h`, не `CppSDK/` (папка `dumps/CppSDK`
  в репо — мёртвый артефакт Dumper-7).

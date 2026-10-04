import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { readdirSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { ServerConfig, Toolset } from './config'
import { toolsetEnabled } from './toolsets'

const LOOM_TEMPLATE_URI = 'ww://templates/loom'
const LOOM_TEMPLATE_DIR = `${import.meta.dir}/../data/templates/loom`
const LOOM_TEMPLATE_EXT = '.lm.tpl'
const T = LOOM_TEMPLATE_URI

const NEW_MOD = (goal: string, modName: string) => `Собери мод Whiskerwood под UE4SS: ${goal}

Имя мода: ${modName}. Работай строго по этому порядку, не пропуская шагов.

0. ww_memory_wakeup, затем ww_memory_search по теме задачи. Половина ответов может быть
   уже записана: какие подсистемы игры не работают, какие идиомы UE4SS здесь ломаются,
   что решали в соседних модах. Не выясняй заново то, что уже выяснено.
1. ww_index_status — убедись, что профиль свежий. Если fingerprint не fresh, остановись
   и передай управление человеку (см. промпт ww:fix-after-patch).
2. ww_game_status — если игра запущена, весь цикл проверяем вживую; если нет, работаем
   по индексу, а живую проверку отложи до запуска.
3. Разведка API. Не бери имена функций из строк бинарника и не выдумывай их:
   ww_find_symbol по смыслу задачи, затем ww_get_type на найденных классах,
   затем ww_get_function на конкретных функциях. Отдельно проверь, нет ли в игре
   родной подсистемы под задачу (уведомления, индикаторы проблем, тултипы) —
   самодельный UMG-оверлей это последний вариант, а не первый.
4. Тексты для UI бери через ww_resolve_loc, числа и ключи — через ww_get_datatable.
   Игровой текст бери ключом из игры, а не переводи сам. Свои строки можно писать
   в Lua прямо по-русски: в FString-параметр кириллица проходит Lua-строкой без потерь,
   а FText собирай через KismetTextLibrary:Conv_StringToText — сырая строка в FText роняет игру.
5. ww_lua_api по каждому используемому механизму UE4SS: там записаны грабли,
   которые в коде не видны.
6. ww_verify_hook одним вызовом со ВСЕМИ путями будущего мода. hook_path копируй из
   ответа буквально — собирать путь самостоятельно запрещено.
7. ww_scaffold_mod (mod_root = <репозиторий модов>/mods/${modName}), затем
   ww_generate_hook на каждую хукаемую функцию и правка Scripts/main.lua.
8. ww_validate_mod — до нуля ошибок. Предупреждения либо чини, либо объясни, почему они
   допустимы именно здесь.
9. ww_deploy_mod при запущенной игре, затем ww_game_log и ww_game_eval —
   убедись, что мод не просто загрузился, а сработал. UI и визуал правь по ww_ui_tree:
   он показывает структуру и значения родных панелей, ручной обход виджетов запрещён.
10. ww_memory_add — запиши то, что нельзя вывести из кода:
    decision на каждый неочевидный выбор хука или подсистемы, pitfall на каждую
    потраченную впустую попытку (с тегом-идентификатором: он станет триггером линта),
    todo на всё непроверенное. mod_name: ${modName} ставь только на записи про сам мод;
    выясненное про игру и UE4SS пиши без mod_name — оно пригодится любому моду.
    Погашенное патчем чисти через ww_memory_invalidate.
11. Итог запиши коротко: какие пути захвачены, что проверено вживую, что осталось непроверенным.`

const NEW_LOOM_MOD = (goal: string, modName: string) => `Собери мод Whiskerwood на Loom (Blueprint → .pak, игрокам UE4SS не нужен): ${goal}

Имя мода: ${modName}. Работай строго по этому порядку, не пропуская шагов.

0. ww_memory_wakeup, затем ww_memory_search по теме задачи и по слову loom. Часть ответов уже
   записана: грабли языка и кита, что в игре не работает, какие точки реакции уже находили.
   Не выясняй заново то, что уже выяснено.
1. ww_loom_status — кит, loom.exe, types.json, движок, открыт ли редактор. Ответ
   kit_not_configured — это не поломка стенда, а незаданный kitDir: остановись и передай
   управление человеку (скилл /ww-setup). Если types.json старше пака игры, кит отстал от
   патча: Blueprint соберутся против старых сигнатур — скажи об этом до начала работы.
2. ww_index_status — профиль должен быть свежим: ww_lift читает игру через .usmap, а .usmap
   от прошлой версии молча даёт пустые или неверные тела функций.
3. Разведка. Имена классов и функций не выдумывай: ww_find_symbol и ww_find_asset, затем
   ww_lift — логика игрового Blueprint приходит уже на языке мода. Где lift оставил заглушку
   «not lifted», добирай ww_get_bytecode. Поля и сигнатуры — ww_get_type и ww_get_function.
4. ww_event_surface по классу или подсистеме: что можно подписать и что переопределить, в
   порядке предпочтения — делегаты ModAPI (onLoadingFinished, onBuildingSpawned,
   onWhiskerSpawned, onOptionChanged, onDayStart), затем BlueprintAssignable-диспетчеры самого
   класса и объектов в его полях, затем события, которые переопределяет наследник (и спавнит
   ли игра этот наследник), и только последним средством Tick с bTickEvenWhenPaused и
   TG_PostUpdateWork. Tick по умолчанию — признак того, что разведка не закончена.
5. Точный вызов бери из ww_get_function: поле loom_call уже собрано под Loom — копируй его
   буквально, сам вызов не собирай, как и hook_path. Цепочку проверяй вживую за секунды:
   ww_call с bp_only: true (откажет там, куда Blueprint не дотянется) и ww_trace_calls
   (срабатывает ли событие и как часто).
6. Файлы мода: <кит>/Content/Mods/${modName}/ — ${modName}.uplugin, PAL_${modName}.uasset и
   сами .lm. Если папки мода ещё нет, создай её одним вызовом ww_loom_new_mod action=create
   mod_name=${modName} templates=[…]: он заводит PAL с уникальным chunk id (без него .pak не
   соберётся), .uplugin и выбранные заготовки из шага 7, а ответ running дожидайся через
   action=status job_id=…. Ответ editor_open — редактор с китом открыт: тогда мод создаёт
   человек в нём (правый клик по Content/Mods → New mod...), заготовки кладёшь сам. Папку
   существующего мода инструмент не трогает (mod_exists). Совпадение папки, .uplugin, PAL,
   первой строки каждого .lm и будущего .pak проверяет ww_loom_validate.
7. Заготовки .lm — ресурсы этого MCP-сервера (resources/list, resources/read):
   ${T}/BP_Startup — DataTable, RegisterModOptions;
   ${T}/BP_MapLoad — onLoadingFinished, Tick;
   ${T}/BP_MainMenuLoad;
   ${T}/HudOverlay и ${T}/WBP_Overlay — оверлей в ряду HUD.
   Бери их, а не пиши с нуля (ww_loom_new_mod кладёт их сам по templates); <Мод> в них
   заменяется именем папки мода, а файл называется по строке blueprint внутри. HudOverlay — вариант BP_MapLoad для мода с оверлеем: он ложится
   как BP_MapLoad.lm вместо шаблона BP_MapLoad и только в паре с WBP_Overlay
   (WBP_<Мод>Overlay.lm).
8. Синтаксис бери только из справки Loom (loom-mcp: docs и docs_search; исходники —
   reference/*.md в <loom-src>), там примеры проверены тестами. Один .lm — один ассет, первая
   строка «blueprint X : Parent at /Game/Mods/${modName}/X» обязана совпадать с путём файла.
   Файл пиши без BOM: Loom отказывается его разбирать («unexpected character»).
9. Грабли, которых check не видит, проверь по своему коду каждую: не наследовать игровой
   виджет (Loom_Canvas перекроет дерево родителя, и в игре виджет будет пустым); не
   переопределять функцию с возвращаемым значением; не писать \\n в значении переменной по
   умолчанию; не трогать мир в BP_MapLoad до onLoadingFinished; не присваивать поля
   DeprecateSlateVector2D (например SlateBrush.ImageSize).
10. ww_loom_validate — до нуля ошибок и предупреждений. missing на игровых BP — не ошибка,
   их подгружает сборка.
11. ww_loom_build — сборка Blueprint и её отчёт. При провале читай report.json и разбор
   инструмента, а не гадай; неудачная сборка может уронить редактор на следующей.
   Зависшую headless-сборку снимает action=cancel.
12. ww_loom_install: action=start mod_name=${modName} — cook джобом; action=status job_id=… —
   прогресс, найденный пак и проверки, ничего не копирует; при ready_to_install —
   action=install job_id=… кладёт .pak в <saved>/mods/${modName}. Без job_id, с одним
   mod_name, status и install берут уже собранный пак, на исход прошлых cook не смотрят. Затем
   ww_game_process restart save=<имя сейва> wait_for=world: .pak подхватывается только при
   старте игры, горячей перезагрузки у него нет.
13. Проверка в игре: ww_game_log с source=modlog по префиксу мода (LogMessage — единственный
   канал из shipping-сборки), ww_ui_tree и ww_screenshot для HUD, ww_trace_calls по своим
   функциям. Ошибки Blueprint игра глушит молча: «мод не работает» без строк в modlog — тоже
   результат, и причину ищи по шагам 9–11.
14. ww_memory_add — запиши то, что нельзя вывести из кода: decision на каждую выбранную точку
   реакции, pitfall на каждую потраченную впустую попытку (с тегом-идентификатором: он станет
   триггером линта), todo на всё непроверенное. mod_name: ${modName} ставь только на записи про
   сам мод; выясненное про игру, Loom и кит пиши без mod_name — оно пригодится любому моду.
15. Итог запиши коротко: какие файлы мода созданы, какие точки реакции взяты и чем
   подтверждены, что проверено в игре, что осталось непроверенным.`

const PORT_TO_LOOM = (luaMod: string, modName: string) => `Перенеси Lua-мод Whiskerwood ${luaMod} на Loom: тот же мод, но Blueprint → .pak, без UE4SS у игрока.

Имя Loom-мода: ${modName}. Работай строго по этому порядку, не пропуская шагов.

0. ww_memory_wakeup, затем ww_memory_search по теме мода и по слову loom: что уже известно про
   этот мод, про его подсистемы и про переносы Lua → Blueprint.
1. Прочитай Lua-мод (Scripts/*.lua) и выпиши каждый RegisterHook: путь функции, что мод делает
   в колбэке, что читает и что меняет. Это и есть список того, что должно появиться в Loom;
   без него дальше идти нельзя.
2. ww_loom_status и ww_index_status: кит, types.json, редактор, свежесть профиля. При
   kit_not_configured остановись и передай управление человеку (скилл /ww-setup).
3. Каждый RegisterHook заменяй точкой реакции, а не хуком: Blueprint не хукает, и «повесить
   хук» здесь нечего. По каждой функции — ww_event_surface по её классу или подсистеме, в
   порядке предпочтения: делегаты ModAPI (onLoadingFinished, onBuildingSpawned,
   onWhiskerSpawned, onOptionChanged, onDayStart) → BlueprintAssignable-диспетчеры класса и
   объектов в его полях → события, которые переопределяет наследник (и спавнит ли игра этот
   наследник) → и только последним средством Tick с bTickEvenWhenPaused и TG_PostUpdateWork.
   Если точки реакции у функции нет, скажи это вслух, а не тащи её в Tick молча.
4. Что Lua делал через API, недоступный Blueprint, проверь отдельно: ww_get_function (поле bp)
   и ww_find_symbol с bp_only: true. Недостижимое из Blueprint заменяют другим путём — данные
   через DataTable ModAPI, поведение через переопределение события, — а не переносят как есть.
5. Точный вызов бери из ww_get_function: поле loom_call уже собрано под Loom, копируй его
   буквально. Цепочку проверяй вживую: ww_call с bp_only: true и ww_trace_calls.
6. Сверяй поведение с оригиналом, пока он жив: ww_validate_mod (пути хуков целы), ww_game_eval,
   ww_game_log (source=ue4ss для Lua-мода и source=modlog для Loom-мода), ww_ui_tree. Одно и то
   же действие на одном сейве должно давать одинаковый результат в обоих логах.
7. Дальше цикл Loom-мода, как в промпте ww:new-loom-mod: папку мода с PAL, .uplugin и
   заготовками создаёт ww_loom_new_mod action=create mod_name=${modName} (при открытом
   редакторе — «New mod...» в нём), заготовки .lm — ресурсы этого MCP-сервера ${T}/<имя>
   (список — resources/list), справка
   по языку из loom-mcp (docs, docs_search), затем ww_loom_validate → ww_loom_build →
   ww_loom_install (start → status → install) →
   ww_game_process restart save=<имя сейва> wait_for=world → ww_game_log с source=modlog.
8. ww_memory_add: перенесённые грабли, найденные точки реакции и то, что из Lua в Loom не
   переносится. mod_name: ${modName} ставь только на записи про сам мод; выясненное про игру,
   Loom и UE4SS пиши без mod_name — оно пригодится любому моду.
9. Итог запиши таблицей: хук в Lua → точка реакции в Loom → чем подтверждено. Отдельно —
   что перенести не удалось и почему.`

const FIX_AFTER_PATCH = (modsGlob: string) => `Игра обновилась. Проверь, что сломалось в модах (${modsGlob}).

1. ww_index_status. Если профиль устарел (game_version индекса не совпадает с игрой либо
   fingerprint не fresh) — ОСТАНОВИСЬ. Предложи человеку запустить скилл /ww-update-index
   и дождись согласия; сам индекс не пересобирай и не выполняй его шаги вручную —
   переиндексация это отдельный контур, отдельно запускаемый человеком.

2. ww_memory_wakeup — что уже известно про эти моды и прошлые патчи.
3. Когда профиль свежий: ww_diff_versions(from: прошлая версия, to: новая) — если обе
   собраны. Смотри в первую очередь на signature_changed и removed без пометки
   blueprint: у BP-классов отсутствие в дампе означает «не было загружено», а не «удалено».
4. По каждому Lua-моду: ww_validate_mod. Пути, ставшие not_found, перепроверь через
   ww_verify_hook и, при запущенной игре, с live: true — BP-класс может быть просто
   не загружен, и это не поломка. У мода с dlls/main.dll индекс нативную часть не проверяет:
   AOB-сигнатуры и смещения полей ломаются молча. Смотри её строки в ww_game_log после
   перезапуска игры; чинится пересборкой native/, затем ww_deploy_mod и перезапуск.
5. По каждому моду на Loom (Blueprint, .pak) — ww_loom_status. Читай поля, а не общий вердикт:
   kit_classes_missing_from_game или kit_functions_missing_from_game > 0 — кит отстал от патча,
   и Loom соберёт мод против несуществующих сигнатур; functions_params_differ > 0 — разошёлся
   состав параметров; bp_events_missing_from_kit > 0 — из кита пропало переопределяемое событие;
   bp_callable_missing_from_kit > 0 сам по себе поломкой не является (Loom этих функций просто
   не видит), но если мод их вызывает — вызов надо убрать или заменить, сверяясь с
   ww_get_function и ww_get_type. Если кит разошёлся, его обновляет человек: стабы едут из
   патча кита, в редакторе их не пересобрать; после обновления кита нужна сборка Blueprint в
   редакторе. Дальше по моду: ww_loom_validate → ww_loom_build → ww_loom_install (start →
   status → install). Сборка против
   старых стабов проходит без ошибок и ломается уже у игрока — поэтому этот шаг не пропускай.
   Если пришло diff: skipped, сверки не было: причину читай в diff_reason, а индекс или кит
   чинит человек.
6. Чини только то, что действительно сломалось: новый hook_path бери из ww_get_function,
   не переписывай логику мода заодно.
7. После правок — ww_validate_mod и, если игра запущена, ww_deploy_mod с
   проверкой через ww_game_log.
8. Память приведи в соответствие с новой версией: ww_memory_invalidate на записи,
   которые патч опроверг (в reason укажи версию), ww_memory_add на то, что сломалось
   и как чинилось — на следующем патче это первое, что понадобится. Изменения в игре
   пиши без mod_name, правки конкретного мода — с ним.`

export const PROMPT_GROUPS: Record<string, Toolset> = {
  'ww:new-mod': 'lua',
  'ww:new-loom-mod': 'loom',
  'ww:port-to-loom': 'loom',
  'ww:fix-after-patch': 'recon',
}

export interface LoomTemplate {
  name: string
  uri: string
  file: string
  description: string
}

function templateDescription(text: string): string {
  const lines: string[] = []
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const m = /^\/\/\s?(.*)$/.exec(raw.trim())
    if (!m || m[1].trim().length === 0) break
    lines.push(m[1].trim())
  }
  return lines.join(' ')
}

export function loomTemplates(): LoomTemplate[] {
  let files: string[]
  try {
    files = readdirSync(LOOM_TEMPLATE_DIR).filter((f) => f.endsWith(LOOM_TEMPLATE_EXT)).sort()
  } catch {
    return []
  }
  return files.map((f) => {
    const name = f.slice(0, -LOOM_TEMPLATE_EXT.length)
    const file = `${LOOM_TEMPLATE_DIR}/${f}`
    let description = ''
    try {
      description = templateDescription(readFileSync(file, 'utf8'))
    } catch {}
    return { name, uri: `${LOOM_TEMPLATE_URI}/${name}`, file, description }
  })
}

/** Шаблоны .lm — ресурсы группы loom, своего инструмента у них нет. */
export function registerResources(server: McpServer, config: ServerConfig): void {
  if (!toolsetEnabled(config, 'loom')) return
  for (const t of loomTemplates()) {
    server.registerResource(
      `loom-template-${t.name}`,
      t.uri,
      {
        title: `Шаблон Loom: ${t.name}`,
        description: t.description.length > 0 ? t.description : `Заготовка ${t.name}.lm`,
        mimeType: 'text/plain',
      },
      (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: readFileSync(t.file, 'utf8') }] }),
    )
  }
}

export function registerPrompts(server: McpServer, config: ServerConfig): void {
  const enabled = (name: string): boolean => {
    const group = PROMPT_GROUPS[name]
    return !group || toolsetEnabled(config, group)
  }

  if (enabled('ww:new-mod')) {
    server.registerPrompt(
      'ww:new-mod',
      {
        title: 'Новый мод Whiskerwood',
        description:
          'Полный цикл создания мода: разведка API по индексу, проверка путей хуков, скаффолд, валидация, dev-развёртывание и проверка в живой игре.',
        argsSchema: {
          goal: z.string().describe('Что мод должен делать, одной-двумя фразами'),
          mod_name: z.string().describe('Имя мода: латиница, цифры, дефис (станет именем каталога)'),
        },
      },
      ({ goal, mod_name }) => ({
        messages: [{ role: 'user', content: { type: 'text', text: NEW_MOD(goal, mod_name) } }],
      }),
    )
  }

  if (enabled('ww:fix-after-patch')) {
    server.registerPrompt(
      'ww:fix-after-patch',
      {
        title: 'Починка модов после патча игры',
        description:
          'Проверка актуальности профиля, явная передача управления человеку на пересборку индекса, затем поиск и починка сломанных путей во всех модах, включая сверку кита Loom с индексом.',
        argsSchema: {
          mods: z.string().optional().describe('Какие моды проверять; по умолчанию все в mods/'),
        },
      },
      ({ mods }) => ({
        messages: [{ role: 'user', content: { type: 'text', text: FIX_AFTER_PATCH(mods ?? 'все моды в mods/') } }],
      }),
    )
  }

  if (enabled('ww:new-loom-mod')) {
    server.registerPrompt(
      'ww:new-loom-mod',
      {
        title: 'Новый мод Whiskerwood на Loom',
        description:
          'Полный цикл мода на Loom: кит и types.json, разведка через ww_lift и ww_event_surface, заготовки .lm, проверка исходника, сборка Blueprint, cook и установка .pak, проверка по modlog.',
        argsSchema: {
          goal: z.string().describe('Что мод должен делать, одной-двумя фразами'),
          mod_name: z.string().describe('Имя мода: как папка в Content/Mods, так и .uplugin с PAL'),
        },
      },
      ({ goal, mod_name }) => ({
        messages: [{ role: 'user', content: { type: 'text', text: NEW_LOOM_MOD(goal, mod_name) } }],
      }),
    )
  }

  if (enabled('ww:port-to-loom')) {
    server.registerPrompt(
      'ww:port-to-loom',
      {
        title: 'Перенос Lua-мода на Loom',
        description:
          'Перенос мода с Lua на Loom: каждый RegisterHook превращается в точку реакции через ww_event_surface, недостижимое из Blueprint находится заранее, поведение сверяется с оригиналом вживую.',
        argsSchema: {
          lua_mod: z.string().describe('Имя или каталог Lua-мода, который переносим'),
          mod_name: z.string().optional().describe('Имя Loom-мода; по умолчанию совпадает с Lua-модом'),
        },
      },
      ({ lua_mod, mod_name }) => ({
        messages: [
          { role: 'user', content: { type: 'text', text: PORT_TO_LOOM(lua_mod, mod_name ?? lua_mod) } },
        ],
      }),
    )
  }
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ServerConfig } from './config'
import { createGameContext, GameContext } from './utils/game-context'
import { errorText } from './utils/ai-text'
import { handleFindSymbol } from './tools/find-symbol'
import { handleSearchMembers } from './tools/search-members'
import { handleGetType } from './tools/get-type'
import { handleGetFunction } from './tools/get-function'
import { handleVerifyHook } from './tools/verify-hook'
import { handleIndexStatus } from './tools/index-status'
import { handleGameStatus } from './tools/game-status'
import { handleGameEval } from './tools/game-eval'
import { handleUiTree } from './tools/ui-tree'
import { handleTraceCalls } from './tools/trace-calls'
import { handleGameConsole } from './tools/game-console'
import { handleGameLog } from './tools/game-log'
import { handleGetDataTable } from './tools/get-datatable'
import { handleResolveLoc } from './tools/resolve-loc'
import { handleFindAsset } from './tools/find-asset'
import { handleExtractAsset } from './tools/extract-asset'
import { handleLuaApi } from './tools/lua-api'
import { handleScaffoldMod, TEMPLATES } from './tools/scaffold-mod'
import { handleGenerateHook } from './tools/generate-hook'
import { handleValidateMod } from './tools/validate-mod'
import { handleDeployMod } from './tools/deploy-mod'
import { handlePackageMod, PackageModArgs } from './tools/package-mod'
import { handleDiffVersions } from './tools/diff-versions'
import { handleMemoryWakeup } from './tools/memory-wakeup'
import { handleMemorySearch } from './tools/memory-search'
import { handleMemoryAdd } from './tools/memory-add'
import { handleMemoryInvalidate } from './tools/memory-invalidate'
import { MEMORY_CATEGORIES } from './utils/memory-db'
import { registerPrompts } from './prompts'

const READ_ONLY = { readOnlyHint: true, openWorldHint: false }
const LIVE_READ = { readOnlyHint: true, openWorldHint: true }
const LIVE_WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true }

export function createServer(config: ServerConfig): McpServer {
  const server = new McpServer({ name: 'whiskerwood-mcp', version: '0.1.0' })

  const wrap =
    <A extends { version?: string }>(fn: (ctx: GameContext, args: A) => string) =>
    async (args: A) => {
      try {
        const ctx = await createGameContext(config, args.version)
        const text = fn(ctx, args)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { content: [{ type: 'text' as const, text: errorText('server_error', 'error', msg) }], isError: true }
      }
    }

  const wrapAsync =
    <A extends { version?: string }>(fn: (ctx: GameContext, args: A) => Promise<string>) =>
    async (args: A) => {
      try {
        const ctx = await createGameContext(config, args.version)
        const text = await fn(ctx, args)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { content: [{ type: 'text' as const, text: errorText('server_error', 'error', msg) }], isError: true }
      }
    }

  // Bridge-инструменты не должны падать из-за сломанного или устаревшего индекса:
  // именно тогда живая игра и нужна для диагностики.
  const wrapBridge =
    <A extends { version?: string }>(fn: (ctx: GameContext | null, args: A) => Promise<string>) =>
    async (args: A) => {
      let ctx: GameContext | null = null
      try {
        ctx = await createGameContext(config, args.version)
      } catch {
        ctx = null
      }
      try {
        const text = await fn(ctx, args)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { content: [{ type: 'text' as const, text: errorText('server_error', 'error', msg) }], isError: true }
      }
    }

  // Память и сравнение версий живут вне профиля: им не нужен готовый индекс текущей версии.
  const wrapPlain =
    <A>(fn: (args: A) => string) =>
    async (args: A) => {
      try {
        return { content: [{ type: 'text' as const, text: fn(args) }] }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { content: [{ type: 'text' as const, text: errorText('server_error', 'error', msg) }], isError: true }
      }
    }

  const versionParam = z
    .string()
    .optional()
    .describe('Версия игры (профиль индекса). По умолчанию — единственный/старший готовый профиль.')

  server.registerTool(
    'ww_find_symbol',
    {
      title: 'Поиск символа',
      description:
        'Первый вызов, когда точное имя класса, функции, структуры или енума неизвестно. Полнотекстовый поиск по индексу рефлексии. Используй ДО обращения к точным инструментам и ДО написания хуков. Не угадывай имена из строк бинарника — многие существуют в ассетах, но отсутствуют в рефлексии.',
      inputSchema: {
        pattern: z.string().describe('Имя или его часть, можно несколько слов через пробел'),
        kind: z
          .string()
          .optional()
          .describe('Фильтр вида: Class | ScriptStruct | Enum | Function | Package | bp'),
        package: z.string().optional().describe('Фильтр по пакету/модулю, например SystemCore'),
        limit: z.number().int().positive().max(200).optional(),
        version: versionParam,
      },
      annotations: READ_ONLY,
    },
    wrap((ctx, args) => handleFindSymbol(ctx, args)),
  )

  server.registerTool(
    'ww_search_members',
    {
      title: 'Обратный поиск по членам',
      description:
        'Обратный поиск: в каком классе есть поле или метод с таким именем. Сценарий «знаю что ищу, не знаю где». Для поиска самих классов/функций предпочти ww_find_symbol.',
      inputSchema: {
        pattern: z.string().describe('Имя поля или метода. По умолчанию ищется как подстрока; символ % задаёт свой шаблон, подчёркивание трактуется буквально'),
        member_kind: z.enum(['field', 'method', 'any']).optional(),
        limit: z.number().int().positive().max(200).optional(),
        version: versionParam,
      },
      annotations: READ_ONLY,
    },
    wrap((ctx, args) => handleSearchMembers(ctx, args)),
  )

  server.registerTool(
    'ww_get_type',
    {
      title: 'Информация о типе',
      description:
        'Class / ScriptStruct / Enum целиком: поля с офсетами и типами, родитель, список методов, наследники; для енума — значения. Путь принимается в любой форме (индексной, /Script/..., /Game/...). Для сигнатуры отдельной функции предпочти ww_get_function.',
      inputSchema: {
        path: z.string().describe('Путь типа в любой форме'),
        version: versionParam,
      },
      annotations: READ_ONLY,
    },
    wrap((ctx, args) => handleGetType(ctx, args)),
  )

  server.registerTool(
    'ww_get_function',
    {
      title: 'Сигнатура функции',
      description:
        'Точная сигнатура функции: параметры по порядку, типы с источником (uht/objdump/usmap/none), out-параметры, возврат, и всегда — готовый hook_path для RegisterHook. НЕ собирай hook_path самостоятельно — копируй из ответа.',
      inputSchema: {
        path: z.string().describe('Путь функции в любой форме'),
        version: versionParam,
      },
      annotations: READ_ONLY,
    },
    wrap((ctx, args) => handleGetFunction(ctx, args)),
  )

  server.registerTool(
    'ww_verify_hook',
    {
      title: 'Проверка хуковых путей',
      description:
        'Ключевой инструмент: батч-проверка путей хуков ПЕРЕД записью кода мода. Принимает пути в любой форме, нормализует и сверяет с индексом. Вызывай со всеми путями мода одним вызовом. Статусы: found | found_not_hookable | found_hook_path_unavailable | not_found | not_found_possibly_not_loaded; при found_not_hookable отдаётся object_path для StaticFindObject, хукать его нельзя. Похожие имена идут в suggestions и заменой найденному не являются.',
      inputSchema: {
        paths: z.array(z.string()).min(1).describe('Проверяемые пути (до 50 за вызов)'),
        live: z
          .boolean()
          .optional()
          .describe('Дополнительно пробить каждый путь в запущенной игре через мост WWBridge'),
        version: versionParam,
      },
      annotations: READ_ONLY,
    },
    wrapAsync((ctx, args) => handleVerifyHook(ctx, config, args)),
  )

  server.registerTool(
    'ww_index_status',
    {
      title: 'Состояние индекса',
      description:
        'Версия игры и профиля, свежесть по отпечатку файлов, источник типов, место снятия дампа, покрытие BP-классов и счётчики фильтрации. Вызывай, когда нужно понять, актуален ли индекс после патча игры.',
      inputSchema: {
        version: versionParam,
      },
      annotations: READ_ONLY,
    },
    wrap((ctx) => handleIndexStatus(ctx, config)),
  )

  server.registerTool(
    'ww_get_datatable',
    {
      title: 'DataTable игры',
      description:
        'Баланс игры из Content/Data: без аргументов — список всех таблиц с числом строк; с name — строки таблицы; с name+row — одна строка целиком; с row_pattern — поиск ключа строки по всем таблицам. Значения приходят как JSON, разобранный CUE4Parse по .usmap. Таблицы локализации (kind=loc) читай через ww_resolve_loc.',
      inputSchema: {
        name: z.string().optional().describe('Имя таблицы, например TechUnlocksV2'),
        row: z.string().optional().describe('Точное имя строки — вернёт её целиком'),
        row_pattern: z.string().optional().describe('Часть имени строки; символ % задаёт свой шаблон'),
        limit: z.number().int().positive().max(200).optional(),
        version: versionParam,
      },
      annotations: READ_ONLY,
    },
    wrap((ctx, args) => handleGetDataTable(ctx, args)),
  )

  server.registerTool(
    'ww_resolve_loc',
    {
      title: 'Текст по ключу локализации',
      description:
        'Ключ локализации → текст. Локализация в Whiskerwood сделана таблицами Loc_* (18 языков), а не .locres. Принимает точный ключ, шаблон ключа или слова из текста. lang по умолчанию из конфига (En,Ru), lang="all" — все языки. В Lua передавай уже готовую строку: Utf8String на 5.6 не работает.',
      inputSchema: {
        key_or_pattern: z.string().describe('Ключ вида mod.desc.starvation, его часть или слова из текста'),
        lang: z.string().optional().describe('Языки через запятую (En, Ru, De, Zh-Tw, …) либо all'),
        limit: z.number().int().positive().max(200).optional(),
        version: versionParam,
      },
      annotations: READ_ONLY,
    },
    wrap((ctx, args) => handleResolveLoc(ctx, config, args)),
  )

  server.registerTool(
    'ww_find_asset',
    {
      title: 'Поиск ассета',
      description:
        'Поиск по реестру ассетов игры (AssetRegistry): путь /Game/..., имя и класс ассета. Нужен, чтобы найти файл для ww_extract_asset или понять, где лежит блюпринт. Для поиска классов и функций рефлексии используй ww_find_symbol.',
      inputSchema: {
        pattern: z.string().describe('Имя или часть пути; символ % задаёт свой шаблон'),
        class: z.string().optional().describe('Фильтр по классу ассета: Blueprint, WidgetBlueprint, DataTable, Texture2D…'),
        limit: z.number().int().positive().max(200).optional(),
        version: versionParam,
      },
      annotations: READ_ONLY,
    },
    wrap((ctx, args) => handleFindAsset(ctx, args)),
  )

  server.registerTool(
    'ww_extract_asset',
    {
      title: 'Извлечь ассет из пака',
      description:
        'Достаёт файлы ассета (.uasset и спутники .uexp/.ubulk) из пака игры на диск. Единственный инструмент, пишущий за пределы репозитория модов: dest_dir обязан лежать внутри extractRoot из конфига, иначе запрос отвергается.',
      inputSchema: {
        asset_path: z.string().describe('Путь /Game/..., путь внутри пака или имя ассета'),
        dest_dir: z.string().describe('Каталог назначения внутри extractRoot'),
        version: versionParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    wrap((ctx, args) => handleExtractAsset(ctx, config, args)),
  )

  server.registerTool(
    'ww_game_status',
    {
      title: 'Состояние игры и моста',
      description:
        'Запущена ли игра, жив ли мост WWBridge, загружен ли уровень, аптайм сессии, последняя ошибка. Вызывай ПЕРЕД любым live-инструментом, чтобы отличить «игра не запущена» от «путь неверен». При выключенной игре отвечает мгновенно, без таймаута.',
      inputSchema: { version: versionParam },
      annotations: LIVE_READ,
    },
    wrapBridge((ctx) => handleGameStatus(ctx, config)),
  )

  server.registerTool(
    'ww_game_eval',
    {
      title: 'Выполнить Lua в игре',
      description:
        'Выполняет чанк Lua в процессе игры через UE4SS и возвращает сериализованный результат. Используй для проверки гипотез об API, поиска живых объектов (FindAllOf/FindFirstOf) и чтения состояния мира. Пиши return, иначе значения не будет. Бесконечный цикл в чанке подвесит игру.',
      inputSchema: {
        lua: z.string().describe('Тело чанка. Возвращаемое значение передавай через return'),
        timeout_ms: z.number().int().positive().max(120000).optional(),
        version: versionParam,
      },
      annotations: LIVE_WRITE,
    },
    wrapBridge((ctx, args) => handleGameEval(ctx, config, args)),
  )

  server.registerTool(
    'ww_ui_tree',
    {
      title: 'Дерево виджетов',
      description:
        'Дамп поддерева UMG живой игры: класс, видимость, текстура кисти, текст и тип слота по каждому виджету. Первый инструмент, когда надо понять устройство экрана или найти контейнер для своего виджета. Без аргументов — дерево PlayHud.',
      inputSchema: {
        root: z.string().optional().describe('Класс владельца для FindFirstOf, по умолчанию PlayHud'),
        field: z
          .string()
          .optional()
          .describe('Поле-виджет у владельца, с которого начать (например ImportantAgentModifiers)'),
        depth: z.number().int().positive().max(20).optional().describe('Глубина обхода, по умолчанию 6'),
        version: versionParam,
      },
      annotations: LIVE_READ,
    },
    wrapBridge((ctx, args) => handleUiTree(ctx, config, args)),
  )

  server.registerTool(
    'ww_trace_calls',
    {
      title: 'Счётчик вызовов UFunction',
      description:
        'Вешает хуки на указанные функции, ждёт заданное окно и отдаёт число вызовов каждой. Нужен, чтобы понять, кто и как часто дёргает функцию, и вызывается ли она вообще: чисто нативные C++ -> C++ вызовы не ловятся и дадут ноль. Пути бери из hook_path в ответе ww_verify_hook.',
      inputSchema: {
        paths: z.array(z.string()).min(1).max(10).describe('Пути функций в форме hook_path'),
        seconds: z.number().int().positive().max(120).optional().describe('Окно наблюдения, по умолчанию 10'),
        capture_args: z
          .boolean()
          .optional()
          .describe('Дополнительно записать до 20 образцов: владелец вызова и первый аргумент'),
        version: versionParam,
      },
      annotations: LIVE_WRITE,
    },
    wrapAsync((ctx, args) => handleTraceCalls(ctx, config, args)),
  )

  server.registerTool(
    'ww_game_console',
    {
      title: 'Консольная команда игры',
      description:
        'Отправляет команду в консоль игры (exec-команды вроде Arco_GiveResource, Arco_UnlockAll или UE-команды вроде stat fps). Требует загруженного уровня: без PlayerController команда невыполнима. Вывод команды читай через ww_game_log.',
      inputSchema: {
        command: z.string().describe('Команда целиком, одной строкой'),
        version: versionParam,
      },
      annotations: LIVE_WRITE,
    },
    wrapBridge((ctx, args) => handleGameConsole(ctx, config, args)),
  )

  server.registerTool(
    'ww_game_log',
    {
      title: 'Лог UE4SS',
      description:
        'Разобранный UE4SS.log: фильтры по времени, уровню и имени мода. По умолчанию — записи текущей сессии игры. Первое место, куда смотреть, когда мод загрузился, но ничего не делает. Работает и при выключенной игре.',
      inputSchema: {
        since: z
          .string()
          .optional()
          .describe('session (по умолчанию — с последнего старта игры), all, либо метка вида 2026-08-29 21:52:56'),
        level: z.enum(['error', 'warn', 'info', 'all']).optional(),
        mod: z.string().optional().describe('Имя Lua-мода, как оно печатается в логе'),
        limit: z.number().int().positive().max(500).optional(),
        version: versionParam,
      },
      annotations: LIVE_READ,
    },
    wrapBridge(async (ctx, args) => handleGameLog(ctx, config, args)),
  )


  server.registerTool(
    'ww_lua_api',
    {
      title: 'Справочник UE4SS Lua API',
      description:
        'Сигнатуры, примеры и грабли UE4SS Lua API: хуки, поиск объектов, потоки, ввод, текст, раскладка мода. Без аргументов — оглавление по категориям. Вызывай ПЕРЕД написанием кода мода: здесь записаны отличия этой сборки (ExecuteInGameThread асинхронный, FindAllOf при нуле совпадений даёт nil, Utf8String не работает). Классы и функции самой игры ищи через ww_find_symbol.',
      inputSchema: {
        symbol: z.string().optional().describe('Имя символа UE4SS, например RegisterHook или ExecuteInGameThread'),
        category: z
          .string()
          .optional()
          .describe('Категория: hooks | search | objects | params | threading | input | ue-helpers | console | logging | text | ui | mod | dev | absent-api'),
        version: versionParam,
      },
      annotations: READ_ONLY,
    },
    wrapBridge(async (ctx, args) => handleLuaApi(ctx, config, args)),
  )

  server.registerTool(
    'ww_scaffold_mod',
    {
      title: 'Создать каркас мода',
      description:
        'Создаёт структуру Lua-мода UE4SS: mod.json, Scripts/main.lua из шаблона, подключение общей библиотеки lib/. Шаблоны: hook (перехват UFunction), ui (реакция на состояние с показом в UI), keybind (действие по клавише), diagnostic (разведка живой игры). mod_root обязан лежать внутри sandboxRoots, обычно <modsRepo>/mods/<имя>. Существующий код не перезаписывает.',
      inputSchema: {
        mod_root: z.string().describe('Каталог мода, например D:/Whiskerwood_IO/WhiskerWood_Mods/mods/research-notifier'),
        name: z.string().optional().describe('Имя мода; по умолчанию имя каталога. Станет именем папки в ue4ss/Mods'),
        template: z.enum(TEMPLATES).describe('Шаблон точки входа'),
        version: versionParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    wrap((ctx, args) => handleScaffoldMod(ctx, config, args)),
  )

  server.registerTool(
    'ww_generate_hook',
    {
      title: 'Скелет хука по сигнатуре из индекса',
      description:
        'Готовый код RegisterHook с реальной сигнатурой функции из индекса: правильный hook_path, распаковка каждого параметра через :get() с учётом его типа, ToString для FName/FString/FText. Используй вместо ручного написания хука — путь и арность коллбэка тогда гарантированно совпадают с рефлексией.',
      inputSchema: {
        function_path: z.string().describe('Путь функции в любой форме; удобнее всего взять из ww_verify_hook'),
        kind: z.enum(['pre', 'post', 'both']).optional().describe('Какой коллбэк генерировать; по умолчанию post'),
        version: versionParam,
      },
      annotations: READ_ONLY,
    },
    wrap((ctx, args) => handleGenerateHook(ctx, args)),
  )

  server.registerTool(
    'ww_validate_mod',
    {
      title: 'Проверка мода',
      description:
        'Разбирает все .lua мода в AST и сверяет с индексом: синтаксис, каждый литеральный путь RegisterHook/StaticFindObject/FindFirstOf/FindAllOf/NotifyOnNewObject, форма пути (двоеточие против точки), арность коллбэков хуков, коллизии с соседними модами репозитория, известные грабли UE4SS. Динамически собранные пути помечаются отдельно как непроверяемые. Вызывай ПЕРЕД ww_deploy_mod и после каждой правки. live: true дополнительно пробивает пути через мост в живой игре.',
      inputSchema: {
        mod_root: z.string().describe('Каталог мода'),
        live: z.boolean().optional().describe('Дополнительно пробить пути в запущенной игре'),
        version: versionParam,
      },
      annotations: READ_ONLY,
    },
    wrapAsync((ctx, args) => handleValidateMod(ctx, config, args)),
  )

  server.registerTool(
    'ww_deploy_mod',
    {
      title: 'Развернуть мод',
      description:
        'mode=dev — загрузить мод в запущенную игру через мост WWBridge прямо из каталога разработки, со снятием хуков предыдущей загрузки; повторный вызов перезагружает мод без перезапуска игры. mode=release — junction (при отказе копия) в ue4ss/Mods/<Имя> плюс строка в mods.txt; подхватится при следующем старте игры. Сначала прогони ww_validate_mod.',
      inputSchema: {
        mod_root: z.string().describe('Каталог мода'),
        mode: z.enum(['dev', 'release']).optional().describe('По умолчанию dev'),
        version: versionParam,
      },
      annotations: LIVE_WRITE,
    },
    wrapBridge((ctx, args) => handleDeployMod(ctx, config, args)),
  )

  server.registerTool(
    'ww_package_mod',
    {
      title: 'Собрать релизный zip',
      description:
        'Релизная сборка мода для раздачи игрокам: одна папка <Имя>/ со всеми .lua и mod.json, внутрь неё вендорится общая библиотека lib/ (Scripts/ww/*.lua) — у игрока нет WWBridge, расширяющего package.path, и без вендоринга require("ww.log") не найдётся. Рядом кладётся УСТАНОВКА.txt (свой из корня мода или сгенерированный). Архив пишется в <modsRepo>/dist и никогда не перетирает существующий: при совпадении имени добавляется суффикс -b2, -b3. Версия берётся из mod.json, mod_version её задаёт и сохраняет обратно. Это не установка в игру — для неё ww_deploy_mod.',
      inputSchema: {
        mod_root: z.string().describe('Каталог мода'),
        mod_version: z.string().optional().describe('Версия релиза вида 1.2.3; по умолчанию version из mod.json или 1.0.0'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    wrapPlain((args: PackageModArgs) => handlePackageMod(config, args)),
  )

  server.registerTool(
    'ww_diff_versions',
    {
      title: 'Различия между версиями игры',
      description:
        'Сравнивает два собранных профиля: что исчезло, что появилось, у каких функций сменилась сигнатура и у каких объектов сменился hook_path. Первый шаг после патча игры, до починки модов. Отсутствие BP-класса в новом профиле не означает удаления — дамп это снимок памяти, перепроверяй через ww_verify_hook с live: true.',
      inputSchema: {
        from: z.string().describe('Версия-источник, например 0.6.190.0'),
        to: z.string().describe('Версия-приёмник'),
        kind: z
          .string()
          .optional()
          .describe('Ограничить вид: Class | ScriptStruct | Enum | Function | Package | bp. По умолчанию всё, кроме пакетов'),
        limit: z.number().int().positive().max(200).optional(),
      },
      annotations: READ_ONLY,
    },
    wrapPlain((args) => handleDiffVersions(config, args)),
  )

  server.registerTool(
    'ww_memory_wakeup',
    {
      title: 'Проектная память: обзор',
      description:
        'Первый вызов в сессии: что уже решено по этому проекту — принятые решения, известные грабли, предпочтения, незакрытые todo. Память общая на игру и переживает сессии. Вызывай ДО разведки API: половина ответов может быть уже записана.',
      inputSchema: {
        mod_name: z.string().optional().describe('Сузить до одного мода; общие записи остаются в выдаче'),
        limit: z.number().int().positive().max(100).optional(),
      },
      annotations: READ_ONLY,
    },
    wrapPlain((args) => handleMemoryWakeup(config, args)),
  )

  server.registerTool(
    'ww_memory_search',
    {
      title: 'Проектная память: поиск',
      description:
        'Полнотекстовый поиск по проектной памяти. Спрашивай прежде, чем заново выяснять то, что уже выяснялось: почему выбран такой хук, какая подсистема игры не работает, что сломалось на прошлом патче. Погашенные записи по умолчанию не выдаются.',
      inputSchema: {
        query: z.string().describe('Слова по теме: имя функции, подсистемы, мода'),
        mod_name: z.string().optional().describe('Сузить до одного мода; общие записи остаются в выдаче'),
        category: z.enum(MEMORY_CATEGORIES).optional(),
        include_invalidated: z.boolean().optional().describe('Показать и погашенные записи'),
        limit: z.number().int().positive().max(100).optional(),
      },
      annotations: READ_ONLY,
    },
    wrapPlain((args) => handleMemorySearch(config, args)),
  )

  server.registerTool(
    'ww_memory_add',
    {
      title: 'Проектная память: записать',
      description:
        'Батч-запись в проектную память по итогам работы: принятые решения (decision), обнаруженные грабли (pitfall), предпочтения владельца (preference), незакрытые хвосты (todo), факты (note). Записывай то, что нельзя вывести из кода и индекса: почему сделано так, а не иначе, и что было проверено вживую. Запись с category=pitfall и тегами-символами попадает в линт ww_validate_mod. Повтор той же summary в той же категории обновляет запись, а не плодит дубль.',
      inputSchema: {
        entries: z
          .array(
            z.object({
              category: z.enum(MEMORY_CATEGORIES),
              summary: z.string().min(3).describe('Суть одной строкой — по ней запись ищут и по ней же дедуплицируют'),
              body: z.string().optional().describe('Детали: что проверено, чем подтверждено, что осталось неясным'),
              tags: z
                .array(z.string())
                .optional()
                .describe('Символы и темы. Для pitfall тег-идентификатор (Utf8String, ForEachUObject) становится триггером линта'),
              mod_name: z.string().optional().describe('К какому моду относится; без него запись общая для всех модов'),
              importance: z.number().int().min(1).max(5).optional().describe('1..5, по умолчанию 3'),
            }),
          )
          .min(1)
          .max(20),
        mod_name: z.string().optional().describe('Мод по умолчанию для всех записей батча'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    wrapPlain((args) => handleMemoryAdd(config, args)),
  )

  server.registerTool(
    'ww_memory_invalidate',
    {
      title: 'Проектная память: погасить запись',
      description:
        'Мягкое удаление записи, ставшей неверной: после патча игры, смены решения или опровержения гипотезы. Из поиска и линта запись уходит, история сохраняется. Гаси, а не переписывай: причина устаревания сама по себе ценна.',
      inputSchema: {
        public_id: z.string().describe('Идентификатор из ww_memory_search или ww_memory_wakeup'),
        reason: z.string().min(3).describe('Почему запись больше не верна'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    wrapPlain((args) => handleMemoryInvalidate(config, args)),
  )

  registerPrompts(server)

  return server
}


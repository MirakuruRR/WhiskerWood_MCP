import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ServerConfig } from './config'
import { createGameContext, GameContext } from './utils/game-context'
import { errorText } from './utils/ai-text'
import { handleFindSymbol } from './tools/find-symbol'
import { handleSearchMembers } from './tools/search-members'
import { handleGetType } from './tools/get-type'
import { handleGetFunction } from './tools/get-function'
import { handleFindCallers } from './tools/find-callers'
import { handleGetBytecode } from './tools/get-bytecode'
import { handleVerifyHook } from './tools/verify-hook'
import { handleIndexStatus } from './tools/index-status'
import { handleGameStatus } from './tools/game-status'
import { handleGameProcess } from './tools/game-process'
import { handleCaptureDumps } from './tools/capture-dumps'
import { handleIndexRelease } from './tools/index-release'
import { handleGameEval } from './tools/game-eval'
import { handleUiTree } from './tools/ui-tree'
import { handleTraceCalls } from './tools/trace-calls'
import { handleCallFunction } from './tools/call-function'
import { handleGameConsole } from './tools/game-console'
import { handleGameLog } from './tools/game-log'
import { handleCrashReport } from './tools/crash-report'
import { handleScreenshot } from './tools/screenshot'
import { handleGetDataTable } from './tools/get-datatable'
import { handleResolveLoc } from './tools/resolve-loc'
import { handleFindAsset } from './tools/find-asset'
import { handleExtractAsset } from './tools/extract-asset'
import { handleLuaApi } from './tools/lua-api'
import { handleScaffoldMod, TEMPLATES } from './tools/scaffold-mod'
import { handleGenerateHook } from './tools/generate-hook'
import { handleValidateMod } from './tools/validate-mod'
import { handleDeployMod } from './tools/deploy-mod'
import { handlePackageMod, IndexGameVersion, PackageModArgs } from './tools/package-mod'
import { handleInstallMod, InstallModArgs } from './tools/install-mod'
import { handleDiffVersions } from './tools/diff-versions'
import { handleEventSurface } from './tools/event-surface'
import { handleLift } from './tools/lift'
import { handleLoomBuild, LoomBuildArgs } from './tools/loom-build'
import { handleLoomInstall, LoomInstallArgs } from './tools/loom-install'
import { handleLoomNewMod, LoomNewModArgs } from './tools/loom-new-mod'
import { handleLoomStatus } from './tools/loom-status'
import { handleLoomValidate, LoomValidateArgs } from './tools/loom-validate'
import { handleMemoryWakeup } from './tools/memory-wakeup'
import { handleMemorySearch } from './tools/memory-search'
import { handleMemoryAdd } from './tools/memory-add'
import { handleMemoryInvalidate } from './tools/memory-invalidate'
import { MEMORY_CATEGORIES } from './utils/memory-db'
import { registerPrompts, registerResources } from './prompts'
import { toolEnabled } from './toolsets'

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

  // Кадр игры приходит не только текстом: MCP позволяет вложить png прямо в ответ.
  const wrapBridgeImage =
    <A extends { version?: string }>(
      fn: (ctx: GameContext | null, args: A) => Promise<{ text: string; pngBase64?: string; mime?: 'image/png' | 'image/jpeg' }>,
    ) =>
    async (args: A) => {
      let ctx: GameContext | null = null
      try {
        ctx = await createGameContext(config, args.version)
      } catch {
        ctx = null
      }
      try {
        const out = await fn(ctx, args)
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
          { type: 'text', text: out.text },
        ]
        if (out.pngBase64) content.push({ type: 'image', data: out.pngBase64, mimeType: out.mime ?? 'image/png' })
        return { content }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { content: [{ type: 'text' as const, text: errorText('server_error', 'error', msg) }], isError: true }
      }
    }

  // Память, сравнение версий и инструменты кита живут вне профиля: им не нужен готовый индекс текущей версии.
  const wrapPlain =
    <A>(fn: (args: A) => string | Promise<string>) =>
    async (args: A) => {
      try {
        return { content: [{ type: 'text' as const, text: await fn(args) }] }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { content: [{ type: 'text' as const, text: errorText('server_error', 'error', msg) }], isError: true }
      }
    }

  // Группа инструмента решает, регистрировать ли его: loom-режим выключает lua-набор.
  const registerTool = ((name: string, def: unknown, cb: unknown) => {
    if (!toolEnabled(config, name)) return
    return (server.registerTool as unknown as (n: string, d: unknown, c: unknown) => unknown)(name, def, cb)
  }) as McpServer['registerTool']

  const versionParam = z
    .string()
    .optional()
    .describe('Версия игры (профиль индекса). По умолчанию — единственный/старший готовый профиль.')

  registerTool(
    'ww_find_symbol',
    {
      title: 'Поиск символа',
      description:
        'Первый вызов, когда точное имя класса, функции, структуры или енума неизвестно. Полнотекстовый поиск по индексу рефлексии. Используй ДО обращения к точным инструментам и ДО написания хуков. Не угадывай имена из строк бинарника — многие существуют в ассетах, но отсутствуют в рефлексии. bp — статус символа для Blueprint-мода (у функций как в ww_get_function, у классов in_types | not_in_types); bp_only: true оставляет только то, чем Blueprint может пользоваться (у функций callable | pure | world_context | latent | not_in_types, у классов из types.json или игровые BP, которые LoomBuild подгрузит при сборке); total_found считается до фильтра, число отброшенных — в bp_filtered.',
      inputSchema: {
        pattern: z.string().describe('Имя или его часть, можно несколько слов через пробел'),
        kind: z
          .string()
          .optional()
          .describe('Фильтр вида: Class | ScriptStruct | Enum | Function | Package | bp'),
        package: z.string().optional().describe('Фильтр по пакету/модулю, например SystemCore'),
        bp_only: z.boolean().optional().describe('Только то, что доступно Blueprint: без функций, которые Loom вызвать не может'),
        limit: z.number().int().positive().max(200).optional(),
        version: versionParam,
      },
      annotations: READ_ONLY,
    },
    wrap((ctx, args) => handleFindSymbol(ctx, config, args)),
  )

  registerTool(
    'ww_search_members',
    {
      title: 'Обратный поиск по членам',
      description:
        'Обратный поиск: в каком классе есть поле или метод с таким именем. Сценарий «знаю что ищу, не знаю где». Для поиска самих классов/функций предпочти ww_find_symbol. bp — статус члена для Blueprint-мода (у полей read | read_only | edit_only | hidden, у функций как в ww_get_function); bp_only: true оставляет только то, что Blueprint может использовать.',
      inputSchema: {
        pattern: z.string().describe('Имя поля или метода. По умолчанию ищется как подстрока; символ % задаёт свой шаблон, подчёркивание трактуется буквально'),
        member_kind: z.enum(['field', 'method', 'any']).optional(),
        bp_only: z.boolean().optional().describe('Только то, что доступно Blueprint: без того, что Loom не видит или не может вызвать'),
        limit: z.number().int().positive().max(200).optional(),
        version: versionParam,
      },
      annotations: READ_ONLY,
    },
    wrap((ctx, args) => handleSearchMembers(ctx, config, args)),
  )

  registerTool(
    'ww_get_type',
    {
      title: 'Информация о типе',
      description:
        'Class / ScriptStruct / Enum целиком: поля с офсетами и типами, родитель, список методов, наследники; для енума — значения. Путь принимается в любой форме (индексной, /Script/..., /Game/...). Для сигнатуры отдельной функции предпочти ww_get_function. Поля и методы помечены bp: у поля — read | read_only | edit_only | hidden (hidden — Blueprint его не видит), у метода — как bp у ww_get_function. bp: not_in_types и bp_loads_at_build: true у игрового BP, которого нет в types.json: LoomBuild подгрузит его при сборке.',
      inputSchema: {
        path: z.string().describe('Путь типа в любой форме'),
        version: versionParam,
      },
      annotations: READ_ONLY,
    },
    wrap((ctx, args) => handleGetType(ctx, config, args)),
  )

  registerTool(
    'ww_get_function',
    {
      title: 'Сигнатура функции',
      description:
        'Точная сигнатура функции: параметры по порядку, типы с источником (uht/objdump/usmap/none), out-параметры, возврат, и всегда — готовый hook_path для RegisterHook. НЕ собирай hook_path самостоятельно — копируй из ответа. Поле bp — статус функции для Blueprint: callable | pure | latent | world_context | internal | deprecated | editor_only | not_callable | not_in_types; у каждого параметра dir: in | ref | out, hidden: true у пина, который узел заполняет сам. loom_call — готовый вызов Loom: часть до « -> » копируй в исходник как есть, после « -> » — что вызов даёт (запись в фигурных скобках читается по именам полей). НЕ собирай вызов сам — копируй loom_call. Вместо bp может прийти bp_hint: types.json недоступен (кит не настроен или ещё не собирался).',
      inputSchema: {
        path: z.string().describe('Путь функции в любой форме'),
        version: versionParam,
      },
      annotations: READ_ONLY,
    },
    wrap((ctx, args) => handleGetFunction(ctx, config, args)),
  )

  registerTool(
    'ww_find_callers',
    {
      title: 'Кто вызывает функцию',
      description:
        'Обратный статический xref: кто вызывает функцию/класс из BP-байткода cooked-сборки (сайдкар WwParse: CUE4Parse разбирает ScriptBytecode). kind различает final/math/local_final (статический вызов, есть callee_path) от virtual/local_virtual (виртуальная диспетчеризация по имени, callee_path нет) и ref (класс/CDO/компонент ссылается на объект вне вызова функции — SuperStruct, ComponentTemplate и т.п.). Покрывает только тот prefix ассетов, что был просканирован при последней сборке индекса; C++-вызовы, невидимые в BP-байткоде, сюда не попадают.',
      inputSchema: {
        path: z.string().describe('Путь функции или класса в любой форме'),
        kind: z.string().optional().describe('Фильтр по kind: final | math | local_final | virtual | local_virtual | ref'),
        limit: z.number().int().positive().max(200).optional(),
        version: versionParam,
      },
      annotations: READ_ONLY,
    },
    wrap((ctx, args) => handleFindCallers(ctx, args)),
  )

  registerTool(
    'ww_get_bytecode',
    {
      title: 'Дизасм тела функции',
      description:
        'Линейный дизасм BP-байткода функции (EX_*-выражения с отступами по вложенности, разобрано сайдкаром WwParse из cooked-сборки). Сначала пробуй ww_lift: он отдаёт то же тело читаемым исходником Loom, с именами енумов и вызовов вместо чисел, а этот инструмент остаётся запасным — для мест, где lift поставил пометку «not lifted», и когда нужен сам байткод. Полезно, когда ww_trace_calls показывает ноль срабатываний или неясен порядок вызовов внутри функции — в отличие от трейса, не требует запущенной игры. Для чисто нативных (C++) функций байткода нет — вернётся no_bytecode.',
      inputSchema: {
        function_path: z.string().describe('Путь функции в любой форме'),
        version: versionParam,
      },
      annotations: READ_ONLY,
    },
    wrap((ctx, args) => handleGetBytecode(ctx, args)),
  )

  registerTool(
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

  registerTool(
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

  registerTool(
    'ww_index_release',
    {
      title: 'Освободить index.db',
      description:
        'Закрывает открытые сервером дескрипторы index.db всех профилей. Нужен только перед bun run setup --force, когда пересобирается уже загруженная версия: Windows не даёт подменить каталог профиля, пока файл в нём открыт. При обычной переиндексации на новую версию игры не нужен — новый профиль публикуется в свой каталог.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    wrapPlain(() => handleIndexRelease()),
  )

  registerTool(
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

  registerTool(
    'ww_resolve_loc',
    {
      title: 'Текст по ключу локализации',
      description:
        'Ключ локализации → текст. Локализация в Whiskerwood сделана таблицами Loc_* (18 языков), а не .locres. Принимает точный ключ, шаблон ключа или слова из текста. lang по умолчанию из конфига (En,Ru), lang="all" — все языки. В Lua передавай уже готовую строку: кириллица из Lua-строки проходит в FString-параметр без потерь, FText собирается через KismetTextLibrary:Conv_StringToText.',
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

  registerTool(
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

  registerTool(
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

  registerTool(
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

  registerTool(
    'ww_game_process',
    {
      title: 'Процесс игры',
      description:
        'Управление самим процессом игры: запуск через Steam, force kill, перезапуск и автономная загрузка сохранения. action=start запускает копию из Steam (AppID берётся из appmanifest) и ЖДЁТ готовности: wait_for=process|bridge|menu|world, по умолчанию bridge. Перед стартом UE4SS.log уезжает в архив state/logs, поэтому ww_game_log потом читает только текущую сессию. action=start вместе с save запускает игру и, дождавшись главного меню, грузит сохранение через мост (ArcoGameInstance:EnterPlay) — это единственный автономный путь к загруженному миру; status=save_loaded означает, что карта поднялась, тяжёлый сейв может ещё дозагружать состояние. action=stop — taskkill /F без спроса, несохранённый прогресс теряется. action=restart нужен release-модам: они подхватываются только при старте игры. action=list_saves — имена сохранений с датами. Если игра исчезла не по нашей команде, status помечает exit_kind=unexpected и отдаёт крашдамп и последнюю ошибку лога. Состояние моста без трогания процесса смотри через ww_game_status.',
      inputSchema: {
        action: z
          .enum(['status', 'start', 'stop', 'restart', 'load_save', 'list_saves'])
          .optional()
          .describe('По умолчанию status'),
        save: z
          .string()
          .optional()
          .describe('Имя сохранения без расширения, как в list_saves. Со start/restart — загрузить сразу после выхода в меню'),
        args: z.array(z.string()).optional().describe('Аргументы запуска, например -windowed -ResX=1280 -ResY=720'),
        wait_for: z
          .enum(['none', 'process', 'bridge', 'menu', 'world'])
          .optional()
          .describe('Чего ждать: появления процесса, живого моста, главного меню, загруженного уровня'),
        timeout_ms: z.number().int().positive().max(600000).optional().describe('Бюджет ожидания, по умолчанию 180000'),
        version: versionParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    wrapBridge((ctx, args) => handleGameProcess(ctx, config, args)),
  )

  registerTool(
    'ww_capture_dumps',
    {
      title: 'Снять дампы рефлексии',
      description:
        'Снимает свежие дампы (.usmap, UE4SS_ObjectDump.txt, UHTHeaderDump) прямо из запущенной игры через мост — DumpUSMAP/DumpAllObjects/GenerateUHTCompatibleHeaders, без AutoDump и без перезапуска игры. Нужен загруженный мир (ww_game_process action=start save=... wait_for=world), иначе часть блюпринтовых UI-классов не попадёт в дамп — откажет с no_world, пока не разрешишь allow_main_menu. Перед фактическим снятием выдерживает settle_ms (по умолчанию 60000): миру нужно время догрузить объекты после входа в уровень. Дальше — bun run dumps:pull и bun run setup.',
      inputSchema: {
        settle_ms: z.number().int().min(0).max(180000).optional().describe('Пауза перед стартом дампа после входа в уровень, по умолчанию 60000'),
        timeout_ms: z.number().int().positive().max(600000).optional().describe('Общий бюджет ожидания маркера ALL DONE, по умолчанию settle_ms + 120000'),
        allow_main_menu: z.boolean().optional().describe('Снять дамп без загруженного мира (неполный — часть UI-классов не попадёт)'),
        version: versionParam,
      },
      annotations: LIVE_WRITE,
    },
    wrapBridge((ctx, args) => handleCaptureDumps(ctx, config, args)),
  )

  registerTool(
    'ww_game_eval',
    {
      title: 'Выполнить Lua в игре',
      description:
        'Выполняет чанк Lua в процессе игры через UE4SS и возвращает сериализованный результат. Используй для проверки гипотез об API, поиска живых объектов (FindAllOf/FindFirstOf) и чтения состояния мира. Пиши return, иначе значения не будет. Бесконечный цикл в чанке подвесит игру. Обход UMG-виджетов руками не пиши: дамп дерева есть у ww_ui_tree. После выполнения в полях идёт bp_warning — члены из чанка, до которых Blueprint не дотягивается (сверка с types.json кита): это готовый сигнал «в Lua работает, в Loom не переносится». На результат предупреждение не влияет.',
      inputSchema: {
        lua: z.string().describe('Тело чанка. Возвращаемое значение передавай через return'),
        timeout_ms: z.number().int().positive().max(120000).optional(),
        version: versionParam,
      },
      annotations: LIVE_WRITE,
    },
    wrapBridge((ctx, args) => handleGameEval(ctx, config, args)),
  )

  registerTool(
    'ww_ui_tree',
    {
      title: 'Дерево виджетов',
      description:
        'Дамп поддерева UMG живой игры: класс, видимость, текстура кисти, текст, тип слота и выравнивание слота, а где смогли снять реальную геометрию — size=WxH и pos=X,Y (не всегда доступно вне живого Tick/Paint, тогда поле молча опускается). Шапка ответа показывает полное имя выбранного объекта и число кандидатов — так видно, тестовая карточка нашлась или игровая. Первый инструмент, когда надо понять устройство экрана, найти контейнер для своего виджета или увидеть, какую иконку и текст нарисовала игра: ищи в дампе tex= и text=. Без аргументов — дерево PlayHud. Ручной обход виджетов через ww_game_eval этим не заменяй.',
      inputSchema: {
        root: z
          .string()
          .optional()
          .describe(
            'Класс владельца для FindAllOf, по умолчанию PlayHud; для виджета pak-мода — полный путь класса (/Game/Mods/<Мод>/<Ассет>.<Класс>_C), короткое имя не принимается',
          ),
        object_path: z
          .string()
          .optional()
          .describe('Точный путь конкретного инстанса (GetFullName) вместо поиска по классу — снимает неоднозначность между тестовой и игровой карточкой'),
        index: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Номер кандидата (с 1) среди найденных по root через FindAllOf, если их несколько'),
        field: z
          .string()
          .optional()
          .describe('Поле-виджет у владельца, с которого начать (например ImportantAgentModifiers)'),
        depth: z.number().int().positive().max(20).optional().describe('Глубина обхода, по умолчанию 6'),
        match_name: z.string().optional().describe('Печатать только узлы, чьё имя содержит эту подстроку (без учёта регистра) — против заливки ответа глубоким деревом'),
        version: versionParam,
      },
      annotations: LIVE_READ,
    },
    wrapBridge((ctx, args) => handleUiTree(ctx, config, args)),
  )

  registerTool(
    'ww_trace_calls',
    {
      title: 'Трейс вызовов UFunction',
      description:
        'Вешает хуки на указанные функции и считает вызовы; с capture_args пишет сэмплы всех аргументов по именам с t_ms от старта окна — этим различимо "до клика / после клика" между несколькими трейсимыми функциями. Нужен, чтобы понять, кто и как часто дёргает функцию, и вызывается ли она вообще: чисто нативные C++ -> C++ вызовы не ловятся и дадут ноль. Без action — одноразовый блокирующий режим (start+wait+stop), самый простой способ спросить "вызывается ли вообще". С action=start возвращает session_id сразу и не блокирует: читай счётчик через action=read (тот же session_id), сними хуки через action=stop. Захват аргументов на часто вызываемой функции может ронять FPS — трейс сам деградирует в чистый счётчик при частоте выше порога. Пути бери из hook_path в ответе ww_verify_hook.',
      inputSchema: {
        paths: z
          .array(z.string())
          .max(10)
          .optional()
          .describe(
            'Пути функций в форме hook_path. Обязателен для action=start и одноразового режима, не нужен для read/stop. Принимаются и полные пути к функциям pak-мода (/Game/Mods/<Мод>/<Ассет>.<Класс>_C:<Функция>): сигнатуру и имена аргументов для них даёт пак мода, а сам путь проверяется живьём',
          ),
        action: z
          .enum(['start', 'read', 'stop'])
          .optional()
          .describe('Без значения — одноразовый режим (start+wait+stop). start — поставить хуки и вернуться сразу; read — прочитать текущий счётчик без остановки; stop — снять хуки и вернуть итог'),
        session_id: z.string().optional().describe('session_id из ответа action=start; для read/stop защищает от чтения чужой сессии'),
        seconds: z.number().int().positive().max(120).optional().describe('Окно наблюдения в одноразовом режиме, по умолчанию 10'),
        capture_args: z.boolean().optional().describe('Писать сэмплы вызовов: все параметры по именам, t_ms, порядковый номер'),
        max_samples: z.number().int().positive().max(200).optional().describe('Размер кольцевого буфера сэмплов, по умолчанию 50, максимум 200'),
        version: versionParam,
      },
      annotations: LIVE_WRITE,
    },
    wrapAsync((ctx, args) => handleTraceCalls(ctx, config, args)),
  )

  registerTool(
    'ww_call',
    {
      title: 'Вызов UFunction на объекте',
      description:
        'Зовёт произвольную UFunction по индексному пути (как ww_get_function) на найденном объекте живой игры, с аргументами по именам параметров. Сигнатура и арность проверяются до вызова по индексу. Возвращает return-значение и out-параметры. Закрывает случаи вида "нажать кнопку dev-вью" или "уплатить налог программно" без сборки виджета руками — конкретные рецепты (что дёрнуть для какого окна) веди в памяти через ww_memory_add, а не жди их от инструмента. object принимает полный путь объекта (StaticFindObject) или короткое имя класса (первый через FindAllOf, object_index — если их несколько). С bp_only отказывает всему, что Loom не соберёт (события, private/protected, editor_only, internal, not_in_types, world_context), с причиной в bp_reason; готовый вызов Loom приходит в loom_call — и при bp_only, и без него. Путь /Game/Mods/<Мод>/... — функция pak-мода: индекс игры её не знает, сигнатуру берём из пака мода, а сам путь проверяем живьём; короткое имя для мода не принимается (у каждого мода свой BP_MapLoad_C). Массивы, сеты, карты и делегаты как аргументы не поддержаны — для них ww_game_eval. Вызов произвольной UFunction в игровом потоке может уронить игру так же, как ww_game_eval: нативный access violation pcall не ловит. Один вызов за раз, не пачкой.',
      inputSchema: {
        object: z
          .string()
          .describe('Путь объекта (GetFullName/object_path) или короткое имя класса для FindAllOf; для мода — полный путь класса /Game/Mods/<Мод>/<Ассет>.<Класс>_C'),
        object_index: z.number().int().positive().optional().describe('Номер кандидата (с 1), если по object нашлось несколько'),
        function_path: z.string().describe('Путь функции в любой форме индекса; для мода — /Game/Mods/<Мод>/<Ассет>.<Класс>_C:<Функция>'),
        args: z.record(z.string(), z.unknown()).optional().describe('Аргументы по именам параметров — из ww_get_function'),
        bp_only: z
          .boolean()
          .optional()
          .describe('Пропустить только callable и pure: отказывает событиям, private/protected, editor_only, internal, not_in_types и world_context — такая цепочка не переносится в Loom один в один'),
        version: versionParam,
      },
      annotations: LIVE_WRITE,
    },
    wrapAsync((ctx, args) => handleCallFunction(ctx, config, args)),
  )

  registerTool(
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

  registerTool(
    'ww_game_log',
    {
      title: 'Лог игры: UE4SS и modlog',
      description:
        'Разобранный лог: source=ue4ss (по умолчанию) — UE4SS.log с фильтрами по времени, уровню и имени Lua-мода; source=modlog — <Saved>/Logs/modlog.txt, единственный канал из shipping-игры для pak-мода: тут строки ModAPI.LogMessage и сообщения загрузчика модов (в том числе «Not loading mod» — почему pak не поднялся). У modlog нет уровней, а строки мода не несут меток времени: since=session читает с офсета, снятого при ww_game_process action=start, фильтр mod идёт по префиксу «<Мод>:», сообщения загрузчика приходят отдельным блоком warnings. Первое место, куда смотреть, когда мод загрузился, но ничего не делает. Работает и при выключенной игре.',
      inputSchema: {
        source: z
          .enum(['ue4ss', 'modlog'])
          .optional()
          .describe('ue4ss (по умолчанию) — UE4SS.log; modlog — <Saved>/Logs/modlog.txt: строки мода и сообщения загрузчика pak-модов'),
        since: z
          .string()
          .optional()
          .describe(
            'session (по умолчанию: у ue4ss — с метки старта, у modlog — с офсета, снятого при ww_game_process action=start), all, либо метка вида 2026-08-29 21:52:56',
          ),
        level: z
          .enum(['error', 'warn', 'info', 'all'])
          .optional()
          .describe('только для ue4ss: у modlog уровней нет, параметр игнорируется и возвращается полем level_ignored'),
        mod: z
          .string()
          .optional()
          .describe(
            'имя мода: у ue4ss — как печатается в логе, у modlog — из префикса «<Мод>:» у строк ModAPI.LogMessage; строки загрузчика про этот мод приходят отдельным блоком warnings',
          ),
        limit: z.number().int().positive().max(500).optional(),
        version: versionParam,
      },
      annotations: LIVE_READ,
    },
    wrapBridge(async (ctx, args) => handleGameLog(ctx, config, args)),
  )

  registerTool(
    'ww_crash_report',
    {
      title: 'Разбор краша игры',
      description:
        'Разбор краша без ручного лазанья по %LOCALAPPDATA%. По умолчанию читает отчёт WWCrashGuard (Saved/Crashes/wwguard/crash-*.txt): виновный мод, файл и строка Lua, стек Lua, последние вызовы, таймлайн ошибок, нативный стек — для Lua-модов этого обычно достаточно. confidence=certain — ответ готов; guess/none — сверить с details (jsonl) и затем engine: true. engine: true — движковый дамп UECC: ErrorMessage и код исключения из CrashContext.runtime-xml, хвост UE4SS.log до краша и включённые моды; он же автоматически, если отчётов WWCrashGuard нет. Работает при выключенной игре. Без аргументов — последний краш; list: true — список; crash: подстрока имени отчёта или каталога дампа.',
      inputSchema: {
        crash: z
          .string()
          .optional()
          .describe('Подстрока имени отчёта (crash-<id>-<время>.txt, достаточно id) или каталога UECC-Windows-... при engine; по умолчанию последний краш'),
        list: z.boolean().optional().describe('Список последних крашей вместо разбора'),
        limit: z.number().int().positive().max(100).optional().describe('Сколько крашей показать в list, по умолчанию 10'),
        tail: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe('Сколько последних строк оставить в Timeline отчёта WWCrashGuard или в хвосте лога при engine, по умолчанию 30'),
        engine: z
          .boolean()
          .optional()
          .describe('Разбирать движковый дамп UECC и UE4SS.log вместо отчёта WWCrashGuard — когда вердикт неуверенный'),
        version: versionParam,
      },
      annotations: LIVE_READ,
    },
    wrapBridge(async (ctx, args) => handleCrashReport(ctx, config, args)),
  )

  registerTool(
    'ww_screenshot',
    {
      title: 'Скриншот из игры',
      description:
        'Кадр из игры для визуальной проверки правок; картинка приходит прямо в ответ MCP-блоком image, мастер-кадр копится по пути из field file для сравнения между правками. window/auto: снимок игрового окна (класс UnrealWindow) через PrintWindow — кадр с HUD, каким его видит игрок, работает даже перекрытым. engine: HighResShot через консоль моста — чистый мир в разрешении res, но БЕЗ UMG/HUD (проверено на 0.7.200): для шрифта, отступов и цвета бери window. Вложенная копия без crop — JPEG q82, вписанная в бокс res (window/auto) или ≤1920 (engine); с crop {x,y,w,h} в пикселях кадра — нативный PNG области ради пиксельной точности вёрстки. res в window/auto задаёт бокс вложенной копии (WxH), в engine — разрешение рендера; множитель только в engine. attach_image: false — только пути, без картинки.',
      inputSchema: {
        mode: z.enum(['auto', 'engine', 'window']).optional().describe('По умолчанию auto: окно игры, при неудаче HighResShot'),
        res: z
          .string()
          .optional()
          .describe('Бокс вложенной копии WxH (window/auto) или разрешение рендера (engine, можно множителем 2); по умолчанию 1280x720 в engine и 1920x1920 для копии'),
        crop: z
          .object({
            x: z.number().int(),
            y: z.number().int(),
            w: z.number().int().positive(),
            h: z.number().int().positive(),
          })
          .optional()
          .describe('Область кропа в пикселях кадра, отсчёт от левого верхнего угла окна; вкладывается нативным PNG'),
        timeout_ms: z.number().int().positive().max(60000).optional().describe('Сколько ждать файл кадра engine-пути, по умолчанию 15000'),
        attach_image: z.boolean().optional().describe('Прикладывать картинку в ответ; по умолчанию true'),
        version: versionParam,
      },
      annotations: LIVE_READ,
    },
    wrapBridgeImage((ctx, args) => handleScreenshot(ctx, config, args)),
  )

  registerTool(
    'ww_lua_api',
    {
      title: 'Справочник UE4SS Lua API',
      description:
        'Сигнатуры, примеры и грабли UE4SS Lua API: хуки, поиск объектов, потоки, ввод, текст, раскладка мода. Без аргументов — оглавление по категориям. Вызывай ПЕРЕД написанием кода мода: здесь записаны отличия этой сборки (ExecuteInGameThread асинхронный, FindAllOf при нуле совпадений даёт nil, глобала Utf8String нет — есть FUtf8String). Классы и функции самой игры ищи через ww_find_symbol.',
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

  registerTool(
    'ww_scaffold_mod',
    {
      title: 'Создать каркас мода',
      description:
        'Создаёт структуру Lua-мода UE4SS: mod.json, Scripts/main.lua из шаблона, подключение общей библиотеки lib/. Шаблоны: hook (перехват UFunction), ui (реакция на состояние с показом в UI), keybind (действие по клавише), diagnostic (разведка живой игры). mod_root обязан лежать внутри sandboxRoots, обычно <modsRepo>/mods/<имя>. Существующий код не перезаписывает.',
      inputSchema: {
        mod_root: z.string().describe('Каталог мода, например <репозиторий модов>/mods/research-notifier'),
        name: z.string().optional().describe('Имя мода; по умолчанию имя каталога. Станет именем папки в ue4ss/Mods'),
        template: z.enum(TEMPLATES).describe('Шаблон точки входа'),
        version: versionParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    wrap((ctx, args) => handleScaffoldMod(ctx, config, args)),
  )

  registerTool(
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

  registerTool(
    'ww_validate_mod',
    {
      title: 'Проверка мода',
      description:
        'Разбирает .lua мода из Scripts/ в AST и сверяет с индексом: синтаксис, каждый путь RegisterHook/StaticFindObject/FindFirstOf/FindAllOf/NotifyOnNewObject (литерал или строковая константа, в том числе из require-модуля мода), форма пути (двоеточие против точки), арность коллбэков хуков, известные грабли UE4SS. Конфликты ищет и в соседних модах репозитория, и в реально установленных в ue4ss/Mods: один и тот же хуковый путь (UE4SS сцепляет коллбэки без приоритетов) и запись в одно и то же свойство одного класса; порядок разрешения берётся из mods.txt. Если в моде есть нативная часть (dlls/main.dll, исходники native/), проверяет и её. Грабли из проектной памяти, чьи теги-символы встречаются в коде, идут отдельным блоком memory_hints и на статус не влияют. Находки одного кода сворачиваются; погасить принятое — комментарий -- ww:ignore <code|pit-id> или validate_ignore в mod.json. Вызывай в конце работы над модом, перед тем как сказать пользователю, что готово; повторные прогоны — с since_last: true. live: true дополнительно пробивает пути через мост в живой игре.',
      inputSchema: {
        mod_root: z.string().describe('Каталог мода'),
        live: z.boolean().optional().describe('Дополнительно пробить пути в запущенной игре'),
        detail: z
          .enum(['summary', 'default', 'full'])
          .optional()
          .describe('summary — только ошибки и счётчики; default — ошибки целиком, остальное свёрнуто по кодам; full — всё построчно'),
        codes: z.array(z.string()).optional().describe('Показать только эти коды находок (memory_pitfall — блок граблей)'),
        file: z.string().optional().describe('Показать только находки в файлах, путь которых содержит эту строку'),
        since_last: z.boolean().optional().describe('Показать только новое относительно прошлого прогона этого мода в текущей сессии сервера'),
        version: versionParam,
      },
      annotations: READ_ONLY,
    },
    wrapAsync((ctx, args) => handleValidateMod(ctx, config, args)),
  )

  registerTool(
    'ww_deploy_mod',
    {
      title: 'Развернуть мод',
      description:
        'Dev-деплой мода. Lua-часть (Scripts/main.lua) грузится в запущенную игру через мост WWBridge прямо из каталога разработки, со снятием хуков предыдущей загрузки; повторный вызов перезагружает её без перезапуска игры. Нативная часть (dlls/main.dll, C++-мод UE4SS) горячо не перезагружается: инструмент кладёт её в <ue4ssDir>/Mods/<Имя>/dlls (занятую игрой прежнюю DLL переименовывает в *.ww-old) и включает мод в mods.txt, если в каталоге игры нет Lua-копии. Если в живой игре DLL не та, что в репозитории, отвечает restart_required и Lua не грузит — нужен ww_game_process action=restart и повторный вызов. Без запущенной игры DLL всё равно кладётся.',
      inputSchema: {
        mod_root: z.string().describe('Каталог мода'),
        version: versionParam,
      },
      annotations: LIVE_WRITE,
    },
    wrapBridge((ctx, args) => handleDeployMod(ctx, config, args)),
  )

  registerTool(
    'ww_package_mod',
    {
      title: 'Собрать релизный zip',
      description:
        'Релизная сборка мода для раздачи игрокам: одна папка <Имя>/ со всеми .lua, dlls/ (если у мода есть нативная часть) и mod.json; исходники native/, мусор сборки (.pdb, .obj, .lib…) и всё, что исключает .gitignore репозитория модов (файлы, которые мод пишет сам во время игры), в архив не попадают, мод из одной DLL тоже принимается, внутрь неё вендорится общая библиотека lib/ (Scripts/ww/*.lua) — у игрока нет WWBridge, расширяющего package.path, и без вендоринга require("ww.log") не найдётся. Рядом кладутся УСТАНОВКА.txt и INSTALL.txt (свои из корня мода или сгенерированные) — с установкой UE4SS и самого мода. Архив пишется в <modsRepo>/dist и никогда не перетирает существующий: при совпадении имени добавляется суффикс -b2, -b3. Версия берётся из mod.json, mod_version её задаёт и сохраняет обратно. Версию игры (game_version в mod.json и строка требований в УСТАНОВКА.txt/INSTALL.txt, в том числе в своих readme мода) инструмент сам проставляет из действующего профиля индекса и сохраняет в mod.json; руками её не правят. Если индекс устарел или не собран, остаётся версия из mod.json, а в ответе — предупреждение. Это не установка в игру — для неё ww_deploy_mod.',
      inputSchema: {
        mod_root: z.string().describe('Каталог мода'),
        mod_version: z.string().optional().describe('Версия релиза вида 1.2.3; по умолчанию version из mod.json или 1.0.0'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    wrapPlain(async (args: PackageModArgs) => {
      let index: IndexGameVersion
      try {
        index = { version: (await createGameContext(config)).gameVersion }
      } catch (e) {
        index = { version: null, reason: (e instanceof Error ? e.message : String(e)).split('\n')[0] }
      }
      return handlePackageMod(config, args, index)
    }),
  )

  registerTool(
    'ww_install_mod',
    {
      title: 'Установить релиз в игру',
      description:
        'Ставит мод в <ue4ssDir>/Mods/<Имя> из каталога (mod_root, копия — как ww_package_mod собирал бы файлы) или из готового релизного zip (как отдаёт ww_package_mod: папка "<Имя мода>/..." внутри архива). Имя берётся из mod.json, если не задано явно. Перед перезаписью существующего каталога делает бэкап в state/backup/<Имя>-<таймштамп>; каталог синхронизируется, а не сносится: файлы, которые исключает .gitignore репозитория модов (состояние, которое мод пишет сам во время игры), не ставятся и не удаляются; загруженную игрой DLL Windows не даёт удалить, поэтому она переименовывается в *.ww-old, а новая DLL подхватится после перезапуска (restart_required). Если каталог есть, но не похож на мод UE4SS (нет ни Scripts/main.lua, ни dlls/main.dll), без force: true отказывается перетирать. dll_only: true ставит только dlls/ — dev-раскладка мода Lua+DLL, где Lua грузится мостом через ww_deploy_mod, а Lua-копия в игре задвоила бы хуки. Правит mods.txt идемпотентно (enable по умолчанию true). Исключение из правила "сервер пишет только в песочницу" (вместе с ww_extract_asset, ww_deploy_mod и инструментами Loom, см. ARCHITECTURE.md) — пишет ещё и в каталог игры: <ue4ssDir>/Mods/<Имя> и mods.txt. Live-загрузка в уже запущенную игру без перезапуска — отдельный ww_deploy_mod.',
      inputSchema: {
        mod_root: z.string().optional().describe('Каталог мода для установки (взаимоисключимо с zip)'),
        zip: z.string().optional().describe('Путь к релизному zip (взаимоисключимо с mod_root)'),
        name: z.string().optional().describe('Имя установки; по умолчанию — name из mod.json / имя папки в архиве'),
        enable: z.boolean().optional().describe('Включить в mods.txt, по умолчанию true'),
        force: z.boolean().optional().describe('Перезаписать существующий каталог, даже если он не похож на мод UE4SS'),
        dll_only: z.boolean().optional().describe('Поставить только нативную часть dlls/, убрав из каталога игры остальное (dev-раскладка Lua+DLL)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    wrapPlain((args: InstallModArgs) => handleInstallMod(config, args)),
  )

  registerTool(
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

  registerTool(
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

  registerTool(
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

  registerTool(
    'ww_memory_add',
    {
      title: 'Проектная память: записать',
      description:
        'Батч-запись в проектную память по итогам работы: принятые решения (decision), обнаруженные грабли (pitfall), предпочтения владельца (preference), незакрытые хвосты (todo), факты (note). Записывай то, что нельзя вывести из кода и индекса: почему сделано так, а не иначе, и что было проверено вживую. Запись с category=pitfall попадает в подсказки ww_validate_mod, если её тег — символ кода (имя из Lua API UE4SS или идентификатор с _, точкой, двоеточием либо двумя заглавными: FindAllOf, ww.hook, HarvestingCamp); обычные слова-теги триггерами не считаются. Повтор той же summary в той же категории обновляет запись, а не плодит дубль. mod_name решается для каждой записи отдельно: знание об игре, UE4SS или инструментах — без mod_name, даже если добыто во время работы над модом; только такие записи уходят в общую базу.',
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
              mod_name: z
                .string()
                .optional()
                .describe(
                  'Только если запись про сам мод и без него бессмысленна: его код, решения, баги, планы. Устройство игры, поведение UE4SS, грабли инструментов — без mod_name, иначе знание останется запертым в моде',
                ),
              importance: z.number().int().min(1).max(5).optional().describe('1..5, по умолчанию 3'),
            }),
          )
          .min(1)
          .max(20),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    wrapPlain((args) => handleMemoryAdd(config, args)),
  )

  registerTool(
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

  registerTool(
    'ww_lift',
    {
      title: 'Поднять Blueprint в исходник Loom',
      description:
        'Два режима. asset_path — поднять cooked Blueprint игры или Workshop-мода обратно в читаемый исходник Loom (.lm): сайдкар WwParse отдаёт JSON пакета по .usmap, loom.exe из кита поднимает его в скретч-проект state/lift/<версия игры>/, и в ответ приходит текст .lm вместе с пометками. Зови, когда нужно понять логику игрового Blueprint и писать мод на Loom: енумы, вызовы и структуры приходят именами, а не числами, — в отличие от ww_get_bytecode, который даёт EX_*-дизасм и обрезается. Подъём Loom 0.1.0 отказывает на пакет целиком, поэтому инструмент сам добивает отказы фолбэками: стабит функции с неподдерживаемым байткодом (EX_SwitchValue, EX_VectorConst, EX_CallMulticastDelegate и т. п.), выбрасывает дерево виджетов, снимает невыразимые значения по умолчанию. Каждое такое место помечено в .lm строкой // not lifted с причиной и готовой командой ww_get_bytecode: пустое тело — это заглушка, а не отсутствие логики; раскладку выброшенного дерева виджетов показывает ww_ui_tree. Путь принимается в любой форме индекса (BP_PlayHud, BP_PlayHud.BP_PlayHud_C, /Game/UI/BP_PlayHud.BP_PlayHud_C), /Game/Mods/<Мод>/... ищется в паках мода — в индексе игры их нет. Ответ кэшируется по (версия игры, ассет), refresh: true пересобирает заново. pattern — поиск по коду игры: если индекс собран с шагом подъёма (bun run setup), в нём есть исходники всех BP, и поиск отдаёт функцию, номер строки и сниппет; если профиль собран без этого шага, ответ будет no_code_index с объяснением.',
      inputSchema: {
        asset_path: z
          .string()
          .optional()
          .describe('Путь Blueprint в любой форме индекса: BP_PlayHud, BP_PlayHud.BP_PlayHud_C, /Game/UI/BP_PlayHud.BP_PlayHud_C, /Game/Mods/<Мод>/BP_X'),
        pattern: z.string().optional().describe('Поиск по поднятому коду игры: слово или фраза из тела функции (взаимоисключим с asset_path)'),
        limit: z.number().int().positive().max(100).optional().describe('Сколько совпадений вернуть в режиме pattern'),
        refresh: z.boolean().optional().describe('Игнорировать кэш и поднять заново (только для asset_path)'),
        version: versionParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    wrapAsync((ctx, args) => handleLift(ctx, config, args)),
  )

  registerTool(
    'ww_loom_build',
    {
      title: 'Сборка Blueprint из Loom',
      description:
        "Сборка Blueprint'ов из исходников Loom (.lm) и чтение её отчёта; свежий индекс игры не нужен. action=status (по умолчанию): последний <кит>/Intermediate/Loom/report.json (ok, sources, errors, blueprints по статусам built|unchanged|failed|skipped) и хвост строк LogLoomBuild/LogLoom из <кит>/Saved/Logs/Whiskerwood.log, открыт ли редактор и что с последним джобом сборки (с job_id — с этим джобом); ничего не собирает. action=build: если редактор с этим .uproject открыт, сборку запускает сам плагин по DirectoryWatcher при сохранении .lm — инструмент ждёт report.json новее своего старта (wait_ms, по умолчанию 90000) и говорит, подхватилось ли (picked_up | already_fresh | no_build_seen); если редактор закрыт, идёт headless-сборка UnrealEditor-Cmd -run=LoomBuild джобом: ответ отдаёт job_id, а прогресс и итог читаются через action=status job_id=… (сборка идёт десятки секунд, холодный старт дольше; джоб переживает перезапуск сервера). action=cancel снимает headless-сборку деревом процессов (taskkill /T /F по раннеру; без job_id — идущую или последнюю сборку); cook сюда не относится, его статус и отмена — в ww_loom_install. force собирает все Blueprint'ы, даже неизменившиеся, и доступен только при закрытом редакторе. Две сборки одного проекта одновременно недопустимы: при работающем джобе ответ busy, при чужом командире (-run=Cook) project_busy. failed в применителе: перед следующей сборкой удали автосейвы пакетов из <кит>/Saved/Autosaves, иначе следующая сборка может упасть на assert FindObject<UBlueprint>; failed с 0 Blueprints — отказ уровня исходника, безопасный.",
      inputSchema: {
        action: z
          .enum(['status', 'build', 'cancel'])
          .optional()
          .describe('По умолчанию status: отчёт и лог без сборки; build — собрать; cancel — снять headless-сборку'),
        job_id: z.string().optional().describe('id джоба из action=build: status показывает этот джоб, cancel снимает его'),
        force: z.boolean().optional().describe("Собрать все Blueprint'ы, даже неизменившиеся; только при закрытом редакторе (headless)"),
        wait_ms: z.number().int().positive().max(600000).optional().describe('Сколько ждать сборку, запущенную редактором по DirectoryWatcher, по умолчанию 90000'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    wrapPlain((args: LoomBuildArgs) => handleLoomBuild(config, args)),
  )

  registerTool(
    'ww_loom_install',
    {
      title: 'Собрать и установить pak-мод',
      description:
        'Cook & Install без редактора: start → status → install. action=start запускает RunUAT BuildCookRun с аргументами WWModTools джобом (идут минуты) и отвечает job_id. action=status только читает: прогресс cook, а по завершённому джобу — найденный пак мода среди pakchunk<N>-Windows.pak, итог проверок (только ассеты мода, размер меньше лимита загрузчика, имена папки/.uplugin/.pak совпадают, EngineVersion = версии движка кита) и сравнение с <saved>/mods/<Мод>: ready_to_install или installed, если там уже лежат те же файлы. Джоб смотрится только при явном job_id: status и install с одним mod_name работают по паку, который уже лежит в pakchunk, — исход прошлых cook (упал, отменён) им не мешает, а если cook этого мода идёт прямо сейчас, ответ busy с его job_id; status без аргументов показывает идущий или последний cook. action=install — единственное копирующее действие: по завершённому cook (job_id) или по уже собранному паку (mod_name) копирует <Мод>.pak и <Мод>.uplugin в <saved>/mods/<Мод>/ с бэкапом прежней версии в state/backup; если файлы уже совпадают побайтно — already_installed, ничего не копируется. start с skip_cook: true — установка уже собранного пака одним вызовом, без RunUAT (то же, что install mod_name=… без job_id). action=cancel снимает cook деревом процессов: job_id — этот джоб, mod_name — идущий или последний cook этого мода, без аргументов — любой идущий или последний. Единственный, кроме ww_install_mod, ww_deploy_mod (DLL нативной части) и ww_extract_asset, инструмент, пишущий за пределы песочницы: ровно в <saved>/mods/<Мод> (в <кит>/Content и <кит>/Plugins не пишет). Pak-мод подхватывается только при старте игры — после установки нужен ww_game_process restart save=… wait_for=world. Индекс игры не нужен: работает и на устаревшем профиле.',
      inputSchema: {
        action: z
          .enum(['start', 'status', 'install', 'cancel'])
          .describe('start — cook джобом (или установка при skip_cook); status — только чтение: прогресс, пак, проверки; install — копирование в <saved>/mods пака завершённого cook (job_id) или уже собранного (mod_name); cancel — снять cook'),
        mod_name: z
          .string()
          .optional()
          .describe('Имя папки мода в <кит>/Content/Mods; оно же имя .uplugin и .pak. Обязательно для start; для status и install без job_id — какой собранный пак проверить или поставить; для cancel без job_id — чей cook снять'),
        job_id: z.string().optional().describe('id джоба из action=start; только с ним status и install смотрят на джоб; без него status и install с mod_name берут уже собранный пак, cancel с mod_name — идущий или последний cook этого мода'),
        skip_cook: z.boolean().optional().describe('Только для start: установка уже собранного пака, без RunUAT'),
        version: versionParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    wrapPlain((args: LoomInstallArgs) => handleLoomInstall(config, args)),
  )

  registerTool(
    'ww_loom_new_mod',
    {
      title: 'Новый Loom-мод в ките',
      description:
        'Создаёт новый Loom-мод в ките без интерфейса редактора — то же, что «New mod...» плагина WWModTools: папка <кит>/Content/Mods/<Мод>, PAL_<Мод> (Primary Asset Label с первым свободным ChunkId 1..300 по существующим PAL и pakchunk<N>-Windows.pak, CookRule AlwaysCook, метит всю папку; без него .pak не соберётся), <Мод>.uplugin в формате плагина (Name, Description, Version, CreatedBy, EngineVersion = версии движка кита) и по желанию заготовки .lm из ресурсов ww://templates/loom/<имя> с подстановкой имени мода. PAL пишет сам редактор: UnrealEditor-Cmd -run=pythonscript со скриптом data/loom/new_mod.py джобом, около 30 с (.uproject не меняется). action=create проверяет всё до записи — имя (латиница, цифры, _), шаблоны (HudOverlay — вместо BP_MapLoad и только с WBP_Overlay), папки мода ещё нет (иначе mod_exists, ничего не перезаписывает), редактор с проектом закрыт (editor_open: тогда создай мод в нём через New mod...), джобов в ките нет (busy), — запускает джоб и ждёт его до wait_ms; .uplugin и .lm пишутся только после успешного PAL, а при провале папка мода убирается целиком. Ответ: status created | failed | cancelled | running, chunk, files, next. action=status job_id=… — итог джоба (дописывает файлы, если create не дождался); action=cancel снимает джоб деревом процессов и убирает недосозданное. Единственная запись сервера в <кит>/Content — эта новая папка.',
      inputSchema: {
        action: z
          .enum(['create', 'status', 'cancel'])
          .describe('create — создать мод джобом; status — итог джоба (без job_id — идущего или последнего); cancel — снять джоб'),
        mod_name: z.string().optional().describe('Имя папки мода в <кит>/Content/Mods: латиница, цифры, _, первым — буква или цифра; оно же PAL_<Мод>, .uplugin и .pak. Обязательно для create'),
        display_name: z.string().optional().describe('Name в .uplugin — отображаемое имя, по умолчанию имя папки'),
        description: z.string().optional().describe('Description в .uplugin, по умолчанию пусто'),
        version: z.string().optional().describe('Version в .uplugin, по умолчанию 1.0'),
        created_by: z.string().optional().describe('CreatedBy в .uplugin, по умолчанию пусто'),
        templates: z
          .array(z.string())
          .optional()
          .describe('Заготовки .lm, которые положить сразу: BP_Startup, BP_MapLoad, BP_MainMenuLoad, HudOverlay, WBP_Overlay (имена ресурсов ww://templates/loom/<имя>); HudOverlay ложится как BP_MapLoad.lm и требует WBP_Overlay'),
        job_id: z.string().optional().describe('id джоба из action=create: для status и cancel'),
        wait_ms: z.number().int().min(0).max(300000).optional().describe('Сколько create ждёт джоб, по умолчанию 90000; 0 — сразу вернуть job_id'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    wrapPlain((args: LoomNewModArgs) => handleLoomNewMod(config, args)),
  )

  registerTool(
    'ww_loom_status',
    {
      title: 'Статус кита Loom',
      description:
        'Кит Loom и его расхождения с игрой: найден ли кит, движок, loom.exe и types.json, открыт ли редактор, последний report.json, версия Loom против плагина, mtime types.json против пака игры и главное — сверка types.json с индексом: что есть в ките, но пропало из игры, и какие BlueprintCallable-функции игры Loom не видит. Работает без свежего профиля: без индекса отдаёт всё, кроме сверки.',
      inputSchema: { version: versionParam },
      annotations: READ_ONLY,
    },
    wrapPlain((args) => handleLoomStatus(config, args)),
  )

  registerTool(
    'ww_loom_validate',
    {
      title: 'Проверка Loom-мода',
      description:
        'Проверка Loom-мода до сборки: loom check по проекту мода плюс правила, которых check не видит, — заголовок blueprint и путь файла, имя папки/.uplugin/PAL, LogMessage без префикса мода, \\n в значении по умолчанию, наследование от игрового виджета (пустой Loom_Canvas поверх дерева родителя), override функции с возвращаемым значением, присваивание DeprecateSlateVector2D-полей, обращение к миру в BP_MapLoad до onLoadingFinished, BOM в начале файла, грабли Loom из памяти проекта. Отдельно сверяет ссылки на игровые классы, функции и поля с индексом: есть в ките, но нет в игре — стабы кита разъехались после патча. missing с именами игровых Blueprint — не ошибка, LoomBuild подгружает их сам. Работает и без свежего профиля: сверка с игрой тогда опускается.',
      inputSchema: {
        mod_root: z.string().optional().describe('Каталог мода; взаимоисключим с mod_name'),
        mod_name: z.string().optional().describe('Имя папки мода в <кит>/Content/Mods, например research_notifier'),
        version: versionParam,
      },
      annotations: READ_ONLY,
    },
    wrapPlain((args: LoomValidateArgs) => handleLoomValidate(config, args)),
  )

  registerTool(
    'ww_event_surface',
    {
      title: 'Точки реакции класса',
      description:
        'На что подписаться и что переопределить в Loom-моде: у класса или подсистемы — точки реакции по убыванию предпочтения. 1) делегаты ModAPI (глобальные) с готовой строкой bind и сигнатурой колбэка; 2) диспетчеры BlueprintAssignable самого класса и классов из его полей (глубина depth, по умолчанию 1) — тоже с bind; 3) события, переопределяемые наследником (флаг event), и следы спавна: где класс и его подклассы стоят в DataTable (подстрочный поиск — КАНДИДАТЫ, подмена через ModAPI.WriteDataTableValue) и рёбра ref xref; 4) последним средством — опрос в Tick с bTickEvenWhenPaused и TG_PostUpdateWork. У каждой точки поле verify: как проверить её вживую через ww_trace_calls (путь берётся из hook_path индекса), и evidence: откуда взяты данные (types.json кита + таблицы индекса). Отличие от ww_verify_hook: тот проверяет, годится ли путь для RegisterHook в Lua-моде, а этот отвечает, чем в Blueprint заменить сам хук. Без types.json кита отвечает types_json_unavailable: пропиши kitDir и собери кит.',
      inputSchema: {
        class_path: z.string().describe('Класс или подсистема: индексный путь, /Script/..., /Game/... или короткое имя'),
        depth: z.number().int().min(0).max(3).optional().describe('Глубина обхода полей за диспетчерами, по умолчанию 1 (0 — только сам класс)'),
        limit: z.number().int().positive().max(200).optional().describe('Максимум точек в каждой секции (ModAPI, диспетчеры, события), по умолчанию 12'),
        version: versionParam,
      },
      annotations: READ_ONLY,
    },
    wrap((ctx, args) => handleEventSurface(ctx, config, args)),
  )

  registerPrompts(server, config)
  registerResources(server, config)

  return server
}


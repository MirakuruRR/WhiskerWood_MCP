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
import { handlePackageMod, PackageModArgs } from './tools/package-mod'
import { handleInstallMod, InstallModArgs } from './tools/install-mod'
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

  server.registerTool(
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

  server.registerTool(
    'ww_game_eval',
    {
      title: 'Выполнить Lua в игре',
      description:
        'Выполняет чанк Lua в процессе игры через UE4SS и возвращает сериализованный результат. Используй для проверки гипотез об API, поиска живых объектов (FindAllOf/FindFirstOf) и чтения состояния мира. Пиши return, иначе значения не будет. Бесконечный цикл в чанке подвесит игру. Обход UMG-виджетов руками не пиши: дамп дерева есть у ww_ui_tree.',
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
        'Дамп поддерева UMG живой игры: класс, видимость, текстура кисти, текст, тип слота и выравнивание слота, а где смогли снять реальную геометрию — size=WxH и pos=X,Y (не всегда доступно вне живого Tick/Paint, тогда поле молча опускается). Шапка ответа показывает полное имя выбранного объекта и число кандидатов — так видно, тестовая карточка нашлась или игровая. Первый инструмент, когда надо понять устройство экрана, найти контейнер для своего виджета или увидеть, какую иконку и текст нарисовала игра: ищи в дампе tex= и text=. Без аргументов — дерево PlayHud. Ручной обход виджетов через ww_game_eval этим не заменяй.',
      inputSchema: {
        root: z.string().optional().describe('Класс владельца для FindAllOf, по умолчанию PlayHud'),
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

  server.registerTool(
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
          .describe('Пути функций в форме hook_path. Обязателен для action=start и одноразового режима, не нужен для read/stop'),
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

  server.registerTool(
    'ww_call',
    {
      title: 'Вызов UFunction на объекте',
      description:
        'Зовёт произвольную UFunction по индексному пути (как ww_get_function) на найденном объекте живой игры, с аргументами по именам параметров. Сигнатура и арность проверяются до вызова по индексу. Возвращает return-значение и out-параметры. Закрывает случаи вида "нажать кнопку dev-вью" или "уплатить налог программно" без сборки виджета руками — конкретные рецепты (что дёрнуть для какого окна) веди в памяти через ww_memory_add, а не жди их от инструмента. object принимает полный путь объекта (StaticFindObject) или короткое имя класса (первый через FindAllOf, object_index — если их несколько). Массивы, сеты, карты и делегаты как аргументы не поддержаны — для них ww_game_eval. Вызов произвольной UFunction в игровом потоке может уронить игру так же, как ww_game_eval: нативный access violation pcall не ловит. Один вызов за раз, не пачкой.',
      inputSchema: {
        object: z
          .string()
          .describe('Путь объекта (GetFullName/object_path) или короткое имя класса для FindAllOf'),
        object_index: z.number().int().positive().optional().describe('Номер кандидата (с 1), если по object нашлось несколько'),
        function_path: z.string().describe('Путь функции в любой форме индекса'),
        args: z.record(z.string(), z.unknown()).optional().describe('Аргументы по именам параметров — из ww_get_function'),
        version: versionParam,
      },
      annotations: LIVE_WRITE,
    },
    wrapAsync((ctx, args) => handleCallFunction(ctx, config, args)),
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
    'ww_crash_report',
    {
      title: 'Разбор краша игры',
      description:
        'Разбор краша без ручного лазанья по %LOCALAPPDATA%: сам находит свежий дамп в Saved/Crashes, достаёт ErrorMessage и код исключения из CrashContext.runtime-xml, подшивает хвост UE4SS.log до момента краша (из текущего лога или архива state/logs) и список включённых модов. Символов в Shipping-дампе нет, поэтому связка «адрес + последняя активность модов в логе» — основной материал. Работает при выключенной игре. Без аргументов — последний краш; list: true — список крашей с датами; crash: подстрока имени каталога дампа.',
      inputSchema: {
        crash: z.string().optional().describe('Подстрока имени каталога дампа (UECC-Windows-...); по умолчанию последний краш'),
        list: z.boolean().optional().describe('Список последних крашей вместо разбора'),
        limit: z.number().int().positive().max(100).optional().describe('Сколько крашей показать в list, по умолчанию 10'),
        tail: z.number().int().positive().max(200).optional().describe('Сколько строк лога до краша подшить, по умолчанию 30'),
        version: versionParam,
      },
      annotations: LIVE_READ,
    },
    wrapBridge(async (ctx, args) => handleCrashReport(ctx, config, args)),
  )

  server.registerTool(
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
        mod_root: z.string().describe('Каталог мода, например <репозиторий модов>/mods/research-notifier'),
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
        'Разбирает все .lua мода в AST и сверяет с индексом: синтаксис, каждый литеральный путь RegisterHook/StaticFindObject/FindFirstOf/FindAllOf/NotifyOnNewObject, форма пути (двоеточие против точки), арность коллбэков хуков, известные грабли UE4SS. Конфликты ищет и в соседних модах репозитория, и в реально установленных в ue4ss/Mods: один и тот же хуковый путь (UE4SS сцепляет коллбэки без приоритетов) и запись в одно и то же свойство одного класса; порядок разрешения берётся из mods.txt, а для записей из ExecuteWithDelay помечается как недетерминированная гонка. Динамически собранные пути помечаются отдельно как непроверяемые. Вызывай ПЕРЕД ww_deploy_mod и после каждой правки. live: true дополнительно пробивает пути через мост в живой игре.',
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
        'Загрузить мод в запущенную игру через мост WWBridge прямо из каталога разработки, со снятием хуков предыдущей загрузки; повторный вызов перезагружает мод без перезапуска игры. Сначала прогони ww_validate_mod.',
      inputSchema: {
        mod_root: z.string().describe('Каталог мода'),
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
        'Релизная сборка мода для раздачи игрокам: одна папка <Имя>/ со всеми .lua и mod.json, внутрь неё вендорится общая библиотека lib/ (Scripts/ww/*.lua) — у игрока нет WWBridge, расширяющего package.path, и без вендоринга require("ww.log") не найдётся. Рядом кладутся УСТАНОВКА.txt и INSTALL.txt (свои из корня мода или сгенерированные) — с установкой UE4SS и самого мода. Архив пишется в <modsRepo>/dist и никогда не перетирает существующий: при совпадении имени добавляется суффикс -b2, -b3. Версия берётся из mod.json, mod_version её задаёт и сохраняет обратно. Это не установка в игру — для неё ww_deploy_mod.',
      inputSchema: {
        mod_root: z.string().describe('Каталог мода'),
        mod_version: z.string().optional().describe('Версия релиза вида 1.2.3; по умолчанию version из mod.json или 1.0.0'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    wrapPlain((args: PackageModArgs) => handlePackageMod(config, args)),
  )

  server.registerTool(
    'ww_install_mod',
    {
      title: 'Установить релиз в игру',
      description:
        'Ставит мод в <ue4ssDir>/Mods/<Имя> из каталога (mod_root, копия — как ww_package_mod собирал бы файлы) или из готового релизного zip (как отдаёт ww_package_mod: папка "<Имя мода>/..." внутри архива). Имя берётся из mod.json, если не задано явно. Перед перезаписью существующего каталога делает бэкап в state/backup/<Имя>-<таймштамп>; если каталог есть, но не похож на мод UE4SS (нет Scripts/main.lua), без force: true отказывается перетирать. Правит mods.txt идемпотентно (enable по умолчанию true). Единственное вместе с ww_extract_asset исключение из правила "сервер пишет только в песочницу" — пишет ещё и в каталог игры: <ue4ssDir>/Mods/<Имя> и mods.txt. Live-загрузка в уже запущенную игру без перезапуска — отдельный ww_deploy_mod.',
      inputSchema: {
        mod_root: z.string().optional().describe('Каталог мода для установки (взаимоисключимо с zip)'),
        zip: z.string().optional().describe('Путь к релизному zip (взаимоисключимо с mod_root)'),
        name: z.string().optional().describe('Имя установки; по умолчанию — name из mod.json / имя папки в архиве'),
        enable: z.boolean().optional().describe('Включить в mods.txt, по умолчанию true'),
        force: z.boolean().optional().describe('Перезаписать существующий каталог, даже если он не похож на мод UE4SS'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    wrapPlain((args: InstallModArgs) => handleInstallMod(config, args)),
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


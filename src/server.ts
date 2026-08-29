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
import { handleGameConsole } from './tools/game-console'
import { handleGameLog } from './tools/game-log'
import { handleGetDataTable } from './tools/get-datatable'
import { handleResolveLoc } from './tools/resolve-loc'
import { handleFindAsset } from './tools/find-asset'
import { handleExtractAsset } from './tools/extract-asset'

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

  return server
}

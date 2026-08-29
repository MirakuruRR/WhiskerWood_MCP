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

const READ_ONLY = { readOnlyHint: true, openWorldHint: false }

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
        pattern: z.string().describe('Имя поля или метода (можно шаблон с % и _)'),
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
        'Ключевой инструмент: батч-проверка путей хуков ПЕРЕД записью кода мода. Принимает пути в любой форме, нормализует и сверяет с индексом. Вызывай со всеми путями мода одним вызовом. Статусы: found | found_hook_path_unavailable | not_found | not_found_possibly_not_loaded; похожие имена идут в suggestions и заменой найденному не являются.',
      inputSchema: {
        paths: z.array(z.string()).min(1).describe('Проверяемые пути (до 50 за вызов)'),
        live: z
          .boolean()
          .optional()
          .describe('Проба в живой игре через bridge (доступно с фазы 2)'),
        version: versionParam,
      },
      annotations: READ_ONLY,
    },
    wrap((ctx, args) => handleVerifyHook(ctx, args)),
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

  return server
}

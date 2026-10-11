import { ServerConfig } from '../config'
import { GameContext } from '../utils/game-context'
import { renderAiText, Scalar } from '../utils/ai-text'
import { findGameProcess } from '../utils/game-process'
import { gameOwnership, ownershipHint } from '../utils/session'
import { clickGameWindow } from '../utils/window-input'
import { echoFields } from './bridge-common'

export interface ClickArgs {
  x: number
  y: number
  button?: 'left' | 'right'
  double?: boolean
  restore_cursor?: boolean
  takeover?: boolean
}

export async function handleClick(ctx: GameContext | null, config: ServerConfig, args: ClickArgs): Promise<string> {
  const button = args.button ?? 'left'
  const fields: Record<string, Scalar> = { ...echoFields(ctx), x: args.x, y: args.y, button }
  if (args.double) fields.double = true

  const proc = findGameProcess(config)
  if (!proc) return renderAiText({ reportType: 'click', fields: { ...fields, status: 'game_not_running' } })
  if (args.takeover !== true) {
    const own = gameOwnership(config, proc)
    if (own.conflict === 'other_session') {
      return renderAiText({ reportType: 'click', fields: { ...fields, status: 'owned_by_other_session', ...own.fields, hint: ownershipHint(own, 'click') } })
    }
  }

  const res = clickGameWindow(proc.pid, args.x, args.y, button, args.double === true, args.restore_cursor !== false)
  if (!res.ok) {
    const hint =
      res.status === 'outside'
        ? 'точка вне окна игры: x, y — нативные пиксели окна (от его левого верхнего угла), а не пиксели вложения; пересчёт — по window и attach_scale из ответа ww_screenshot'
        : res.status === 'minimized'
          ? 'окно игры свёрнуто: разверни его, иначе Slate клик не получит'
          : res.status === 'no_game_window'
            ? 'процесс есть, а окна UnrealWindow нет: игра ещё грузится'
            : undefined
    return renderAiText({ reportType: 'click', fields: { ...fields, status: res.status, ...(res.error ? { error: res.error } : {}), ...(hint ? { hint } : {}) } })
  }
  return renderAiText({
    reportType: 'click',
    fields: {
      ...fields,
      status: 'clicked',
      screen: res.screen ?? '',
      window: res.window ?? '',
      next: 'клик отправлен, но дошёл ли он до виджета, видно только по результату: ww_screenshot, ww_ui_tree или лог мода',
    },
  })
}

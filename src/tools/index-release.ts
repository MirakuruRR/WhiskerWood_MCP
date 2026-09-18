import { closeIndexDbs } from '../utils/db'
import { renderAiText } from '../utils/ai-text'

export function handleIndexRelease(): string {
  closeIndexDbs()
  return renderAiText({
    reportType: 'index_release',
    fields: { status: 'ok', hint: 'дескрипторы index.db закрыты — bun run setup --force теперь сможет подменить каталог профиля' },
  })
}

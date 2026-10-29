import type { ApprovalMode } from './types.js'
import { APPROVAL_WORDS } from '../sessions/settings.js'

/** Пояснение для модели, не разрешение: ограничения задают CLI и брокер. */
export function approvalContext(provider: 'claude' | 'codex', approval: ApprovalMode | undefined, broker: boolean): string {
  const mode = approval ?? 'ask'
  const label = APPROVAL_WORDS[mode]
  const title = label[0]!.toUpperCase() + label.slice(1)
  const lines = [
    '<pult_runtime_context>',
    `Контекст Пульта для этого хода: провайдер ${provider}; выбран режим «${title}» (${mode}). При смене режима ориентируйся на контекст текущего хода и действующие ограничения инструментов.`,
  ]
  if (provider === 'codex') {
    const sandbox = mode === 'full' ? 'danger-full-access' : mode === 'read-only' ? 'read-only' : 'workspace-write'
    const asks = broker && (mode === 'ask' || mode === 'read-only')
    lines.push(`Codex: sandbox=${sandbox}, approval_policy=${asks ? 'on-request' : 'never'}.`)
    if (mode === 'read-only') lines.push('Песочница разрешает чтение; расширение доступа запрашивается отдельно.')
    if (mode === 'workspace') lines.push('Разрешены правки в рабочей папке. Запросить запуск вне песочницы в этом режиме нельзя: «без вопросов» означает автоматический отказ для действий, требующих расширения доступа.')
    if (asks) lines.push('Для необходимого действия за пределами песочницы используй штатный запрос разрешения: он приходит человеку в Inbox Пульта.')
    if (mode !== 'full') lines.push('Вложенные процессы, включая claude и codex, наследуют песочницу. Сеть, localhost, Keychain или файлы авторизации могут быть недоступны, даже когда CLI работает в обычном терминале.')
    if (mode === 'workspace' && broker) lines.push('Если задача требует выхода из песочницы, объясни причину и предложи пользователю переключить режим этой сессии на «Спрашивать», затем повторить запрос. Сам режим не меняй и ограничения не обходи.')
  } else {
    const cliMode = mode === 'workspace' ? 'acceptEdits' : mode === 'full' ? 'bypassPermissions' : mode === 'read-only' ? 'manual' : 'настройки владельца'
    lines.push(`Claude Code: permission-mode=${cliMode}.`)
    if (mode === 'read-only') lines.push('Инструменты правки отключены; Bash требует разрешения.')
    if (mode === 'workspace') lines.push('Правки файлов принимаются автоматически по правилам acceptEdits; для остальных инструментов действуют разрешения Claude Code. Это отличается от workspace-write + never у Codex.')
    if (broker && mode !== 'full') lines.push('Если инструмент требует разрешения, используй штатный запрос: он приходит человеку в Inbox Пульта.')
  }
  if (!broker) lines.push('Сейчас брокер разрешений недоступен: действия, требующие подтверждения, отклоняются. Объясни это пользователю; подтверждение в тексте чата не заменяет разрешение инструмента.')
  if (mode === 'full') lines.push('Пульт не ставит свою песочницу или запросы разрешений в этом режиме. Это не гарантирует доступ к сети, Keychain, учётной записи или ресурсам ОС.')
  lines.push(
    'При отказе доступа или ответе вложенной CLI «Not logged in» сначала различай ограничения текущего процесса и состояние входа пользователя. Сообщай наблюдаемый факт и источник ограничения; такой ответ сам по себе не доказывает, что пользователь вышел из аккаунта. Повторный вход предлагай после подтверждения проблемы авторизации вне ограниченного процесса.',
    '</pult_runtime_context>',
  )
  return lines.join('\n')
}

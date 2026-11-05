import { useCallback, useState } from 'react'
import type { ReactElement } from 'react'
import { t } from '../lib/i18n.js'
import type { InterfaceMode } from '../model/appearance.js'
import type { AgentView } from '../model/agents.js'
import { statusView } from '../model/agents.js'
import { accessChip } from '../model/access.js'
import { contextView } from '../model/context.js'
import type { ConvItem } from '../model/conversation.js'
import { ContextMenu } from './ContextMenu.js'
import type { MenuEntry } from './ContextMenu.js'
import { Icon } from './common.js'
import { Markdown } from './Markdown.js'

export function modeMenuItems(mode: InterfaceMode, onMode: (mode: InterfaceMode) => void): MenuEntry[] {
  return [{ heading: t('Режим интерфейса') }, ...(['normal', 'expanded', 'focus'] as const).map((value) => ({ label: value === 'normal' ? t('Обычный') : value === 'expanded' ? t('Расширенный') : t('Фокус'), checked: mode === value, testId: `mode-${value}`, onSelect: () => onMode(value) }))]
}

export function WorkspaceActions(p: { sidebarHidden: boolean; onSidebar(): void; filesOpen: boolean; onFiles?(): void; runtimeOpen: boolean; onRuntime?(): void; mode?: InterfaceMode; onMode?(mode: InterfaceMode): void }): ReactElement {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const close = useCallback(() => setAt(null), [])
  return <div className="workspace-actions">
    <button type="button" className="chrome-icon sidebar-toggle" onClick={p.onSidebar} aria-expanded={!p.sidebarHidden} aria-label={p.sidebarHidden ? t('Показать беседы') : t('Скрыть беседы')} title={t('Беседы')} data-testid="toggle-sidebar"><Icon name="sidebar" /></button>
    {p.onRuntime && <button type="button" className="chrome-icon" aria-pressed={p.runtimeOpen} title={t('Превью')} aria-label={t('Превью')} onClick={p.onRuntime} data-testid="toggle-runtime"><Icon name="model" /></button>}
    {p.onFiles && <button type="button" className="chrome-icon" aria-pressed={p.filesOpen} title={t('Файлы')} aria-label={t('Файлы')} onClick={p.onFiles} data-testid="toggle-files"><Icon name="folder" /></button>}
    {p.onMode && <button type="button" className="chrome-icon" title={t('Режим интерфейса')} aria-label={t('Режим интерфейса')} aria-haspopup="menu" aria-expanded={at !== null} data-testid="mode-menu-open" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAt(at ? null : { x: r.right, y: r.bottom + 4 }) }}><Icon name="more" /></button>}
    {at && p.onMode && <ContextMenu at={at} onClose={close} items={modeMenuItems(p.mode ?? 'normal', p.onMode)} label={t('Режим интерфейса')} testId="mode-menu" />}
  </div>
}

export function ConversationSummary({ agent, items }: { agent: AgentView; items: readonly ConvItem[] }): ReactElement {
  const latest = [...items].reverse().find((it) => it.type === 'model' && it.text.trim())
  const context = contextView(agent.context)
  return <aside className="conversation-summary" aria-label={t('Сводка разговора')} data-testid="conversation-summary">
    <h3>{t('Сводка')}</h3>
    <div className={`summary-state t-${statusView(agent.status).tone}`}>{statusView(agent.status).label}</div>
    {latest?.type === 'model' && <section><h4>{t('Последний ответ')}</h4><div className="summary-answer"><Markdown text={latest.text} /></div></section>}
    <section><h4>{t('Параметры')}</h4><dl><dt>{t('Модель')}</dt><dd>{agent.model ?? agent.provider}</dd><dt>{t('Усилие')}</dt><dd>{agent.effort ?? '—'}</dd><dt>{t('Доступ')}</dt><dd>{accessChip(agent).label}</dd><dt>{t('Контекст')}</dt><dd>{context?.short ?? '—'}</dd></dl></section>
  </aside>
}

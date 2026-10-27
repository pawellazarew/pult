// Активные беседы, проекты и постоянно доступные недавние — с раздельной прокруткой.

import { useCallback, useState } from 'react'
import type { MouseEvent, ReactElement } from 'react'
import { ContextMenu } from './ContextMenu.js'
import type { MenuEntry } from './ContextMenu.js'
import type { AgentView } from '../model/agents.js'
import { agentLabel, ago, shortPath } from '../model/agents.js'
import { chatSections, chatStatus } from '../model/navigation.js'
import { projectName } from '../model/projects.js'
import { contextRowView } from '../model/context.js'
import type { ProjectGroup } from '../model/projects.js'
import { projectRemoval } from '../model/projects.js'
import { plural } from '../lib/ru.js'
import { CMD, Icon, Kbd } from './common.js'

export interface ProjectTreeProps {
  groups: readonly ProjectGroup[]
  selected: string | null
  now: number
  /** Свёрнутые проекты (пути). */
  collapsed: ReadonlySet<string>
  onSelect(name: string): void
  /** Новая сессия: `null` — без папки (её выберут в диалоге), иначе — в этом проекте. */
  onNew(projectPath: string | null): void
  onToggle(path: string): void
  onAddProject(): void
  /** Закрепить неявный проект (папку сессии) или убрать закреплённый из списка. */
  onPin(path: string, pinned: boolean): void
  /**
   * M8d: убрать из списка папку С сессиями — окно спросит подтверждение («N сессий уйдут в архив») и
   * отдаст демону `project.remove {sessions}`. Нет — старое поведение (только закрепить/снять).
   */
  onHide?(path: string, sessions: readonly string[], busy: readonly string[]): void
  /** Сессии в архиве — своя секция внизу дерева. */
  archived?: readonly AgentView[]
  onRename?(name: string): void
  onArchive?(name: string, archived: boolean): void
  onRemove?(name: string): void
  onReveal?(path: string): void
  /** О2: выгрузить разговор в Markdown (файл в PULT_HOME/exports, Finder покажет его). */
  onExport?(name: string): void
  /** О3: браузер для агента вкл/выкл и «показывать окно» — со следующего хода. Нет — старая оболочка. */
  onBrowser?(name: string, on: boolean, headed: boolean): void
}

type OpenMenu = { at: { x: number; y: number }; items: MenuEntry[]; testId: string }

/** Куда встать меню: правый клик — под курсор, «⋯» — под кнопку. */
const menuAt = (e: MouseEvent<HTMLElement>): { x: number; y: number } => {
  if (e.type === 'contextmenu') return { x: e.clientX, y: e.clientY }
  const r = e.currentTarget.getBoundingClientRect()
  return { x: r.left, y: r.bottom + 2 }
}

/** Пункты меню браузера агента: вкл/выкл и, когда включён, «показывать окно». Действуют со следующего хода. */
export function browserItems(a: AgentView, onBrowser: (name: string, on: boolean, headed: boolean) => void): MenuEntry[] {
  if (!a.browser) return [{ label: 'Браузер для агента', onSelect: () => onBrowser(a.name, true, false), testId: 'row-browser-on' }]
  const headed = a.browser.headed === true
  return [
    { label: '✓ Браузер для агента', onSelect: () => onBrowser(a.name, false, false), testId: 'row-browser-off' },
    { label: headed ? '✓ Показывать окно браузера' : 'Показывать окно браузера', onSelect: () => onBrowser(a.name, true, !headed), testId: 'row-browser-headed' },
  ]
}

export function ProjectTree(p: ProjectTreeProps): ReactElement {
  const archived = p.archived ?? []
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [query, setQuery] = useState('')
  const sections = chatSections(p.groups, query)
  const active = sections.filter((s) => s.key !== 'recent' && s.rows.length > 0)
  const recent = sections.find((s) => s.key === 'recent')!
  const closeMenu = useCallback(() => setMenu(null), [])

  const projectMenu = (e: MouseEvent<HTMLElement>, g: ProjectGroup): void => {
    e.preventDefault(); e.stopPropagation()
    const removal = projectRemoval(g)
    setMenu({ at: menuAt(e), testId: 'project-menu-list', items: [
      { label: 'Новая сессия здесь', onSelect: () => p.onNew(g.path), testId: 'project-menu-new' },
      ...(!g.pinned ? [{ label: 'Закрепить как проект', onSelect: () => p.onPin(g.path, true), testId: 'project-pin' }] : []),
      // M8d: убрать можно ЛЮБОЙ проект. Закреплённый без сессий — снять закрепление (это и есть «убрать»);
      // закреплённый с сессиями можно и просто открепить — сессии останутся папкой; «Убрать из списка…» у папки с
      // сессиями — их в архив (с вопросом), и папка пропадает из дерева.
      ...(g.pinned
        ? [{ label: removal?.kind === 'archive' ? 'Открепить (сессии останутся папкой)' : 'Убрать из списка', onSelect: () => p.onPin(g.path, false), testId: 'project-unpin' }]
        : []),
      ...(removal?.kind === 'archive' && p.onHide
        ? [{ label: 'Убрать из списка…', onSelect: () => p.onHide?.(g.path, removal.sessions, removal.busy), testId: 'project-hide' }] : []),
      'sep',
      { label: 'Показать в Finder', onSelect: () => p.onReveal?.(g.path), disabled: !p.onReveal, testId: 'project-reveal' },
    ] })
  }
  const sessionMenu = (e: MouseEvent<HTMLElement>, a: AgentView): void => {
    e.preventDefault(); e.stopPropagation()
    setMenu({ at: menuAt(e), testId: 'session-menu-list', items: [
      { label: 'Переименовать…', onSelect: () => p.onRename?.(a.name), disabled: !p.onRename, testId: 'row-rename' },
      { label: 'Показать папку в Finder', onSelect: () => p.onReveal?.(a.cwd), disabled: !p.onReveal, testId: 'row-reveal' },
      { label: 'Экспорт в Markdown', onSelect: () => p.onExport?.(a.name), disabled: !p.onExport, testId: 'row-export' },
      ...(p.onBrowser ? browserItems(a, p.onBrowser) : []),
      a.archived
        ? { label: 'Вернуть из архива', onSelect: () => p.onArchive?.(a.name, false), disabled: !p.onArchive, testId: 'row-unarchive' }
        : { label: 'В архив', onSelect: () => p.onArchive?.(a.name, true), disabled: !p.onArchive, testId: 'row-archive' },
      'sep',
      { label: 'Удалить…', onSelect: () => p.onRemove?.(a.name), danger: true, disabled: !p.onRemove, testId: 'row-remove' },
    ] })
  }
  const row = (a: AgentView, project: string): ReactElement =>
    <SessionRow key={a.name} a={a} project={project} selected={a.name === p.selected} now={p.now} onSelect={p.onSelect} onMenu={sessionMenu} />
  return (
    <nav className="agents" aria-label="Проекты и сессии">
      <div className="sidebar-top">
        <button type="button" className="btn btn-primary new-chat" onClick={() => p.onNew(null)} data-testid="new-agent">
          <Icon name="plus" />Новый чат<span className="grow" /><Kbd>{`${CMD}N`}</Kbd>
        </button>
        <label className="chat-search"><Icon name="search" /><input value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault(); e.stopPropagation()
              if (query) setQuery('')
              else document.querySelector<HTMLTextAreaElement>('[data-testid="composer"]')?.focus()
            } else if (e.key === 'Enter') {
              const first = sections.flatMap((s) => s.rows)[0]?.agent
              if (first) { e.preventDefault(); e.stopPropagation(); p.onSelect(first.name); setQuery(''); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-testid="composer"]')?.focus()) }
            }
          }}
          placeholder="Поиск бесед и проектов" aria-label="Поиск бесед и проектов" data-testid="chat-filter" title={`Поиск бесед (${CMD}K)`} /><Kbd>{`${CMD}K`}</Kbd>
          {query && <button type="button" className="row-btn" onClick={() => setQuery('')} aria-label="Очистить поиск"><Icon name="x" /></button>}
        </label>
      </div>
      <div className="tree" data-testid="agent-list">
        {(active.length > 0 || sections.every((s) => s.rows.length === 0)) && <div className="active-chats" data-testid="active-chats">
        {active.map((section) => (
          <section key={section.key} className="chat-section" data-testid={`chats-${section.key}`}>
            <h3 className="chat-section-title">{section.label}<span>{section.rows.length}</span></h3>
            <ul className="ag-list" role="listbox" aria-label={section.label}>
              {section.rows.map(({ agent: a, projectPath }) => row(a, projectPath))}
            </ul>
          </section>
        ))}
        {sections.every((s) => s.rows.length === 0) && <div className="empty-hint" data-testid="agents-empty">
          <h3>{query ? 'Ничего не найдено' : 'Начни с нового чата'}</h3>
          {query ? 'Попробуй другое название или имя проекта.' : 'Выбери папку проекта и напиши, что сделать.'}
        </div>}
        </div>}
        <div className="sidebar-projects" data-testid="sidebar-projects">
        <details className="project-manager" data-testid="project-manager">
          <summary>Проекты<span className="count">{p.groups.length}</span></summary>
          <button type="button" className="btn btn-sm btn-ghost project-add" onClick={p.onAddProject} data-testid="add-project" title="Добавить папку проекта">
            <Icon name="plus" />Добавить проект
          </button>
          {p.groups.map((g) => (
            <section key={g.path} className="proj" data-testid="project" data-project={g.path} data-pinned={g.pinned ? '1' : '0'}>
              <div className="proj-h" onContextMenu={(e) => projectMenu(e, g)} title={g.path}>
                <Icon name="folder" />
                <span className="proj-name">{g.name}</span>
                {g.unread > 0 && <span className="proj-unread" data-testid="project-unread" title={`${g.unread} ${plural(g.unread, 'непрочитанная беседа', 'непрочитанные беседы', 'непрочитанных бесед')}`}>{g.unread}</span>}
                <span className="grow" />
                <button type="button" className="proj-btn" title={`Новая сессия в ${shortPath(g.path, 60)}`} data-testid="project-new-session"
                  onClick={(e) => { e.stopPropagation(); p.onNew(g.path) }}><Icon name="plus" /></button>
                <button type="button" className="proj-btn" data-testid="project-menu" title="Действия с проектом"
                  aria-label={`Действия с проектом ${g.name}`} onClick={(e) => projectMenu(e, g)}><span className="dots" aria-hidden="true">⋯</span></button>
              </div>
            </section>
          ))}
        </details>
          {archived.length > 0 && (
            <section className="proj proj-archive" data-testid="archive-section">
              <div className="proj-h" onClick={() => setArchiveOpen((v) => !v)} aria-expanded={archiveOpen} title="Сессии в архиве: реплика возвращает сессию из архива">
                <Icon name="chev" className={`ic proj-chev${archiveOpen ? ' open' : ''}`} />
                <span className="proj-name">Архив</span>
                <span className="count">{archived.length}</span>
              </div>
              {archiveOpen && (
                <ul className="ag-list" role="listbox" aria-label="Сессии в архиве">
                  {archived.map((a) => row(a, a.repo ?? a.cwd))}
                </ul>
              )}
            </section>
          )}
        </div>
        <section className="chat-section chat-recent" data-testid="chats-recent">
          <h3 className="chat-section-title">Недавние<span>{recent.rows.length}</span></h3>
          <ul className="ag-list" role="listbox" aria-label="Недавние">
            {recent.rows.map(({ agent: a, projectPath }) => row(a, projectPath))}
          </ul>
          {recent.rows.length === 0 && <div className="recent-empty">{query ? 'Нет совпадений среди недавних' : 'Здесь будут недавние беседы'}</div>}
        </section>
      </div>
      {menu && <ContextMenu at={menu.at} items={menu.items} onClose={closeMenu} testId={menu.testId} />}
    </nav>
  )
}

function SessionRow({ a, project, selected, now, onSelect, onMenu }: {
  a: AgentView; project: string; selected: boolean; now: number; onSelect(name: string): void
  onMenu(e: MouseEvent<HTMLElement>, a: AgentView): void
}): ReactElement {
  const sv = chatStatus(a)
  const needs = sv.tone === 'wait'
  const ctx = a.context && a.context.window && a.context.used / a.context.window >= .8 ? contextRowView(a.context) : null
  return (
    <li className="ag" role="option" aria-selected={selected}
      data-provider={a.provider} data-needs={needs ? '1' : '0'} data-unread={a.unread ? '1' : '0'} data-testid="agent-row" data-agent={a.name}
      tabIndex={0} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSelect(a.name) } }}
      onClick={() => onSelect(a.name)} onContextMenu={(e) => onMenu(e, a)}>
      <span className="ag-name" title={a.title ? `${a.title} · имя для CLI: ${a.name}` : undefined}>
        {a.unread && <UnreadDot a={a} testId="row-unread" />}{agentLabel(a)}
      </span>
      <span className="ag-right" title={a.pending > 0 ? `${a.pending} ${plural(a.pending, 'запрос', 'запроса', 'запросов')} в Inbox` : undefined}>
        {/* Однозначное состояние рядом с названием, текущее действие — во второй строке. */}
        <span className={`chat-row-status t-${sv.tone}${a.status === 'cold' || a.status === 'idle' || a.status === 'done' ? ' is-quiet' : ''}`} data-testid="row-status" title={sv.detail}>{sv.label}{a.pending > 0 ? ` · ${a.pending}` : ''}</span>
        <button type="button" className="row-btn" data-testid="row-menu" title="Действия с сессией" aria-label={`Действия с сессией ${agentLabel(a)}`}
          onClick={(e) => onMenu(e, a)}><span className="dots" aria-hidden="true">⋯</span></button>
      </span>
      <span className="ag-meta">
        <span className="chat-project" title={a.cwd}>{projectName(project)}</span>
        <span className={`chat-provider who-${a.provider}`}>{a.provider === 'claude' ? 'Claude' : a.provider === 'codex' ? 'Codex' : a.provider}</span>
        {a.status === 'working' && <span className="chat-action" title={sv.detail}>{sv.detail}</span>}
        {a.background && <span className="bg" title={`фоновые задачи:\n${a.background.tasks.join('\n')}`} data-testid="row-background">фон · {a.background.count}</span>}
        {ctx && <span className={`ctx t-${ctx.tone}`} title={ctx.title} data-testid="row-context">ctx {ctx.short}</span>}
        <span className="when">{ago(a.lastActivity, now)}</span>
      </span>
    </li>
  )
}

/**
 * Точка «непрочитано» (О2): ход закончился, упал или спросил, а сессию с тех пор не открывали. Красная —
 * если это ошибка (ход упал, лимит, страж), иначе цвета акцента.
 */
export function UnreadDot({ a, testId }: { a: Pick<AgentView, 'attention'>; testId: string }): ReactElement {
  const error = a.attention?.kind === 'failed' || a.attention?.kind === 'limit' || a.attention?.kind === 'blocked'
  return <span className="unread-dot" data-error={error ? '1' : '0'} data-testid={testId} role="img"
    aria-label={error ? 'непрочитанная ошибка' : 'непрочитано'} title={error ? 'непрочитанная ошибка' : 'непрочитано'} />
}

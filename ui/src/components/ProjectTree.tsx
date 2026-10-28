// Основная навигация — проекты с чатами; недавние остаются отдельными ярлыками снизу.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent, ReactElement } from 'react'
import { SidebarSplit } from './SidebarSplit.js'
import type { ProjectFilter } from '../model/navigation.js'
import { ContextMenu } from './ContextMenu.js'
import type { MenuEntry } from './ContextMenu.js'
import type { AgentView } from '../model/agents.js'
import { agentLabel, ago, shortPath } from '../model/agents.js'
import { chatSections, chatStatus, projectChats, projectPreview } from '../model/navigation.js'
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
  const [revealRequest, setRevealRequest] = useState(0)
  const sections = chatSections(p.groups, query)
  const [filter, setFilter] = useState<ProjectFilter>('all')
  const [longProjects, setLongProjects] = useState(new Set<string>())
  const list = projectChats(p.groups, query, filter)
  const selectedProject = p.groups.find((g) => g.sessions.some((a) => a.name === p.selected))?.path
  const lastReveal = useRef<string | null>(null)
  const projectArea = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!p.selected || !selectedProject || lastReveal.current === `${selectedProject}:${p.selected}`) return
    lastReveal.current = `${selectedProject}:${p.selected}`
    if (p.collapsed.has(selectedProject)) p.onToggle(selectedProject)
  }, [p.selected, selectedProject, p.collapsed, p.onToggle])
  const recent = sections.find((s) => s.key === 'recent')!
  useEffect(() => {
    if (!p.selected) return
    const timer = window.setTimeout(() => {
      const area = projectArea.current
      const row = area?.querySelector<HTMLElement>('[data-testid="agent-row"][aria-selected="true"]')
      if (!area || !row || row.closest('details:not([open])')) return
      const bounds = area.getBoundingClientRect(), item = row.getBoundingClientRect()
      if (item.top < bounds.top || item.bottom > bounds.bottom) row.scrollIntoView({ block: 'nearest' })
    }, 240)
    return () => window.clearTimeout(timer)
  }, [p.selected, selectedProject, revealRequest])
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
  const row = (a: AgentView, project: string, shortcut = false): ReactElement =>
    <SessionRow key={a.name} a={a} project={project} shortcut={shortcut} selected={a.name === p.selected} now={p.now} onSelect={(name) => {
      if (shortcut) { if (p.collapsed.has(project)) p.onToggle(project); setRevealRequest((n) => n + 1) }
      p.onSelect(name)
    }} onMenu={sessionMenu} />
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
              const first = list.flatMap((g) => g.rows)[0]
              if (first) { e.preventDefault(); e.stopPropagation(); p.onSelect(first.name); setQuery(''); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-testid="composer"]')?.focus()) }
            }
          }}
          placeholder="Поиск бесед и проектов" aria-label="Поиск бесед и проектов" data-testid="chat-filter" title={`Поиск бесед (${CMD}K)`} /><Kbd>{`${CMD}K`}</Kbd>
          {query && <button type="button" className="row-btn" onClick={() => setQuery('')} aria-label="Очистить поиск"><Icon name="x" /></button>}
        </label>
      </div>
      <div className="sidebar-filters" aria-label="Фильтр чатов">
        {(['all', 'working', 'waiting'] as const).map((key) => {
          const count = key === 'all' ? sections.reduce((n, g) => n + g.rows.length, 0) : sections.find((g) => g.key === key)!.rows.length
          return <button type="button" key={key} className={`sidebar-filter${filter === key ? ' active' : ''}`} aria-pressed={filter === key}
            data-testid={`filter-${key}`} onClick={() => setFilter(key)}>{key === 'all' ? 'Все' : key === 'working' ? 'В работе' : 'Ждут'}<span>{count}</span></button>
        })}
      </div>
      <SidebarSplit projects={<div className="sidebar-projects" data-testid="sidebar-projects" ref={projectArea}>
        <div className="project-manager" data-testid="project-manager">
          <div className="projects-heading"><h3>Проекты<span className="count">{list.length}</span></h3>
            <button type="button" className="proj-btn project-add" onClick={p.onAddProject} data-testid="add-project" title="Добавить папку проекта" aria-label="Добавить проект"><Icon name="plus" /></button>
          </div>
          {list.map(({ group: g, rows, working, waiting }) => {
            const closed = !query && p.collapsed.has(g.path)
            const full = !!query || filter !== 'all' || longProjects.has(g.path)
            const shown = projectPreview(rows, p.selected, full)
            const waitLabel = `${waiting} ${plural(waiting, 'ждёт ответа', 'ждут ответа', 'ждут ответа')}`
            return <details key={g.path} className={`proj project-group${selectedProject === g.path ? ' current-project' : ''}`} open={!closed}
              data-testid="project" data-project={g.path} data-pinned={g.pinned ? '1' : '0'}
              onToggle={(e) => { if (!query && e.currentTarget.open === p.collapsed.has(g.path)) p.onToggle(g.path) }}>
              <summary className="proj-h" onContextMenu={(e) => projectMenu(e, g)} onClick={(e) => { if (query) e.preventDefault() }} title={g.path} data-testid="project-toggle">
                <Icon name="chev" className="ic proj-chev" /><Icon name="folder" />
                <span className="proj-name">{g.name}</span><span className="project-chat-count" aria-label={`${rows.length} чатов`}>{rows.length}</span>
                <span className="grow" />
                {closed && waiting > 0 && <span className="project-state t-wait" title={`${waitLabel}${working ? ` · ${working} в работе` : ''}`} aria-label={waitLabel}>● {waiting}</span>}
                {closed && waiting === 0 && working > 0 && <span className="project-state t-run" title={`${working} в работе`} aria-label={`${working} в работе`}>● {working}</span>}
                {g.unread > 0 && <span className="proj-unread" data-testid="project-unread" title={`${g.unread} ${plural(g.unread, 'непрочитанная беседа', 'непрочитанные беседы', 'непрочитанных бесед')}`}>{g.unread}</span>}
                <button type="button" className="proj-btn" title={`Новая сессия в ${shortPath(g.path, 60)}`} aria-label={`Новый чат в ${g.name}`} data-testid="project-new-session"
                  onKeyDown={(e) => e.stopPropagation()} onClick={(e) => { e.preventDefault(); e.stopPropagation(); p.onNew(g.path) }}><Icon name="plus" /></button>
                <button type="button" className="proj-btn" data-testid="project-menu" title="Действия с проектом" aria-label={`Действия с проектом ${g.name}`}
                  onKeyDown={(e) => e.stopPropagation()} onClick={(e) => projectMenu(e, g)}><span className="dots" aria-hidden="true">⋯</span></button>
              </summary>
              <div className="project-chats chat-section">
                <ul className="ag-list" role="listbox" aria-label={`Чаты проекта ${g.name}`}>{shown.map((a) => row(a, g.path))}</ul>
                {rows.length === 0 && <button type="button" className="project-empty" onClick={() => p.onNew(g.path)}>Новый чат в этом проекте<Icon name="plus" /></button>}
                {!full && shown.length < rows.length && <button type="button" className="project-more" data-testid="project-more" onClick={() => setLongProjects((before) => new Set(before).add(g.path))}>Показать ещё {rows.length - shown.length}</button>}
                {longProjects.has(g.path) && !query && filter === 'all' && rows.length > 4 && <button type="button" className="project-more" onClick={() => setLongProjects((before) => { const next = new Set(before); next.delete(g.path); return next })}>Свернуть список</button>}
              </div>
            </details>
          })}
          {list.length === 0 && <div className="empty-hint" data-testid="agents-empty"><h3>{query ? 'Ничего не найдено' : filter === 'all' ? 'Начни с нового чата' : 'Таких чатов пока нет'}</h3>
            {query ? 'Попробуй другое название или имя проекта.' : 'Выбери другой фильтр или создай новый чат.'}</div>}
        </div>
        {archived.length > 0 && <section className="proj proj-archive" data-testid="archive-section">
          <button type="button" className="proj-h archive-toggle" onClick={() => setArchiveOpen((v) => !v)} aria-expanded={archiveOpen} title="Сессии в архиве: реплика возвращает сессию из архива">
            <Icon name="chev" className={`ic proj-chev${archiveOpen ? ' open' : ''}`} /><span className="proj-name">Архив</span><span className="count">{archived.length}</span>
          </button>
          {archiveOpen && <ul className="ag-list" role="listbox" aria-label="Сессии в архиве">{archived.map((a) => row(a, a.repo ?? a.cwd))}</ul>}
        </section>}
      </div>} recent={<section className="chat-section chat-recent" data-testid="chats-recent">
        <h3 className="chat-section-title">Недавние<span>{recent.rows.length}</span></h3>
        <ul className="ag-list" role="listbox" aria-label="Недавние">{recent.rows.map(({ agent: a, projectPath }) => row(a, projectPath, true))}</ul>
        {recent.rows.length === 0 && <div className="recent-empty">{query ? 'Нет совпадений среди недавних' : 'Здесь будут недавние беседы'}</div>}
      </section>} />
      {menu && <ContextMenu at={menu.at} items={menu.items} onClose={closeMenu} testId={menu.testId} />}
    </nav>
  )
}

function SessionRow({ a, project, selected, now, onSelect, onMenu, shortcut = false }: {
  a: AgentView; project: string; selected: boolean; now: number; shortcut?: boolean; onSelect(name: string): void
  onMenu(e: MouseEvent<HTMLElement>, a: AgentView): void
}): ReactElement {
  const sv = chatStatus(a)
  const needs = sv.tone === 'wait'
  const ctx = a.context && a.context.window && a.context.used / a.context.window >= .8 ? contextRowView(a.context) : null
  return (
    <li className="ag" role="option" aria-selected={selected}
      data-provider={a.provider} data-needs={needs ? '1' : '0'} data-unread={a.unread ? '1' : '0'} data-testid={shortcut ? 'recent-row' : 'agent-row'} data-agent={a.name} data-sidebar-chat="1"
      tabIndex={0} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSelect(a.name) } }}
      onClick={() => onSelect(a.name)} onContextMenu={(e) => onMenu(e, a)}>
      <span className="ag-name" title={a.title ? `${a.title} · имя для CLI: ${a.name}` : undefined}>
        {a.unread && <UnreadDot a={a} testId={shortcut ? 'recent-unread' : 'row-unread'} />}{agentLabel(a)}
      </span>
      <span className="ag-right" title={a.pending > 0 ? `${a.pending} ${plural(a.pending, 'запрос', 'запроса', 'запросов')} в Inbox` : undefined}>
        {/* Однозначное состояние рядом с названием, текущее действие — во второй строке. */}
        <span className={`chat-row-status t-${sv.tone}${a.status === 'cold' || a.status === 'idle' || a.status === 'done' ? ' is-quiet' : ''}`} data-testid="row-status" title={sv.detail}>{sv.label}{a.pending > 0 ? ` · ${a.pending}` : ''}</span>
        <button type="button" className="row-btn" data-testid="row-menu" title="Действия с сессией" aria-label={`Действия с сессией ${agentLabel(a)}`}
          onClick={(e) => onMenu(e, a)}><span className="dots" aria-hidden="true">⋯</span></button>
      </span>
      <span className="ag-meta">
        {shortcut && <span className="chat-project" title={a.cwd}>{projectName(project)}</span>}
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

import { ProviderIcon } from './ProviderIcon.js'
import { t } from '../lib/i18n.js'
// Основная навигация — проекты с чатами; недавние остаются отдельными ярлыками снизу.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent, ReactElement } from 'react'
import type { ProjectFilter } from '../model/navigation.js'
import { ContextMenu } from './ContextMenu.js'
import type { MenuEntry } from './ContextMenu.js'
import type { AgentView } from '../model/agents.js'
import { agentLabel, ago, shortPath } from '../model/agents.js'
import { chatSections, chatStatus, projectChats, projectPreview } from '../model/navigation.js'
import { projectName } from '../model/projects.js'
import { contextRowView } from '../model/context.js'
import { sidebarFull } from '../model/access.js'
import type { ProjectGroup } from '../model/projects.js'
import { projectRemoval } from '../model/projects.js'
import { plural } from '../lib/ru.js'
import { CMD, Icon, Kbd } from './common.js'
import type { DraftChat } from '../model/draft.js'
import { draftLabel, folderName } from '../model/draft.js'
import type { TemporarySummary } from '../../../src/temporary/types.js'
import { temporaryBusy } from '../model/temporary.js'
import './temporary-chat.css'
import { LOUD_STATES, StatusDot, toneState } from './StatusDot.js'

export interface ProjectTreeProps {
  mode?: 'normal'|'expanded'|'focus'
  groups: readonly ProjectGroup[]
  selected: string | null
  /**
   * Реплика, отправленная из поля ввода этого окна (не из очереди и не из CLI): когда её ход начнётся и чат встанет
   * наверх, строку возвращаем в виду. `id` — номер отправки, одна отправка — одна прокрутка.
   */
  revealSend?: { name: string; id: number } | null
  now: number
  /** Свёрнутые проекты (пути). */
  collapsed: ReadonlySet<string>
  onSelect(name: string): void
  /** Новый чат (черновик): `null` — как ⌘N (папка открытого чата или последняя), иначе — в этом проекте. */
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
  /** Шаг B: черновики новых чатов — курсивные строки вверху списка (§3.2). */
  drafts?: readonly DraftChat[]
  activeDraft?: string | null
  onOpenDraft?(id: string): void
  onDiscardDraft?(id: string): void
  /** RAM-only conversations never enter groups, AgentView, ordinary search, menus or saved tabs. */
  temporaryChats?: readonly TemporarySummary[]
  activeTemporaryId?: string | null
  onSelectTemporary?(id: string): void
  onNewTemporary?(): void
  temporaryAvailable?: boolean
  temporaryStarting?: boolean
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
  if (!a.browser) return [{ label: t('Браузер для агента'), onSelect: () => onBrowser(a.name, true, false), testId: 'row-browser-on' }]
  const headed = a.browser.headed === true
  return [
    { label: t('✓ Браузер для агента'), onSelect: () => onBrowser(a.name, false, false), testId: 'row-browser-off' },
    { label: headed ? t('✓ Показывать окно браузера') : t('Показывать окно браузера'), onSelect: () => onBrowser(a.name, true, !headed), testId: 'row-browser-headed' },
  ]
}

/** Действия меню сессии. Один и тот же набор — в строке сайдбара и в шапке разговора («⋯»). */
export interface SessionMenuApi {
  onRename?(name: string): void
  onReveal?(path: string): void
  onExport?(name: string): void
  onBrowser?(name: string, on: boolean, headed: boolean): void
  onArchive?(name: string, archived: boolean): void
  onRemove?(name: string): void
}

/**
 * Пункты меню сессии: ровно те же для сайдбара (правый клик и «⋯» строки) и для шапки разговора.
 * «Удалить» — всегда последняя и опасная: самое заметное меню не должно состоять из одного удаления.
 */
export function sessionMenuItems(a: AgentView, api: SessionMenuApi): MenuEntry[] {
  return [
    { label: t('Переименовать…'), onSelect: () => api.onRename?.(a.name), disabled: !api.onRename, testId: 'row-rename' },
    { label: t('Показать папку в Finder'), onSelect: () => api.onReveal?.(a.cwd), disabled: !api.onReveal, testId: 'row-reveal' },
    { label: t('Экспорт в Markdown'), onSelect: () => api.onExport?.(a.name), disabled: !api.onExport, testId: 'row-export' },
    ...(api.onBrowser ? browserItems(a, api.onBrowser) : []),
    a.archived
      ? { label: t('Вернуть из архива'), onSelect: () => api.onArchive?.(a.name, false), disabled: !api.onArchive, testId: 'row-unarchive' }
      : { label: t('В архив'), onSelect: () => api.onArchive?.(a.name, true), disabled: !api.onArchive, testId: 'row-archive' },
    'sep',
    { label: t('Удалить…'), onSelect: () => api.onRemove?.(a.name), danger: true, disabled: !api.onRemove, testId: 'row-remove' },
  ]
}

export function ProjectTree(p: ProjectTreeProps): ReactElement {
  const archived = p.archived ?? []
  const temporaryChats = p.temporaryChats ?? []
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const menuOpen = useRef(false)
  useLayoutEffect(() => { menuOpen.current = menu !== null }, [menu])
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [revealRequest, setRevealRequest] = useState(0)
  const sections = chatSections(p.groups, query)
  const [filter, setFilter] = useState<ProjectFilter>('all')
  const [longProjects, setLongProjects] = useState(new Set<string>())
  const list = projectChats(p.groups, query, filter)
  const general = list.find((entry) => entry.group.scope === 'general')
  const projectList = list.filter((entry) => entry.group.scope !== 'general')
  const selectedProject = p.activeTemporaryId ? undefined : p.groups.find((g) => g.sessions.some((a) => a.name === p.selected))?.path
  // Выбранная беседа начала ход по реплике из этого окна и встала наверх проекта — строку возвращаем в виду (прокрутка,
  // только если она ушла из виду). Ход из очереди или из CLI список не дёргает: человек мог прокрутить его в другое место.
  const selectedTurn = p.groups.flatMap((g) => g.sessions).find((a) => a.name === p.selected)?.lastTurnAt
  const sendMark = useRef<{ id: number; turn: string | undefined; done: boolean } | null>(null)
  useEffect(() => {
    const r = p.revealSend
    if (!r || r.name !== p.selected) return
    if (sendMark.current?.id !== r.id) { sendMark.current = { id: r.id, turn: selectedTurn, done: false }; return }
    if (sendMark.current.done || sendMark.current.turn === selectedTurn) return
    sendMark.current.done = true
    setRevealRequest((n) => n + 1)
  }, [p.revealSend, p.selected, selectedTurn])
  const lastReveal = useRef<string | null>(null)
  const projectArea = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!p.selected || !selectedProject || lastReveal.current === `${selectedProject}:${p.selected}`) return
    lastReveal.current = `${selectedProject}:${p.selected}`
    if (p.collapsed.has(selectedProject)) p.onToggle(selectedProject)
  }, [p.selected, selectedProject, p.collapsed, p.onToggle])
  useEffect(() => {
    if (!p.selected) return
    const timer = window.setTimeout(() => {
      // Отложенный reveal не должен прокручивать список и закрывать уже открытое меню другого чата.
      if (menuOpen.current) return
      const area = projectArea.current
      const row = area?.querySelector<HTMLElement>('[data-testid="agent-row"][aria-selected="true"]')
      if (!area || !row || row.closest('details:not([open])')) return
      const bounds = area.getBoundingClientRect(), item = row.getBoundingClientRect()
      if (item.top < bounds.top || item.bottom > bounds.bottom) row.scrollIntoView({ block: 'nearest' })
    }, 240)
    return () => window.clearTimeout(timer)
  }, [p.selected, selectedProject, revealRequest])
  const closeMenu = useCallback(() => setMenu(null), [])
  const newTemporaryItem = (): MenuEntry => ({ label: t('Новый временный чат'), testId: 'temporary-new', disabled: !p.temporaryAvailable || p.temporaryStarting === true, title: !p.temporaryAvailable ? t('Временный чат недоступен') : undefined, onSelect: () => p.onNewTemporary?.() })
  const openNewMenu = (event: MouseEvent<HTMLButtonElement>): void => {
    setMenu({ at: menuAt(event), testId: 'temporary-new-menu-list', items: [
      { label: t('Новый чат'), onSelect: () => p.onNew(null), testId: 'new-menu-saved' }, newTemporaryItem(),
    ] })
  }
  const openTemporaryRail = (event: MouseEvent<HTMLButtonElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({ at: { x: rect.right + 6, y: rect.top }, testId: 'temporary-rail-menu', items: [
      { heading: t('Временные чаты') }, newTemporaryItem(), ...(temporaryChats.length ? ['sep' as const] : []),
      ...temporaryChats.map((chat, index) => ({ label: `${t('Временный чат')} ${index + 1} · ${chat.settings.provider === 'claude' ? 'Claude' : 'Codex'}`, checked: chat.id === p.activeTemporaryId, testId: 'temporary-rail-chat', onSelect: () => p.onSelectTemporary?.(chat.id) })),
    ] })
  }

  const projectMenu = (e: MouseEvent<HTMLElement>, g: ProjectGroup): void => {
    e.preventDefault(); e.stopPropagation()
    const removal = projectRemoval(g)
    setMenu({ at: menuAt(e), testId: 'project-menu-list', items: [
      { label: t('Новый чат здесь'), onSelect: () => p.onNew(g.path), testId: 'project-menu-new' },
      ...(!g.pinned ? [{ label: t('Закрепить как проект'), onSelect: () => p.onPin(g.path, true), testId: 'project-pin' }] : []),
      // M8d: убрать можно ЛЮБОЙ проект. Закреплённый без сессий — снять закрепление (это и есть «убрать»);
      // закреплённый с сессиями можно и просто открепить — сессии останутся папкой; «Убрать из списка…» у папки с
      // сессиями — их в архив (с вопросом), и папка пропадает из дерева.
      ...(g.pinned
        ? [{ label: removal?.kind === 'archive' ? t('Открепить (сессии останутся папкой)') : t('Убрать из списка'), onSelect: () => p.onPin(g.path, false), testId: 'project-unpin' }]
        : []),
      ...(removal?.kind === 'archive' && p.onHide
        ? [{ label: t('Убрать из списка…'), onSelect: () => p.onHide?.(g.path, removal.sessions, removal.busy), testId: 'project-hide' }] : []),
      'sep',
      { label: t('Показать в Finder'), onSelect: () => p.onReveal?.(g.path), disabled: !p.onReveal, testId: 'project-reveal' },
    ] })
  }
  const sessionMenu = (e: MouseEvent<HTMLElement>, a: AgentView): void => {
    e.preventDefault(); e.stopPropagation()
    setMenu({ at: menuAt(e), testId: 'session-menu-list', items: sessionMenuItems(a, p) })
  }
  const row = (a: AgentView, project: string, shortcut = false): ReactElement =>
    <SessionRow key={a.name} a={a} project={project} shortcut={shortcut} selected={!p.activeTemporaryId && a.name === p.selected} now={p.now} onSelect={(name) => {
      if (shortcut) { if (p.collapsed.has(project)) p.onToggle(project); setRevealRequest((n) => n + 1) }
      p.onSelect(name)
    }} onMenu={sessionMenu} />
  if (p.mode === 'focus') return <nav className="agents project-rail" aria-label={t("Проекты и сессии")}>
    <span className="sidebar-brand-mark" aria-hidden="true"><Icon name="mark" /></span>
    <button type="button" className="rail-new" onClick={() => p.onNew(null)} aria-label={t('Новый чат')} title={t('Новый чат')} data-testid="new-agent"><Icon name="plus" /></button>
    {(p.onNewTemporary || temporaryChats.length > 0) && <button type="button" className="rail-group temporary-rail" aria-label={t('Временные чаты')} title={t('Временные чаты')} aria-current={p.activeTemporaryId ? 'true' : undefined} data-testid="temporary-rail" onClick={openTemporaryRail}><Icon name="clock" />{temporaryChats.some((chat) => temporaryBusy(chat.status)) && <StatusDot state="working" className="temporary-busy-dot" />}</button>}
    <div className="rail-groups">{p.groups.map((group) => <button key={group.path} type="button" className="rail-group" aria-current={group.path === selectedProject} title={group.name} aria-label={group.name} data-testid="rail-project" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ at: { x: r.right + 6, y: r.top }, testId: 'rail-chats', items: [{ heading: group.name }, { label: t('Новый чат'), testId: 'rail-new-chat', onSelect: () => p.onNew(group.scope === 'general' ? null : group.path) }, 'sep', ...group.sessions.map((a) => ({ label: agentLabel(a), checked: a.name === p.selected, testId: 'rail-chat', onSelect: () => p.onSelect(a.name) }))] }) }}>{group.scope === 'general' ? <Icon name="model" /> : group.name.slice(0,2)}{group.waiting > 0 && <StatusDot state="waiting" size="md" className="rail-wait" />}</button>)}</div>
    {menu && <ContextMenu at={menu.at} items={menu.items.map((entry) => typeof entry === 'object' && 'testId' in entry && entry.testId === 'temporary-new' ? newTemporaryItem() : entry)} onClose={closeMenu} testId={menu.testId} />}
  </nav>
  return (
    <nav className="agents" aria-label={t("Проекты и сессии")}>
      <div className="sidebar-top"><div className="sidebar-brand"><span className="sidebar-brand-mark" aria-hidden="true"><Icon name="mark" /></span>{t("Пульт")}</div>
        <div className="temporary-new-chooser"><button type="button" className="btn new-chat" onClick={() => p.onNew(null)} data-testid="new-agent">
          <Icon name="edit" />{t("Новый чат")}<span className="grow" /><Kbd>{`${CMD}N`}</Kbd>
        </button>{p.onNewTemporary && <button type="button" className="chrome-icon temporary-new-menu" aria-label={t('Выбрать тип нового чата')} title={t('Выбрать тип нового чата')} aria-haspopup="menu" aria-expanded={menu?.testId === 'temporary-new-menu-list'} data-testid="temporary-new-menu" onClick={openNewMenu}><Icon name="chevd" /></button>}</div>
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
          placeholder={t("Поиск бесед и проектов")} aria-label={t("Поиск бесед и проектов")} data-testid="chat-filter" title={t("Поиск бесед и проектов")} /><Kbd>{`${CMD}K`}</Kbd>
          {query && <button type="button" className="row-btn" onClick={() => setQuery('')} aria-label={t("Очистить поиск")}><Icon name="x" /></button>}
        </label>
      </div>
      {(p.drafts ?? []).length > 0 && (
        <ul className="ag-list draft-list" role="listbox" aria-label={t('Черновики')} data-testid="drafts">
          {(p.drafts ?? []).map((d) => (
            <li key={d.id} className="ag draft-row" role="option" aria-selected={d.id === p.activeDraft} tabIndex={0}
              data-testid="draft-row" data-draft={d.id}
              onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); p.onOpenDraft?.(d.id) } }}
              onClick={() => p.onOpenDraft?.(d.id)}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ at: menuAt(e), testId: 'draft-menu-list', items: [{ label: t('Удалить черновик'), danger: true, onSelect: () => p.onDiscardDraft?.(d.id), testId: 'draft-remove' }] }) }}>
              <span className="ag-name draft-name" title={d.text || undefined}>{draftLabel(d)}</span>
              <span className="ag-right">
                <span className="chat-row-status is-quiet">{t('черновик')}</span>
                <button type="button" className="row-btn" data-testid="draft-row-menu" title={t('Действия с черновиком')} aria-label={t('Действия с черновиком')}
                  onClick={(e) => { e.stopPropagation(); setMenu({ at: menuAt(e), testId: 'draft-menu-list', items: [{ label: t('Удалить черновик'), danger: true, onSelect: () => p.onDiscardDraft?.(d.id), testId: 'draft-remove' }] }) }}><span className="dots" aria-hidden="true">⋯</span></button>
              </span>
              <span className="ag-meta"><span className="chat-project">{d.scope === 'general' ? t('Без проекта') : d.cwd ? folderName(d.cwd) : t('папка не выбрана')}</span></span>
            </li>
          ))}
        </ul>
      )}
      <div className="sidebar-filters" aria-label={t("Фильтр чатов")}>
        {(['all', 'working', 'waiting'] as const).map((key) => {
          const count = key === 'all' ? sections.reduce((n, g) => n + g.rows.length, 0) : sections.find((g) => g.key === key)!.rows.length
          return <button type="button" key={key} className={`sidebar-filter${filter === key ? ' active' : ''}`} aria-pressed={filter === key}
            data-testid={`filter-${key}`} onClick={() => setFilter(key)}>{key === 'all' ? t('Все') : key === 'working' ? t('В работе') : t('Ждут')}<span>{count}</span></button>
        })}
      </div>
      <div className="tree project-sidebar" data-testid="agent-list"><div className="sidebar-projects" data-testid="sidebar-projects" ref={projectArea}>
        {p.mode === 'expanded' && <div className="attention-sections" data-testid="attention-sections">{sections.map((section) => {
          const rows = section.key === 'recent' ? section.rows.filter(({ agent }) => agent.status === 'done' || agent.status === 'idle') : section.rows
          return rows.length ? <section key={section.key} className={`attention-section ${section.key}`}><h3>{section.key === 'waiting' ? t('Ждёт тебя') : section.key === 'working' ? t('Работает') : t('Готово')}<span>{rows.length}</span></h3><ul className="ag-list" role="listbox" aria-label={section.label}>{rows.map(({ agent, projectPath }) => row(agent,projectPath,true))}</ul></section> : null
        })}</div>}
        {temporaryChats.length > 0 && <section className="temporary-sidebar-group" data-testid="temporary-group">
          <h3><Icon name="clock" />{t('Временные чаты')}<span>{temporaryChats.length}</span></h3>
          <div className="temporary-sidebar-list" role="listbox" aria-label={t('Временные чаты')}>
            {temporaryChats.map((chat, index) => <button key={chat.id} type="button" role="option" className="temporary-sidebar-row" aria-selected={chat.id === p.activeTemporaryId} aria-busy={temporaryBusy(chat.status)} aria-label={t`Временный чат ${index + 1}`}
              data-testid="temporary-row" data-temporary-id={chat.id} onClick={() => p.onSelectTemporary?.(chat.id)}>
              <ProviderIcon provider={chat.settings.provider} /><span>{t('Временный чат')}</span><span className="temporary-row-number">{index + 1}</span>{temporaryBusy(chat.status) && <StatusDot state="working" className="temporary-busy-dot" />}
            </button>)}
          </div>
        </section>}
        {general && <details className="general-conversations" open={!p.collapsed.has(general.group.path) || !!query} onToggle={(e) => { const want = !p.collapsed.has(general.group.path) || !!query; if (e.currentTarget.open !== want && !query) p.onToggle(general.group.path) }} data-testid="general-conversations">
          <summary onClick={(e) => { e.preventDefault(); p.onToggle(general.group.path) }}><Icon name="chev" /><span>{t('Разговоры')}</span><span className="count">{general.rows.length}</span><span className="grow" /><button type="button" className="proj-btn" aria-label={t('Новый разговор без проекта')} onClick={(e) => { e.preventDefault(); e.stopPropagation(); p.onNew(null) }} data-testid="general-new"><Icon name="plus" /></button></summary>
          <ul className="ag-list" role="listbox" aria-label={t('Разговоры без проекта')}>{general.rows.map((a) => row(a,general.group.path))}</ul>
        </details>}
        <div className="project-manager" data-testid="project-manager">
          <div className="projects-heading"><h3>{t("Проекты")}<span className="count">{projectList.length}</span></h3>
            <button type="button" className="proj-btn project-add" onClick={p.onAddProject} data-testid="add-project" title={t("Добавить папку проекта")} aria-label={t("Добавить проект")}><Icon name="plus" /></button>
          </div>
          {projectList.map(({ group: g, rows, working, waiting }) => {
            const closed = !query && p.collapsed.has(g.path)
            const full = !!query || filter !== 'all' || longProjects.has(g.path)
            const shown = projectPreview(rows, p.selected, full)
            const waitLabel = `${waiting} ${plural(waiting, t('ждёт ответа'), t('ждут ответа'), t('ждут ответа'))}`
            return <details key={g.path} className={`proj project-group${selectedProject === g.path ? ' current-project' : ''}`} open={!closed}
              data-testid="project" data-project={g.path} data-pinned={g.pinned ? '1' : '0'}
              onToggle={(e) => { if (!query && e.currentTarget.open === p.collapsed.has(g.path)) p.onToggle(g.path) }}>
              <summary className="proj-h" onContextMenu={(e) => projectMenu(e, g)} onClick={(e) => { if (query) e.preventDefault() }} title={g.path} data-testid="project-toggle">
                <Icon name="chev" className="ic proj-chev" /><Icon name="folder" />
                <span className="proj-name">{g.name}</span><span className="project-chat-count" aria-label={t`${rows.length} чатов`}>{rows.length}</span>
                <span className="grow" />
                {closed && waiting > 0 && <span className="project-state t-wait" title={`${waitLabel}${working ? t` · ${working} в работе` : ''}`} aria-label={waitLabel}>● {waiting}</span>}
                {closed && waiting === 0 && working > 0 && <span className="project-state t-run" title={t`${working} в работе`} aria-label={t`${working} в работе`}>● {working}</span>}
                {g.unread > 0 && <span className="proj-unread" data-testid="project-unread" title={`${g.unread} ${plural(g.unread, t('непрочитанная беседа'), t('непрочитанные беседы'), t('непрочитанных бесед'))}`}>{g.unread}</span>}
                <button type="button" className="proj-btn" title={t`Новый чат в ${g.name}`} aria-label={t`Новый чат в ${g.name}`} data-testid="project-new-session"
                  onKeyDown={(e) => e.stopPropagation()} onClick={(e) => { e.preventDefault(); e.stopPropagation(); p.onNew(g.path) }}><Icon name="plus" /></button>
                <button type="button" className="proj-btn" data-testid="project-menu" title={t("Действия с проектом")} aria-label={t`Действия с проектом ${g.name}`}
                  onKeyDown={(e) => e.stopPropagation()} onClick={(e) => projectMenu(e, g)}><span className="dots" aria-hidden="true">⋯</span></button>
              </summary>
              <div className="project-chats chat-section">
                <ul className="ag-list" role="listbox" aria-label={t`Чаты проекта ${g.name}`}>{shown.map((a) => row(a, g.path))}</ul>
                {rows.length === 0 && <button type="button" className="project-empty" onClick={() => p.onNew(g.path)}>{t("Новый чат в этом проекте")}<Icon name="plus" /></button>}
                {!full && shown.length < rows.length && <button type="button" className="project-more" data-testid="project-more" onClick={() => setLongProjects((before) => new Set(before).add(g.path))}>{t("Показать ещё ")}{rows.length - shown.length}</button>}
                {longProjects.has(g.path) && !query && filter === 'all' && rows.length > 4 && <button type="button" className="project-more" onClick={() => setLongProjects((before) => { const next = new Set(before); next.delete(g.path); return next })}>{t("Свернуть список")}</button>}
              </div>
            </details>
          })}
          {list.length === 0 && (temporaryChats.length === 0 || !!query || filter !== 'all') && <div className="empty-hint" data-testid="agents-empty"><h3>{query ? t('Ничего не найдено') : filter === 'all' ? t('Начни с нового чата') : t('Таких чатов пока нет')}</h3>
            {query ? t('Попробуй другое название или имя проекта.') : t('Выбери другой фильтр или создай новый чат.')}</div>}
        </div>
        {archived.length > 0 && <section className="proj proj-archive" data-testid="archive-section">
          <button type="button" className="proj-h archive-toggle" onClick={() => setArchiveOpen((v) => !v)} aria-expanded={archiveOpen} title={t("Сессии в архиве: реплика возвращает сессию из архива")}>
            <Icon name="chev" className={`ic proj-chev${archiveOpen ? ' open' : ''}`} /><span className="proj-name">{t("Архив")}</span><span className="count">{archived.length}</span>
          </button>
          {archiveOpen && <ul className="ag-list" role="listbox" aria-label={t("Сессии в архиве")}>{archived.map((a) => row(a, a.repo ?? a.cwd))}</ul>}
        </section>}
      </div></div>
      {menu && <ContextMenu at={menu.at} items={menu.items.map((entry) => typeof entry === 'object' && 'testId' in entry && entry.testId === 'temporary-new' ? newTemporaryItem() : entry)} onClose={closeMenu} testId={menu.testId} />}
    </nav>
  )
}

function SessionRow({ a, project, selected, now, onSelect, onMenu, shortcut = false }: {
  a: AgentView; project: string; selected: boolean; now: number; shortcut?: boolean; onSelect(name: string): void
  onMenu(e: MouseEvent<HTMLElement>, a: AgentView): void
}): ReactElement {
  const sv = chatStatus(a)
  const state = toneState(sv.tone)
  const needs = state === 'waiting'
  const ctx = a.context && a.context.window && a.context.used / a.context.window >= .8 ? contextRowView(a.context) : null
  return (
    <li className="ag" role="option" aria-selected={selected}
      data-provider={a.provider} data-needs={needs ? '1' : '0'} data-unread={a.unread ? '1' : '0'} data-testid={shortcut ? 'recent-row' : 'agent-row'} data-agent={a.name} data-sidebar-chat="1"
      tabIndex={0} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSelect(a.name) } }}
      onClick={() => onSelect(a.name)} onContextMenu={(e) => onMenu(e, a)}>
      <span className="row-provider" title={a.provider === 'claude' ? 'Claude' : a.provider === 'codex' ? 'Codex' : 'ZCode'}><ProviderIcon provider={a.provider} />{LOUD_STATES.has(state) && <StatusDot state={state} label={sv.label} cutout className="row-live-dot" testId="row-live-dot" />}</span>
      <span className="ag-name" title={a.title ? t`${a.title} · имя для CLI: ${a.name}` : undefined}>
        {a.unread && <UnreadDot a={a} testId={shortcut ? 'recent-unread' : 'row-unread'} />}{agentLabel(a)}
      </span>
      <span className="ag-right" title={a.pending > 0 ? t`${a.pending} ${plural(a.pending, t('запрос'), t('запроса'), t('запросов'))} в Inbox` : undefined}>
        {/* Однозначное состояние рядом с названием, текущее действие — во второй строке. */}
        <span className={`chat-row-status t-${sv.tone}${(a.status === 'cold' || a.status === 'idle' || a.status === 'done') && !a.background ? ' is-quiet' : ''}`} data-testid="row-status" title={sv.detail}>{sv.label}{a.pending > 0 ? ` · ${a.pending}` : ''}</span>
        <button type="button" className="row-btn" data-testid="row-menu" title={t("Действия с сессией")} aria-label={t`Действия с сессией ${agentLabel(a)}`}
          onClick={(e) => onMenu(e, a)}><span className="dots" aria-hidden="true">⋯</span></button>
      </span>
      <span className="ag-meta">
        {shortcut && <span className="chat-project" title={a.cwd}>{projectName(project)}</span>}

        {/* Шаг A: щит «полный» — выбран полный доступ или ещё жив процесс с полными правами (та же метка, что в чате). */}
        {sidebarFull(a) && <span className="row-access" data-testid="row-access-full" title={t("Полный доступ: агент работает без вопросов и без песочницы")}><Icon name="shield" />{t("полный")}</span>}
        {a.status === 'working' && <span className="chat-action" title={sv.detail}>{sv.detail}</span>}
        {a.background && <span className="bg" title={t`фоновые задачи:\n${a.background.tasks.join('\n')}`} data-testid="row-background">{t("фон · ")}{a.background.count}</span>}
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
    aria-label={error ? t('непрочитанная ошибка') : t('непрочитано')} title={error ? t('непрочитанная ошибка') : t('непрочитано')} />
}

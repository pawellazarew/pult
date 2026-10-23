// Слева — проекты и их сессии (как в нативных Claude Code и Codex): проект — папка, под ним его
// сессии, «+» на строке проекта — новая сессия в этой папке. Строка сессии — провайдер кромкой,
// статус чипом, ветка worktree, время последней активности; ждущие тебя — первыми и подсвечены.
// Раскладка — model/projects.ts, порядок сессий — model/agents.ts. Действия над сессией и проектом —
// в меню «⋯» и по правому клику (как везде); на строке проекта видны только «+» и «⋯».

import { useCallback, useState } from 'react'
import type { MouseEvent, ReactElement } from 'react'
import { ContextMenu } from './ContextMenu.js'
import type { MenuEntry } from './ContextMenu.js'
import type { AgentView } from '../model/agents.js'
import { agentLabel, ago, shortPath, statusView } from '../model/agents.js'
import { treePhaseLabel } from '../model/phase.js'
import { contextRowView } from '../model/context.js'
import type { ProjectGroup } from '../model/projects.js'
import { projectRemoval } from '../model/projects.js'
import { plural } from '../lib/ru.js'
import { Chip, CMD, Icon, Kbd } from './common.js'

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
  const total = p.groups.reduce((n, g) => n + g.sessions.length, 0)
  const archived = p.archived ?? []
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const [archiveOpen, setArchiveOpen] = useState(false)
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
      <div className="pane-h">
        <span className="lbl">Проекты</span>
        <span className="count" title={`${p.groups.length} ${plural(p.groups.length, 'проект', 'проекта', 'проектов')}, ${total} ${plural(total, 'сессия', 'сессии', 'сессий')}`}>{p.groups.length || ''}</span>
        <span className="grow" />
        <button type="button" className="btn btn-sm btn-ghost" onClick={p.onAddProject} data-testid="add-project" title="Добавить папку проекта">
          <Icon name="folder" />+
        </button>
        <button type="button" className="btn btn-sm" onClick={() => p.onNew(null)} data-testid="new-agent">
          <Icon name="plus" />Сессия<Kbd>{`${CMD}N`}</Kbd>
        </button>
      </div>
      {p.groups.length === 0 ? (
        <div className="empty-hint" data-testid="agents-empty">
          <h3>Проектов пока нет</h3>
          Добавь папку проекта кнопкой с папкой — или сразу заведи сессию: папка, провайдер, модель и первая реплика. <Kbd>{`${CMD}N`}</Kbd>
        </div>
      ) : (
        <div className="tree" data-testid="agent-list">
          {p.groups.map((g) => {
            const folded = p.collapsed.has(g.path)
            return (
              <section key={g.path} className="proj" data-testid="project" data-project={g.path} data-pinned={g.pinned ? '1' : '0'}>
                <div className="proj-h" onClick={() => p.onToggle(g.path)} onContextMenu={(e) => projectMenu(e, g)} title={g.path} aria-expanded={!folded}>
                  <Icon name="chev" className={`ic proj-chev${folded ? '' : ' open'}`} />
                  <span className="proj-name">{g.name}</span>
                  {!g.pinned && <span className="proj-loose" title="папка сессии — её нет в списке проектов">папка</span>}
                  {g.waiting > 0 && <span className="badge" title={`${g.waiting} ${plural(g.waiting, 'сессия ждёт', 'сессии ждут', 'сессий ждут')} тебя`}>{g.waiting}</span>}
                  {g.unread > 0 && <span className="proj-unread" data-testid="project-unread"
                    title={`${g.unread} ${plural(g.unread, 'непрочитанная сессия', 'непрочитанные сессии', 'непрочитанных сессий')}`}>{g.unread}</span>}
                  <span className="grow" />
                  <button type="button" className="proj-btn" title={`Новая сессия в ${shortPath(g.path, 60)}`} data-testid="project-new-session"
                    onClick={(e) => { e.stopPropagation(); p.onNew(g.path) }}><Icon name="plus" /></button>
                  <button type="button" className="proj-btn" data-testid="project-menu" title="Действия с проектом"
                    aria-label={`Действия с проектом ${g.name}`} onClick={(e) => projectMenu(e, g)}><span className="dots" aria-hidden="true">⋯</span></button>
                </div>
                {!folded && (g.sessions.length === 0
                  ? <div className="proj-empty">сессий нет — «+» заведёт первую</div>
                  : (
                    <ul className="ag-list" role="listbox" aria-label={`Сессии проекта ${g.name}`}>
                      {g.sessions.map((a) => row(a, g.path))}
                    </ul>
                  ))}
              </section>
            )
          })}
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
      )}
      {menu && <ContextMenu at={menu.at} items={menu.items} onClose={closeMenu} testId={menu.testId} />}
    </nav>
  )
}

function SessionRow({ a, project, selected, now, onSelect, onMenu }: {
  a: AgentView; project: string; selected: boolean; now: number; onSelect(name: string): void
  onMenu(e: MouseEvent<HTMLElement>, a: AgentView): void
}): ReactElement {
  const sv = statusView(a.status)
  const needs = sv.needsYou || a.pending > 0
  // 0.3.5: вместо «идёт» — что именно делает ход («думает», «пишет», «Bash»).
  const phaseLabel = sv.busy && !needs ? treePhaseLabel(a.phase) : null
  // Папку пишем, только если сессия не в корне проекта: корень уже виден в строке проекта.
  const sub = (a.repo ?? a.cwd) === project ? null : a.cwd
  // Контекст в строке — только когда окно занято хотя бы наполовину: иначе строка шумит.
  const ctx = contextRowView(a.context)
  return (
    <li className="ag" role="option" aria-selected={selected}
      data-provider={a.provider} data-needs={needs ? '1' : '0'} data-unread={a.unread ? '1' : '0'} data-testid="agent-row" data-agent={a.name}
      onClick={() => onSelect(a.name)} onContextMenu={(e) => onMenu(e, a)}>
      <span className="ag-name" title={a.title ? `${a.title} · имя для CLI: ${a.name}` : undefined}>
        {a.unread && <UnreadDot a={a} testId="row-unread" />}{agentLabel(a)}
      </span>
      <span className="ag-right" title={a.pending > 0 ? `${a.pending} ${plural(a.pending, 'запрос', 'запроса', 'запросов')} в Inbox` : undefined}>
        {/* Счёт — словами в самом чипе: отдельное «1?» читалось загадкой. */}
        <Chip tone={needs ? 'wait' : sv.tone} label={`${needs && !sv.needsYou ? 'ждёт тебя' : phaseLabel ?? sv.label}${a.pending > 0 ? ` · ${a.pending}` : ''}`} testId="row-status" />
        <button type="button" className="row-btn" data-testid="row-menu" title="Действия с сессией" aria-label={`Действия с сессией ${agentLabel(a)}`}
          onClick={(e) => onMenu(e, a)}><span className="dots" aria-hidden="true">⋯</span></button>
      </span>
      <span className="ag-meta">
        <span className={`tag tag-${a.provider}`}>{a.provider}</span>
        {sub && <span className="path" title={a.cwd}>{shortPath(sub, 26)}</span>}
        {a.branch && <span className="br" title="ветка worktree"><Icon name="branch" />{a.branch}</span>}
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

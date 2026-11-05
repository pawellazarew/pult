// Дерево «проект → его сессии» (как в нативных Claude Code и Codex). Проект — папка из списка
// демона (`project.list`); сессия встаёт в САМЫЙ ГЛУБОКИЙ проект, внутри которого лежит её папка
// (у worktree — исходный репозиторий: сама папка worktree живёт в PULT_HOME). Сессия вне всех
// проектов не теряется: её папка показывается неявным проектом — его можно закрепить «+».

import { t as tr } from '../lib/i18n.js'
import type { AgentView } from './agents.js'
import { statusRank } from './agents.js'

export const GENERAL_GROUP_PATH = 'pult:conversations'

export interface ProjectGroup {
  scope?: 'general' | 'project'
  /** Папка проекта — ключ группы. */
  path: string
  /** Подпись: последняя часть пути. */
  name: string
  /** Есть в списке демона (`false` — папка сессии вне всех проектов). */
  pinned: boolean
  sessions: AgentView[]
  /** Сколько сессий группы ждёт человека — виден и у свёрнутого проекта. */
  waiting: number
  /** О2: сколько сессий группы непрочитано — счётчик на строке проекта. */
  unread: number
}

const under = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`)

export function projectName(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.at(-1) ?? path
}

/**
 * Разложить сессии по проектам. Порядок групп стабильный — его не дёргают статусы, рука помнит
 * место: закреплённые в порядке добавления, затем неявные по имени. Порядок сессий внутри — как
 * пришёл (`sortAgents`: ждущие тебя первыми).
 */
export function groupByProject(projects: readonly string[], sessions: readonly AgentView[]): ProjectGroup[] {
  const pinned = [...new Set(projects)]
  const byDepth = [...pinned].sort((a, b) => b.length - a.length)
  const groups = new Map<string, ProjectGroup>()
  for (const p of pinned) groups.set(p, { path: p, name: projectName(p), pinned: true, sessions: [], waiting: 0, unread: 0 })
  const loose: ProjectGroup[] = []
  for (const s of sessions) {
    // Архивные — не в проектах: у них своя секция внизу дерева.
    if (s.archived) continue
    if (s.scope === 'general') {
      let general = groups.get(GENERAL_GROUP_PATH)
      if (!general) { general = { path: GENERAL_GROUP_PATH, scope: 'general', name: tr('Разговоры'), pinned: false, sessions: [], waiting: 0, unread: 0 }; groups.set(GENERAL_GROUP_PATH, general) }
      general.sessions.push(s)
      if (statusRank(s.status, s.pending) === 0) general.waiting++
      if (s.unread) general.unread++
      continue
    }
    const anchor = s.repo ?? s.cwd
    const root = byDepth.find((p) => under(anchor, p))
    let g = root ? groups.get(root) : groups.get(anchor)
    if (!g) {
      g = { path: anchor, name: projectName(anchor), pinned: false, sessions: [], waiting: 0, unread: 0 }
      groups.set(anchor, g)
      loose.push(g)
    }
    g.sessions.push(s)
    if (statusRank(s.status, s.pending) === 0) g.waiting += 1
    if (s.unread) g.unread += 1
  }
  loose.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
  const general = groups.get(GENERAL_GROUP_PATH)
  return [...(general ? [general] : []), ...pinned.map((p) => groups.get(p)!), ...loose]
}

/**
 * M8d «Убрать из списка» для ЛЮБОГО проекта дерева:
 *   * закреплённый без сессий — просто снять закрепление (как было);
 *   * с сессиями (закреплённый или папка сессии) — сессии группы уходят в архив, закрепление снимается, группа
 *     пропадает сама: архивные в дереве не раскладываются. Новая сессия в этой папке (или реплика в архивную)
 *     возвращает её. Файлы на диске не трогаются никогда.
 * Сессии считаются по группе ровно так, как их видит человек, — демону уходит их список (`project.remove {sessions}`).
 */
export type ProjectRemoval = { kind: 'unpin' } | { kind: 'archive'; sessions: string[]; busy: string[] }

/**
 * Занятые сессии группы (ревью M8d): идёт ход, ждёт разрешения или вопроса, стоит очередь реплик. Такую группу
 * убрать нельзя — демон откажет; окно заранее говорит «сначала останови: …».
 */
export function busySessions(sessions: readonly Pick<AgentView, 'name' | 'status' | 'pending' | 'queue'>[]): string[] {
  return sessions.filter((s) => s.status === 'working' || s.status === 'blocked_permission' || s.status === 'blocked_question'
    || s.pending > 0 || (s.queue?.length ?? 0) > 0).map((s) => s.name)
}

export function projectRemoval(g: Pick<ProjectGroup, 'pinned' | 'sessions'>): ProjectRemoval | null {
  if (g.sessions.length > 0) return { kind: 'archive', sessions: g.sessions.map((s) => s.name), busy: busySessions(g.sessions) }
  return g.pinned ? { kind: 'unpin' } : null
}

/**
 * Вкладки открытых сессий: открыть (в конец, если её нет), закрыть (активной становится соседка
 * справа, иначе слева), выкинуть исчезнувшие (сессию удалили). Чистые функции — ui/test.
 */
export function openTab(tabs: readonly string[], name: string): string[] {
  return tabs.includes(name) ? [...tabs] : [...tabs, name]
}
export function closeTab(tabs: readonly string[], name: string, active: string | null): { tabs: string[]; active: string | null } {
  const i = tabs.indexOf(name)
  if (i < 0) return { tabs: [...tabs], active }
  const next = tabs.filter((t) => t !== name)
  if (active !== name) return { tabs: next, active }
  return { tabs: next, active: next[i] ?? next[i - 1] ?? null }
}
export function pruneTabs(tabs: readonly string[], alive: ReadonlySet<string>): string[] {
  return tabs.filter((t) => alive.has(t))
}

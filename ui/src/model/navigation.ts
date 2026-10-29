import { t as tr } from '../lib/i18n.js'
// Поиск, фильтры состояния и стабильное дерево проектов; недавние служат ярлыками к тем же чатам.
import type { AgentView } from './agents.js'
import { agentLabel, agentRank, byLastTurn, sortAgents, statusView } from './agents.js'
import type { ProjectGroup } from './projects.js'
import { treePhaseLabel } from './phase.js'

export interface ChatRow { agent: AgentView; project: string; projectPath: string }
export interface ChatSection { key: 'waiting' | 'working' | 'recent'; label: string; rows: ChatRow[] }

export function chatSections(groups: readonly ProjectGroup[], query = ''): ChatSection[] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  const rows = groups.flatMap((g) => g.sessions.map((agent) => ({ agent, project: g.name, projectPath: g.path })))
    .filter(({ agent: a, project }) => !a.archived && terms.every((term) =>
      `${agentLabel(a)} ${a.name} ${project} ${a.cwd} ${a.provider} ${a.branch ?? ''}`.toLocaleLowerCase().includes(term)))
  const byName = new Map(rows.map((r) => [r.agent.name, r]))
  const ordered = sortAgents(rows.map((r) => r.agent)).map((a) => byName.get(a.name)!)
  return [
    { key: 'waiting', label: tr('Ждут ответа'), rows: ordered.filter((r) => agentRank(r.agent) === 0) },
    { key: 'working', label: tr('Работают'), rows: ordered.filter((r) => agentRank(r.agent) === 1) },
    { key: 'recent', label: tr('Недавние'), rows: ordered.filter((r) => agentRank(r.agent) === 2) },
  ]
}

/** Слова для человека. Техническое «cold» означает лишь отсутствие запущенного процесса. */
export function chatStatus(a: AgentView): { label: string; tone: string; detail: string } {
  if (a.pending > 0 || statusView(a.status).needsYou) return { label: tr('Ждёт ответа'), tone: 'wait', detail: a.status === 'blocked_question' ? tr('Нужен твой ответ') : tr('Нужно разрешение') }
  if (a.status === 'working') {
    const phase = treePhaseLabel(a.phase)
    return { label: tr('Работает'), tone: 'run', detail: phase && phase !== tr('идёт') ? phase : tr('Выполняет задачу') }
  }
  // Ответ готов, а субагенты или команды ещё доделывают работу: поле ввода открыто, но строка — среди «Работают».
  // Ошибка и лимит важнее: их подпись остаётся, фон виден значком «фон · N».
  if (a.background?.count && a.status !== 'failed' && a.status !== 'limited') return { label: tr('В фоне'), tone: 'run', detail: tr`Фоновые задачи: ${a.background.count}` }
  const sv = statusView(a.status)
  if (a.status === 'cold') return { label: tr('История'), tone: 'queued', detail: tr('Можно продолжить') }
  if (a.status === 'idle' || a.status === 'done') return { label: tr('Готово'), tone: 'ok', detail: tr('Можно продолжить') }
  return { label: sv.label, tone: sv.tone, detail: sv.label }
}

export type ProjectFilter = 'all' | 'working' | 'waiting'
export interface ProjectChats { group: ProjectGroup; rows: AgentView[]; working: number; waiting: number }

/**
 * Projects keep their position. Chats go by the start of their latest turn (`byLastTurn`): a chat jumps to the
 * top once, when a new turn starts, and stays put while it runs, after it ends and under background activity.
 */
export function projectChats(groups: readonly ProjectGroup[], query = '', filter: ProjectFilter = 'all'): ProjectChats[] {
  const matched = new Set(chatSections(groups, query).flatMap((s) => s.rows.map((r) => r.agent.name)))
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  return groups.flatMap((group) => {
    const all = group.sessions.filter((a) => !a.archived && matched.has(a.name))
    const working = all.filter((a) => agentRank(a) === 1).length
    const waiting = all.filter((a) => agentRank(a) === 0).length
    const rows = all.filter((a) => filter === 'all' || agentRank(a) === (filter === 'waiting' ? 0 : 1))
      .sort(byLastTurn)
    const emptyMatches = filter === 'all' && !group.sessions.length && terms.every((term) => `${group.name} ${group.path}`.toLocaleLowerCase().includes(term))
    return rows.length || emptyMatches ? [{ group, rows, working, waiting }] : []
  })
}

/** A long project stays manageable; the selected and busy chats never disappear behind “more”. */
export function projectPreview(rows: readonly AgentView[], selected: string | null, expanded: boolean, limit = 4): AgentView[] {
  return rows.filter((a, i) => expanded || i < limit || a.name === selected || agentRank(a) < 2)
}

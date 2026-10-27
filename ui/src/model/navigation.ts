// Единственный список бесед: внимание важнее папки; проект остаётся подписью и фильтром поиска.
import type { AgentView } from './agents.js'
import { agentLabel, sortAgents, statusRank, statusView } from './agents.js'
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
    { key: 'waiting', label: 'Ждут ответа', rows: ordered.filter((r) => statusRank(r.agent.status, r.agent.pending) === 0) },
    { key: 'working', label: 'Работают', rows: ordered.filter((r) => statusRank(r.agent.status, r.agent.pending) === 1) },
    { key: 'recent', label: 'Недавние', rows: ordered.filter((r) => statusRank(r.agent.status, r.agent.pending) === 2) },
  ]
}

/** Слова для человека. Техническое «cold» означает лишь отсутствие запущенного процесса. */
export function chatStatus(a: AgentView): { label: string; tone: string; detail: string } {
  if (a.pending > 0 || statusView(a.status).needsYou) return { label: 'Ждёт ответа', tone: 'wait', detail: a.status === 'blocked_question' ? 'Нужен твой ответ' : 'Нужно разрешение' }
  if (a.status === 'working') {
    const phase = treePhaseLabel(a.phase)
    return { label: 'Работает', tone: 'run', detail: phase && phase !== 'идёт' ? phase : 'Выполняет задачу' }
  }
  const sv = statusView(a.status)
  if (a.status === 'cold') return { label: 'История', tone: 'queued', detail: 'Можно продолжить' }
  if (a.status === 'idle' || a.status === 'done') return { label: 'Готово', tone: 'ok', detail: 'Можно продолжить' }
  return { label: sv.label, tone: sv.tone, detail: sv.label }
}

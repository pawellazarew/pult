import type { AgentItem, ConvItem } from './conversation.js'

export interface SubagentView { key: string; item: AgentItem; parentKey: string | null; depth: number }

/** Provider tool ids are scoped by their ancestors; opening a projection never launches an agent. */
export function subagentViews(items: readonly ConvItem[], ancestors: readonly string[] = []): SubagentView[] {
  return items.flatMap((item): SubagentView[] => {
    if (item.type !== 'agent') return []
    const path = [...ancestors, item.toolUseId]
    return [{ key: JSON.stringify(path), item, parentKey: ancestors.length ? JSON.stringify(ancestors) : null, depth: ancestors.length }, ...subagentViews(item.items, path)]
  })
}

export function visibleSubagents(views: readonly SubagentView[], hidden: ReadonlySet<string>): SubagentView[] {
  return views.filter((view) => view.item.state === 'running' || !hidden.has(view.key))
}

export function archiveFinished(views: readonly SubagentView[], hidden: ReadonlySet<string>): Set<string> {
  return new Set([...hidden, ...views.filter((view) => view.item.state !== 'running').map((view) => view.key)])
}

export function parseSubagentKeys(raw: string | null): string[] {
  try {
    const data: unknown = JSON.parse(raw ?? '[]')
    return Array.isArray(data) ? [...new Set(data.filter((value): value is string => typeof value === 'string' && value.length < 4096))].slice(-500) : []
  } catch { return [] }
}

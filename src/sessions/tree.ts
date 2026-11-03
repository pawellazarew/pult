import { translator } from '../i18n/core.js'
import { filesEn } from '../i18n/files.en.js'
// Дерево агентов и инструментов. ЧИСТАЯ функция: вход — события сессии, выход — вложенное
// дерево. Ни времени, ни процессов, ни файлов.
//
// ЧТО ЗДЕСЬ ВООБЩЕ ЗА ИЕРАРХИЯ. У Claude всё, что делает субагент, помечено полем
// `parent_tool_use_id` — это id того самого блока `tool_use` с инструментом `Agent`, который
// субагента и породил (измерено, DELTA v0.5 §2). Адаптер кладёт это поле в `parentId` конверта
// события. Значит дерево строится ровно так: узел с `parentId` — ребёнок узла с таким `id`;
// узел без `parentId` — корень. Цепочка длиннее одного уровня (субагент внутри субагента)
// собирается тем же правилом без единой дополнительной строки.
//
// ПОЧЕМУ инструменты тоже узлы: «дерево агентов» без вызовов инструментов показывает пустые
// прямоугольники — по нему нельзя понять, чем субагент занят. Вид узла различается полем
// `kind`, и CLI печатает их по-разному.

import type { PultEvent } from '../core/events.js'

const tr = translator(filesEn)

export type TreeNodeKind = 'agent' | 'tool'
export type TreeNodeStatus = 'running' | 'done' | 'failed'

export interface TreeNode {
  /** id блока `tool_use` — он же ключ, по которому к узлу цепляются дети. */
  id: string
  kind: TreeNodeKind
  name: string
  subagentType?: string
  model?: string
  status: TreeNodeStatus
  startedAt: string
  endedAt?: string
  durationMs?: number
  children: TreeNode[]
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

function elapsed(from: string, to: string): number | undefined {
  const a = Date.parse(from)
  const b = Date.parse(to)
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : undefined
}

export interface AgentTree {
  roots: TreeNode[]
  /** Все узлы по id — удобно тесту и будущему Ф2, где по узлу кликают. */
  byId: Map<string, TreeNode>
  /** Узлы, чей родитель в потоке не встретился: сирот прячем не молча. */
  orphans: number
}

export function buildTree(events: readonly PultEvent[]): AgentTree {
  const byId = new Map<string, TreeNode>()
  const roots: TreeNode[] = []
  const pendingChildren = new Map<string, TreeNode[]>()
  let orphans = 0

  const attach = (node: TreeNode, parentId: string | undefined): void => {
    if (parentId === undefined) { roots.push(node); return }
    const parent = byId.get(parentId)
    if (parent) { parent.children.push(node); return }
    // Родитель ещё не пришёл: события субагента могут опередить свой `tool_use` только при
    // чтении журнала кусками, но закладываться на порядок здесь дороже, чем подождать.
    const waiting = pendingChildren.get(parentId)
    if (waiting) waiting.push(node)
    else pendingChildren.set(parentId, [node])
  }

  const adopt = (node: TreeNode): void => {
    const waiting = pendingChildren.get(node.id)
    if (!waiting) return
    node.children.push(...waiting)
    pendingChildren.delete(node.id)
  }

  const open = (ev: PultEvent, kind: TreeNodeKind): void => {
    const d = ev.data as Record<string, unknown>
    const id = str(d['toolUseId'])
    if (id === undefined || byId.has(id)) return
    const node: TreeNode = {
      id,
      kind,
      name: str(d['name']) ?? (kind === 'agent' ? 'Agent' : 'tool'),
      ...(str(d['subagentType']) !== undefined ? { subagentType: str(d['subagentType']) as string } : {}),
      ...(str(d['model']) !== undefined ? { model: str(d['model']) as string } : {}),
      status: 'running',
      startedAt: ev.ts,
      children: [],
    }
    byId.set(id, node)
    attach(node, ev.parentId)
    adopt(node)
  }

  const close = (ev: PultEvent): void => {
    const d = ev.data as Record<string, unknown>
    const id = str(d['toolUseId'])
    if (id === undefined) return
    const node = byId.get(id)
    if (!node) return
    node.status = d['isError'] === true ? 'failed' : 'done'
    node.endedAt = ev.ts
    const ms = elapsed(node.startedAt, ev.ts)
    if (ms !== undefined) node.durationMs = ms
  }

  for (const ev of events) {
    switch (ev.kind) {
      case 'agent.spawned': open(ev, 'agent'); break
      case 'tool.called': open(ev, 'tool'); break
      case 'agent.finished':
      case 'tool.finished': close(ev); break
      default: break
    }
  }

  for (const waiting of pendingChildren.values()) {
    orphans += waiting.length
    roots.push(...waiting)
  }

  return { roots, byId, orphans }
}

/** Отступами, для `pult agent tree`. */
export function formatTree(tree: AgentTree, indent = ''): string {
  const lines: string[] = []
  const walk = (node: TreeNode, prefix: string): void => {
    const mark = node.status === 'running' ? '…' : node.status === 'failed' ? '✗' : '✓'
    const bits = [
      node.kind === 'agent' ? `Agent(${node.subagentType ?? '?'})` : node.name,
      node.model ? `· ${node.model}` : '',
      node.durationMs !== undefined ? tr`· ${node.durationMs} мс` : '',
    ].filter(Boolean)
    lines.push(`${prefix}${mark} ${bits.join(' ')}`)
    for (const child of node.children) walk(child, prefix + '  ')
  }
  for (const root of tree.roots) walk(root, indent)
  return lines.join('\n')
}

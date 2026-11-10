import { t as tr } from '../lib/i18n.js'
import type { ConvItem, ToolItem } from './conversation.js'

export type ActivityEntry = { type: 'item'; item: ConvItem } | { type: 'tools'; key: string; items: ToolItem[] }

/** Group only adjacent ordinary calls. Decisions, errors and images always remain visible. */
export function groupActivity(items: readonly ConvItem[]): ActivityEntry[] {
  const out: ActivityEntry[] = []
  let batch: ToolItem[] = []
  const flush = (): void => {
    if (batch.length === 1) out.push({ type: 'item', item: batch[0]! })
    else if (batch.length) out.push({ type: 'tools', key: batch[0]!.key, items: batch })
    batch = []
  }
  for (const item of items) {
    if (item.type === 'tool' && item.state !== 'error' && item.state !== 'stopped' && !item.images?.length) batch.push(item)
    else { flush(); out.push({ type: 'item', item }) }
  }
  flush()
  return out
}

/**
 * Ключи сворачиваемых блоков ленты: пачки «N действий» (по первой строке пачки — она не меняется, пока пачка
 * растёт) и истории субагента. По ним лента помнит, что раскрыто, и раскрывает путь к цели перехода.
 */
export const toolsGroupKey = (firstKey: string): string => `tools:${firstKey}`
export const subagentBodyKey = (agentKey: string): string => `sub:${agentKey}`

/**
 * Свёрнутые блоки, внутри которых лежит элемент с этим ключом, — от внешнего к внутреннему; `[]` — элемент
 * на виду, `null` — его нет. Свёрнутое не рисуется вовсе (иначе большой чат монтировал сотни скрытых строк),
 * поэтому переход из поиска сперва раскрывает этот путь и только потом ищет элемент в DOM.
 */
export function foldPath(items: readonly ConvItem[], key: string): string[] | null {
  for (const entry of groupActivity(items)) {
    if (entry.type === 'tools') {
      if (entry.items.some((it) => it.key === key)) return [toolsGroupKey(entry.key)]
      continue
    }
    const it = entry.item
    if (it.key === key) return []
    if (it.type === 'agent') {
      const inner = foldPath(it.items, key)
      if (inner) return [subagentBodyKey(it.key), ...inner]
    }
  }
  return null
}

export function friendlyTool(name: string): string {
  if (/commandExecution|^Bash$|exec_command|write_stdin/.test(name)) return tr('Команда')
  if (/fileChange|^Edit$|^Write$|apply_patch/.test(name)) return tr('Правка файлов')
  if (/^Read$|read_file/.test(name)) return tr('Чтение файла')
  if (/webSearch|web.*run/.test(name)) return tr('Поиск в интернете')
  if (name === 'imageView') return tr('Просмотр изображения')
  if (/imageGeneration|imagegen/.test(name)) return tr('Создание изображения')
  return name
}

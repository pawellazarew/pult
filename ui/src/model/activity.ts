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

export function friendlyTool(name: string): string {
  if (/commandExecution|^Bash$|exec_command|write_stdin/.test(name)) return 'Команда'
  if (/fileChange|^Edit$|^Write$|apply_patch/.test(name)) return 'Правка файлов'
  if (/^Read$|read_file/.test(name)) return 'Чтение файла'
  if (/webSearch|web.*run/.test(name)) return 'Поиск в интернете'
  if (/imageGeneration|imagegen/.test(name)) return 'Создание изображения'
  return name
}

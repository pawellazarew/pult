import { foldConversation } from '../../ui/src/model/conversation.ts'
import type { PultEvent } from '../../src/core/events.ts'

export function presentTranscript(events: PultEvent[], truncated = false) {
  const items = foldConversation(events).items.filter(item => item.type === 'user' || item.type === 'model')
  return {
    messages: items.slice(-20).map(item => ({
      id: String(item.id), role: item.type === 'user' ? 'user' : 'assistant',
      label: item.type === 'user' ? 'Вы' : 'Ассистент', text: item.text,
      time: new Date(item.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
    })),
    total: items.length,
    tools: events.filter(e => e.kind === 'tool.called' && !e.parentId).length,
    truncated,
  }
}

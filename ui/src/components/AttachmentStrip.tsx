import type { ReactElement } from 'react'
import type { SavedAttachment } from '../../../shell/src/contract.js'

export function AttachmentStrip({ items, previews, pending, onRemove }: {
  items: readonly SavedAttachment[]; previews: Record<string, string>; pending: number; onRemove(path: string): void
}): ReactElement | null {
  if (!items.length && !pending) return null
  return <div className="attachment-area" data-testid="attachment-area">
    <div className="attachment-list" aria-label="Прикреплённые файлы">
      {items.map((a) => <div className="attachment-card" key={a.path} data-testid="attachment-card" data-path={a.path} title={a.path}>
        {previews[a.path] ? <span className="attachment-preview" aria-hidden="true"><img src={previews[a.path]} alt="" /></span>
          : <span className="attachment-icon" aria-hidden="true">{a.kind === 'directory' ? '▤' : '↗'}</span>}
        <span className="attachment-info"><span className="attachment-name">{a.name}</span><span className="attachment-meta">{a.kind === 'directory' ? 'Папка · ссылка' : a.bytes < 1024 ? `${a.bytes} Б` : a.bytes < 1048576 ? `${Math.ceil(a.bytes / 1024)} КБ` : `${(a.bytes / 1048576).toFixed(1)} МБ`}</span></span>
        <button type="button" className="attachment-remove" aria-label={`Убрать ${a.name}`} onClick={() => onRemove(a.path)} data-testid="attachment-remove">×</button>
      </div>)}
      {pending > 0 && <span className="attachment-saving" role="status">Сохраняю вложения…</span>}
    </div>
    <span className="attachment-retention">Копии файлов хранятся в Пульте 30 дней. Оригиналы остаются у тебя.</span>
  </div>
}

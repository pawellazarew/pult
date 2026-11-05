import { useContext, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { PromptAttachment } from '../../../src/core/promptAttachments.js'
import { t } from '../lib/i18n.js'
import { ImageContext } from './Images.js'
import { MdBridgeContext } from './Markdown.js'
import { FilePreviewContext } from '../model/filePreviewContext.js'

export function attachmentSize(attachment: Pick<PromptAttachment, 'kind' | 'bytes'>): string {
  if (attachment.kind === 'directory') return t('Папка · ссылка')
  return attachment.bytes < 1024 ? t`${attachment.bytes} Б` : attachment.bytes < 1048576 ? t`${Math.ceil(attachment.bytes / 1024)} КБ` : t`${(attachment.bytes / 1048576).toFixed(1)} МБ`
}

/** Metadata survives history replay even when the corresponding owned copy has expired. */
export function UserAttachments({ items }: { items: readonly PromptAttachment[] }): ReactElement | null {
  if (!items.length) return null
  return <div className="user-attachments" role="list" aria-label={t('Прикреплённые файлы')} data-testid="user-attachments">
    {items.map((attachment, index) => <UserAttachment key={`${attachment.path}:${index}`} attachment={attachment} />)}
  </div>
}

function UserAttachment({ attachment: a }: { attachment: PromptAttachment }): ReactElement {
  const imageContext = useContext(ImageContext), bridge = useContext(MdBridgeContext), preview = useContext(FilePreviewContext)
  const root = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [image, setImage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [opening, setOpening] = useState(false)
  const isImage = a.kind === 'file' && /^image\/(png|jpeg|gif|webp)$/.test(a.mime)
  const read = imageContext?.bridge.readImage, sessionId = imageContext?.sessionId
  useEffect(() => {
    if (!isImage) return
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect() } }, { rootMargin: '400px' })
    if (root.current) observer.observe(root.current)
    return () => observer.disconnect()
  }, [isImage])
  useEffect(() => {
    if (!isImage || !visible) return
    let alive = true
    setImage(null); setError(null)
    if (!read || !sessionId) { setError(t('Превью недоступно')); return }
    void read(sessionId, a.path).then((result) => {
      if (!alive) return
      if (/^data:image\/(?:png|jpeg|gif|webp);base64,/.test(result.dataUrl)) setImage(result.dataUrl)
      else setError(t('Превью недоступно'))
    }, () => { if (alive) setError(t('Файл недоступен')) })
    return () => { alive = false }
  }, [read, sessionId, a.path, isImage, visible, attempt])
  const open = async (): Promise<void> => {
    if (opening) return
    setOpening(true)
    try {
      if (isImage && imageContext?.bridge.openImage) await imageContext.bridge.openImage(imageContext.sessionId, a.path)
      else if (a.kind === 'directory' && bridge?.revealPath) await bridge.revealPath(a.path)
      else if (preview && (a.path === preview.basePath || a.path.startsWith(preview.basePath.replace(/\/$/, '') + '/'))) preview.open(a.path)
      else if (bridge?.openFile) await bridge.openFile(a.path)
      else throw new Error('unavailable')
    } catch { setError(t('Файл недоступен')) }
    finally { setOpening(false) }
  }
  const canOpen = (isImage && !!imageContext?.bridge.openImage) || !!bridge?.openFile || (a.kind === 'directory' && !!bridge?.revealPath) || (!!preview && a.path.startsWith(preview.basePath.replace(/\/$/, '') + '/'))
  return <div ref={root} className={`user-attachment${error ? ' user-attachment-unavailable' : ''}`} role="listitem" data-testid="user-attachment">
    <button type="button" className="user-attachment-open" onClick={() => void open()} disabled={!canOpen || opening} aria-label={t`Открыть ${a.name}`} title={a.name}>
      <span className="user-attachment-thumb" aria-hidden="true">{image ? <img src={image} alt="" loading="lazy" onError={() => { setImage(null); setError(t('Превью недоступно')) }} /> : a.kind === 'directory' ? '▤' : isImage ? '▧' : a.name.split('.').pop()?.toUpperCase().slice(0, 4) || '↗'}</span>
      <span className="user-attachment-info"><span className="user-attachment-name">{a.name}</span><span className="user-attachment-size">{attachmentSize(a)}</span></span>
    </button>
    {error && <span className="user-attachment-error" role="status">{error}{isImage && read && <button type="button" onClick={() => setAttempt(attempt + 1)}>{t('Повторить')}</button>}</span>}
  </div>
}

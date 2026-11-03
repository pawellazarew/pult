import { t } from '../lib/i18n.js'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactElement } from 'react'

export interface ImageBridge {
  readImage?(sessionId: string, source: string): Promise<{ dataUrl: string; name: string }>
  saveImage?(sessionId: string, source: string): Promise<boolean>
  openImage?(sessionId: string, source: string): Promise<void>
}
export const ImageContext = createContext<{ bridge: ImageBridge; sessionId: string } | null>(null)

/** Only local raster references become automatic previews. Network URLs remain ordinary links. */
export function isImagePath(src: string): boolean {
  return src.length < 4096 && !/[\0\r\n]/.test(src) && !/^[a-z][a-z0-9+.-]*:/i.test(src)
    && /\.(?:png|jpe?g|gif|webp)$/i.test(src)
}

export function ImagePreview({ source, label }: { source: string; label?: string }): ReactElement {
  const ctx = useContext(ImageContext)
  const card = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setVisible(true); observer.disconnect() }
    }, { rootMargin: '600px' })
    if (card.current) observer.observe(card.current)
    return () => observer.disconnect()
  }, [])
  const [image, setImage] = useState<{ dataUrl: string; name: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [note, setNote] = useState('')
  const trigger = useRef<HTMLButtonElement>(null)
  const viewer = useRef<HTMLDivElement>(null)
  const caption = label || image?.name || source.split('/').pop() || t('Изображение')
  const read = ctx?.bridge.readImage
  const sessionId = ctx?.sessionId
  useEffect(() => {
    if (!visible) return
    let alive = true
    setImage(null); setError(null)
    if (!read || !sessionId) { setError(t('Для просмотра обнови окно Пульта.')); return }
    read(sessionId, source).then((value) => {
      if (!alive) return
      if (!/^data:image\/(?:png|jpeg|gif|webp);base64,/.test(value.dataUrl)) { setError(t('Формат изображения не поддерживается.')); return }
      setImage(value)
    }, () => { if (alive) setError(t('Изображение недоступно: файл удалён или находится вне папок этой сессии.')) })
    return () => { alive = false }
  }, [read, sessionId, source, attempt, visible])
  useEffect(() => {
    if (!expanded) return
    const prior = document.activeElement as HTMLElement | null
    viewer.current?.focus()
    return () => { (trigger.current ?? prior)?.focus() }
  }, [expanded])
  const action = async (kind: 'save' | 'open'): Promise<void> => {
    if (!ctx) return
    setNote('')
    try {
      if (kind === 'save') { if (await ctx.bridge.saveImage?.(ctx.sessionId, source)) setNote(t('Сохранено')) }
      else await ctx.bridge.openImage?.(ctx.sessionId, source)
    } catch { setNote(t('Не удалось открыть или сохранить файл.')) }
  }
  return <span ref={card} className="image-card" data-testid="image-card">
    {image ? <button ref={trigger} type="button" className="image-thumb" onClick={() => { setZoom(1); setExpanded(true) }} aria-label={t`Увеличить: ${caption}`}>
      <img src={image.dataUrl} alt={caption} loading="lazy" onError={() => { setImage(null); setError(t('Не удалось прочитать изображение.')) }} />
    </button> : <span className="image-placeholder" role="status">{error ?? t('Загружаю изображение…')}</span>}
    <span className="image-caption" title={source}>{caption}
      {error && read && <button type="button" onClick={() => setAttempt(attempt + 1)}>{t("Повторить")}</button>}
    </span>
    {expanded && image && createPortal(<div className="image-overlay" onClick={(e) => { if (e.target === e.currentTarget) setExpanded(false) }}>
      <div ref={viewer} className="image-viewer" role="dialog" aria-modal="true" aria-label={caption} tabIndex={-1}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') { e.preventDefault(); setExpanded(false) }
          if (e.key === 'Tab') {
            const buttons = viewer.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
            if (!buttons?.length) return
            const first = buttons[0]!, last = buttons[buttons.length - 1]!
            if (e.shiftKey && (document.activeElement === first || document.activeElement === viewer.current)) { e.preventDefault(); last.focus() }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
          }
        }}>
        <div className="image-toolbar"><strong>{caption}</strong>
          <button type="button" onClick={() => setZoom(Math.max(.25, zoom - .25))} aria-label={t("Уменьшить масштаб")}>−</button>
          <button type="button" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button type="button" onClick={() => setZoom(Math.min(4, zoom + .25))} aria-label={t("Увеличить масштаб")}>+</button>
          {ctx?.bridge.saveImage && <button type="button" onClick={() => void action('save')}>{t("Сохранить…")}</button>}
          {ctx?.bridge.openImage && <button type="button" onClick={() => void action('open')}>{t("Открыть файл")}</button>}
          <button type="button" onClick={() => setExpanded(false)} aria-label={t("Закрыть просмотр")}>×</button>
        </div>
        <div className="image-canvas"><img src={image.dataUrl} alt={caption} style={{ width: `${zoom * 100}%` }} /></div>
        {note && <div className="image-note" role="status">{note}</div>}
      </div>
    </div>, document.body)}
  </span>
}

export function ImageGallery({ sources }: { sources: readonly string[] }): ReactElement | null {
  if (!sources.length) return null
  return <div className="image-gallery" data-testid="image-gallery">{[...new Set(sources)].map((src) => <ImagePreview key={src} source={src} />)}</div>
}

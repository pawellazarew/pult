import { t } from '../lib/i18n.js'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask, TextLayer } from 'pdfjs-dist'

type PdfLibrary = typeof import('pdfjs-dist')
type LoadedDocument = { source: string; document: PDFDocumentProxy }
const MAX_BYTES = 20 * 1024 * 1024
const MAX_PAGES = 5000
const MAX_PIXELS = 12_000_000
const MAX_SIDE = 8192
const MAX_ZOOM = 2.5

function pdfError(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error && error.name === 'PasswordException') {
    return t('PDF защищён паролем. Открой его системным приложением.')
  }
  return t('Не удалось показать PDF. Файл может быть повреждён — попробуй открыть его системным приложением.')
}

/** Only local bytes enter PDF.js; no URL from the PDF, forms, scripts or links are activated. */
export function PdfPreview({ base64, name }: { base64: string; name: string }): ReactElement {
  const library = useRef<PdfLibrary | null>(null)
  const stage = useRef<HTMLDivElement>(null)
  const pageHost = useRef<HTMLDivElement>(null)
  const [loaded, setLoaded] = useState<LoadedDocument | null>(null)
  const [loadError, setLoadError] = useState<{ source: string; message: string } | null>(null)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [rendering, setRendering] = useState(true)
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [fit, setFit] = useState(true)
  const [scale, setScale] = useState(1)
  const [width, setWidth] = useState(0)
  const [pageText, setPageText] = useState('')
  const document = loaded?.source === base64 ? loaded.document : null
  const error = loadError?.source === base64 ? loadError.message : renderError

  useEffect(() => {
    let alive = true
    let task: PDFDocumentLoadingTask | null = null
    setLoaded(null); setLoadError(null); setRenderError(null)
    setPage(1); setFit(true); setZoom(1); setPageText(''); setRendering(true)
    void (async () => {
      // Import on use: server-rendered UI tests never initialize browser-only PDF.js globals.
      const pdf = await import('pdfjs-dist')
      if (!alive) return
      library.current = pdf
      const asset = (file: string): string => new URL(`pdf/${file}`, window.location.href).href
      pdf.GlobalWorkerOptions.workerSrc = asset('pdf.worker.mjs')
      if (!base64 || base64.length > Math.ceil(MAX_BYTES / 3) * 4 + 4) throw new Error('size')
      const raw = atob(base64)
      if (raw.length > MAX_BYTES) throw new Error('size')
      const data = Uint8Array.from(raw, (c) => c.charCodeAt(0))
      task = pdf.getDocument({
        data, useWasm: false, enableXfa: false, disableFontFace: true, useSystemFonts: true,
        useWorkerFetch: false, cMapUrl: asset('cmaps/'), cMapPacked: true,
        standardFontDataUrl: asset('standard_fonts/'), maxImageSize: 16_000_000,
        isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
      })
      const result = await task.promise
      if (!alive) return
      if (result.numPages > MAX_PAGES) {
        setLoadError({ source: base64, message: t('В PDF больше 5000 страниц. Открой его системным приложением.') })
        await task.destroy()
        return
      }
      setLoaded({ source: base64, document: result })
    })().catch((e: unknown) => { if (alive) setLoadError({ source: base64, message: pdfError(e) }) })
    return () => { alive = false; void task?.destroy().catch(() => {}) }
  }, [base64])

  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const update = (): void => setWidth(Math.max(0, Math.floor(el.clientWidth - 32)))
    const observer = new ResizeObserver(update)
    observer.observe(el); update()
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const host = pageHost.current
    if (!host) return
    let alive = true
    let render: RenderTask | null = null
    let textLayer: TextLayer | null = null
    host.replaceChildren()
    setRendering(true); setRenderError(null); setPageText('')
    if (!document || !library.current || width < 40) return
    const pdf = library.current
    void (async () => {
      const current = await document.getPage(page)
      if (!alive) return
      const original = current.getViewport({ scale: 1 })
      if (!(original.width > 0 && original.height > 0) || !Number.isFinite(original.width * original.height)) throw new Error('page dimensions')
      const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1))
      const requested = fit ? width / original.width : zoom
      const actual = Math.min(requested, Math.sqrt(MAX_PIXELS / (original.width * original.height * ratio ** 2)), MAX_SIDE / (Math.max(original.width, original.height) * ratio))
      if (!(actual > 0) || !Number.isFinite(actual)) throw new Error('page dimensions')
      const viewport = current.getViewport({ scale: actual })
      const canvas = window.document.createElement('canvas')
      canvas.dataset.testid = 'pdf-canvas'
      canvas.setAttribute('role', 'img')
      canvas.setAttribute('aria-label', t`${name}, страница ${page}`)
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio))
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio))
      canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`
      const sheet = window.document.createElement('div')
      sheet.className = 'pdf-page'
      sheet.style.width = `${viewport.width}px`; sheet.style.height = `${viewport.height}px`
      sheet.style.setProperty('--total-scale-factor', String(actual))
      sheet.append(canvas)
      render = current.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0], annotationMode: pdf.AnnotationMode.DISABLE })
      await render.promise
      if (!alive) return
      host.replaceChildren(sheet)
      setScale(actual); setRendering(false)
      try {
        const content = await current.getTextContent()
        if (!alive) return
        setPageText(content.items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim())
        const layer = window.document.createElement('div')
        layer.className = 'pdf-text-layer'
        layer.setAttribute('aria-hidden', 'true')
        sheet.append(layer)
        textLayer = new pdf.TextLayer({ textContentSource: content, container: layer, viewport })
        // Selection is an enhancement; text extraction must not hide a readable rendered page.
        await textLayer.render()
      } catch { /* The canvas remains usable when a PDF has no extractable text. */ }
      if (alive) current.cleanup()
    })().catch((e: unknown) => {
      if (alive) { setRendering(false); setRenderError(pdfError(e)) }
    })
    return () => { alive = false; render?.cancel(); textLayer?.cancel() }
  }, [document, page, zoom, fit, width, name])

  const move = (next: number): void => {
    setPage(next)
    if (stage.current) { stage.current.scrollTop = 0; stage.current.scrollLeft = 0 }
  }
  const changeZoom = (direction: -1 | 1): void => {
    setZoom(Math.max(.25, Math.min(MAX_ZOOM, (direction > 0 ? Math.floor((fit ? scale : zoom) * 4 + .01) + 1 : Math.ceil((fit ? scale : zoom) * 4 - .01) - 1) / 4)))
    setFit(false)
  }
  const state = error ? 'error' : document && !rendering ? 'ready' : 'loading'
  return <section className="pdf-preview" aria-label={`PDF: ${name}`} data-testid="pdf-preview" data-state={state}>
    <div className="pdf-toolbar" aria-label={t("Просмотр PDF")}>
      <button type="button" className="btn btn-sm" data-testid="pdf-prev" aria-label={t("Предыдущая страница")} disabled={!document || page <= 1} onClick={() => move(page - 1)}>←</button>
      <span className="pdf-page-count" aria-live="polite">{document ? `${page} / ${document.numPages}` : 'PDF'}</span>
      <button type="button" className="btn btn-sm" data-testid="pdf-next" aria-label={t("Следующая страница")} disabled={!document || page >= document.numPages} onClick={() => move(page + 1)}>→</button>
      <span className="pdf-toolbar-space" />
      <button type="button" className="btn btn-sm" data-testid="pdf-zoom-out" aria-label={t("Уменьшить PDF")} disabled={!document || (!fit && zoom <= .25)} onClick={() => changeZoom(-1)}>−</button>
      <span className="pdf-zoom" data-testid="pdf-zoom">{Math.round(scale * 100)}%</span>
      <button type="button" className="btn btn-sm" data-testid="pdf-zoom-in" aria-label={t("Увеличить PDF")} disabled={!document || (!fit && zoom >= MAX_ZOOM)} onClick={() => changeZoom(1)}>+</button>
      <button type="button" className="btn btn-sm btn-ghost" data-testid="pdf-fit" aria-pressed={fit} disabled={!document} onClick={() => setFit(true)}>{t("По ширине")}</button>
    </div>
    {error && <div className="pdf-error" role="alert">{error}</div>}
    <div ref={stage} className="pdf-scroll" tabIndex={0} aria-label={t("Страница PDF")} hidden={!!error}>
      {state === 'loading' && <div className="pdf-loading" role="status">{document ? t('Показываю страницу…') : t('Загружаю PDF…')}</div>}
      <div ref={pageHost} className="pdf-page-host" />
    </div>
    {document && !error && pageText && <details className="pdf-page-text">
      <summary>{t("Текст страницы")}</summary><pre>{pageText}</pre>
    </details>}
  </section>
}

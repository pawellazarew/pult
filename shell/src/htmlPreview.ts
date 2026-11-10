import { randomUUID } from 'node:crypto'
import type { FilePreview } from '../../src/core/fileBrowserTypes.js'

export const HTML_PREVIEW_SCHEME = 'pult-preview'

/** Serves only HTML already authorized by the file reader, on a separate origin. */
export class HtmlPreviews {
  private readonly pages = new Map<string, { key: string; text: string }>()

  attach(sessionId: string, file: FilePreview): FilePreview {
    if (!/\.html?$/i.test(file.path) || file.kind !== 'text' || file.text === undefined || file.truncated) return file
    const key = `${sessionId}\0${file.path}`
    const existing = [...this.pages].find(([, page]) => page.key === key && page.text === file.text)
    if (existing) return { ...file, htmlUrl: `${HTML_PREVIEW_SCHEME}://page/${existing[0]}` }
    for (const [id, page] of this.pages) if (page.key === key) this.pages.delete(id)
    const id = randomUUID()
    this.pages.set(id, { key, text: file.text })
    if (this.pages.size > 32) this.pages.delete(this.pages.keys().next().value!)
    return { ...file, htmlUrl: `${HTML_PREVIEW_SCHEME}://page/${id}` }
  }

  response(raw: string): Response {
    const url = new URL(raw)
    const page = url.hostname === 'page' && !url.search ? this.pages.get(url.pathname.slice(1)) : undefined
    if (!page) return new Response('Preview unavailable', { status: 404 })
    return new Response(page.text, { headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src https: data: blob:; script-src https: 'unsafe-inline'; style-src https: 'unsafe-inline'; connect-src https:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    } })
  }
}

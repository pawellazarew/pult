/** Local paths are opened by the shell after a click, never fetched by the renderer. */
export function localFilePath(raw: string): string | null {
  return raw.length <= 8192 && raw.startsWith('/') && !raw.startsWith('//') && !/[\u0000-\u001f\u007f]/.test(raw) ? raw : null
}

export function fileCitation(text: string): { path: string; length: number } | null {
  const match = /^:codex-file-citation\{((?:[^"{}]|"(?:\\.|[^"\\])*")*)\}/.exec(text.slice(0, 8400))
  if (!match) return null
  let attrs = match[1]!
  let path: string | null = null
  while (attrs.trim()) {
    const attr = /^\s*([\w-]+)\s*=\s*("(?:\\.|[^"\\])*")\s*/.exec(attrs)
    if (!attr) return null
    try { if (attr[1] === 'path') { if (path !== null) return null; path = JSON.parse(attr[2]!) as string } } catch { return null }
    attrs = attrs.slice(attr[0].length)
  }
  return path && localFilePath(path) ? { path, length: match[0].length } : null
}


/** Outside-workspace previews must be explicitly referenced in a real conversation message. */
export function referencesFile(events: readonly {kind?: string; data?: Record<string, unknown>}[], source: string): boolean {
  if (!localFilePath(source)) return false
  return events.some((e) => {
    if (e.kind !== 'message.done' && e.kind !== 'message.user') return false
    const text = e.data?.['text']
    if (typeof text !== 'string') return false
    let at = text.indexOf(':codex-file-citation{')
    while (at >= 0) {
      const ref = fileCitation(text.slice(at, at + 8400))
      if (ref?.path === source) return true
      at = text.indexOf(':codex-file-citation{', at + 21)
    }
    // Absolute Markdown links (including angle-wrapped paths with spaces).
    return text.includes('](<' + source + '>)') || (!/\s/.test(source) && text.includes('](' + source + ')'))
  })
}

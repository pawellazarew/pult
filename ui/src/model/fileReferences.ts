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

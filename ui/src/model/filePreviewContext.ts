import { createContext } from 'react'

export const FilePreviewContext = createContext<{ open(path: string): void; basePath: string } | null>(null)

export function relativeDocument(base: string, source: string): string | null {
  if (!base || !source || /^[a-z][a-z0-9+.-]*:/i.test(source) || source.startsWith('#') || source.startsWith('//') || /[\u0000-\u001f]/.test(source)) return null
  if (!source.includes('/') && !/\.[a-z0-9]{1,12}$/i.test(source)) return null
  return source.startsWith('/') ? source : `${base.replace(/\/$/, '')}/${source}`
}

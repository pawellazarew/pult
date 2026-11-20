import { normalizeTitle, SESSION_TITLE_MAX } from './registry.js'

/** Название из первых слов задачи: первая содержательная строка, до 6 слов. */
export function localSessionTitle(text: string): string | null {
  const line = text.split('\n').map((l) => l.replace(/^[#>*\-\s`]+/, '').trim()).find((l) => l.length > 0) ?? ''
  const words = line.split(/\s+/).filter(Boolean).slice(0, 6).join(' ')
  const cut = [...words].slice(0, SESSION_TITLE_MAX).join('').replace(/[\s.,:;!?…—-]+$/u, '')
  return normalizeTitle(cut)
}

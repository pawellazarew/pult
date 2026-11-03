// Имя сессии из папки (быстрый старт, шаг B: имя выделяет демон, design/2026-11-02-quick-start §3.3). Раньше имя
// предлагала форма окна и человек мог его поправить; теперь поля нет, и `agent.start {requestId}` берёт имя сам — так
// столкновений клиентских имён нет. Функция чистая: её же зовёт окно (подсказка в черновике) и тесты.

/** Транслитерация кириллицы для имени латиницей (`[a-z][a-z0-9_-]{0,31}`). */
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}

/** Имя агента из папки: латиница, `[a-z][a-z0-9_-]{0,31}`, свободное (суффикс -2, -3…). */
export function suggestName(folder: string, taken: Iterable<string>): string {
  const base = folder.split('/').filter(Boolean).pop() ?? ''
  let s = [...base.toLowerCase()].map((ch) => TRANSLIT[ch] ?? ch).join('')
  s = s.replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^[-_0-9]+/, '').replace(/[-_]+$/, '')
  if (!s) s = 'agent'
  s = s.slice(0, 28).replace(/[-_]+$/, '')
  const busy = new Set(taken)
  if (!busy.has(s)) return s
  for (let i = 2; i < 100; i++) {
    const c = `${s}-${i}`
    if (!busy.has(c)) return c
  }
  return `${s.slice(0, 20)}-${Date.now().toString(36).slice(-6)}`
}

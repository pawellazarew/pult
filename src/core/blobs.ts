// Картинки и прочие base64-блоки в выводе инструментов — в заглушку ДО журнала.
// Адаптер сначала сохраняет растровые картинки через core/images.ts; событие несёт отдельный массив images.
//
// ЗАЧЕМ. Скриншот страницы — сотни килобайт base64 в одном событии `tool.finished`. Журнал раздувается, а
// строка NDJSON больше 1 МиБ рвёт соединение окна (`MAX_LINE_BYTES` клиента). Человеку в ленте сама картинка
// base64-текстом не нужна, модели она уже ушла от провайдера — в журнал идёт `[изображение, N КБ]`.

/** Блок длиннее этого, похожий на base64, считается бинарным даже без пометки `type: image`. */
export const BLOB_MIN_CHARS = 16 * 1024
const BASE64_RE = /^[A-Za-z0-9+/=\r\n]+$/

const kb = (chars: number): number => Math.max(1, Math.round((chars * 3) / 4 / 1024))
export const blobPlaceholder = (chars: number, what = 'изображение'): string => `[${what}, ${kb(chars)} КБ]`

/**
 * Копия значения, где картинки заменены текстом-заглушкой:
 *   * `{type: 'image', data: '<base64>'}` (MCP) и `{type: 'image', source: {type: 'base64', data}}` (Anthropic) —
 *     в `{type: 'text', text: '[изображение, N КБ]'}`;
 *   * любая строка длиннее BLOB_MIN_CHARS из одних знаков base64 — в `[данные, N КБ]`.
 * Остальное — как было. Чистая функция.
 */
export function stripBlobs(v: unknown): unknown {
  if (typeof v === 'string') {
    if (/^data:image\/[^;,]+;base64,/i.test(v)) return blobPlaceholder(v.length)
    return v.length >= BLOB_MIN_CHARS && BASE64_RE.test(v) ? blobPlaceholder(v.length, 'данные') : v
  }
  if (Array.isArray(v)) return v.map(stripBlobs)
  if (v === null || typeof v !== 'object') return v
  const o = v as Record<string, unknown>
  if (o['type'] === 'image') {
    const src = o['source'] !== null && typeof o['source'] === 'object' ? o['source'] as Record<string, unknown> : null
    const data = typeof o['data'] === 'string' ? o['data'] : typeof src?.['data'] === 'string' ? src['data'] as string : null
    if (data !== null) return { type: 'text', text: blobPlaceholder(data.length) }
  }
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(o)) out[k] = stripBlobs(x)
  return out
}

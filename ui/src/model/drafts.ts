// Черновики поля реплики (0.3.4). Окно закрывается — непустой черновик сессии ложится в localStorage, новое
// окно ставит его в поле той же сессии. Нужно обновлению окна (демон закрывает окно SIGTERM, Electron выходит
// штатно, и `pagehide`/`beforeunload` успевают), но работает и при ⌘Q, закрытии окна и переключении сессии.
// Чистые функции над хранилищем `get/set` — без DOM; хранилище недоступно — черновик просто не переживёт выход.

export const DRAFTS_KEY = 'pult.drafts'
/** Старше недели — не черновик, а забытый текст: не подставляем. */
export const DRAFT_TTL_MS = 7 * 24 * 3_600_000
/** Сессий с черновиком в хранилище — не больше; лишние, самые старые, вытесняются. */
export const DRAFTS_MAX = 50
/** Черновик пишется и по ходу набора — через столько тишины после последнего изменения. */
export const DRAFT_SAVE_MS = 500
/** Длиннее — обрезается: localStorage общий на окно (~5 МБ), поле реплики так много не держит. */
export const DRAFT_MAX_CHARS = 100_000

export interface DraftStore {
  get(k: string): string | null
  set(k: string, v: string): void
}

interface Saved { text: string; at: number }

/** Все живые черновики; мусор и просроченные — мимо. */
export function readDrafts(store: DraftStore, now: number): Record<string, Saved> {
  let raw: unknown
  try { raw = JSON.parse(store.get(DRAFTS_KEY) ?? '{}') } catch { return {} }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, Saved> = {}
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    const o = v as { text?: unknown; at?: unknown } | null
    if (!o || typeof o.text !== 'string' || !o.text.trim() || typeof o.at !== 'number') continue
    if (now - o.at > DRAFT_TTL_MS) continue
    out[name] = { text: o.text, at: o.at }
  }
  return out
}

function write(store: DraftStore, all: Record<string, Saved>): void {
  const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, DRAFTS_MAX)
  store.set(DRAFTS_KEY, JSON.stringify(Object.fromEntries(keep)))
}

/** Записать черновик сессии; пустой (одни пробелы) — убрать запись. */
export function saveDraft(store: DraftStore, name: string, text: string, now: number): void {
  if (!name) return
  const all = readDrafts(store, now)
  if (!text.trim()) {
    if (!(name in all)) return
    delete all[name]
  } else {
    all[name] = { text: text.slice(0, DRAFT_MAX_CHARS), at: now }
  }
  write(store, all)
}

/** Черновик сессии для поля при открытии; запись остаётся, пока поле не опустеет (отправка, стёрли). */
export function peekDraft(store: DraftStore, name: string, now: number): string | null {
  return readDrafts(store, now)[name]?.text ?? null
}

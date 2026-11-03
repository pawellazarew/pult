// Черновики новых чатов (быстрый старт, шаг B; design/2026-11-02-quick-start §3.2) — у демона, по файлу на черновик:
// `PULT_HOME/drafts/<uuid>.json`, 0600. Раньше черновики полей жили в `localStorage` окна, и запись переписывала весь
// набор разом (ревью Codex № 13): два окна затирали друг друга. Здесь каждый черновик — свой файл со своим `rev`:
//
//   * запись — compare-and-set: окно шлёт `baseRev`, который видело; не совпал — `draft_conflict`, окно перечитывает;
//   * владелец — окно (`owner.id`) и его пульс. Пока пульс свежий (< 30 с), чужое окно черновик не пишет
//     (`draft_owned`) и видит «открыт в другом окне · Забрать»; «Забрать» (`draft.claim`) — явный перехват;
//   * пульс живёт в памяти демона: после рестарта демона все черновики свободны — окна, которое их держало, тоже нет.
//
// Содержимое демон не толкует (это снимок полей черновика окна: папка, провайдер, модель, усилие, доступ, браузер,
// ветка, режим, текст, происхождение полей, источник, `consentRev`), но держит в рамках: объект, не больше 256 КБ.

import { mkdirSync, readdirSync, readFileSync, unlinkSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from '../service/fsutil.js'

export const DRAFT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** Пульс окна старше — черновик можно забрать (§3.2). */
export const DRAFT_OWNER_STALE_MS = 30_000
export const DRAFT_MAX_BYTES = 256 * 1024
export const DRAFTS_MAX = 200
const OWNER_RE = /^[A-Za-z0-9_-]{1,64}$/

export interface DraftRecord {
  id: string
  rev: number
  owner: string | null
  updatedAt: string
  data: Record<string, unknown>
}

export interface DraftView extends DraftRecord {
  /** Владелец жив (пульс свежий). Своё окно сравнивает `owner` со своим id. */
  ownerAlive: boolean
}

/** Строка списка черновиков без тела (ревью Codex 12): тело — отдельным `draft.get`, кадр NDJSON не переполнится. */
export type DraftMeta = Omit<DraftView, 'data'> & { bytes: number }

export class DraftError extends Error {
  constructor(readonly code: 'invalid_params' | 'not_found' | 'draft_conflict' | 'draft_owned' | 'draft_starting', message: string, readonly rev?: number) { super(message) }
}

export interface DraftStore {
  list(): DraftView[]
  /** Список без тел, новые первыми, страницами. */
  meta(offset?: number, limit?: number): { drafts: DraftMeta[]; total: number }
  get(id: string): DraftView | null
  put(id: string, data: unknown, baseRev: number, owner: string, force?: boolean): DraftView
  claim(id: string, owner: string): DraftView
  touch(ids: readonly string[], owner: string): number
  remove(id: string, owner?: string): boolean
  /**
   * Захват черновика стартом (ревью Codex 10, recheck 4) — compare-and-set по ревизии и владельцу: пока старт идёт,
   * черновик нельзя ни записать, ни «Забрать», ни удалить из другого окна. Захват живёт в памяти демона: упал демон —
   * захвата нет.
   */
  beginStart(id: string, rev: number, owner: string, requestId: string): DraftView
  /** Конец старта: `consumed` — реплика принята, черновик удаляется; иначе захват снимается, черновик остаётся. */
  endStart(id: string, requestId: string, consumed: boolean): void
}

export function createDraftStore(dir: string, now: () => number = Date.now): DraftStore {
  const beats = new Map<string, { owner: string; at: number }>()
  /** Черновики, которые сейчас отправляет старт: id → requestId. */
  const starting = new Map<string, string>()
  const notStarting = (id: string): void => {
    if (starting.has(id)) throw new DraftError('draft_starting', 'черновик сейчас отправляется — дождись чата или ошибки')
  }
  const file = (id: string): string => join(dir, `${id}.json`)
  const ensure = (): void => { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700) }
  const read = (id: string): DraftRecord | null => {
    try {
      const o = JSON.parse(readFileSync(file(id), 'utf8')) as Record<string, unknown>
      if (o['id'] !== id || typeof o['rev'] !== 'number' || !o['data'] || typeof o['data'] !== 'object' || Array.isArray(o['data'])) return null
      return {
        id, rev: o['rev'], owner: typeof o['owner'] === 'string' ? o['owner'] : null,
        updatedAt: typeof o['updatedAt'] === 'string' ? o['updatedAt'] : new Date(0).toISOString(), data: o['data'] as Record<string, unknown>,
      }
    } catch { return null }
  }
  const alive = (r: DraftRecord): boolean => {
    const b = beats.get(r.id)
    return !!b && b.owner === r.owner && now() - b.at < DRAFT_OWNER_STALE_MS
  }
  const view = (r: DraftRecord): DraftView => ({ ...r, ownerAlive: alive(r) })
  const checkId = (id: unknown): string => {
    if (typeof id !== 'string' || !DRAFT_ID_RE.test(id)) throw new DraftError('invalid_params', 'черновик: id — UUID')
    return id
  }
  const checkOwner = (owner: unknown): string => {
    if (typeof owner !== 'string' || !OWNER_RE.test(owner)) throw new DraftError('invalid_params', 'черновик: owner — id окна (латиница, цифры, - и _)')
    return owner
  }
  const ids = (): string[] => {
    try { return readdirSync(dir).filter((n) => n.endsWith('.json') && DRAFT_ID_RE.test(n.slice(0, -5))).map((n) => n.slice(0, -5)) } catch { return [] }
  }
  const write = (r: DraftRecord, owner: string): DraftView => {
    ensure()
    atomicWrite(file(r.id), JSON.stringify(r) + '\n', 0o600)
    beats.set(r.id, { owner, at: now() })
    return view(r)
  }
  return {
    list() {
      return ids().flatMap((id) => { const r = read(id); return r ? [view(r)] : [] })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    },
    meta(offset = 0, limit = 50) {
      const all = ids().flatMap((id) => {
        const r = read(id)
        if (!r) return []
        const { data, ...rest } = view(r)
        return [{ ...rest, bytes: Buffer.byteLength(JSON.stringify(data)) }]
      }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      return { drafts: all.slice(offset, offset + limit), total: all.length }
    },
    get(id) {
      const r = read(checkId(id))
      return r ? view(r) : null
    },
    put(rawId, data, baseRev, rawOwner, force = false) {
      const id = checkId(rawId)
      const owner = checkOwner(rawOwner)
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new DraftError('invalid_params', 'черновик: data — объект')
      const body = JSON.stringify(data)
      if (Buffer.byteLength(body) > DRAFT_MAX_BYTES) throw new DraftError('invalid_params', `черновик больше ${DRAFT_MAX_BYTES / 1024} КБ`)
      if (!Number.isSafeInteger(baseRev) || baseRev < 0) throw new DraftError('invalid_params', 'черновик: baseRev — целое ≥ 0')
      notStarting(id)
      const cur = read(id)
      if (!cur && ids().length >= DRAFTS_MAX) throw new DraftError('invalid_params', `черновиков уже ${DRAFTS_MAX} — удали лишние`)
      if (cur && cur.rev !== baseRev) throw new DraftError('draft_conflict', `черновик изменился (сейчас — запись ${cur.rev}) — перечитай`, cur.rev)
      if (!cur && baseRev !== 0) throw new DraftError('draft_conflict', 'черновика уже нет — его отправили или удалили в другом окне', 0)
      if (cur && cur.owner && cur.owner !== owner && alive(cur) && !force) {
        throw new DraftError('draft_owned', 'черновик открыт в другом окне — «Забрать», чтобы продолжить здесь', cur.rev)
      }
      return write({ id, rev: (cur?.rev ?? 0) + 1, owner, updatedAt: new Date(now()).toISOString(), data: JSON.parse(body) as Record<string, unknown> }, owner)
    },
    claim(rawId, rawOwner) {
      const id = checkId(rawId)
      const owner = checkOwner(rawOwner)
      notStarting(id)
      const cur = read(id)
      if (!cur) throw new DraftError('not_found', 'черновика нет — его отправили или удалили')
      return write({ ...cur, rev: cur.rev + 1, owner, updatedAt: new Date(now()).toISOString() }, owner)
    },
    beginStart(rawId, rev, rawOwner, requestId) {
      const id = checkId(rawId)
      const owner = checkOwner(rawOwner)
      const busy = starting.get(id)
      if (busy && busy !== requestId) throw new DraftError('draft_starting', 'черновик уже отправляется')
      const cur = read(id)
      if (!cur) throw new DraftError('draft_conflict', 'черновика уже нет — его отправили или удалили в другом окне', 0)
      if (cur.owner && cur.owner !== owner && alive(cur)) throw new DraftError('draft_owned', 'черновик открыт в другом окне — «Забрать», чтобы отправить отсюда', cur.rev)
      if (cur.rev !== rev) throw new DraftError('draft_conflict', `черновик изменился (сейчас — запись ${cur.rev}) — перечитай`, cur.rev)
      starting.set(id, requestId)
      return view(cur)
    },
    endStart(rawId, requestId, consumed) {
      const id = checkId(rawId)
      if (starting.get(id) !== requestId) return
      starting.delete(id)
      if (consumed) { try { unlinkSync(file(id)) } catch { /* уже нет */ } beats.delete(id) }
    },
    touch(list, rawOwner) {
      const owner = checkOwner(rawOwner)
      let n = 0
      for (const id of list) {
        if (typeof id !== 'string' || !DRAFT_ID_RE.test(id)) continue
        const r = read(id)
        if (r && r.owner === owner) { beats.set(id, { owner, at: now() }); n++ }
      }
      return n
    },
    remove(rawId, owner) {
      const id = checkId(rawId)
      notStarting(id)
      const cur = read(id)
      if (!cur) return false
      if (owner !== undefined && cur.owner && cur.owner !== checkOwner(owner) && alive(cur)) {
        throw new DraftError('draft_owned', 'черновик открыт в другом окне — удалить его можно там или после «Забрать»', cur.rev)
      }
      try { unlinkSync(file(id)) } catch { return false }
      beats.delete(id)
      return true
    },
  }
}

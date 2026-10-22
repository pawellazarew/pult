// Черновики поля реплики (0.3.4): окно закрылось (обновление окна, ⌘Q) — непустой черновик сессии в localStorage,
// новое окно ставит его в поле той же сессии. Модель — без DOM; хранилище — подставное.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DRAFT_MAX_CHARS, DRAFT_TTL_MS, DRAFTS_KEY, DRAFTS_MAX, peekDraft, readDrafts, saveDraft } from '../src/model/drafts.js'
import type { DraftStore } from '../src/model/drafts.js'

function memStore(): DraftStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => { data.set(k, v) } }
}

const T = Date.parse('2026-10-22T10:00:00Z')

describe('черновики поля реплики переживают закрытие окна', () => {
  it('«перезагрузка»: сохранили при закрытии — новое окно видит черновик своей сессии, чужой — нет', () => {
    const store = memStore()
    // Закрытие окна: pagehide → saveDraft текущего поля.
    saveDraft(store, 'fix-limits', 'допиши тест на откат\nи README', T)
    saveDraft(store, 'docs', '   ', T) // одни пробелы — не черновик
    // Новое окно (то же хранилище): поле сессии fix-limits открывается с черновиком.
    assert.equal(peekDraft(store, 'fix-limits', T + 30_000), 'допиши тест на откат\nи README')
    assert.equal(peekDraft(store, 'docs', T + 30_000), null)
    assert.equal(peekDraft(store, 'other', T + 30_000), null)
    // Запись живёт, пока поле не опустеет (отправили) — тогда её нет.
    assert.equal(peekDraft(store, 'fix-limits', T + 60_000), 'допиши тест на откат\nи README')
    saveDraft(store, 'fix-limits', '', T + 90_000)
    assert.equal(peekDraft(store, 'fix-limits', T + 90_000), null)
  })

  it('просроченные, мусор и лишние вытесняются; длинный текст обрезается', () => {
    const store = memStore()
    saveDraft(store, 'old', 'давно', T)
    assert.equal(peekDraft(store, 'old', T + DRAFT_TTL_MS + 1), null)
    store.set(DRAFTS_KEY, '{не json')
    assert.deepEqual(readDrafts(store, T), {})
    store.set(DRAFTS_KEY, JSON.stringify({ a: { text: 5, at: T }, b: null, c: { text: 'ок', at: T } }))
    assert.deepEqual(Object.keys(readDrafts(store, T)), ['c'])
    for (let i = 0; i < DRAFTS_MAX + 5; i++) saveDraft(store, `s${i}`, `текст ${i}`, T + i)
    const all = readDrafts(store, T + 100)
    assert.equal(Object.keys(all).length, DRAFTS_MAX)
    assert.equal(all['s0'], undefined, 'самые старые вытеснены')
    assert.ok(all[`s${DRAFTS_MAX + 4}`])
    saveDraft(store, 'big', 'я'.repeat(DRAFT_MAX_CHARS + 10), T + 200)
    assert.equal(peekDraft(store, 'big', T + 200)?.length, DRAFT_MAX_CHARS)
  })

  it('хранилище недоступно — ничего не падает', () => {
    const broken: DraftStore = { get: () => { throw new Error('denied') }, set: () => { throw new Error('denied') } }
    const safe: DraftStore = { get: (k) => { try { return broken.get(k) } catch { return null } }, set: (k, v) => { try { broken.set(k, v) } catch { /* нет */ } } }
    saveDraft(safe, 'x', 'текст', T)
    assert.equal(peekDraft(safe, 'x', T), null)
  })
})

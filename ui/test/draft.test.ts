// Шаг B быстрого старта (design/2026-11-02-quick-start/DESIGN-REVIEW.md §3.2–§3.8, §6): черновик нового чата без окна —
// резолвер на входах, submit-guard (IME, автоповтор, замок ссылки, без папки), порядок Esc, готовность провайдера,
// снимок у демона и восстановление, отрисовка состояний (пустой, без папки, из ссылки, отказ папки, вход не выполнен).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DraftView } from '../src/components/Draft.js'
import { ProjectTree } from '../src/components/ProjectTree.js'
import {
  accessChipLabel, createDraft, draftEmpty, draftFromSnapshot, draftLabel, draftSnapshot, draftStartParams, escDecision, linkPromptStats, modelUnlisted,
  pickApproval, pickModel, readinessBlocks, readinessOf, refreshBeforeStart, remembersAccess, resolveDraft, submitDecision, withDraftFolder,
} from '../src/model/draft.js'
import type { DraftChat } from '../src/model/draft.js'
import type { ProviderCatalog } from '../src/model/types.js'
import { CONSENT, draft, draftProps, env, NO_CONSENT } from './draftFixture.js'

const html = (c: unknown, props: Record<string, unknown>): string =>
  renderToStaticMarkup(createElement(c as ComponentType<Record<string, unknown>>, props))
const text = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim()
const FULL_FOLDER = { cwd: '/w/acme-api', ok: true, folder: { access: 'full' as const } }
const catalog = (over: Partial<ProviderCatalog['codex']> = {}, at = '2026-11-03T10:00:00Z'): ProviderCatalog => ({
  checkedAt: at,
  claude: { provider: 'claude', state: 'ready', detail: '', models: [] },
  codex: { provider: 'codex', state: 'ready', detail: '', models: [{ id: 'gpt-5.6', label: 'gpt-5.6', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', isDefault: true }], ...over },
  zcode: { provider: 'zcode', state: 'ready', detail: '', models: [] },
})

describe('шаг B: черновик — резолвер на входах (§3.7, §3.8)', () => {
  it('⌘N в папке с запомненным полным доступом и согласием — полный сразу; без согласия — «Спрашивать» и «Включить снова»', () => {
    const ok = createDraft({ cwd: '/w/acme-api' }, env({ consent: CONSENT, folder: FULL_FOLDER }))
    assert.deepEqual([ok.approval, ok.approvalOrigin, ok.notes], ['full', 'folder', []])
    assert.equal(remembersAccess(ok, null), false, 'унаследованное из памяти само не закрепляется')
    const off = createDraft({ cwd: '/w/acme-api' }, env({ folder: FULL_FOLDER }))
    assert.deepEqual([off.approval, off.notes, off.blockedApproval], ['ask', ['full-revoked'], 'full'])
  })
  it('ссылка: полный не включается ни из памяти, ни при согласии; клик «Включить для этого чата» — да, но в память не пишется', () => {
    const link = createDraft({ cwd: '/w/acme-api', origin: { kind: 'link' } }, env({ consent: CONSENT, folder: FULL_FOLDER }))
    assert.deepEqual([link.approval, link.notes], ['ask', ['link-full-blocked']])
    const on = pickApproval(link, 'full', CONSENT.rev)
    assert.equal(on.approval, 'full')
    assert.equal(remembersAccess(on, null), false)
    const p = draftStartParams(on, { prompt: 'x', consentRev: CONSENT.rev, inheritMode: null })
    assert.deepEqual([p['origin'], p['confirm'], p['consentRev'], 'rememberAccess' in p], ['link', true, CONSENT.rev, false])
  })
  it('память пишется только явным выбором и без «Только этот чат»; «Только чтение» — тоже', () => {
    const d = pickApproval(draft(), 'read-only', null)
    assert.equal(draftStartParams(d, { prompt: '', inheritMode: null })['rememberAccess'], true)
    assert.equal('rememberAccess' in draftStartParams({ ...d, chatOnly: true }, { prompt: '', inheritMode: null }), false)
    assert.equal('rememberAccess' in draftStartParams(draft(), { prompt: '', inheritMode: null }), false)
  })
  it('смена папки и провайдера пересчитывает только неявные поля', () => {
    const e = env({ folder: { cwd: '/w/b', ok: true, folder: { access: 'read-only' } } })
    const a = draft('/w/a')
    assert.equal(withDraftFolder(a, '/w/b', e).approval, 'read-only')
    assert.equal(withDraftFolder(pickApproval(a, 'ask', null), '/w/b', e).approval, 'ask')
    const opus = pickModel(a, 'claude', 'opus', env(), null)
    assert.deepEqual([opus.model, opus.picked.model], ['opus', true])
    assert.equal(resolveDraft(opus, env({ settings: { newSession: { rememberLast: false, defaults: { claude: { model: 'haiku' }, codex: {}, zcode: {} } }, lastUsed: {} } })).model, 'opus')
  })
  it('согласие отозвали после явного выбора полного — «Спрашивать» и строка «отозвано»', () => {
    const d = pickApproval(draft(), 'full', CONSENT.rev)
    const after = resolveDraft(d, env({ consent: { ...NO_CONSENT, rev: 5, revokedAt: '2026-11-03T10:00:00Z' } }))
    assert.deepEqual([after.approval, after.notes.includes('full-revoked')], ['ask', true])
  })
})

describe('шаг B: клавиатура (§3.5)', () => {
  const base = { composing: false, repeat: false, busy: false, linkLocked: false, hasFolder: true, hasText: true, blocked: false }
  it('единый submit-guard: IME, автоповтор, отправка в пути, замок ссылки — ничего; без папки — меню папки', () => {
    assert.equal(submitDecision(base), 'send')
    for (const k of ['composing', 'repeat', 'busy', 'linkLocked'] as const) assert.equal(submitDecision({ ...base, [k]: true }), null, k)
    assert.equal(submitDecision({ ...base, hasFolder: false }), 'folder')
    assert.equal(submitDecision({ ...base, hasFolder: false, hasText: false }), 'folder')
    assert.equal(submitDecision({ ...base, hasText: false }), null)
    assert.equal(submitDecision({ ...base, blocked: true }), null)
  })
  it('Esc по порядку: меню → диалог → пустой черновик; с текстом — подтверждение', () => {
    assert.equal(escDecision({ menuOpen: true, dialogOpen: true, empty: true }), 'menu')
    assert.equal(escDecision({ menuOpen: false, dialogOpen: true, empty: true }), 'dialog')
    assert.equal(escDecision({ menuOpen: false, dialogOpen: false, empty: true }), 'discard')
    assert.equal(escDecision({ menuOpen: false, dialogOpen: false, empty: false }), 'confirm')
  })
})

describe('шаг B: готовность провайдера и модели (§4)', () => {
  it('checking / ready / stale / login-required / catalog-error / unavailable; держат отправку только вход и CLI', () => {
    const now = Date.parse('2026-11-03T10:01:00Z')
    assert.equal(readinessOf(null, 'claude', false, now), 'checking')
    assert.equal(readinessOf(catalog(), 'claude', true, now), 'checking')
    assert.equal(readinessOf(catalog(), 'claude', false, now), 'ready')
    assert.equal(readinessOf(catalog({}, '2026-11-03T09:00:00Z'), 'claude', false, now), 'stale')
    assert.equal(readinessOf(catalog({ state: 'login_required' }), 'codex', false, now), 'login-required')
    assert.equal(readinessOf(catalog({ state: 'error' }), 'codex', false, now), 'catalog-error')
    assert.equal(readinessOf(catalog({ state: 'unavailable' }), 'codex', false, now), 'unavailable')
    assert.deepEqual((['checking', 'ready', 'stale', 'catalog-error', 'login-required', 'unavailable'] as const).map(readinessBlocks), [false, false, false, false, true, true])
  })
  it('модели нет в каталоге — ID сохраняется, пометка без автозамены', () => {
    const d = { ...pickModel(draft(), 'codex', null, env(), catalog()), model: 'gpt-5.5' }
    assert.equal(modelUnlisted(d, catalog()), true)
    assert.equal(modelUnlisted({ ...d, model: 'gpt-5.6' }, catalog()), false)
    const out = html(DraftView, draftProps({ draft: d, catalog: catalog() }))
    assert.match(out, /data-testid="draft-model-unlisted"/)
    assert.match(out, /data-model="gpt-5.5"/)
  })
})

describe('шаг B: снимок у демона (§3.2)', () => {
  it('снимок — полный набор полей; восстановление сохраняет выбор, полный — только при том же согласии', () => {
    const d = pickApproval({ ...draft(), text: 'Разберись с импортом' }, 'full', CONSENT.rev)
    const snap = draftSnapshot(d)
    for (const k of ['cwd', 'provider', 'model', 'effort', 'approval', 'browser', 'worktree', 'branch', 'mode', 'text', 'origin', 'picked', 'chatOnly', 'consentRev']) assert.ok(k in snap, k)
    const same = draftFromSnapshot(d.id, 3, JSON.parse(JSON.stringify(snap)), env({ consent: CONSENT }))
    assert.deepEqual([same?.approval, same?.rev, same?.text, same?.restored], ['full', 3, 'Разберись с импортом', true])
    const changed = draftFromSnapshot(d.id, 3, snap, env({ consent: { ...CONSENT, rev: 9 } }))
    assert.deepEqual([changed?.approval, changed?.notes], ['ask', ['full-revoked']], 'consentRev сменился — полный снят')
    assert.equal(draftFromSnapshot(d.id, 1, 'мусор', env()), null)
    const junk = draftFromSnapshot(d.id, 1, { provider: 'bash', approval: 'root', cwd: 'rel', text: 5 }, env())
    assert.deepEqual([junk?.provider, junk?.approval, junk?.cwd, junk?.text], ['claude', 'ask', null, ''])
  })
  it('подпись в сайдбаре: первая строка текста или «Новый чат»', () => {
    assert.equal(draftLabel({ text: '\n  Собери changelog\nвторая' }), 'Собери changelog')
    assert.equal(draftLabel({ text: '   ' }), 'Новый чат')
  })
})

describe('шаг B: вид черновика (кадры 01, 08, 12)', () => {
  it('пустой проектный чат: задача, компактный ввод и выбор проекта в заголовке; отправить нельзя', () => {
    const out = html(DraftView, draftProps())
    const t = text(out)
    assert.match(t, /Новый чат/)
    assert.doesNotMatch(t, /черновик · ещё не заведён/)
    assert.match(t, /Что делаем в acme-api ?\?/)
    for (const id of ['draft-input', 'draft-chip-folder', 'draft-chip-model', 'draft-chip-effort', 'draft-chip-access', 'draft-chip-more']) assert.match(out, new RegExp(`data-testid="${id}"`), id)
    assert.doesNotMatch(out, /draft-esc-hint|draft-hint|<kbd/)
    assert.match(out, /data-testid="draft-send"[^>]*disabled=""/)
    assert.doesNotMatch(out, /draft-chip-preset/, 'чип пресета — шагом C')
  })
  it('с текстом: без постоянных служебных подсказок, отправка доступна', () => {
    const out = html(DraftView, draftProps({ draft: { ...draft(), text: 'Почини импорт' } }))
    assert.doesNotMatch(text(out), /черновик сохранится, если уйти/)
    assert.doesNotMatch(out, /data-testid="draft-send"[^>]*disabled=""/)
  })
  it('без проекта: можно начать разговор без выбора папки, а проекты доступны в меню заголовка', () => {
    const recent = [{ path: '/w/docs-site', at: '2026-11-02T10:00:00Z', source: 'codex' as const }]
    const out = html(DraftView, draftProps({ draft: draft(null), recent }))
    assert.match(text(out), /О чём поговорим\?/)
    assert.match(text(out), /Без проекта/)
    assert.doesNotMatch(out, /draft-recent-folder|draft-pick-folder|draft-hint|<kbd/)
    assert.doesNotMatch(out, /Выбери папку|папку выберешь до отправки/)
    const menu = html(DraftView, draftProps({ draft: draft(null), recent, initialMenu: 'folder' }))
    assert.match(menu, /data-testid="draft-folder-general"/)
    assert.match(menu, /data-value="\/w\/docs-site"/)
    assert.match(text(menu), /Другая папка…/)
  })
  it('из ссылки: плашка, строка «Включить для этого чата», чужая папка — пометка', () => {
    const link = createDraft({ cwd: '/w/acme-api', origin: { kind: 'link' }, text: 'Собери changelog' }, env({ consent: CONSENT, folder: FULL_FOLDER }))
    const out = html(DraftView, draftProps({ draft: link, env: env({ consent: CONSENT, folder: FULL_FOLDER }) }))
    assert.match(out, /data-testid="draft-from-link"/)
    assert.match(text(out), /Для acme-api запомнен полный доступ, но черновик из ссылки его не включает\. Включить для этого чата/)
    assert.match(out, /data-testid="draft-send"[^>]*disabled=""/, 'первую секунду отправка заперта')
    const rejected = html(DraftView, draftProps({ draft: createDraft({ cwd: null, origin: { kind: 'link', pathRejected: true } }, env()) }))
    assert.match(rejected, /data-testid="draft-link-path-rejected"/)
  })
  it('полный доступ — красная рамка и чип; вход не выполнен — отправка выключена с причиной и «Проверить»', () => {
    const full = html(DraftView, draftProps({ draft: { ...pickApproval(draft(), 'full', 4), text: 'x' }, env: env({ consent: CONSENT }) }))
    assert.match(full, /class="draft-box full"/)
    assert.match(full, /class="dchip danger"[^>]*data-testid="draft-chip-access"/)
    const codex = { ...pickModel(draft(), 'codex', null, env(), null), text: 'x' }
    const login = html(DraftView, draftProps({ draft: codex, catalog: catalog({ state: 'login_required', fixCmd: 'codex login' }) }))
    assert.match(text(login), /Codex: не выполнен вход — codex login · Проверить/)
    assert.match(login, /data-testid="draft-send"[^>]*disabled=""/)
  })
  it('меню у чипа: модели по провайдерам со статусом входа, усилие, «⋯» — ветка', () => {
    const model = html(DraftView, draftProps({ catalog: catalog(), initialMenu: 'model' }))
    assert.match(model, /data-testid="draft-menu-model"/)
    assert.match(text(model), /Claude ● вход выполнен haiku быстрая, для мелочей/)
    assert.match(model, /data-value="codex:gpt-5.6"/)
    assert.match(html(DraftView, draftProps({ initialMenu: 'effort' })), /data-value="xhigh"/)
    const more = html(DraftView, draftProps({ draft: { ...draft(), worktree: true }, initialMenu: 'more' }))
    assert.match(more, /data-testid="draft-branch"/)
    assert.match(more, /placeholder="pult\/&lt;имя чата&gt;"/)
  })
  it('сайдбар: строка черновика курсивом с «черновик» и папкой', () => {
    const out = html(ProjectTree, {
      groups: [], selected: null, now: 0, collapsed: new Set(), onSelect: () => {}, onNew: () => {}, onToggle: () => {}, onAddProject: () => {}, onPin: () => {},
      drafts: [{ ...draft(), text: 'Почини импорт заказов' }, draft(null)], activeDraft: draft().id,
    })
    assert.match(out, /data-testid="draft-row"/)
    assert.match(text(out), /Почини импорт заказов черновик ⋯ acme-api/)
    assert.match(text(out), /Новый чат черновик ⋯ Без проекта/)
  })
})

describe('ревью шага B: окно', () => {
  const stamp = { key: '/w/acme-api', dev: '1', ino: '2' }
  const info = (over: Record<string, unknown> = {}) => ({ cwd: '/w/acme-api', ok: true, folder: { ...stamp, access: 'full' as const }, ...over })
  it('«как в настройках Claude» — режим ПАПКИ: bypass в проекте — чип красный, ссылка его не включает (M4, Codex 1)', () => {
    const e = env({ consent: CONSENT, inheritMode: 'bypassPermissions', folder: { cwd: '/w/acme-api', ok: true, folder: { access: 'inherit' } } })
    const user = createDraft({ cwd: '/w/acme-api' }, e)
    assert.equal(user.approval, 'inherit')
    const out = html(DraftView, draftProps({ draft: user, env: e }))
    assert.match(out, /class="dchip danger"[^>]*data-testid="draft-chip-access"/)
    assert.match(text(out), /Настройки Claude · bypassPermissions/)
    const link = createDraft({ cwd: '/w/acme-api', origin: { kind: 'link' } }, e)
    assert.deepEqual([link.approval, link.notes], ['ask', ['link-full-blocked']])
    assert.equal('approvalOrigin' in draftStartParams(link, { prompt: '', inheritMode: 'bypassPermissions' }), false)
    assert.equal(draftStartParams(pickApproval(link, 'inherit', CONSENT.rev), { prompt: '', inheritMode: 'bypassPermissions' })['approvalOrigin'], 'explicit')
  })
  it('восстановленный черновик: папку заменили — доступ пересчитан и отправка остановлена; та же папка — снимок как был (Codex 2)', () => {
    const e = env({ consent: CONSENT, folder: info() })
    const d = createDraft({ cwd: '/w/acme-api' }, e)
    assert.deepEqual([d.approval, d.folder], ['full', stamp])
    const snap = draftFromSnapshot(d.id, 2, JSON.parse(JSON.stringify(draftSnapshot(d))), e)!
    assert.deepEqual(snap.folder, stamp)
    assert.deepEqual(refreshBeforeStart(snap, e).changed, false)
    const swapped = env({ consent: CONSENT, folder: { cwd: '/w/acme-api', ok: true, folder: { key: '/w/acme-api', dev: '1', ino: '9' } } })
    const r = refreshBeforeStart(snap, swapped)
    assert.deepEqual([r.changed, r.draft.approval], [true, 'workspace'], 'новая папка без памяти — «Правки в папке», не унаследованный полный')
    assert.deepEqual(draftStartParams(d, { prompt: '', inheritMode: null })['folder'], stamp, 'демон сверит идентичность')
  })
  it('отправка быстрее памяти папки — пересчёт перед стартом (m3)', () => {
    const early = createDraft({ cwd: '/w/acme-api' }, env())
    assert.equal(early.approval, 'workspace')
    const r = refreshBeforeStart(early, env({ folder: { cwd: '/w/acme-api', ok: true, folder: { ...stamp, access: 'read-only' } } }))
    assert.deepEqual([r.changed, r.draft.approval], [true, 'read-only'])
  })
  it('согласие отозвали и дали снова (другой номер) — явный полный снимается; на старт — номер выбора (m2, Codex 3)', () => {
    const d = pickApproval(draft(), 'full', 4)
    assert.equal(draftStartParams(d, { prompt: '', consentRev: 6, inheritMode: null })['consentRev'], 4)
    const after = resolveDraft(d, env({ consent: { ...CONSENT, rev: 6 } }))
    assert.deepEqual([after.approval, after.notes.includes('full-revoked')], ['ask', true])
  })
  it('восстановленный снимок с опущенным полным в память не пишет (m1)', () => {
    const d = pickApproval(draft(), 'full', 4)
    const r = draftFromSnapshot(d.id, 1, draftSnapshot(d), env({ consent: NO_CONSENT }))!
    assert.deepEqual([r.approval, r.approvalOrigin, remembersAccess(r, null)], ['ask', 'default', false])
  })
  it('черновик с одними вложениями — не пустой; вложения и текст ссылки — в снимке', () => {
    const att = { path: '/h/attachments/draft-x/a.txt', name: 'a.txt', bytes: 1, mime: 'text/plain', kind: 'file' as const }
    const d = { ...draft(), attachments: [att] }
    assert.equal(draftEmpty(d), false)
    const back = draftFromSnapshot(d.id, 1, JSON.parse(JSON.stringify(draftSnapshot(d))), env())!
    assert.deepEqual(back.attachments, [att])
  })
  it('ссылка: счётчик строк и знаков, пока текст не трогали; полный путь в шапке (M5)', () => {
    const link = createDraft({ cwd: '/Users/user/src/very/long/path/to/acme-api', origin: { kind: 'link' }, text: 'раз\nдва\nтри' }, env())
    assert.deepEqual(linkPromptStats(link), { lines: 3, chars: 11 })
    assert.equal(linkPromptStats({ ...link, text: 'раз' }), null)
    const out = html(DraftView, draftProps({ draft: link }))
    assert.match(text(out), /Текст из ссылки: 3 строки · 11 знаков/)
    assert.match(out, /\/Users\/user\/src\/very\/long\/path\/to\/acme-api<\/div>/)
  })
  it('чип доступа — коротко; меню говорит правду о памяти (Codex 13, 14)', () => {
    assert.deepEqual((['read-only', 'ask', 'workspace', 'full'] as const).map((a) => accessChipLabel({ approval: a }, null)), ['Только чтение', 'Спрашивать', 'Правки в папке', 'Полный доступ'])
    const menu = (d: DraftChat): string => text(html(DraftView, draftProps({ draft: d, initialMenu: 'access' })))
    assert.match(menu(draft()), /Сейчас — по умолчанию; выбор здесь запомню для acme-api/)
    assert.match(menu(pickApproval(draft(), 'read-only', null)), /Запишу для acme-api при отправке/)
    assert.match(menu({ ...pickApproval(draft(), 'read-only', null), chatOnly: true }), /Только этот чат — память папки не трогаю/)
    const link = pickApproval(createDraft({ cwd: '/w/acme-api', origin: { kind: 'link' } }, env({ consent: CONSENT })), 'full', 4)
    assert.match(text(html(DraftView, draftProps({ draft: link, env: env({ consent: CONSENT }), initialMenu: 'access' }))), /Полный из ссылки — только этому чату, в память не пишу/)
  })
  it('сбой с расхождением: «Вернуть мой текст», «Оставить копию»', () => {
    const out = html(DraftView, draftProps({ error: { text: 'x', retry: false, restoreText: 'мой', fork: true } }))
    assert.match(out, /data-testid="draft-restore-text"/)
    assert.match(out, /data-testid="draft-fork"/)
  })
})

describe('перепроверка Codex: окно', () => {
  const stamp = { key: '/w/acme-api', dev: '1', ino: '2' }
  it('явный полный после подмены папки не переносится: доступ пересчитан, отправка остановлена (recheck 2)', () => {
    const e = env({ consent: CONSENT, folder: { cwd: '/w/acme-api', ok: true, folder: { ...stamp } } })
    const d = pickApproval(createDraft({ cwd: '/w/acme-api' }, e), 'full', CONSENT.rev)
    const snap = draftFromSnapshot(d.id, 1, JSON.parse(JSON.stringify(draftSnapshot(d))), e)!
    assert.equal(snap.approval, 'full')
    const swapped = env({ consent: CONSENT, folder: { cwd: '/w/acme-api', ok: true, folder: { ...stamp, ino: '9' } } })
    const r = refreshBeforeStart(snap, swapped)
    assert.deepEqual([r.changed, r.draft.approval, r.draft.picked.approval], [true, 'workspace', undefined])
  })
  it('унаследованный полный из памяти папки при новом номере согласия — «Спрашивать»; на старт — номер разрешения черновика (recheck 3)', () => {
    const folder = { cwd: '/w/acme-api', ok: true, folder: { ...stamp, access: 'full' as const } }
    const d = createDraft({ cwd: '/w/acme-api' }, env({ consent: CONSENT, folder }))
    assert.deepEqual([d.approval, d.approvalOrigin, d.consentRev], ['full', 'folder', CONSENT.rev])
    assert.equal(draftStartParams(d, { prompt: '', consentRev: 6, inheritMode: null })['consentRev'], CONSENT.rev, 'не текущий номер окна')
    const after = resolveDraft(d, env({ consent: { ...CONSENT, rev: 6 }, folder }))
    assert.deepEqual([after.approval, after.notes.includes('full-revoked')], ['ask', true])
  })
  it('черновик уже заведён с другими настройками: «Открыть чат» и «Завести новый»', () => {
    const out = html(DraftView, draftProps({ error: { text: 'x', retry: false, fork: true, openChat: 'acme-api' } }))
    assert.match(out, /data-testid="draft-open-chat"/)
    assert.match(text(out), /Открыть чат · Завести новый/)
  })
})

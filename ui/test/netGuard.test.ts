// 0.3.6 в окне: «Настройки» → «Страж сети» — имена стран, поиск, чипы, черновик правила, выходы провайдеров под
// черновиком и предупреждение «сейчас ходы не пойдут», «Сохранить» недоступна для пустого allow.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SettingsDialog } from '../src/components/Settings.js'
import {
  addCountry, canCheckNet, countryLabel, exitRows, guardDraftError, guardFromExits, NET_CHECK_COOLDOWN_MS, refusedWarning, removeCountry, searchCountries,
  switchGuardMode,
} from '../src/model/netGuard.js'
import type { GuardRule } from '../src/model/netGuard.js'
import type { GuardCheck } from '../src/model/health.js'
import { netBlockedText } from '../src/model/conversation.js'
import { settingsParams } from '../src/model/sessionSettings.js'

const html = (c: unknown, props: Record<string, unknown>): string =>
  renderToStaticMarkup(createElement(c as ComponentType<Record<string, unknown>>, props))
const text = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/\s+/g, ' ').trim()
const noop = (): void => {}
const NS = { rememberLast: true, defaults: { claude: {}, codex: {} } }
const check = (provider: string, loc: string | null, at = '2026-10-26T10:00:00Z', reason = 'ok'): GuardCheck => ({ provider, loc, ok: reason === 'ok', reason, checkedAt: at })

describe('страж сети: страны', () => {
  it('имя по-русски с кодом; кода без имени — сам код', () => {
    assert.equal(countryLabel('DE'), 'Германия (DE)')
    assert.equal(countryLabel('BY'), 'Беларусь (BY)')
    assert.equal(countryLabel('XX'), 'XX')
  })

  it('поиск: по началу имени, по слову имени, по коду, «ё» = «е»; выбранные не предлагаются', () => {
    assert.equal(searchCountries('герм', [])[0], 'DE')
    assert.equal(searchCountries('ГЕРМ', [])[0], 'DE')
    assert.equal(searchCountries('de', [])[0], 'DE', 'точный код — первым')
    assert.ok(searchCountries('штаты', []).includes('US'), 'слово внутри имени')
    assert.ok(searchCountries('фин', []).includes('FI'))
    assert.ok(!searchCountries('герм', ['DE']).includes('DE'))
    assert.deepEqual(searchCountries('нет-такой-страны', []), [])
    assert.equal(searchCountries('', [], 5).length, 5)
    assert.ok(searchCountries('кот-д', []).includes('CI'))
  })

  it('чипы: добавить (без повтора), убрать', () => {
    let r: GuardRule = { mode: 'deny', countries: ['RU'] }
    r = addCountry(r, 'BY')
    r = addCountry(r, 'BY')
    assert.deepEqual(r, { mode: 'deny', countries: ['RU', 'BY'] })
    r = removeCountry(r, 'RU')
    assert.deepEqual(r, { mode: 'deny', countries: ['BY'] })
  })

  it('смена режима: список не переезжает — у каждого режима свой, возврат восстанавливает прежний', () => {
    const deny: GuardRule = { mode: 'deny', countries: ['RU', 'BY'] }
    const a = switchGuardMode(deny, 'allow', {})
    assert.deepEqual(a.rule, { mode: 'allow', countries: [] }, 'запретительный список — не разрешающий')
    const b = switchGuardMode(addCountry(a.rule, 'DE'), 'deny', a.stash)
    assert.deepEqual(b.rule, deny)
    assert.deepEqual(switchGuardMode(b.rule, 'allow', b.stash).rule, { mode: 'allow', countries: ['DE'] })
    assert.equal(switchGuardMode(deny, 'deny', {}).rule, deny)
  })

  it('черновик: allow без стран — ошибка; deny без стран и allow со страной — можно', () => {
    assert.match(guardDraftError({ mode: 'allow', countries: [] }) ?? '', /хотя бы одна страна/)
    assert.equal(guardDraftError({ mode: 'deny', countries: [] }), null)
    assert.equal(guardDraftError({ mode: 'allow', countries: ['DE'] }), null)
    assert.match(guardDraftError({ mode: 'allow', countries: ['ZZ'] }) ?? '', /ZZ/)
  })
})

describe('страж сети: выходы под черновиком правила', () => {
  it('свежайшая проверка на провайдера; проходит / не проходит по черновику; не проверялся; неизвестен', () => {
    const checks = [check('claude', 'RU', '2026-10-26T09:00:00Z'), check('claude', 'DE', '2026-10-26T10:00:00Z'), check('opencode', null, '2026-10-26T10:00:00Z', 'proxy_dead')]
    const rows = exitRows({ mode: 'allow', countries: ['DE'] }, checks)
    assert.deepEqual(rows.map((r) => [r.provider, r.ok]), [['claude', true], ['codex', null], ['opencode', false]])
    assert.equal(rows[0]!.text, 'claude: выход Германия (DE) — проходит')
    assert.equal(rows[1]!.text, 'codex: выход не проверялся')
    assert.equal(rows[2]!.text, 'opencode: выход неизвестен (прокси не отвечает) — не проходит')
    assert.equal(refusedWarning(rows), null, 'неизвестный выход — не про правило')
    const denyDe = exitRows({ mode: 'deny', countries: ['DE'] }, checks)
    assert.equal(denyDe[0]!.text, 'claude: выход Германия (DE) — не проходит')
    assert.equal(refusedWarning(denyDe), 'С этими правилами сейчас ходы не пойдут: claude (выход DE)')
  })

  it('выходы из settings.get → проверки стража', () => {
    assert.deepEqual(guardFromExits({ claude: { loc: 'FI', path: 'direct', reason: 'ok', checkedAt: '2026-10-26T10:00:00Z' }, codex: undefined }), [check('claude', 'FI')])
    assert.deepEqual(guardFromExits(undefined), [])
  })

  it('«Проверить сеть» — не во время проверки и не чаще паузы', () => {
    assert.equal(canCheckNet(false, 0, 1000), true)
    assert.equal(canCheckNet(true, 0, 1000), false)
    assert.equal(canCheckNet(false, 1000 + NET_CHECK_COOLDOWN_MS, 1000), false)
    assert.ok(NET_CHECK_COOLDOWN_MS >= 10_000)
  })

  it('параметры settings.set: правило — только когда передано', () => {
    assert.deepEqual(settingsParams(NS), { newSession: NS })
    assert.deepEqual(settingsParams(NS, undefined, { mode: 'allow', countries: ['DE'] }), { newSession: NS, network: { guard: { mode: 'allow', countries: ['DE'] } } })
  })

  it('отказ хода в ленте: режим allow — «страны выхода нет в списке разрешённых», список — «разрешены»', () => {
    const t = netBlockedText({ reason: 'not_allowed_country', loc: 'US', guard: ['DE', 'FI'], guardMode: 'allow' })
    assert.match(t.title, /страны выхода нет в списке разрешённых/)
    assert.match(t.text, /выход: US · разрешены: DE, FI/)
    assert.match(t.text, /Страж сети/)
  })
})

describe('страж сети: экран «Настройки»', () => {
  const panel = (rule: GuardRule, checks: GuardCheck[] = []): Record<string, unknown> => ({ rule, checks, checking: false, onCheck: noop })

  it('режим, чипы с «×», поиск, выходы, «Проверить сеть»; без раздела у старого демона', () => {
    const out = html(SettingsDialog, { settings: NS, catalog: null, onSave: async () => null, onClose: noop, netGuard: panel({ mode: 'deny', countries: ['RU', 'BY'] }, [check('claude', 'DE')]) })
    const t = text(out)
    assert.match(out, /data-testid="settings-net-guard"/)
    assert.match(out, /data-testid="guard-mode-deny"[^>]*checked=""/)
    assert.doesNotMatch(out, /data-testid="guard-mode-allow"[^>]*checked/)
    assert.match(t, /Запрещать страны из списка/)
    assert.match(t, /Разрешать только страны из списка/)
    assert.match(out, /data-testid="guard-chip" data-code="RU"/)
    assert.match(out, /aria-label="Убрать Беларусь \(BY\)"/)
    assert.match(out, /data-testid="guard-search"/)
    assert.match(t, /claude: выход Германия \(DE\) — проходит/)
    assert.match(t, /codex: выход не проверялся/)
    assert.match(out, /data-testid="guard-check"/)
    assert.doesNotMatch(out, /data-testid="guard-warning"/)
    assert.doesNotMatch(out, /data-testid="settings-save" disabled/)
    const old = html(SettingsDialog, { settings: NS, catalog: null, onSave: async () => null, onClose: noop })
    assert.doesNotMatch(old, /settings-net-guard/)
  })

  it('текущий выход не пройдёт по правилу — предупреждение до сохранения; сохранять можно', () => {
    const out = html(SettingsDialog, { settings: NS, catalog: null, onSave: async () => null, onClose: noop, netGuard: panel({ mode: 'allow', countries: ['FI'] }, [check('claude', 'DE')]) })
    assert.match(out, /data-testid="guard-warning"/)
    assert.match(text(out), /С этими правилами сейчас ходы не пойдут: claude \(выход DE\)/)
    assert.doesNotMatch(out, /data-testid="settings-save" disabled/)
  })

  it('allow без стран — «Сохранить» недоступна, причина в подвале', () => {
    const out = html(SettingsDialog, { settings: NS, catalog: null, onSave: async () => null, onClose: noop, netGuard: panel({ mode: 'allow', countries: [] }) })
    assert.match(out, /disabled="" data-testid="settings-save"|data-testid="settings-save"[^>]*disabled/)
    assert.match(text(out), /хотя бы одна страна/)
    assert.match(out, /data-testid="guard-empty"/)
    assert.match(out, /data-testid="guard-closed"/, 'сохранённое правило закрыто — раздел объясняет')
    assert.match(text(out), /Сейчас все ходы запрещены/)
    const open = html(SettingsDialog, { settings: NS, catalog: null, onSave: async () => null, onClose: noop, netGuard: panel({ mode: 'allow', countries: ['DE'] }) })
    assert.doesNotMatch(open, /guard-closed/)
  })
})

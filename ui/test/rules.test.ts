// План 16, № 11 в окне: «Настройки» → «Правила „Всегда“» — правила Codex с меткой Пульта, дата, сессия, «Отозвать».

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RulesSection, SettingsDialog } from '../src/components/Settings.js'
import { revokeParams, ruleDate, ruleMeta, ruleTitle, unmarkedNote } from '../src/model/rules.js'
import type { CodexRule, CodexRulesList } from '../src/model/rules.js'

const html = (c: unknown, props: Record<string, unknown>): string =>
  renderToStaticMarkup(createElement(c as ComponentType<Record<string, unknown>>, props))
const text = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/\s+/g, ' ').trim()

const AT = new Date(2026, 9, 29, 13, 5).toISOString()
const EXEC: CodexRule = { id: 'r-0a1b2c3d', at: AT, session: 'w', cwd: '/srv/p', kind: 'execpolicy', label: 'git push' }
const NET: CodexRule = { id: 'r-11112222', at: AT, session: 'gone', kind: 'network', label: 'api.example.com' }
const LIST: CodexRulesList = { path: '/h/.codex/rules/default.rules', exists: true, rules: [EXEC, NET], unmarked: 3 }

describe('правила «Всегда»: модель', () => {
  it('заголовок — словами кнопки карточки', () => {
    assert.equal(ruleTitle(EXEC), 'Команды, начинающиеся с «git push»')
    assert.equal(ruleTitle(NET), 'Пускать в сеть к api.example.com')
  })
  it('дата по машине; кривое время — как есть', () => {
    assert.equal(ruleDate(AT), '29.10.2026 13:05')
    assert.equal(ruleDate('вчера'), 'вчера')
  })
  it('сессия-источник: название, «удалена» или имя как есть', () => {
    const label = (n: string): string | null => (n === 'w' ? '«Починка» (w)' : null)
    assert.equal(ruleMeta(EXEC, label), '29.10.2026 13:05 · сессия «Починка» (w) · /srv/p')
    assert.equal(ruleMeta(NET, label), '29.10.2026 13:05 · сессия gone (удалена)')
    assert.equal(ruleMeta(NET), '29.10.2026 13:05 · сессия gone')
  })
  it('строки без метки — счётчиком с честным «не трогает», склонение', () => {
    assert.equal(unmarkedNote(0), null)
    assert.match(unmarkedNote(1) ?? '', /^Ещё 1 строка правил/)
    assert.match(unmarkedNote(3) ?? '', /^Ещё 3 строки .*не показывает и не отзывает/)
    assert.match(unmarkedNote(11) ?? '', /^Ещё 11 строк /)
    assert.match(unmarkedNote(97) ?? '', /^Ещё 97 строк /)
  })
  it('«Отозвать» — settings.set {codexRules: {revoke}}', () => {
    assert.deepEqual(revokeParams('r-1'), { codexRules: { revoke: 'r-1' } })
  })
})

describe('правила «Всегда»: раздел «Настроек»', () => {
  it('строка на правило с кнопкой «Отозвать», путь файла, счётчик без метки', () => {
    const out = html(RulesSection, { panel: { list: LIST, onRevoke: async () => ({ ok: '' }) } })
    assert.equal((out.match(/data-testid="rule-row"/g) ?? []).length, 2)
    assert.match(out, /data-testid="rule-revoke-r-0a1b2c3d"/)
    const t = text(out)
    assert.match(t, /Правила «Всегда»/)
    assert.match(t, /\/h\/\.codex\/rules\/default\.rules/)
    assert.match(t, /Команды, начинающиеся с «git push» 29\.10\.2026 13:05 · сессия w · \/srv\/p Отозвать/)
    assert.match(t, /Codex читает правила только при запуске, поэтому после отзыва Пульт перезапускает свой Codex: сразу, если он свободен, иначе — когда закончатся ходы, фон и вопросы/)
    assert.match(t, /разрешения «в этой сессии» у всех сессий Codex сбрасываются/)
    assert.match(t, /Codex, запущенный вне Пульта \(терминал, IDE\), держит правило до своего перезапуска/)
    assert.doesNotMatch(t, /могут помнить/)
    assert.match(t, /Ещё 3 строки/)
  })
  it('пусто — так и сказано; ошибка чтения — красной строкой', () => {
    const empty = text(html(RulesSection, { panel: { list: { ...LIST, rules: [], unmarked: 0 }, onRevoke: async () => ({ ok: '' }) } }))
    assert.match(empty, /Пульт ещё не записал ни одного правила/)
    assert.doesNotMatch(empty, /без метки/)
    const bad = html(RulesSection, { panel: { list: { ...LIST, rules: [], error: 'EACCES' }, onRevoke: async () => ({ ok: '' }) } })
    assert.match(bad, /data-testid="rules-read-error"/)
  })
  it('осталась копия прерванной записи — предупреждение с путём', () => {
    const out = html(RulesSection, { panel: { list: { ...LIST, backup: '/h/.codex/rules/default.rules.pult.bak' }, onRevoke: async () => ({ ok: '' }) } })
    assert.match(out, /data-testid="rules-backup"/)
    assert.match(text(out), /default\.rules\.pult\.bak — до её удаления Пульт файл не правит\. Если файл правил пуст или обрезан — mv \/h\/\.codex\/rules\/default\.rules\.pult\.bak \/h\/\.codex\/rules\/default\.rules\s*, затем проверь последние строки/)
  })
  it('в диалоге — только когда демон отдаёт правила', () => {
    const base = { settings: null, catalog: null, onSave: async () => null, onClose: () => {} }
    assert.doesNotMatch(html(SettingsDialog, base), /settings-rules/)
    assert.match(html(SettingsDialog, { ...base, rules: { list: LIST, onRevoke: async () => ({ ok: '' }) } }), /data-testid="settings-rules"/)
  })
})

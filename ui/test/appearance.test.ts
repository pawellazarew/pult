import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setLanguage } from '../../src/i18n/core.js'
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, appearanceVariables, effectiveTheme, normalizeAppearance, readAppearance } from '../src/model/appearance.js'
import { setAppearance } from '../src/useAppearance.js'
import { AppearanceSection, FilesStorageSection, SettingsDialog, UsageSection } from '../src/components/Settings.js'

const noop = (): void => {}
const html = (component: unknown, props: Record<string, unknown>): string => renderToStaticMarkup(createElement(component as ComponentType<Record<string, unknown>>, props))
const now = Date.parse('2026-11-05T12:00:00Z')

describe('per-device appearance', () => {
  it('recovers safely from malformed and old preferences without accepting arbitrary CSS values', () => {
    for (const raw of [null, '', '{', 'null', '17', '[]', '"dark"']) assert.deepEqual(readAppearance(raw), DEFAULT_APPEARANCE)
    assert.deepEqual(readAppearance(JSON.stringify({ mode: 'focus', theme: 'dark', uiFont: 'url(secret)', codeFont: 'unknown', fontSize: 800, density: 'compact' })), {
      ...DEFAULT_APPEARANCE, mode: 'focus', theme: 'dark', density: 'compact',
    })
    assert.deepEqual(readAppearance(JSON.stringify({ mode: 'expanded', theme: 'light', uiFont: 'system', codeFont: 'menlo', fontSize: 18, density: 'compact' })), {
      mode: 'expanded', theme: 'light', uiFont: 'system', codeFont: 'menlo', fontSize: 18, density: 'compact',
    })
    assert.equal(normalizeAppearance({ fontSize: 13.5 }).fontSize, DEFAULT_APPEARANCE.fontSize)
  })
  it('explicit theme overrides the system and system preference follows both appearances', () => {
    assert.equal(effectiveTheme('light', true), 'light')
    assert.equal(effectiveTheme('dark', false), 'dark')
    assert.equal(effectiveTheme('system', true), 'dark')
    assert.equal(effectiveTheme('system', false), 'light')
  })
  it('restores persisted choices before a patch and continues working when storage fails', () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const data = new Map<string, string>([[APPEARANCE_KEY, JSON.stringify({ mode: 'expanded', codeFont: 'menlo', uiFont: 'bad' })]])
    let fail = false
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { if (fail) throw new Error('storage unavailable'); data.set(key, value) },
    } } })
    try {
      setAppearance({ theme: 'dark' })
      assert.deepEqual(JSON.parse(data.get(APPEARANCE_KEY)!), { ...DEFAULT_APPEARANCE, mode: 'expanded', codeFont: 'menlo', theme: 'dark' })
      fail = true
      assert.doesNotThrow(() => setAppearance({ mode: 'focus', fontSize: 18 }))
      fail = false
      setAppearance({ density: 'compact' })
      const saved = JSON.parse(data.get(APPEARANCE_KEY)!)
      assert.equal(saved.mode, 'focus'); assert.equal(saved.fontSize, 18); assert.equal(saved.density, 'compact')
    } finally {
      if (previous) Object.defineProperty(globalThis, 'window', previous)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  })
  it('produces local font stacks and scalable presentation variables', () => {
    const vars = appearanceVariables({ ...DEFAULT_APPEARANCE, uiFont: 'system', codeFont: 'menlo', fontSize: 18, density: 'compact' })
    assert.match(vars['--body'], /-apple-system/)
    assert.match(vars['--mono'], /^Menlo/)
    assert.equal(vars['--ui-font-size'], '18px')
    assert.equal(vars['--density-space'], '.8')
    assert.equal(Object.keys(vars).some((key) => /permission|sandbox|model/.test(key)), false)
  })
  it('renders all three modes as native, labelled radio controls and keeps the default visible', () => {
    const view = html(AppearanceSection, { value: DEFAULT_APPEARANCE, onChange: noop })
    assert.match(view, /role="radiogroup"/)
    assert.equal((view.match(/type="radio"/g) ?? []).length, 3)
    assert.match(view, /<input(?=[^>]*checked="")(?=[^>]*data-testid="appearance-mode-normal")[^>]*>/)
    assert.match(view, /appearance-ui-font/); assert.match(view, /appearance-code-font/)
    assert.match(view, /По умолчанию/)
  })
})

describe('usage and attachment storage settings', () => {
  it('shows no fabricated zeros for missing usage and clears percentages from expired windows', () => {
    const empty = html(UsageSection, { now })
    assert.equal((empty.match(/Провайдер ещё не передал лимиты/g) ?? []).length, 3)
    assert.doesNotMatch(empty, /Использовано: 0%|aria-valuenow="0"/)
    const view = html(UsageSection, { now, usage: { codex: {
      fiveHour: { utilization: .42, resetsAt: now / 1000 + 3600 },
      sevenDay: { utilization: .9, resetsAt: now / 1000 - 1 },
      updatedAt: 'not-a-date', status: 'allowed', resetsAt: null, eventId: 1,
    } } })
    assert.match(view, /Использовано: 42%/)
    assert.doesNotMatch(view, /Использовано: 90%/)
    assert.match(view, /aria-valuenow="42"/)
    assert.match(view, /Нет свежих данных/)
    assert.doesNotMatch(view, /Данные на/)
  })
  it('supports forever and keeps unsupported storage settings disabled', () => {
    const forever = html(FilesStorageSection, { retentionDays: null, onRetentionChange: noop })
    assert.match(forever, /value="forever" selected=""/)
    assert.doesNotMatch(forever, /data-testid="settings-retention" disabled/)
    const old = html(FilesStorageSection, {})
    assert.match(old, /data-testid="settings-retention" disabled/)
    assert.match(old, /Обнови Пульт/)
  })
  it('translates the new appearance, usage and storage controls to English', () => {
    setLanguage('en')
    try {
      for (const view of [html(AppearanceSection, { value: DEFAULT_APPEARANCE, onChange: noop }), html(UsageSection, { now }), html(FilesStorageSection, { retentionDays: 30, onRetentionChange: noop })]) assert.doesNotMatch(view, /[А-Яа-яЁё]/)
    } finally { setLanguage('ru') }
  })
  it('keeps the existing settings API compatible and exposes dedicated sections', () => {
    const view = html(SettingsDialog, { settings: null, catalog: null, onSave: async () => null, onClose: noop })
    for (const section of ['appearance', 'usage', 'storage', 'general', 'sessions']) assert.match(view, new RegExp(`settings-nav-${section}`))
    assert.match(view, /data-settings-active="true" data-testid="settings-nav-appearance"/)
    assert.doesNotMatch(view, /К работе<kbd/)
  })
})

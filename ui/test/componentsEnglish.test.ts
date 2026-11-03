import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { setLanguage } from '../../src/i18n/core.js'

// Match application startup: locale is selected before modules with localized constants load.
setLanguage('en')
const { SettingsDialog } = await import('../src/components/Settings.js')
const { Inbox } = await import('../src/components/Panels.js')
const { DraftView } = await import('../src/components/Draft.js')
const { draftProps } = await import('./draftFixture.js')
const { Conversation } = await import('../src/components/Conversation.js')
const { PermCard } = await import('../src/components/PermCard.js')
const { ProjectTree } = await import('../src/components/ProjectTree.js')
const { groupByProject } = await import('../src/model/projects.js')
const { foldConversation } = await import('../src/model/conversation.js')
const { ConsentDialog, AccessSection } = await import('../src/components/Access.js')
const { runtimeSetupLabel } = await import('../src/components/RuntimePanel.js')

const html = (component: unknown, props: Record<string, unknown>): string =>
  renderToStaticMarkup(createElement(component as ComponentType<Record<string, unknown>>, props))
const noop = (): void => {}
const now = Date.parse('2026-10-30T10:00:00Z')
const agent = { name: 'example', provider: 'claude' as const, status: 'idle' as const, cwd: '/srv/project', pending: 0, lastActivity: '2026-10-30T10:00:00Z' }
const conversationProps = { agent, items: [], now, focusedPerm: null, permBusy: new Set(), sendError: null, sending: false,
  onSend: async () => true, onRename: async () => true, onStop: noop, onRemove: noop, onReveal: noop, onApprove: noop, onDeny: noop, onFocusPerm: noop }

describe('English application screens', () => {
  it('settings and new-session forms have English labels and safety explanations', () => {
    const settings = html(SettingsDialog, { settings: null, catalog: null, language: 'en', languageSupported: true, onSave: async () => null, onClose: noop })
    assert.match(settings, />Settings</)
    const overridden = html(SettingsDialog, { settings: null, catalog: null, language: 'en', languageSupported: true, languageOverride: 'ru', onSave: async () => null, onClose: noop })
    assert.match(overridden, /Language is set by PULT_LANG=ru/)
    assert.match(overridden, /id="settings-language"[^>]*disabled/)
    assert.match(settings, /Language/)
    assert.match(settings, />System default</)
    assert.match(settings, /value="en" selected=""/)
    assert.match(settings, /Full access cannot be a default/)
    assert.match(settings, /New chat \(⌘N\) starts with these defaults/)
    assert.match(settings, />Save /)
    // Language names are intentionally displayed in their native language.
    assert.doesNotMatch(settings.replace('Русский', ''), /[А-Яа-яЁё]/)

    for (const menu of [null, 'folder', 'model', 'effort', 'access', 'more'] as const) {
      const create = html(DraftView, draftProps({ initialMenu: menu }))
      assert.match(create, /New chat/)
      assert.doesNotMatch(create, /[А-Яа-яЁё]/, `menu ${menu}`)
    }
    const access = html(DraftView, draftProps({ initialMenu: 'access' }))
    assert.match(access, /Full access/)
    assert.match(access, /This chat only/)
    const pick = html(DraftView, draftProps({ draft: { ...draftProps().draft, cwd: null } }))
    assert.match(pick, /Where are we working\?/)
    assert.doesNotMatch(pick, /[А-Яа-яЁё]/)
  })

  it('conversation chrome is English while Russian message text is untouched', () => {
    const empty = html(Conversation, conversationProps)
    assert.match(empty, /No messages yet/)
    assert.match(empty, /Message to session/)
    assert.match(empty, />Send</)
    assert.doesNotMatch(empty, /[А-Яа-яЁё]/)

    const message = 'Привет, не переводи мой текст'
    const items = foldConversation([{ id: 1, ts: '2026-10-30T10:00:00Z', sessionId: 'example', provider: 'claude', kind: 'message.user', data: { text: message } }]).items
    const populated = html(Conversation, { ...conversationProps, items })
    assert.match(populated, /Привет, не переводи мой текст/)
    assert.doesNotMatch(populated.replaceAll(message, ''), /[А-Яа-яЁё]/)
  })

  it('permission actions are English and the original command stays unchanged', () => {
    const out = html(PermCard, { permId: 'p1', toolName: 'Bash', input: { command: 'echo Привет', description: 'Проверка вывода' }, state: 'pending', createdAt: '2026-10-30T10:00:00Z', now,
      onApprove: noop, onDeny: noop, onFocus: noop })
    assert.match(out, />Allow</)
    assert.match(out, />Deny…</)
    assert.match(out, /echo Привет/)
    assert.match(out, /Проверка вывода/)
    assert.doesNotMatch(out.replaceAll('Привет', '').replaceAll('Проверка вывода', ''), /[А-Яа-яЁё]/)
  })

  it('project navigation and empty Inbox have no Russian application text', () => {
    const groups = groupByProject([], [agent])
    const tree = html(ProjectTree, { groups, selected: 'example', now, collapsed: new Set(), onSelect: noop, onNew: noop, onToggle: noop, onAddProject: noop, onPin: noop })
    assert.match(tree, /New chat/)
    assert.match(tree, /Projects/)
    assert.match(tree, /Add project/)
    assert.doesNotMatch(tree, /[А-Яа-яЁё]/)
    const inbox = html(Inbox, { items: [], agents: [], focused: null, busy: new Set(), retrying: new Set(), now, onFocus: noop, onApprove: noop, onDeny: noop, onClose: noop })
    assert.match(inbox, /Nothing waiting/)
    assert.doesNotMatch(inbox, /[А-Яа-яЁё]/)
  })

  it('full-access consent dialog, Settings → Access and preview setup labels are English', () => {
    const consent = html(ConsentDialog, { onGrant: noop, onKeep: noop })
    assert.match(consent, /Full access: Claude, Codex and ZCode/)
    assert.match(consent, />Allow full access</)
    assert.match(consent, /Keep current access/)
    assert.match(consent, /<code>bypassPermissions<\/code>\. It asks or refuses only/)
    assert.doesNotMatch(consent, /[А-Яа-яЁё]/)
    const granted = { rev: 1, version: 1, current: 1, granted: true, providers: ['claude', 'codex', 'zcode'], grantedAt: '2026-11-02T10:00:00Z' }
    const section = html(AccessSection, { consent: granted, onRevoke: async () => null })
    assert.match(section, /Full access allowed 2 Nov 2026/)
    assert.match(section, />Revoke</)
    assert.doesNotMatch(section, /[А-Яа-яЁё]/)
    assert.equal(runtimeSetupLabel('pending', true), 'This task needs setup')
    assert.equal(runtimeSetupLabel('approved', false), 'Complete the setup steps')
  })
})

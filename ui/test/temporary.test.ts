import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it } from 'node:test'
import { setLanguage } from '../../src/i18n/core.js'
import type { TemporaryDraftRequest, TemporarySnapshot } from '../../src/temporary/types.js'
import { TemporaryDraftBuffer, temporaryBusy, temporaryErrorCode, temporaryErrorMessage, temporaryMarkdown, temporaryPromptId } from '../src/model/temporary.js'
import { TemporaryChat, TemporaryMarkdown } from '../src/components/TemporaryChat.js'
import { MdBridgeContext } from '../src/components/Markdown.js'
import { ImageContext } from '../src/components/Images.js'
import { FilePreviewContext } from '../src/model/filePreviewContext.js'
import { ProjectTree } from '../src/components/ProjectTree.js'

const snapshot = (text = '', revision = 0, extra: Partial<TemporarySnapshot> = {}): TemporarySnapshot => ({ epoch: 'epoch-one', id: 'private-one', title: 'Временный чат', revision, settings: { provider: 'claude' }, status: 'idle', messages: [], draft: { text, revision }, ...extra })
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const settle = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve() }

describe('temporary RAM draft concurrency', () => {
  it('reuses a submission receipt after renderer remount or lost acknowledgement without storing private text', () => {
    const original = snapshot('PRIVATE_CANARY', 7)
    const first = new TemporaryDraftBuffer(original, async () => original)
    const remounted = new TemporaryDraftBuffer(structuredClone(original), async () => original)
    assert.equal(temporaryPromptId(first.getSnapshot().revision), temporaryPromptId(remounted.getSnapshot().revision))
    assert.notEqual(temporaryPromptId(8), temporaryPromptId(7))
    assert.ok(!temporaryPromptId(7).includes('PRIVATE_CANARY'))
  })
  it('serializes writes and coalesces keystrokes typed during a slow RPC', async () => {
    const calls: Array<{ request: TemporaryDraftRequest; reply: ReturnType<typeof deferred<TemporarySnapshot>> }> = []
    const buffer = new TemporaryDraftBuffer(snapshot(), (request) => {
      const reply = deferred<TemporarySnapshot>(); calls.push({ request, reply }); return reply.promise
    })
    buffer.edit('A'); buffer.edit('AB'); buffer.edit('ABC')
    assert.equal(calls.length, 1); assert.equal(buffer.getSnapshot().text, 'ABC')
    calls[0]!.reply.resolve(snapshot('A', 1)); await settle()
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1]!.request, { epoch: 'epoch-one', id: 'private-one', text: 'ABC', baseDraftRevision: 1 })
    calls[1]!.reply.resolve(snapshot('ABC', 2)); await buffer.flush()
    assert.equal(buffer.getSnapshot().dirty, false); assert.equal(buffer.getSnapshot().text, 'ABC')
  })
  it('ignores old polls and recognizes its own in-flight acknowledgement without losing newer input', async () => {
    const replies = [deferred<TemporarySnapshot>(), deferred<TemporarySnapshot>()]
    const calls: TemporaryDraftRequest[] = []
    const buffer = new TemporaryDraftBuffer(snapshot(), (request) => { calls.push(request); return replies[calls.length - 1]!.promise })
    buffer.edit('first'); buffer.edit('second')
    buffer.observe(snapshot('', 0)); assert.equal(buffer.getSnapshot().text, 'second')
    buffer.observe(snapshot('first', 1)); assert.equal(buffer.getSnapshot().text, 'second'); assert.equal(buffer.getSnapshot().conflict, false)
    replies[0]!.resolve(snapshot('first', 1)); await settle()
    assert.equal(calls[1]!.baseDraftRevision, 1)
    buffer.observe(snapshot('', 0)); assert.equal(buffer.getSnapshot().text, 'second')
    replies[1]!.resolve(snapshot('second', 2)); await buffer.flush()
    assert.equal(buffer.getSnapshot().dirty, false)
  })
  it('keeps local text on a remote conflict and saves it only after an explicit choice', async () => {
    const replies = [deferred<TemporarySnapshot>(), deferred<TemporarySnapshot>()]
    const calls: TemporaryDraftRequest[] = []
    const buffer = new TemporaryDraftBuffer(snapshot(), (request) => { calls.push(request); return replies[calls.length - 1]!.promise })
    buffer.edit('my secret')
    buffer.observe(snapshot('other window', 1))
    replies[0]!.reject({ code: 'draft_conflict' }); await buffer.flush()
    assert.equal(buffer.getSnapshot().text, 'my secret'); assert.equal(buffer.getSnapshot().conflict, true)
    assert.equal(calls.length, 1, 'conflict automatically overwrote the other client')
    buffer.keepLocal(); assert.equal(calls.length, 2); assert.equal(calls[1]!.baseDraftRevision, 1)
    replies[1]!.resolve(snapshot('my secret', 2)); await buffer.flush()
    assert.equal(buffer.getSnapshot().conflict, false); assert.equal(buffer.getSnapshot().dirty, false)
  })
  it('waits for a fresh remote snapshot before offering a conflict resolution', async () => {
    const pending = deferred<TemporarySnapshot>()
    const buffer = new TemporaryDraftBuffer(snapshot('before', 3), () => pending.promise)
    buffer.edit('local')
    pending.reject({ code: 'draft_conflict' }); await buffer.flush()
    assert.equal(buffer.getSnapshot().remoteReady, false)
    buffer.useRemote(); assert.equal(buffer.getSnapshot().text, 'local')
    buffer.observe(snapshot('remote', 4)); buffer.useRemote()
    assert.equal(buffer.getSnapshot().text, 'remote'); assert.equal(buffer.getSnapshot().dirty, false)
  })
  it('holds disconnected input in RAM and discards it on an epoch change, including late replies', async () => {
    const pending = deferred<TemporarySnapshot>(); let calls = 0
    const buffer = new TemporaryDraftBuffer(snapshot(), () => { calls++; return pending.promise })
    buffer.setOnline(false); buffer.edit('offline secret'); await buffer.flush()
    assert.equal(calls, 0); assert.equal(buffer.getSnapshot().dirty, true)
    buffer.setOnline(true); assert.equal(calls, 1)
    buffer.observe(snapshot('', 0, { epoch: 'new-daemon' }))
    assert.equal(buffer.getSnapshot().text, ''); assert.equal(buffer.getSnapshot().expired, true)
    pending.resolve(snapshot('offline secret', 1)); await buffer.flush()
    assert.equal(buffer.getSnapshot().text, '', 'late acknowledgement restored an expired secret')
    buffer.edit('must not resurrect'); assert.equal(calls, 1)
  })
  it('retains text on memory-limit and transport errors, exposing only fixed safe codes', async () => {
    let attempts = 0
    const buffer = new TemporaryDraftBuffer(snapshot(), async () => {
      attempts++
      throw attempts === 1 ? { code: 'memory_limit', message: 'provider echoed PRIVATE_CANARY' } : new Error('raw stderr PRIVATE_CANARY')
    })
    buffer.edit('keep this'); await buffer.flush()
    assert.equal(buffer.getSnapshot().error, 'memory_limit'); assert.equal(buffer.getSnapshot().text, 'keep this')
    buffer.edit('shorter'); await buffer.flush()
    assert.equal(buffer.getSnapshot().error, 'internal')
    assert.ok(!JSON.stringify(buffer.getSnapshot()).includes('PRIVATE_CANARY'))
    assert.ok(!temporaryErrorMessage(new Error('PRIVATE_CANARY')).includes('PRIVATE_CANARY'))
  })
})

const hostile = '**bold ![private](/workspace/secret.png)**\n\n[local](/workspace/private.txt) [image](/tmp/canary.png) [web](https://example.com) [bad](javascript:alert(1))\n\n:codex-file-citation{path="/tmp/private.ts" line=1}\n\n| data | link |\n| --- | --- |\n| ![nested](/tmp/hidden.png) | [bad](file:///etc/passwd) |\n\n```html\n<img src="https://secret.example/track">\n```'

describe('temporary rendering privacy boundary', () => {
  it('eliminates file and image nodes at every Markdown depth while retaining safe links and code', () => {
    const blocks = temporaryMarkdown(hostile)
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value)) { value.forEach(visit); return }
      const part = value as Record<string, unknown>
      assert.notEqual(part.t, 'file'); assert.notEqual(part.t, 'image')
      if (part.t === 'link') assert.match(String(part.href), /^https:\/\/example\.com\//)
      Object.values(part).forEach(visit)
    }
    visit(blocks)
    const rendered = renderToStaticMarkup(createElement(TemporaryMarkdown, { text: hostile, openExternal: async () => {} }))
    assert.match(rendered, /<strong>/); assert.match(rendered, /<table>/); assert.match(rendered, /href="https:\/\/example.com\//)
    assert.doesNotMatch(rendered, /<img|image-card|file-link|href="(?:file:|javascript:|\/)/)
    assert.match(rendered, /&lt;img src=/, 'untrusted HTML was interpreted')
  })
  it('does not touch browser storage or inherit image/file operations even under the ordinary full bridge', () => {
    const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const forbidden = (): never => { throw new Error('temporary UI crossed the storage/file boundary') }
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { get localStorage() { return forbidden() }, get sessionStorage() { return forbidden() } } })
    try {
      const chat = snapshot('', 1, { messages: [{ id: 'm', turnId: 't', role: 'assistant', text: hostile, at: '2026-11-05T12:00:00Z', state: 'done' }] })
      const markup = renderToStaticMarkup(createElement(MdBridgeContext.Provider, { value: { copyText: forbidden, readImage: forbidden, openFile: forbidden, revealPath: forbidden } }, createElement(ImageContext.Provider, { value: { sessionId: 'ordinary-project', bridge: { readImage: forbidden } } }, createElement(FilePreviewContext.Provider, { value: { basePath: '/private/project', open: forbidden } }, createElement(TemporaryChat, {
        chat, capabilities: [{ provider: 'claude', available: true }], online: true,
        onDraft: async () => chat, onConfigure: async () => chat, onPrompt: async () => chat, onStop: async () => chat, onEnd: forbidden,
      })))))
      assert.doesNotMatch(markup, /image-card|file-link|attachment-picker|dictation|runtime|<img/)
      assert.match(markup, /data-temporary-chat="true"/)
      assert.match(markup, /data-testid="temporary-model" disabled/)
    } finally { if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window') }
  })
  it('keeps sending unavailable until capabilities are verified and separates Stop from End', () => {
    const chat = snapshot('next question', 1, { status: 'working' })
    const markup = renderToStaticMarkup(createElement(TemporaryChat, {
      chat, capabilities: [{ provider: 'claude', available: false, reason: 'privacy_unverified' }], online: true,
      onDraft: async () => chat, onConfigure: async () => chat, onPrompt: async () => chat, onStop: async () => chat, onEnd: () => {},
    }))
    assert.match(markup, /data-testid="temporary-send"[^>]*disabled/)
    assert.match(markup, /data-testid="temporary-stop"/); assert.match(markup, /data-testid="temporary-end"/)
    assert.equal(temporaryBusy('working'), true); assert.equal(temporaryBusy('stopping'), true); assert.equal(temporaryBusy('interrupted'), false)
    assert.equal(temporaryErrorCode({ code: 'not_a_safe_code', message: 'PRIVATE_CANARY' }), 'internal')
  })
  it('translates the dedicated UI and safe error messages', () => {
    setLanguage('en')
    try {
      const chat = snapshot()
      const markup = renderToStaticMarkup(createElement(TemporaryChat, { chat, capabilities: [], online: false, onDraft: async () => chat, onConfigure: async () => chat, onPrompt: async () => chat, onStop: async () => chat, onEnd: () => {} }))
      assert.doesNotMatch(markup, /[А-Яа-яЁё]/)
      for (const code of ['temporary_expired', 'draft_conflict', 'memory_limit', 'blocked_network', 'internal', 'delete_unconfirmed', 'draft_changed']) assert.doesNotMatch(temporaryErrorMessage({ code }), /[А-Яа-яЁё]/)
      assert.match(markup, /data-testid="temporary-end"[^>]*disabled/)
    } finally { setLanguage('ru') }
  })
  it('does not expose previous messages or input when the authoritative chat is closed', () => {
    const chat = snapshot('CLOSED_SECRET', 2, { status: 'closed', messages: [{ id: 'm', turnId: 't', role: 'user', text: 'CLOSED_SECRET', at: '2026-11-05T12:00:00Z', state: 'done' }] })
    const markup = renderToStaticMarkup(createElement(TemporaryChat, { chat, capabilities: [], online: true, onDraft: async () => chat, onConfigure: async () => chat, onPrompt: async () => chat, onStop: async () => chat, onEnd: () => {} }))
    assert.ok(!markup.includes('CLOSED_SECRET'))
  })
  it('keeps temporary navigation separate from ordinary rows, search metadata and context menus', () => {
    const summary = { ...snapshot(), title: 'PRIVATE_TITLE_CANARY', preview: 'PRIVATE_PREVIEW_CANARY' } as unknown as TemporarySnapshot
    const props = { groups: [], selected: null, now: 0, collapsed: new Set<string>(), onSelect: () => {}, onNew: () => {}, onToggle: () => {}, onAddProject: () => {}, onPin: () => {}, temporaryChats: [summary], activeTemporaryId: summary.id, temporaryAvailable: false, onNewTemporary: () => {}, onSelectTemporary: () => {} }
    const markup = renderToStaticMarkup(createElement(ProjectTree, props))
    assert.match(markup, /data-testid="temporary-row"/)
    assert.match(markup, /data-testid="temporary-new-menu"/)
    assert.doesNotMatch(markup, /PRIVATE_TITLE_CANARY|PRIVATE_PREVIEW_CANARY|data-sidebar-chat|data-testid="agent-row"|row-export|row-archive/)
    assert.ok(!markup.includes(`title="${summary.id}"`))
    const focus = renderToStaticMarkup(createElement(ProjectTree, { ...props, mode: 'focus' }))
    assert.match(focus, /data-testid="temporary-rail"/)
    assert.match(focus, /data-testid="new-agent"/)
  })
})

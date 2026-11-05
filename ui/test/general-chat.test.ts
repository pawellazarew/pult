import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createDraft, draftFromSnapshot, draftSnapshot, draftStartParams, pickModel, remembersAccess, submitDecision, withDraftFolder } from '../src/model/draft.js'
import { GENERAL_GROUP_PATH, groupByProject } from '../src/model/projects.js'
import type { AgentView } from '../src/model/agents.js'
import { CONSENT, env } from './draftFixture.js'

describe('general conversation model', () => {
  it('starts without a folder and does not inherit project defaults or remember its access', () => {
    const e = env({ consent: CONSENT, settings: { newSession: { rememberLast: true, defaults: { claude: { approval: 'workspace', browser: true, worktree: true }, codex: {}, zcode: {} } }, lastUsed: {} } })
    const d = createDraft({ cwd: null, text: 'Обсудим' }, e)
    assert.deepEqual([d.scope, d.cwd, d.approval, d.worktree, d.browser], ['general', null, 'ask', false, false])
    const start = draftStartParams(d, { prompt: d.text, inheritMode: null })
    assert.equal(start.scope, 'general')
    assert.equal('cwd' in start, false)
    assert.equal('rememberAccess' in start, false)
    assert.equal(remembersAccess({ ...d, approvalOrigin: 'explicit' }, null), false)
    assert.equal(submitDecision({ composing: false, repeat: false, busy: false, linkLocked: false, hasFolder: false, scope: d.scope, hasText: true, blocked: false }), 'send')
    const project = withDraftFolder(d, '/projects/pult', e)
    assert.equal(project.scope, 'project')
    assert.equal(project.text, d.text)
    assert.equal(withDraftFolder(project, null, e).scope, 'general')
  })

  it('keeps rejected links project-scoped and roundtrips scope and Codex speed', () => {
    const e = env()
    const rejected = createDraft({ cwd: null, origin: { kind: 'link', pathRejected: true } }, e)
    assert.equal(rejected.scope, 'project')
    const d = { ...pickModel(createDraft({ cwd: null }, e), 'codex', null, e, null), serviceTier: 'fast' as const }
    const recovered = draftFromSnapshot(d.id, 1, draftSnapshot(d), e)!
    assert.deepEqual([recovered.scope, recovered.cwd, recovered.serviceTier], ['general', null, 'fast'])
    assert.equal(draftStartParams(recovered, { prompt: 'x', inheritMode: null }).serviceTier, 'fast')
    assert.equal(pickModel(d, 'claude', 'sonnet', e, null).serviceTier, undefined)
    assert.equal(draftFromSnapshot(d.id, 1, { cwd: '/projects/old' }, e)?.scope, 'project')
    assert.equal(draftFromSnapshot(d.id, 1, { scope: 'general', approval: 'workspace', picked: {} }, e)?.approval, 'ask')
  })

  it('groups general conversations before real projects without leaking managed paths', () => {
    const session = (name: string, extra: Partial<AgentView> = {}): AgentView => ({ name, provider: 'claude', status: 'idle', cwd: '/internal/conversations/a-123456', pending: 0, lastActivity: '2026-11-05', ...extra })
    const groups = groupByProject(['/projects/pult'], [session('general', { scope: 'general' }), session('project', { cwd: '/projects/pult' }), session('archived', { scope: 'general', archived: true })])
    assert.deepEqual(groups.map((g) => g.path), [GENERAL_GROUP_PATH, '/projects/pult'])
    assert.equal(groups[0]?.scope, 'general')
    assert.deepEqual(groups[0]?.sessions.map((s) => s.name), ['general'])
  })
})

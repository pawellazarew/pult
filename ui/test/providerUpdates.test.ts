import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DaemonStatus, ProviderTool } from '../../shell/src/contract.js'
import type { ProviderFileIdentity } from '../../src/env/providerIdentity.js'
import { inboxCounts, inboxSystemView } from '../src/model/inbox.js'
import { observeProviderTools, providerDaemonKey, providerIdentityKey, providerToolKey, providerUpdateCards } from '../src/model/providerUpdates.js'

const old: ProviderFileIdentity = { path: '/bin/codex', realpath: '/app/codex', dev: '1', ino: '2', size: '300', mtimeNs: '100', ctimeNs: '200' }
const next: ProviderFileIdentity = { ...old, ino: '3', ctimeNs: '201' }
const tool = (installation: ProviderFileIdentity | null | undefined = old): ProviderTool => ({ provider: 'codex', path: '/bin/codex', realpath: '/app/codex', version: '1.2.3', source: 'application', ...(installation !== undefined ? { installation } : {}) })
const status = (installation: ProviderFileIdentity | null = old, initialized = true): DaemonStatus => ({
  version: '0.3.23', protocol: 1, pid: 101, startedAt: '2026-11-19T12:00:00Z', uptimeMs: 100, home: '/scratch', sock: '/scratch/socket',
  clients: 1, subscriptions: 1, lastEventId: 0, mode: 'on-demand',
  providerInstallations: { codex: { initialized, installation }, claude: { initialized: false, installation: null } },
})
const options = { online: true, canReconnect: true }

describe('updated provider installations', () => {
  it('compares canonical file identity rather than launcher aliases or version alone', () => {
    assert.equal(providerIdentityKey(old), providerIdentityKey({ ...old, path: '/app/codex' }))
    const s = status()
    const observation = observeProviderTools(null, providerDaemonKey(s)!, [tool(next)], 1)
    const cards = providerUpdateCards(s, observation, options)
    assert.equal(cards.length, 1)
    assert.equal(cards[0]!.action, 'reconnect')
    assert.match(cards[0]!.detail, /1\.2\.3/)
    assert.match(cards[0]!.detail, /подтверждения/)
    assert.deepEqual(providerUpdateCards(s, observeProviderTools(null, providerDaemonKey(s)!, [tool({ ...old, path: '/app/codex' })], 1), options), [])
  })

  it('does not acknowledge an update until a fresh daemon selected the actual new file', () => {
    const s = status()
    const observation = observeProviderTools(null, providerDaemonKey(s)!, [tool(next)], 1)
    assert.equal(providerUpdateCards(s, observation, options).length, 1)
    const restarted = { ...status(next), pid: 102 }
    assert.deepEqual(providerUpdateCards(restarted, observation, options), [], 'old-daemon observation is not reused')
    assert.deepEqual(providerUpdateCards(restarted, observeProviderTools(observation, providerDaemonKey(restarted)!, [tool(next)], 2), options), [])
    const updatedAgain = { ...next, ino: '4' }
    assert.equal(providerUpdateCards(restarted, observeProviderTools(null, providerDaemonKey(restarted)!, [tool(updatedAgain)], 3), options).length, 1)
  })

  it('does not force restart of an uninitialized lazy Rust runtime', () => {
    const s = status(null, false)
    assert.deepEqual(providerUpdateCards(s, observeProviderTools(null, providerDaemonKey(s)!, [tool(next)], 1), options), [])
    const missingAtStartup = status(null, true)
    assert.equal(providerUpdateCards(missingAtStartup, observeProviderTools(null, providerDaemonKey(missingAtStartup)!, [tool(next)], 2), options)[0]!.action, 'reconnect')
  })

  it('detects a reported version change behind an unchanged launcher and retains it through a failed version probe', () => {
    const s = status()
    const first = observeProviderTools(null, providerDaemonKey(s)!, [tool()], 1)
    const nextVersion = observeProviderTools(first, providerDaemonKey(s)!, [{ ...tool(), version: '1.2.4' }], 2)
    assert.equal(providerUpdateCards(s, nextVersion, options)[0]!.action, 'reconnect')
    const failedVersion = observeProviderTools(nextVersion, providerDaemonKey(s)!, [{ ...tool(), version: null }], 3)
    assert.equal(providerUpdateCards(s, failedVersion, options)[0]!.action, 'reconnect')
    const restarted = { ...s, pid: 102 }
    const fresh = observeProviderTools(failedVersion, providerDaemonKey(restarted)!, [{ ...tool(), version: '1.2.4' }], 4)
    assert.deepEqual(providerUpdateCards(restarted, fresh, options), [])
  })

  it('retains missing and unstable installations as checks, never as accepted updates', () => {
    const s = status()
    const changing = { ...tool(next), changedDuringCheck: true, version: null }
    assert.equal(providerToolKey(changing), null)
    const unstable = providerUpdateCards(s, observeProviderTools(null, providerDaemonKey(s)!, [changing], 1), options)
    assert.equal(unstable[0]!.action, 'check')
    const missing = { ...tool(null), path: null, realpath: null, version: null, source: 'missing' as const }
    const cards = providerUpdateCards(s, observeProviderTools(null, providerDaemonKey(s)!, [missing], 1), options)
    assert.equal(cards[0]!.error, true)
    assert.equal(cards[0]!.action, 'check')
    const unused = { ...status(null, false), providerInstallations: undefined }
    assert.deepEqual(providerUpdateCards(unused, observeProviderTools(null, providerDaemonKey(unused)!, [missing], 1), options), [])
  })

  it('exposes the first failed check even without a successful observation', () => {
    const cards = providerUpdateCards(status(), null, { ...options, error: 'probe failed' })
    assert.equal(cards.length, 1)
    assert.equal(cards[0]!.action, 'check')
    assert.equal(cards[0]!.detail, 'probe failed')
  })

  it('uses per-daemon observation baselines with older daemon/desktop pairs', () => {
    const s = { ...status(), providerInstallations: undefined }
    const legacy = { ...tool() }; delete legacy.installation
    const first = observeProviderTools(null, providerDaemonKey(s)!, [legacy], 1)
    assert.deepEqual(providerUpdateCards(s, first, options), [])
    const second = observeProviderTools(first, providerDaemonKey(s)!, [{ ...legacy, version: '1.2.4' }], 2)
    assert.equal(providerUpdateCards(s, second, options).length, 1)
    const fresh = { ...s, pid: 202 }
    const afterRestart = observeProviderTools(second, providerDaemonKey(fresh)!, [{ ...legacy, version: '1.2.4' }], 3)
    assert.deepEqual(providerUpdateCards(fresh, afterRestart, options), [])
    assert.equal(providerToolKey({ ...legacy, installation: null }), null, 'explicit failed metadata is not a legacy observation')
  })

  it('counts system actions without creating session unread or permission targets', () => {
    const s = status()
    const cards = providerUpdateCards(s, observeProviderTools(null, providerDaemonKey(s)!, [tool(next)], 1), { ...options, error: 'check failed' })
    assert.deepEqual(inboxCounts([], [], cards), { all: 2, unread: 0, errors: 1 })
    assert.equal(inboxSystemView('all', cards).length, 2)
    assert.deepEqual(inboxSystemView('unread', cards), [])
    assert.deepEqual(inboxSystemView('errors', cards).map(card => card.id), ['provider-check-error'])
  })

  it('disables reconnect while busy, offline or unsupported without hiding pending work', () => {
    const s = status()
    const observation = observeProviderTools(null, providerDaemonKey(s)!, [tool(next)], 1)
    for (const mode of [{ online: false, canReconnect: true }, { online: true, canReconnect: false }, { ...options, reconnecting: true }]) {
      assert.equal(providerUpdateCards(s, observation, mode)[0]!.actionDisabled, true)
    }
  })
})

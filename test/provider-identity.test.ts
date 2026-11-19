import assert from 'node:assert/strict'
import { chmodSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { captureProviderIdentity, observeProviderTool, sameProviderIdentity } from '../dist/env/providerIdentity.js'
import type { LocatedTool } from '../dist/env/locate.js'
import { readToken } from '../dist/core/token.js'
import { PROTOCOL_VERSION } from '../dist/core/rpc.js'
import { rawConnect, startTestDaemon, tempHome } from './helpers.js'

const tool = (file: string | null): LocatedTool => ({ name: 'codex', path: file, realpath: null, version: null,
  versionExitCode: null, viaPath: false, triedCount: 1 })
const executable = (file: string, text = 'original'): void => writeFileSync(file, `#!/bin/sh\n# ${text}\nexit 0\n`, { mode: 0o700 })

describe('provider installation identity', () => {
  it('accepts an executable alias, rejects missing/non-executable/non-file paths, and preserves nanoseconds as strings', () => {
    const home = tempHome()
    try {
      const file = join(home.paths.home, 'codex'), alias = join(home.paths.home, 'alias')
      executable(file); symlinkSync(file, alias)
      const captured = captureProviderIdentity(alias)
      assert.ok(captured)
      assert.equal(captured.path, alias)
      assert.ok(sameProviderIdentity(captured, captureProviderIdentity(file)))
      for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const) assert.match(captured[key], /^\d+$/)
      assert.equal(captureProviderIdentity('codex'), null)
      assert.equal(captureProviderIdentity(join(home.paths.home, 'absent')), null)
      assert.equal(captureProviderIdentity(home.paths.home), null)
      assert.equal(captureProviderIdentity('bad\0path'), null)
      chmodSync(file, 0o600)
      assert.equal(captureProviderIdentity(alias), null)
    } finally { home.remove() }
  })

  it('a same-path/same-version replacement never inherits the previous identity', async () => {
    const home = tempHome()
    try {
      const file = join(home.paths.home, 'codex'), next = join(home.paths.home, 'replacement')
      executable(file)
      const before = captureProviderIdentity(file)
      const observed = await observeProviderTool(tool(file), async (chosen, args) => {
        assert.equal(chosen, file); assert.deepEqual(args, ['--version'])
        executable(next); renameSync(next, file)
        return { status: 0, stdout: 'codex 1.0\n', stderr: '' }
      })
      assert.equal(observed.version, null)
      assert.equal(observed.changedDuringCheck, true)
      assert.equal(sameProviderIdentity(before, observed.installation), false)
      const stable = await observeProviderTool(tool(file), async () => ({ status: 0, stdout: 'codex 1.0\n', stderr: '' }))
      assert.equal(stable.version, 'codex 1.0')
      assert.equal(stable.changedDuringCheck, false)
      assert.ok(sameProviderIdentity(stable.installation, captureProviderIdentity(file)))
    } finally { home.remove() }
  })

  it('a retargeted launcher or disappearing executable discards the in-flight version', async () => {
    const home = tempHome()
    try {
      const old = join(home.paths.home, 'old'), next = join(home.paths.home, 'new'), alias = join(home.paths.home, 'codex')
      executable(old); executable(next, 'updated'); symlinkSync(old, alias)
      const observed = await observeProviderTool(tool(alias), async () => {
        unlinkSync(alias); symlinkSync(next, alias)
        return { status: 0, stdout: 'old version', stderr: '' }
      })
      assert.equal(observed.version, null)
      assert.equal(observed.changedDuringCheck, true)
      assert.ok(sameProviderIdentity(observed.installation, captureProviderIdentity(next)))
      const missing = await observeProviderTool(tool(alias), async () => {
        unlinkSync(next)
        return { status: 0, stdout: 'new version', stderr: '' }
      })
      assert.equal(missing.version, null)
      assert.equal(missing.installation, null)
      assert.equal(missing.changedDuringCheck, true)
    } finally { home.remove() }
  })

  it('in-place changes and failed probes cannot publish a successful version', async () => {
    const home = tempHome()
    try {
      const file = join(home.paths.home, 'codex')
      executable(file)
      const changed = await observeProviderTool(tool(file), async () => {
        writeFileSync(file, '#!/bin/sh\n# updated in place\nexit 0\n')
        return { status: 0, stdout: 'old version', stderr: '' }
      })
      assert.equal(changed.changedDuringCheck, true)
      assert.equal(changed.version, null)
      const failed = await observeProviderTool(tool(file), async () => ({ status: 1, stdout: 'not a version', stderr: 'failed' }))
      assert.equal(failed.changedDuringCheck, false)
      assert.equal(failed.version, null)
      const unavailable = await observeProviderTool(tool(file), async () => { throw new Error('launch failure') })
      assert.equal(unavailable.version, null)
      assert.equal(unavailable.versionExitCode, null)
      let launched = false
      await observeProviderTool(tool(null), async () => { launched = true; throw new Error('not reached') })
      assert.equal(launched, false)
    } finally { home.remove() }
  })

  it('the actual daemon RPC retains its selected installation after replacement and rediscovers it only on a new daemon', async () => {
    const home = tempHome()
    const file = join(home.paths.home, 'chosen-cli'), next = join(home.paths.home, 'next-cli')
    executable(file)
    const initial = captureProviderIdentity(file)
    let daemon = await startTestDaemon(home, { claudeBin: file, codexBin: file })
    try {
      const read = async () => {
        const conn = await rawConnect(home.paths)
        try {
          conn.send({ type: 'hello', token: readToken(home.paths.token), client: 'shell', protocol: PROTOCOL_VERSION })
          assert.equal((await conn.next())['type'], 'hello_ok')
          conn.send({ id: 1, method: 'daemon.status' })
          return (await conn.next())['result'] as { providerInstallations: { codex: { initialized: boolean; installation: typeof initial } } }
        } finally { conn.end() }
      }
      assert.deepEqual((await read()).providerInstallations.codex, { initialized: true, installation: initial })
      executable(next, 'replacement'); renameSync(next, file)
      assert.equal(sameProviderIdentity(initial, captureProviderIdentity(file)), false)
      assert.deepEqual((await read()).providerInstallations.codex.installation, initial)
      await daemon.stop('qualification')
      daemon = await startTestDaemon(home, { claudeBin: file, codexBin: file })
      assert.ok(sameProviderIdentity((await read()).providerInstallations.codex.installation, captureProviderIdentity(file)))
    } finally {
      await daemon.stop('qualification')
      home.remove()
    }
  })
})

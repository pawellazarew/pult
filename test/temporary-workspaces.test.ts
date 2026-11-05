import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, it } from 'node:test'
import { cleanupTemporaryWorkspaces, createTemporaryWorkspace, removeTemporaryWorkspace, validateTemporaryWorkspace } from '../dist/temporary/workspaces.js'
import { TemporaryChatError } from '../dist/temporary/types.js'

describe('temporary neutral workspaces', () => {
  it('creates random private empty folders and removes only managed startup orphans', () => {
    const home = mkdtempSync(join(tmpdir(), 'temporary-workspaces-')), root = join(home, 'neutral')
    try {
      const a = createTemporaryWorkspace(root), b = createTemporaryWorkspace(root)
      assert.notEqual(a, b)
      assert.match(basename(a), /^work-[A-Za-z0-9]{6}$/)
      assert.equal(statSync(root).mode & 0o777, 0o700)
      assert.equal(statSync(a).mode & 0o777, 0o700)
      validateTemporaryWorkspace(root, a)
      writeFileSync(join(a, 'orphan'), 'orphan')
      mkdirSync(join(root, 'unrelated'))
      cleanupTemporaryWorkspaces(root)
      assert.equal(existsSync(a), false)
      assert.equal(existsSync(b), false)
      assert.equal(existsSync(join(root, 'unrelated')), true)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('rejects substituted roots, rejects child links and never deletes a symlink target', () => {
    const home = mkdtempSync(join(tmpdir(), 'temporary-workspaces-')), root = join(home, 'neutral'), foreign = join(home, 'foreign')
    try {
      const cwd = createTemporaryWorkspace(root)
      mkdirSync(foreign)
      writeFileSync(join(foreign, 'keep'), 'FOREIGN_CANARY')
      rmSync(cwd, { recursive: true })
      symlinkSync(foreign, cwd)
      assert.throws(() => validateTemporaryWorkspace(root, cwd), TemporaryChatError)
      removeTemporaryWorkspace(root, cwd)
      assert.equal(readFileSync(join(foreign, 'keep'), 'utf8'), 'FOREIGN_CANARY')
      renameSync(root, `${root}-old`)
      symlinkSync(foreign, root)
      assert.throws(() => createTemporaryWorkspace(root), TemporaryChatError)
      assert.throws(() => cleanupTemporaryWorkspaces(root), TemporaryChatError)
      assert.equal(readFileSync(join(foreign, 'keep'), 'utf8'), 'FOREIGN_CANARY')
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})

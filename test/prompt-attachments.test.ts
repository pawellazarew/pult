import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { claudePromptAttachmentBlocks, codexPromptInput, ownedPromptAttachment, promptAttachmentContext, validateOwnedPromptAttachments } from '../dist/core/promptAttachments.js'
import type { PromptAttachment } from '../dist/core/promptAttachments.js'
import { userTurnLine } from '../dist/adapters/claude/argv.js'
import { describeChanges, hasChanges, planConfigure } from '../dist/sessions/settings.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=', 'base64')
function fixture(run: (home: string, image: PromptAttachment) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'pt-input-'))
  try {
    const day = join(home, 'attachments', 'w', '2026-11-05'); mkdirSync(day, { recursive: true })
    const path = join(day, 'screenshot.png'); writeFileSync(path, PNG)
    run(home, { path, name: 'Снимок экрана.png', bytes: PNG.length, mime: 'image/png', kind: 'file' })
  } finally { rmSync(home, { recursive: true, force: true }) }
}

describe('structured prompt attachments', () => {
  it('passes real session-owned metadata, excludes sibling ownership and forged byte length', () => fixture((home, image) => {
    assert.deepEqual(validateOwnedPromptAttachments(home, 'w', [image]), [image])
    assert.equal(ownedPromptAttachment(home, 'other', image.path), false)
    assert.throws(() => validateOwnedPromptAttachments(home, 'other', [image]), /недоступно/)
    assert.throws(() => validateOwnedPromptAttachments(home, 'w', [{ ...image, bytes: PNG.length - 1 }]), /изменилось/)
    assert.throws(() => validateOwnedPromptAttachments(home, 'w', Array(21).fill(image)), /20/)
  }))
  it('does not follow a replaced attachment or day symlink', () => fixture((home, image) => {
    const outside = join(home, 'outside.png'); writeFileSync(outside, PNG); unlinkSync(image.path); symlinkSync(outside, image.path)
    assert.equal(ownedPromptAttachment(home, 'w', image.path), false)
    assert.throws(() => codexPromptInput({ home, sessionId: 'w' }, 'text', [image]), /недоступно/)
  }))
  it('Codex image-only prompt uses a native localImage without appending paths to text', () => fixture((home, image) => {
    assert.deepEqual(codexPromptInput({ home, sessionId: 'w' }, '', [image]), [{ type: 'localImage', path: image.path }])
    assert.deepEqual(codexPromptInput({ home, sessionId: 'w' }, 'Посмотри', [image]), [{ type: 'text', text: 'Посмотри' }, { type: 'localImage', path: image.path }])
    assert.equal(promptAttachmentContext('Посмотри', [image]), 'Посмотри')
  }))
  it('Claude receives image bytes while the original text and metadata stay separate', () => fixture((home, image) => {
    const blocks = claudePromptAttachmentBlocks({ home, sessionId: 'w' }, [image])
    assert.deepEqual(blocks, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }])
    const line = JSON.parse(userTurnLine('Посмотри', 'u1', 'runtime-context', blocks))
    assert.deepEqual(line.message.content, [{ type: 'text', text: 'Посмотри' }, blocks[0], { type: 'text', text: 'runtime-context' }])
    assert.ok(!JSON.stringify(image).includes(PNG.toString('base64')))
  }))
  it('non-image copies and explicit directory references produce provider-only context', () => fixture((home, image) => {
    const file = join(home, 'attachments', 'w', '2026-11-05', 'notes.md'); writeFileSync(file, 'hello')
    const notes: PromptAttachment = { path: file, name: 'notes.md', bytes: 5, mime: 'text/markdown', kind: 'file' }
    const directory: PromptAttachment = { path: home, name: 'folder', bytes: 0, mime: 'inode/directory', kind: 'directory' }
    assert.deepEqual(validateOwnedPromptAttachments(home, 'w', [notes, directory]), [notes, directory])
    const input = codexPromptInput({ home, sessionId: 'w' }, 'read', [notes, image])
    assert.deepEqual(input, [{ type: 'text', text: `read\n\nПрикреплённые файлы:\n- ${JSON.stringify(file)}` }, { type: 'localImage', path: image.path }])
  }))
  it('expired or spoofed image inputs fail before native content is built', () => fixture((home, image) => {
    assert.throws(() => claudePromptAttachmentBlocks({ home, sessionId: 'w' }, [{ ...image, mime: 'image/jpeg' }]), /формат/)
    unlinkSync(image.path)
    assert.throws(() => claudePromptAttachmentBlocks({ home, sessionId: 'w' }, [image]), /прикрепи/)
  }))
})

describe('Codex service-tier selection', () => {
  it('Fast and Normal are real changes; absent tier means Normal', () => {
    const change = planConfigure({ provider: 'codex' }, { serviceTier: 'fast' }, null, new Map())
    assert.deepEqual(change, { serviceTier: { from: 'default', to: 'fast' } })
    assert.ok(hasChanges(change)); assert.match(describeChanges(change), /Normal → Fast/)
    assert.deepEqual(planConfigure({ provider: 'codex' }, { serviceTier: 'default' }, null, new Map()), {})
    assert.deepEqual(planConfigure({ provider: 'codex', serviceTier: 'fast' }, { serviceTier: 'default' }, null, new Map()), { serviceTier: { from: 'fast', to: 'default' } })
  })
  it('rejects unsupported providers and invalid tiers', () => {
    for (const provider of ['claude', 'zcode'] as const) assert.throws(() => planConfigure({ provider }, { serviceTier: 'fast' }, null, new Map()), /только у Codex/)
    assert.throws(() => planConfigure({ provider: 'codex' }, { serviceTier: 'turbo' as never }, null, new Map()), /default или fast/)
  })
})

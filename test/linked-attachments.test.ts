import assert from 'node:assert/strict'
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { claudePromptAttachmentBlocks, codexPromptInput, validateOwnedPromptAttachments, MAX_PROMPT_ATTACHMENT_BYTES } from '../dist/core/promptAttachments.js'
import { referencesFile } from '../dist/core/fileReferences.js'
import { sweepAttachments } from '../dist/core/attachments.js'
import { createRegistry } from '../dist/sessions/registry.js'
import { ensureLayout, layout } from '../dist/core/paths.js'
import type { PromptAttachment } from '../dist/core/promptAttachments.js'

const LARGE = 27_282_841
function fixture(run: (root: string, home: string, reference: PromptAttachment) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'pult-linked-input-'))
  try {
    const home = join(root, 'home'); mkdirSync(home)
    const path = join(root, 'Original video.mp4')
    const fd = openSync(path, 'wx'); try { ftruncateSync(fd, LARGE) } finally { closeSync(fd) }
    run(root, home, { path: realpathSync(path), name: 'Original video.mp4', bytes: LARGE, mime: 'video/mp4', kind: 'file-reference' } as unknown as PromptAttachment)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

it('large originals validate as references, including image MIME, and use only provider text paths', () => fixture((_root, home, reference) => {
  const image = { ...reference, mime: 'image/png' }
  assert.deepEqual(validateOwnedPromptAttachments(home, 'w', [reference, image]), [reference, image])
  assert.deepEqual(codexPromptInput({ home, sessionId: 'w' }, 'Посмотри', [image]), [{ type: 'text', text: `Посмотри\n\nПрикреплённые файлы:\n- ${JSON.stringify(image.path)}` }])
  assert.deepEqual(claudePromptAttachmentBlocks({ home, sessionId: 'w' }, [image]), [{ type: 'text', text: `Прикреплённые файлы:\n- ${JSON.stringify(image.path)}` }])
  assert.equal(existsSync(join(home, 'attachments')), false)
  assert.throws(() => validateOwnedPromptAttachments(home, 'w', [{ ...reference, kind: 'file' }]), /метаданные|недоступно/)
}))

it('references fail explicitly when missing, resized, symlinked, or inside the managed cache', () => fixture((root, home, reference) => {
  assert.throws(() => validateOwnedPromptAttachments(home, 'w', [{ ...reference, bytes: LARGE - 1 }]), /изменилось/)
  assert.throws(() => validateOwnedPromptAttachments(home, 'w', [{ ...reference, bytes: MAX_PROMPT_ATTACHMENT_BYTES }]), /метаданные/)
  const alias = join(root, 'alias'); symlinkSync(reference.path, alias)
  assert.throws(() => validateOwnedPromptAttachments(home, 'w', [{ ...reference, path: alias }]), /недоступно|изменилось/)
  const cached = join(home, 'attachments', 'w', 'day'); mkdirSync(cached, { recursive: true })
  const moved = join(cached, 'original.mp4'); renameSync(reference.path, moved)
  assert.throws(() => validateOwnedPromptAttachments(home, 'w', [reference]), /недоступно|изменилось/)
  assert.throws(() => validateOwnedPromptAttachments(home, 'w', [{ ...reference, path: moved }]), /недоступно|изменилось/)
  const parentAlias = join(root, 'cache-alias'); symlinkSync(cached, parentAlias)
  assert.throws(() => validateOwnedPromptAttachments(home, 'w', [{ ...reference, path: join(parentAlias, 'original.mp4') }]), /недоступно|изменилось/)
  const caseAlias = join(home, 'ATTACHMENTS', 'w', 'day', 'original.mp4')
  if (existsSync(caseAlias)) assert.throws(() => validateOwnedPromptAttachments(home, 'w', [{ ...reference, path: caseAlias }]), /недоступно|изменилось/)
}))

it('reference metadata survives registry queue reload/removal and cache GC never removes the original', () => fixture((_root, home, reference) => {
  const paths = layout(home); ensureLayout(paths)
  const registry = createRegistry(paths)
  registry.create({ name: 'w', provider: 'codex', cwd: home, mode: 'turn', createdAt: new Date(0).toISOString(), lastStatus: 'idle', lastEventId: 0, queue: [{ id: 'q1', text: '', at: new Date(0).toISOString(), attachments: [reference] }] })
  assert.deepEqual(createRegistry(paths).get('w')?.queue?.[0]?.attachments, [reference])
  registry.remove('w')
  sweepAttachments(paths.attachments, Date.now(), 0)
  assert.equal(existsSync(reference.path), true)
}))

it('only the exact structured user attachment authorizes a clicked external reference', () => fixture((_root, _home, reference) => {
  const event = { kind: 'message.user', data: { text: '', attachments: [reference] } }
  assert.equal(referencesFile([event], reference.path), true)
  assert.equal(referencesFile([{ ...event, kind: 'tool.finished' }], reference.path), false)
  assert.equal(referencesFile([{ ...event, kind: 'message.done' }], reference.path), false)
  assert.equal(referencesFile([event], reference.path + '.other'), false)
}))

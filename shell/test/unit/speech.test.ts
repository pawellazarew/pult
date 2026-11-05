import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { speechWav, LocalSpeech } from '../../src/speech.js'
import { pcmWav } from '../../../ui/src/model/speech.js'
it('rejects corrupt, oversized and non-WAV IPC audio', () => {
  const valid = pcmWav([new Float32Array(1600)])
  assert.equal(speechWav(valid).length, valid.length)
  assert.throws(() => speechWav('a path'))
  assert.throws(() => speechWav(new Uint8Array(4_000_000)))
  const corrupt = valid.slice(); corrupt[24] = 0
  assert.throws(() => speechWav(corrupt))
  assert.throws(() => speechWav(pcmWav([new Float32Array(20)])))
})
it('missing runtime/model is actionable, never creates recordings or downloads on status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pult-speech-test-'))
  try {
    const speech = new LocalSpeech(join(dir, 'missing'), dir)
    const status = await speech.status()
    assert.equal(status.runtime, false); assert.equal(status.ready, false)
    await assert.rejects(speech.install(), /Обнови/)
    await assert.rejects(speech.transcribe(pcmWav([new Float32Array(1600)]), 'ru'), /Сначала/)
    await assert.rejects(speech.transcribe(pcmWav([new Float32Array(1600)]), '--bad'), /язык/)
    assert.deepEqual(await readdir(dir), [])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

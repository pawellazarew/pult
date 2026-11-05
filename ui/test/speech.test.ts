import assert from 'node:assert/strict'
import { it } from 'node:test'
import { pcmWav, appendDictation, chooseMicrophone } from '../src/model/speech.js'
it('mixes stereo, clamps samples, and writes mono PCM16 at 16 kHz', () => {
  const wav = pcmWav([new Float32Array([-2, 0, 2, NaN]), new Float32Array([-2, 1, 2, 0])])
  const view = new DataView(wav.buffer)
  assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), 'RIFF')
  assert.equal(view.getUint32(24, true), 16000)
  assert.equal(view.getUint32(40, true), 8)
  assert.deepEqual(Array.from({ length: 4 }, (_, i) => view.getInt16(44 + 2 * i, true)), [-32768, 16384, 32767, 0])
})
it('never records from excluded devices; explicit preference wins and survives device ID changes', () => {
  const devices = [{ deviceId: 'default', label: 'Default - AirPods' }, { deviceId: 'air', label: 'AirPods' }, { deviceId: 'new-id', label: 'MacBook' }]
  assert.equal(chooseMicrophone(devices, 'MacBook', 'AirPods'), 'new-id')
  assert.equal(chooseMicrophone(devices, 'AirPods', 'airpods'), 'air')
  assert.equal(chooseMicrophone(devices, 'Unplugged USB', 'AIRPODS'), 'new-id')
  assert.equal(chooseMicrophone(devices.slice(0, 2), '', 'airpods'), null)
  assert.equal(chooseMicrophone(devices, '', ''), 'default')
})
it('dictation preserves a draft including text typed during recognition', () => {
  assert.equal(appendDictation('Уже набрано', ' ещё текст '), 'Уже набрано ещё текст')
  assert.equal(appendDictation('Строка\n', 'голос'), 'Строка\nголос')
  assert.equal(appendDictation('', 'голос'), 'голос')
})

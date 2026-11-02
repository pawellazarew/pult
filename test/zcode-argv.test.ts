// argv для `zcode` (маршрут A спайка docs/17-SPIKE-zcode.md): режимы, resume, отсутствие --model.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildZcodeArgv, ZCODE_MODE } from '../dist/adapters/zcode/argv.js'

describe('zcode argv', () => {
  it('маппинг режимов подтверждений → --mode CLI', () => {
    assert.equal(ZCODE_MODE['read-only'], 'plan')
    assert.equal(ZCODE_MODE['ask'], 'guarded')
    assert.equal(ZCODE_MODE['workspace'], 'edit')
    assert.equal(ZCODE_MODE['full'], 'yolo')
  })

  it('первый ход: реплика в argv (у -p нет stdin), stream-json, terminal, cwd', () => {
    const argv = buildZcodeArgv({ prompt: 'сделай ход', cwd: '/tmp/w', approval: 'workspace' })
    assert.equal(argv[0], '-p')
    assert.equal(argv[1], 'сделай ход')
    assert.equal(argv[argv.indexOf('--cwd') + 1], '/tmp/w')
    assert.equal(argv[argv.indexOf('--mode') + 1], 'edit')
    assert.equal(argv[argv.indexOf('--surface') + 1], 'terminal')
    assert.equal(argv[argv.indexOf('--output-format') + 1], 'stream-json')
    assert.ok(!argv.includes('--resume'))
  })

  it('второй ход: --resume <sess_…>; без режима — guarded (как ask)', () => {
    const argv = buildZcodeArgv({ prompt: 'дальше', cwd: '/tmp/w', resumeSessionId: 'sess_1234', approval: 'ask' })
    assert.equal(argv[argv.indexOf('--resume') + 1], 'sess_1234')
    assert.equal(argv[argv.indexOf('--mode') + 1], 'guarded')
  })

  it('никогда не появляется --model и --effort: таких флагов у CLI нет (strict-парсер упал бы)', () => {
    const argv = buildZcodeArgv({ prompt: 'x', cwd: '/tmp/w' })
    assert.ok(!argv.includes('--model'))
    assert.ok(!argv.includes('--effort'))
  })
})

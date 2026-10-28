// 0.3.16: журнал «Перезапустить и обновить» (src/update/applyJournal.ts) — между старым и новым демоном.

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { APPLY_JOURNAL_MAX_AGE_MS, dropApplyJournal, journalApplies, readApplyJournal, waitPackageProbe, writeApplyJournal } from '../dist/update/applyJournal.js'
import { PROBE_PENDING, readState, writeState } from '../dist/update/versions.js'
import { tempHome } from './helpers.js'

describe('журнал «Перезапустить и обновить»', () => {
  it('запись и чтение (0600); битый файл — нет журнала; удаление', () => {
    const home = tempHome()
    try {
      assert.equal(readApplyJournal(home.paths), null)
      writeApplyJournal(home.paths, { from: '0.3.15', to: '0.3.16', at: '2026-10-28T10:00:00.000Z' })
      assert.deepEqual(readApplyJournal(home.paths), { schema: 1, from: '0.3.15', to: '0.3.16', at: '2026-10-28T10:00:00.000Z' })
      writeFileSync(home.paths.updateApply, '{"schema":1,"from":5}')
      assert.equal(readApplyJournal(home.paths), null)
      dropApplyJournal(home.paths)
      dropApplyJournal(home.paths)
      assert.equal(readApplyJournal(home.paths), null)
    } finally {
      home.remove()
    }
  })

  it('годится, только если версия сменилась и журнал свежий', () => {
    const at = '2026-10-28T10:00:00.000Z'
    const t = Date.parse(at)
    const j = { schema: 1 as const, from: '0.3.15', to: '0.3.16', at }
    assert.equal(journalApplies(j, '0.3.16', t + 5000), true)
    assert.equal(journalApplies(j, '0.3.17', t + 5000), true, 'канал ушёл вперёд — окно догоняет фактическую версию')
    assert.equal(journalApplies(j, '0.3.15', t + 5000), false, 'версия прежняя: провал или откат')
    assert.equal(journalApplies(j, '0.3.16', t + APPLY_JOURNAL_MAX_AGE_MS + 1), false, 'старый журнал')
    assert.equal(journalApplies({ ...j, at: 'вчера' }, '0.3.16', t), false)
  })

  it('итог пробы pult update: «проба идёт» — ждём; ok — да; откат — нет; срок — нет', async () => {
    const home = tempHome()
    try {
      const st = readState(home.paths)
      st.last = { at: 'x', action: 'channel', version: '0.3.16', was: '0.3.15', result: 'failed', message: PROBE_PENDING }
      writeState(home.paths, st)
      const p = waitPackageProbe(home.paths, '0.3.16', { timeoutMs: 3000, pollMs: 10 })
      setTimeout(() => {
        st.last = { at: 'y', action: 'channel', version: '0.3.16', was: '0.3.15', result: 'ok' }
        writeState(home.paths, st)
      }, 60)
      assert.equal(await p, true)
      st.last = { at: 'z', action: 'channel', version: '0.3.16', was: '0.3.15', result: 'rolled_back', message: 'не прошла пробу' }
      writeState(home.paths, st)
      assert.equal(await waitPackageProbe(home.paths, '0.3.16', { timeoutMs: 1000, pollMs: 10 }), false)
      assert.equal(await waitPackageProbe(home.paths, '0.3.17', { timeoutMs: 50, pollMs: 10 }), false)
      assert.equal(await waitPackageProbe(home.paths, '0.3.17', { timeoutMs: 5000, pollMs: 10, stopped: () => true }), false)
    } finally {
      home.remove()
    }
  })
})

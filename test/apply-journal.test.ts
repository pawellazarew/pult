// 0.3.16: журнал «Перезапустить и обновить» (src/update/applyJournal.ts) — между старым и новым демоном.

import assert from 'node:assert/strict'
import { statSync, writeFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { APPLY_JOURNAL_MAX_AGE_MS, dropApplyJournal, journalApplies, readApplyJournal, waitPackageProbe, writeApplyJournal } from '../dist/update/applyJournal.js'
import { PROBE_PENDING, readState, writeState } from '../dist/update/versions.js'
import { withUpdateLock } from '../dist/update/update.js'
import { tempHome } from './helpers.js'

describe('журнал «Перезапустить и обновить»', () => {
  it('запись и чтение (0600); битый файл — нет журнала; удаление', () => {
    const home = tempHome()
    try {
      assert.equal(readApplyJournal(home.paths), null)
      writeApplyJournal(home.paths, { from: '0.3.15', to: '0.3.16', at: '2026-10-28T10:00:00.000Z', windows: ['/Applications/Pult.app/Contents/MacOS/Pult'] })
      assert.deepEqual(readApplyJournal(home.paths), { schema: 1, from: '0.3.15', to: '0.3.16', at: '2026-10-28T10:00:00.000Z', windows: ['/Applications/Pult.app/Contents/MacOS/Pult'] })
      assert.equal((statSync(home.paths.updateApply).mode & 0o777), 0o600)
      // Без списка окон (или мусор в нём) — пустой список.
      writeFileSync(home.paths.updateApply, JSON.stringify({ schema: 1, from: 'a', to: 'b', at: 'c', windows: [5, 'x'] }))
      assert.deepEqual(readApplyJournal(home.paths)?.windows, ['x'])
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
    const j = { schema: 1 as const, from: '0.3.15', to: '0.3.16', at, windows: [] }
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

// Ревью 0.3.16: `pult update` из терминала во время фоновой подготовки ждёт её, а не отказывает «другое обновление».
describe('update.lock: фоновая подготовка — подождать, чужое обновление — отказ', () => {
  const io = (): { lines: string[]; io: { out: (s: string) => void; err: (s: string) => void } } => {
    const lines: string[] = []
    return { lines, io: { out: (s) => lines.push(s), err: (s) => lines.push(s) } }
  }

  it('lock держит --stage — ждёт его конца и продолжает; дольше срока — отказ с пояснением', async () => {
    const home = tempHome()
    try {
      let release: () => void = () => {}
      const stage = withUpdateLock(home.paths, io().io, () => new Promise<number>((r) => { release = () => r(0) }), { stage: true })
      const w = io()
      const next = withUpdateLock(home.paths, w.io, async () => 7, { stageWaitMs: 5000 })
      setTimeout(() => release(), 300)
      assert.equal(await next, 7)
      assert.equal(await stage, 0)
      assert.match(w.lines.join('\n'), /демон готовит обновление в фоне \(pid \d+\) — жду конца подготовки/)

      const stage2 = withUpdateLock(home.paths, io().io, () => new Promise<number>((r) => { release = () => r(0) }), { stage: true })
      const t = io()
      assert.equal(await withUpdateLock(home.paths, t.io, async () => 7, { stageWaitMs: 200 }), 1)
      assert.match(t.lines.join('\n'), /фоновая подготовка обновления \(pid \d+\) идёт дольше .* — повтори позже; журнал: .*update\.log/)
      // Вторая подготовка не ждёт первую — сразу отказ.
      const s2 = io()
      assert.equal(await withUpdateLock(home.paths, s2.io, async () => 7, { stage: true }), 1)
      release()
      assert.equal(await stage2, 0)
    } finally {
      home.remove()
    }
  })

  it('lock держит обычный pult update — отказ сразу, как раньше', async () => {
    const home = tempHome()
    try {
      let release: () => void = () => {}
      const held = withUpdateLock(home.paths, io().io, () => new Promise<number>((r) => { release = () => r(0) }))
      const t = io()
      const t0 = Date.now()
      assert.equal(await withUpdateLock(home.paths, t.io, async () => 7, { stageWaitMs: 5000 }), 1)
      assert.ok(Date.now() - t0 < 2000)
      assert.match(t.lines.join('\n'), /уже идёт другое обновление/)
      release()
      await held
    } finally {
      home.remove()
    }
  })
})

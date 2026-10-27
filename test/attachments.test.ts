// Уборка PULT_HOME/attachments (картинки из буфера окна 0.1.16): старше 30 дней — прочь, на старте демона и раз в сутки;
// ничего вне attachments/, симлинки не раскрываются, свежее не трогается.

import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ATTACHMENTS_MAX_AGE_MS, ATTACHMENTS_SWEEP_MS, sweepAttachments } from '../dist/core/attachments.js'
import { layout } from '../dist/core/paths.js'
import { removeTree, startTestDaemon, tempHome } from './helpers.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.now()

function age(p: string, days: number): void {
  const t = new Date(NOW - days * DAY)
  utimesSync(p, t, t)
}
function file(p: string, days: number, body = 'png'): string {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
  age(p, days)
  return p
}

describe('attachments: раскладка и уборка', () => {
  it('папка — PULT_HOME/attachments, не внутри run/ (там deny для агентов)', () => {
    const p = layout('/h')
    assert.equal(p.attachments, '/h/attachments')
    assert.ok(!p.attachments.startsWith(`${p.run}/`))
    assert.equal(ATTACHMENTS_MAX_AGE_MS, 30 * DAY)
    assert.equal(ATTACHMENTS_SWEEP_MS, DAY)
  })

  it('старше 30 дней — удалены, свежие и папки со свежим — на месте; опустевшая старая папка дня — удалена', () => {
    const root = mkdtempSync(join(tmpdir(), 'pat-'))
    try {
      const dir = join(root, 'attachments')
      const oldA = file(join(dir, '2026-09-01', 'paste-1.png'), 40)
      const oldB = file(join(dir, '2026-09-01', 'paste-2.png'), 31)
      age(join(dir, '2026-09-01'), 31)
      const fresh = file(join(dir, '2026-10-20', 'paste-3.png'), 7)
      const mixedOld = file(join(dir, '2026-09-20', 'paste-4.png'), 35)
      const mixedNew = file(join(dir, '2026-09-20', 'paste-5.png'), 29)
      age(join(dir, '2026-09-20'), 29)
      // Пустая, но свежая папка дня (окно только что завело) — не трогаем.
      mkdirSync(join(dir, '2026-10-27'))
      const r = sweepAttachments(dir, NOW)
      assert.deepEqual(r, { files: 3, dirs: 1, errors: 0 })
      assert.deepEqual([oldA, oldB, mixedOld].map(existsSync), [false, false, false])
      assert.deepEqual([fresh, mixedNew].map(existsSync), [true, true])
      assert.equal(existsSync(join(dir, '2026-09-01')), false)
      assert.equal(existsSync(join(dir, '2026-09-20')), true)
      assert.equal(existsSync(join(dir, '2026-10-27')), true)
      assert.equal(existsSync(dir), true, 'сама attachments остаётся')
    } finally { removeTree(root) }
  })

  it('симлинки не раскрываются: ссылка на папку снаружи — ни шагу внутрь; старая ссылка удаляется сама, цель цела', () => {
    const root = mkdtempSync(join(tmpdir(), 'pat-'))
    try {
      const dir = join(root, 'attachments')
      const outside = join(root, 'outside')
      const victim = file(join(outside, 'precious.txt'), 400)
      age(outside, 400)
      mkdirSync(join(dir, '2026-09-01'), { recursive: true })
      // Ссылки на папку и на файл снаружи. Возраст ссылки — её lstat (время создания): «старыми» их делает прогон
      // «через два дня» с порогом в сутки.
      symlinkSync(outside, join(dir, '2026-09-01', 'dirlink'))
      symlinkSync(victim, join(dir, '2026-09-01', 'filelink'))
      const r = sweepAttachments(dir, NOW + 2 * DAY, DAY)
      assert.equal(existsSync(victim), true, 'файл снаружи цел')
      assert.equal(statSync(outside).isDirectory(), true, 'папка снаружи цела')
      assert.equal(lstatSync(join(dir, '2026-09-01', 'dirlink'), { throwIfNoEntry: false }), undefined, 'ссылка на папку удалена как файл')
      assert.equal(lstatSync(join(dir, '2026-09-01', 'filelink'), { throwIfNoEntry: false }), undefined)
      assert.equal(r.errors, 0)
    } finally { removeTree(root) }
  })

  it('attachments сама симлинк — не трогаем ничего', () => {
    const root = mkdtempSync(join(tmpdir(), 'pat-'))
    try {
      const outside = join(root, 'outside')
      const victim = file(join(outside, 'd', 'old.png'), 400)
      symlinkSync(outside, join(root, 'attachments'))
      assert.deepEqual(sweepAttachments(join(root, 'attachments'), NOW), { files: 0, dirs: 0, errors: 0 })
      assert.equal(existsSync(victim), true)
      assert.equal(readlinkSync(join(root, 'attachments')), outside)
    } finally { removeTree(root) }
  })

  it('нет папки — тихо ничего', () => {
    assert.deepEqual(sweepAttachments(join(tmpdir(), 'нет-такой-папки-pult'), NOW), { files: 0, dirs: 0, errors: 0 })
  })

  it('демон на старте заводит attachments (0700) и удаляет старое, соседей PULT_HOME не трогает', async () => {
    const home = tempHome()
    const { paths } = home
    const old = file(join(paths.attachments, '2026-08-01', 'paste-1.png'), 45)
    age(join(paths.attachments, '2026-08-01'), 45)
    const fresh = file(join(paths.attachments, '2026-10-26', 'paste-2.png'), 1)
    // Старый файл рядом с attachments (в PULT_HOME) — не наш, не трогаем.
    const neighbour = file(join(paths.home, 'old-neighbour.txt'), 400)
    try {
      const d = await startTestDaemon(home)
      try {
        assert.equal(existsSync(old), false)
        assert.equal(existsSync(join(paths.attachments, '2026-08-01')), false)
        assert.equal(existsSync(fresh), true)
        assert.equal(existsSync(neighbour), true)
        assert.equal(statSync(paths.attachments).mode & 0o777, 0o700)
      } finally { await d.stop('test') }
    } finally { home.remove() }
  })

  it('демон заводит attachments, если её нет', async () => {
    const home = tempHome()
    try {
      assert.equal(existsSync(home.paths.attachments), false)
      const d = await startTestDaemon(home)
      try { assert.equal(statSync(home.paths.attachments).isDirectory(), true) } finally { await d.stop('test') }
    } finally { home.remove() }
  })
})

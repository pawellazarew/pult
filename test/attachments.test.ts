// Уборка PULT_HOME/attachments (картинки из буфера окна 0.1.16): старше 30 дней — прочь, на старте демона и раз в сутки;
// ничего вне attachments/, симлинки не раскрываются, свежее не трогается.

import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ATTACHMENTS_MAX_AGE_MS, ATTACHMENTS_SWEEP_MS, sessionAttachmentsDirs, sweepAttachments } from '../dist/core/attachments.js'
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
      const s = join(dir, 'w')
      const oldA = file(join(s, '2026-09-01', 'paste-1.png'), 40)
      const oldB = file(join(s, '2026-09-01', 'paste-2.png'), 31)
      age(join(s, '2026-09-01'), 31)
      const fresh = file(join(s, '2026-10-20', 'paste-3.png'), 7)
      const mixedOld = file(join(s, '2026-09-20', 'paste-4.png'), 35)
      const mixedNew = file(join(s, '2026-09-20', 'paste-5.png'), 29)
      age(join(s, '2026-09-20'), 29)
      // Пустая, но свежая папка дня (окно только что завело) — не трогаем.
      mkdirSync(join(s, '2026-10-27'))
      // Сессия, у которой всё старое: файл, папка дня и сама папка сессии уходят.
      const gone = file(join(dir, 'old', '2026-08-01', 'paste-6.png'), 60)
      age(join(dir, 'old', '2026-08-01'), 60)
      age(join(dir, 'old'), 60)
      const r = sweepAttachments(dir, NOW)
      assert.deepEqual(r, { files: 4, dirs: 3, errors: 0 })
      assert.deepEqual([oldA, oldB, mixedOld, gone].map(existsSync), [false, false, false, false])
      assert.deepEqual([fresh, mixedNew].map(existsSync), [true, true])
      assert.equal(existsSync(join(s, '2026-09-01')), false)
      assert.equal(existsSync(join(s, '2026-09-20')), true)
      assert.equal(existsSync(join(s, '2026-10-27')), true)
      assert.equal(existsSync(join(dir, 'old')), false)
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

  it('папка сессии для --add-dir: заводится 0700, путь как есть и realpath; чужое имя — пусто', () => {
    const root = mkdtempSync(join(tmpdir(), 'pat-'))
    try {
      const home = join(root, 'h')
      mkdirSync(home)
      const dirs = sessionAttachmentsDirs(home, 'w')
      const want = join(realpathSync(home), 'attachments', 'w')
      assert.deepEqual(dirs, [...new Set([join(home, 'attachments', 'w'), want])])
      assert.equal(statSync(want).mode & 0o777, 0o700)
      assert.equal(statSync(join(home, 'attachments')).mode & 0o777, 0o700)
      for (const bad of ['', '..', '../x', 'W', 'a/b']) assert.deepEqual(sessionAttachmentsDirs(home, bad), [], bad)
    } finally { removeTree(root) }
  })

  it('attachments или папка сессии — симлинк (в том числе на ~): --add-dir не даём, по ссылке ничего не создаём', () => {
    const root = mkdtempSync(join(tmpdir(), 'pat-'))
    try {
      const home = join(root, 'h')
      mkdirSync(home)
      symlinkSync(homedir(), join(home, 'attachments'))
      assert.deepEqual(sessionAttachmentsDirs(home, 'zz-pult-test-never'), [])
      assert.equal(existsSync(join(homedir(), 'zz-pult-test-never')), false, 'в домашней папке ничего не заведено')

      const home2 = join(root, 'h2')
      mkdirSync(join(home2, 'attachments'), { recursive: true })
      const outside = join(root, 'outside')
      mkdirSync(outside)
      symlinkSync(outside, join(home2, 'attachments', 'w'))
      assert.deepEqual(sessionAttachmentsDirs(home2, 'w'), [])
    } finally { removeTree(root) }
  })

  it('PULT_HOME сам — симлинк: realpath сравнивается от realpath(PULT_HOME), папка годится', () => {
    const root = mkdtempSync(join(tmpdir(), 'pat-'))
    try {
      mkdirSync(join(root, 'real-h'))
      symlinkSync(join(root, 'real-h'), join(root, 'h'))
      const dirs = sessionAttachmentsDirs(join(root, 'h'), 'w')
      assert.ok(dirs.includes(join(realpathSync(join(root, 'real-h')), 'attachments', 'w')), dirs.join(' '))
    } finally { removeTree(root) }
  })

  it('демон на старте заводит attachments (0700) и удаляет старое, соседей PULT_HOME не трогает', async () => {
    const home = tempHome()
    const { paths } = home
    const old = file(join(paths.attachments, 'w', '2026-08-01', 'paste-1.png'), 45)
    age(join(paths.attachments, 'w', '2026-08-01'), 45)
    const fresh = file(join(paths.attachments, 'w', '2026-10-26', 'paste-2.png'), 1)
    // Старый файл рядом с attachments (в PULT_HOME) — не наш, не трогаем.
    const neighbour = file(join(paths.home, 'old-neighbour.txt'), 400)
    try {
      const d = await startTestDaemon(home)
      try {
        assert.equal(existsSync(old), false)
        assert.equal(existsSync(join(paths.attachments, 'w', '2026-08-01')), false)
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

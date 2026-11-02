// Быстрый старт, шаг A: доступ (design/2026-11-02-quick-start/DESIGN-REVIEW.md §3.6, §5 п. 8, §6).
// Проверяется по-настоящему: реальные RPC демона и argv фальшивого `claude`, а не значения окна.
//   * «Спрашивать» у Claude — явный `--permission-mode manual`; «Как в настройках Claude» (`inherit`) — без флага;
//   * миграция реестра версии 1: записи Claude без режима → `inherit` (поведение идущих чатов не меняется), один раз;
//   * согласие `PULT_HOME/consent.json` проверяет демон САМ: нет согласия — отказ `consent_required`; устаревший
//     `consentRev` — `consent_changed`; отзыв — следующий ход в явном «Спрашивать» и заметка в ленте;
//   * разовое `--yes` CLI — `grant: cli-once`, согласие не пишется и не требуется;
//   * `inherit` при `defaultMode: bypassPermissions` у владельца — это полный доступ: без согласия ход в «Спрашивать»;
//   * действующий режим — из `system/init` (Claude) и ответа `thread/start` (Codex); расхождение — заметка.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { connectClient } from '../dist/cli/client.js'
import { consentCovers, createConsentStore, parseConsent } from '../dist/core/consent.js'
import { layout, ensureLayout } from '../dist/core/paths.js'
import { accessView, expectedReport, isFullLevel, reportIsFull } from '../dist/sessions/access.js'
import { createRegistry, migrateLegacyAsk, parseSessions, SESSIONS_VERSION } from '../dist/sessions/registry.js'
import { codexThreadPolicy, threadReportOf } from '../dist/adapters/codex/adapter.js'
import { startTestDaemon, tempHome, waitFor } from './helpers.js'

type Ev = { kind: string; data: Record<string, unknown> }
type Access = { desired: string; desiredFull: boolean; blocked: boolean; red: boolean; live: boolean; pending: boolean; grant?: string; applied?: { approval: string; reported: string | null; confirmed: boolean; full: boolean } }
type Row = { name: string; approval?: string; grant?: string; access?: Access }

const code = (want: string) => (e: { code?: string }): boolean => e.code === want
const GRANT = { confirm: true, version: 1, providers: ['claude', 'codex'] }

/** Папка сессии с настройкой фальшивого claude: сценарий, куда писать argv, `defaultMode`/подмена режима init. */
function claudeWork(root: string, name: string, extra: Record<string, unknown> = {}): { cwd: string; argvOut: string } {
  const cwd = join(root, name)
  mkdirSync(cwd, { recursive: true })
  const argvOut = join(root, `${name}.argv.jsonl`)
  writeFileSync(join(cwd, '.pult-fake.json'), JSON.stringify({ scenario: 'simple', speed: 0, argvOut, ...extra }))
  return { cwd, argvOut }
}
const lastArgv = (file: string): string[] => (JSON.parse(readFileSync(file, 'utf8').trim().split('\n').at(-1) as string) as { argv: string[] }).argv
const mode = (argv: string[]): string | undefined => { const i = argv.indexOf('--permission-mode'); return i >= 0 ? argv[i + 1] : undefined }

describe('шаг A: чистые правила доступа', () => {
  it('полный уровень, ожидаемый ответ провайдера, «полные права» по ответу', () => {
    assert.equal(isFullLevel('claude', 'full'), true)
    assert.equal(isFullLevel('claude', 'inherit', 'auto'), false)
    assert.equal(isFullLevel('claude', 'inherit', 'bypassPermissions'), true, '«как в настройках» при bypass — полный доступ')
    assert.equal(isFullLevel('codex', 'inherit', 'bypassPermissions'), false)
    assert.equal(expectedReport('claude', 'ask'), 'default', 'manual в system/init виден как default (S10)')
    assert.equal(expectedReport('claude', undefined), 'default')
    assert.equal(expectedReport('claude', 'inherit', 'auto'), 'auto')
    assert.equal(expectedReport('claude', 'inherit'), null)
    assert.equal(expectedReport('codex', 'full'), 'dangerFullAccess/never')
    assert.equal(expectedReport('codex', 'ask'), 'workspaceWrite/on-request')
    assert.equal(reportIsFull('claude', 'bypassPermissions'), true)
    assert.equal(reportIsFull('codex', 'dangerFullAccess/never'), true)
    assert.equal(reportIsFull('codex', 'workspaceWrite/never'), false)
    // Ответ Codex: оба поля — подтверждено; чего-то нет — нет (fixture 09).
    assert.equal(threadReportOf({ approvalPolicy: 'on-request', sandbox: { type: 'readOnly', networkAccess: false } }), 'readOnly/on-request')
    assert.equal(threadReportOf({ sandbox: { type: 'readOnly' } }), null)
    assert.deepEqual(codexThreadPolicy('inherit', true), codexThreadPolicy('ask', true), 'у Codex inherit нет — тише некуда, как ask')
  })
  it('метка: красная, пока выбран полный (с разрешением) или жив процесс с полными правами; понижение — pending', () => {
    const applied = { approval: 'full' as const, reported: 'bypassPermissions', confirmed: true, full: true, at: 'x' }
    const up = accessView({ provider: 'claude', approval: 'full', allowed: true })
    assert.deepEqual([up.red, up.pending, up.live, up.applied], [true, false, false, undefined], 'до первого хода — красная сразу, «ожидается»')
    const down = accessView({ provider: 'claude', approval: 'ask', applied, liveApproval: 'full', allowed: true })
    assert.deepEqual([down.red, down.pending, down.desiredFull], [true, true, false], 'понижение: процесс с полными правами жив — красная, pending')
    const after = accessView({ provider: 'claude', approval: 'ask', applied, liveApproval: null, allowed: true })
    assert.deepEqual([after.red, after.pending], [false, false], 'процесс вышел — метка снята')
    const blocked = accessView({ provider: 'claude', approval: 'full', allowed: false })
    assert.deepEqual([blocked.red, blocked.blocked], [false, true], 'нет разрешения — не красная, а «не разрешён»')
    const live = accessView({ provider: 'claude', approval: 'full', applied: { ...applied, approval: 'ask', reported: 'default', full: false }, liveApproval: 'ask', allowed: false })
    assert.equal(live.pending, false, 'ход и так в «Спрашивать» — ждать нечего')
  })
})

describe('шаг A: согласие — файл', () => {
  it('разбор не верит файлу; согласие на провайдера; rev растёт и после порчи файла; 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-consent-'))
    try {
      const file = join(dir, 'consent.json')
      assert.equal(consentCovers(parseConsent({ version: 1, rev: 3, providers: ['claude', 'evil'], grantedAt: '2026-11-02T10:00:00Z' }), 'claude'), true)
      assert.equal(consentCovers(parseConsent({ version: 1, rev: 3, providers: ['claude'], grantedAt: '2026-11-02T10:00:00Z' }), 'codex'), false)
      assert.equal(consentCovers(parseConsent({ version: 0, rev: 3, providers: ['claude'], grantedAt: '2026-11-02T10:00:00Z' }), 'claude'), false, 'старая версия текста — не действует')
      assert.equal(consentCovers(parseConsent({ version: 1, rev: 3, providers: ['claude'], grantedAt: 'x', revokedAt: '2026-11-02T10:00:00Z' }), 'claude'), false)
      assert.equal(consentCovers(parseConsent('мусор'), 'claude'), false)
      const s = createConsentStore(file)
      assert.equal(s.read().rev, 0)
      const g = s.grant(['codex', 'claude'])
      assert.deepEqual([g.rev, g.providers, g.version], [1, ['claude', 'codex'], 1])
      assert.equal(statSync(file).mode & 0o777, 0o600)
      const r = s.revoke()
      assert.deepEqual([r.rev, r.providers, consentCovers(r, 'claude')], [2, [], false])
      writeFileSync(file, '{не json')
      assert.equal(s.grant(['claude', 'codex']).rev, 3, 'файл испорчен — номер всё равно больше виденного')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('шаг A: миграция реестра (§5 п. 8)', () => {
  it('версия 1: Claude без режима → inherit, Codex и явные режимы не трогаются; версия 2 — без изменений; один раз', () => {
    const base = { provider: 'claude', cwd: '/w', mode: 'turn', createdAt: 'x', lastStatus: 'cold', lastEventId: 0 }
    const raw = { version: 1, sessions: [{ ...base, name: 'old' }, { ...base, name: 'ro', approval: 'read-only' }, { ...base, name: 'cx', provider: 'codex' }, { ...base, name: 'asked', approval: 'ask' }] }
    const list = parseSessions(raw)
    assert.equal(migrateLegacyAsk(raw, list), 2)
    assert.deepEqual(list.map((s) => [s.name, s.approval]), [['old', 'inherit'], ['ro', 'read-only'], ['cx', undefined], ['asked', 'inherit']])
    const v2 = { version: SESSIONS_VERSION, sessions: [{ ...base, name: 'new' }] }
    const l2 = parseSessions(v2)
    assert.equal(migrateLegacyAsk(v2, l2), 0)
    assert.equal(l2[0]?.approval, undefined, 'в версии 2 отсутствие режима — явный «Спрашивать»')

    // Через настоящий реестр: файл переписан версией 2 сразу, второй старт ничего не мигрирует.
    const dir = mkdtempSync(join(tmpdir(), 'pt-mig-'))
    try {
      const paths = layout(dir)
      ensureLayout(paths)
      writeFileSync(paths.sessions, JSON.stringify(raw))
      assert.equal(createRegistry(paths).get('old')?.approval, 'inherit')
      const disk = JSON.parse(readFileSync(paths.sessions, 'utf8')) as { version: number }
      assert.equal(disk.version, SESSIONS_VERSION)
      const again = createRegistry(paths)
      again.create({ ...base, name: 'fresh', provider: 'claude', mode: 'turn', lastStatus: 'cold' } as never)
      assert.equal(createRegistry(paths).get('fresh')?.approval, undefined, 'новая сессия «Спрашивать» не становится inherit на следующем старте')
      assert.equal(createRegistry(paths).get('old')?.approval, 'inherit')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('мигрированная сессия идёт без флага, как до обновления; новая «Спрашивать» — manual', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-mig-d-'))
    const old = claudeWork(root, 'old')
    writeFileSync(home.paths.sessions, JSON.stringify({ version: 1, sessions: [
      { name: 'old', provider: 'claude', cwd: old.cwd, mode: 'turn', createdAt: '2026-10-01T00:00:00Z', lastStatus: 'idle', lastEventId: 0 },
    ] }))
    const d = await startTestDaemon(home)
    const c = await connectClient(home.paths)
    try {
      const fresh = claudeWork(root, 'fresh')
      await c.request('agent.start', { name: 'fresh', kind: 'claude', cwd: fresh.cwd })
      for (const n of ['old', 'fresh']) {
        await c.request('agent.prompt', { name: n, text: 'привет' })
        await c.request('agent.wait', { name: n, timeoutMs: 10_000 })
      }
      assert.equal(mode(lastArgv(old.argvOut)), undefined, 'старый чат — по настройкам владельца, как раньше')
      assert.equal(mode(lastArgv(fresh.argvOut)), 'manual')
      const rows = ((await c.request('agent.list')) as { sessions: Row[] }).sessions
      assert.equal(rows.find((r) => r.name === 'old')?.approval, 'inherit')
      assert.equal(rows.find((r) => r.name === 'fresh')?.access?.applied?.reported, 'default')
    } finally { c.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })
})

describe('шаг A: согласие проверяет демон', () => {
  it('нет согласия — отказ; только окно даёт согласие; rev сверяется; отзыв — следующий ход в «Спрашивать»', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-consent-d-'))
    const d = await startTestDaemon(home)
    const cli = await connectClient(home.paths)
    const win = await connectClient(home.paths, { client: 'shell' })
    try {
      const f = claudeWork(root, 'f')
      await assert.rejects(win.request('agent.start', { name: 'f', kind: 'claude', cwd: f.cwd, approval: 'full' }), code('invalid_params'), 'без confirm — как раньше')
      await assert.rejects(win.request('agent.start', { name: 'f', kind: 'claude', cwd: f.cwd, approval: 'full', confirm: true }), code('consent_required'))
      assert.equal(((await cli.request('agent.list')) as { sessions: Row[] }).sessions.length, 0, 'отказ — до заведения чего-либо')
      // Согласие пишет только окно, только с confirm, текущей версией текста и обоими провайдерами.
      await assert.rejects(cli.request('access.grantFull', GRANT), code('forbidden'))
      await assert.rejects(win.request('access.grantFull', { ...GRANT, confirm: undefined }), code('invalid_params'))
      await assert.rejects(win.request('access.grantFull', { ...GRANT, version: 0 }), code('invalid_params'))
      await assert.rejects(win.request('access.grantFull', { ...GRANT, providers: ['claude'] }), code('invalid_params'))
      await assert.rejects(win.request('settings.set', { access: { consent: true } }), code('invalid_params'))
      const g = (await win.request('access.grantFull', GRANT)) as { consent: { rev: number; granted: boolean } }
      assert.deepEqual([g.consent.rev, g.consent.granted], [1, true])
      // Окно видело старый номер — согласие менялось у него за спиной.
      await assert.rejects(win.request('agent.start', { name: 'f', kind: 'claude', cwd: f.cwd, approval: 'full', confirm: true, consentRev: 0 }), code('consent_changed'))
      await win.request('agent.start', { name: 'f', kind: 'claude', cwd: f.cwd, approval: 'full', confirm: true, consentRev: 1 })
      await win.request('agent.prompt', { name: 'f', text: 'раз' })
      await win.request('agent.wait', { name: 'f', timeoutMs: 10_000 })
      assert.equal(mode(lastArgv(f.argvOut)), 'bypassPermissions')
      let row = ((await win.request('agent.list')) as { sessions: Row[] }).sessions.find((r) => r.name === 'f')
      assert.deepEqual([row?.access?.applied?.reported, row?.access?.applied?.confirmed, row?.access?.applied?.full, row?.access?.live], ['bypassPermissions', true, true, false])
      assert.equal(row?.access?.red, true)

      // Отзыв (любой клиент) — следующий ход: явный «Спрашивать» и одна заметка; новый старт с полным — отказ.
      const r = (await cli.request('access.revokeFull')) as { consent: { rev: number; granted: boolean } }
      assert.deepEqual([r.consent.rev, r.consent.granted], [2, false])
      for (const t of ['два', 'три']) {
        await win.request('agent.prompt', { name: 'f', text: t })
        await win.request('agent.wait', { name: 'f', timeoutMs: 10_000 })
        assert.equal(mode(lastArgv(f.argvOut)), 'manual', 'после отзыва — manual, не «без флага»')
      }
      const notes = ((await win.request('events.tail', { since: 0, sessionId: 'f' })) as { events: Ev[] }).events
        .filter((e) => e.kind === 'session.configured' && e.data['access'] === 'downgraded')
      assert.equal(notes.length, 1, 'заметка одна на отзыв, а не на каждый ход')
      assert.match(String(notes[0]?.data['notice']), /полный доступ отозван — ход в «Спрашивать»/)
      row = ((await win.request('agent.list')) as { sessions: Row[] }).sessions.find((r) => r.name === 'f')
      assert.deepEqual([row?.approval, row?.access?.blocked, row?.access?.red], ['full', true, false])
      await assert.rejects(win.request('agent.start', { name: 'g', kind: 'claude', cwd: claudeWork(root, 'g').cwd, approval: 'full', confirm: true }), code('consent_required'))
      // Смена режима живой сессии на полный — тоже по согласию.
      await win.request('agent.start', { name: 'h', kind: 'claude', cwd: claudeWork(root, 'h').cwd })
      await assert.rejects(win.request('agent.configure', { name: 'h', approval: 'full', confirm: true }), code('consent_required'))
    } finally { cli.close(); win.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })

  it('разовое --yes (grant: cli-once): согласие не пишется и не нужно; живёт до смены режима', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-once-'))
    const d = await startTestDaemon(home)
    const c = await connectClient(home.paths)
    try {
      const o = claudeWork(root, 'o')
      const rec = (await c.request('agent.start', { name: 'o', kind: 'claude', cwd: o.cwd, approval: 'full', confirm: true, grant: 'cli-once' })) as Row
      assert.equal(rec.grant, 'cli-once')
      assert.throws(() => readFileSync(home.paths.consent), 'consent.json не пишется')
      await c.request('agent.prompt', { name: 'o', text: 'раз' })
      await c.request('agent.wait', { name: 'o', timeoutMs: 10_000 })
      assert.equal(mode(lastArgv(o.argvOut)), 'bypassPermissions')
      // Отзыв согласия разовое разрешение не трогает: его давал не диалог.
      await c.request('access.revokeFull')
      await c.request('agent.prompt', { name: 'o', text: 'два' })
      await c.request('agent.wait', { name: 'o', timeoutMs: 10_000 })
      assert.equal(mode(lastArgv(o.argvOut)), 'bypassPermissions')
      await assert.rejects(c.request('agent.start', { name: 'x', kind: 'claude', cwd: o.cwd, approval: 'full', confirm: true, grant: 'forever' }), code('invalid_params'))
      // Вернуть — `--approval ask`: разрешение уходит с режимом; обратно в полный — снова нужно `--yes` или согласие.
      const back = (await c.request('agent.configure', { name: 'o', approval: 'ask' })) as Row
      assert.equal(back.grant, undefined)
      await assert.rejects(c.request('agent.configure', { name: 'o', approval: 'full', confirm: true }), code('consent_required'))
      const again = (await c.request('agent.configure', { name: 'o', approval: 'full', confirm: true, grant: 'cli-once' })) as Row
      assert.equal(again.grant, 'cli-once')
    } finally { c.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })

  it('«как в настройках Claude» при defaultMode bypassPermissions — полный доступ: без согласия старт отказан, ход в «Спрашивать»', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-inh-'))
    // Тестовый демон читает настройки Claude владельца из PULT_HOME/claude-settings.json.
    writeFileSync(join(home.paths.home, 'claude-settings.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }))
    const i = claudeWork(root, 'i', { defaultMode: 'bypassPermissions' })
    // Сессия до обновления (реестр версии 1) — мигрирует в inherit, а согласия нет.
    writeFileSync(home.paths.sessions, JSON.stringify({ version: 1, sessions: [
      { name: 'i', provider: 'claude', cwd: i.cwd, mode: 'turn', createdAt: '2026-10-01T00:00:00Z', lastStatus: 'idle', lastEventId: 0 },
    ] }))
    const d = await startTestDaemon(home)
    const win = await connectClient(home.paths, { client: 'shell' })
    try {
      await assert.rejects(win.request('agent.start', { name: 'n', kind: 'claude', cwd: claudeWork(root, 'n').cwd, approval: 'inherit', confirm: true }), code('consent_required'))
      let row = ((await win.request('agent.list')) as { sessions: Row[] }).sessions.find((r) => r.name === 'i')
      assert.deepEqual([row?.approval, row?.access?.desiredFull, row?.access?.blocked], ['inherit', true, true])
      await win.request('agent.prompt', { name: 'i', text: 'раз' })
      await win.request('agent.wait', { name: 'i', timeoutMs: 10_000 })
      assert.equal(mode(lastArgv(i.argvOut)), 'manual', 'без согласия bypass владельца не действует — явный «Спрашивать»')
      const note = ((await win.request('events.tail', { since: 0, sessionId: 'i' })) as { events: Ev[] }).events.find((e) => e.data['access'] === 'downgraded')
      assert.match(String(note?.data['notice']), /defaultMode: bypassPermissions — это полный доступ/)
      // Согласие дано — снова без флага, как было.
      await win.request('access.grantFull', GRANT)
      await win.request('agent.prompt', { name: 'i', text: 'два' })
      await win.request('agent.wait', { name: 'i', timeoutMs: 10_000 })
      assert.equal(mode(lastArgv(i.argvOut)), undefined)
      row = ((await win.request('agent.list')) as { sessions: Row[] }).sessions.find((r) => r.name === 'i')
      assert.deepEqual([row?.access?.applied?.reported, row?.access?.applied?.full], ['bypassPermissions', true])
    } finally { win.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })
})

describe('шаг A: действующий режим', () => {
  it('Claude сказал не тот режим — заметка одна на расхождение, метка по сказанному', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-mis-'))
    const d = await startTestDaemon(home)
    const c = await connectClient(home.paths)
    try {
      const m = claudeWork(root, 'm', { reportMode: 'bypassPermissions' })
      await c.request('agent.start', { name: 'm', kind: 'claude', cwd: m.cwd })
      for (const t of ['раз', 'два']) {
        await c.request('agent.prompt', { name: 'm', text: t })
        await c.request('agent.wait', { name: 'm', timeoutMs: 10_000 })
      }
      const evs = ((await c.request('events.tail', { since: 0, sessionId: 'm' })) as { events: Ev[] }).events.filter((e) => e.data['access'] === 'mismatch')
      assert.equal(evs.length, 1)
      assert.match(String(evs[0]?.data['notice']), /Claude запущен в режиме bypassPermissions, ожидался default — это полный доступ/)
      const row = ((await c.request('agent.list')) as { sessions: Row[] }).sessions.find((r) => r.name === 'm')
      assert.deepEqual([row?.access?.applied?.reported, row?.access?.applied?.full], ['bypassPermissions', true])
    } finally { c.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })
  it('Codex: режим из ответа thread/start — подтверждён; inherit у Codex — отказ', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-cx-'))
    mkdirSync(join(root, 'r'), { recursive: true })
    const d = await startTestDaemon(home)
    const c = await connectClient(home.paths)
    try {
      await assert.rejects(c.request('agent.start', { name: 'x', kind: 'codex', cwd: join(root, 'r'), approval: 'inherit' }), code('invalid_params'))
      await c.request('agent.start', { name: 'r', kind: 'codex', cwd: join(root, 'r'), approval: 'read-only' })
      await c.request('agent.prompt', { name: 'r', text: 'привет' })
      await c.request('agent.wait', { name: 'r', timeoutMs: 15_000 })
      assert.ok(await waitFor(async () => ((await c.request('agent.list')) as { sessions: Row[] }).sessions.find((s) => s.name === 'r')?.access?.applied?.confirmed === true, 5000))
      const row = ((await c.request('agent.list')) as { sessions: Row[] }).sessions.find((s) => s.name === 'r')
      assert.deepEqual([row?.access?.applied?.reported, row?.access?.applied?.full, row?.access?.red], ['readOnly/on-request', false, false])
      await assert.rejects(c.request('agent.configure', { name: 'r', approval: 'inherit' }), code('invalid_params'))
    } finally { c.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })
})

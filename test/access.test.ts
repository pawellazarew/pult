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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { connectClient } from '../dist/cli/client.js'
import { consentCovers, createConsentStore, parseConsent } from '../dist/core/consent.js'
import { layout, ensureLayout } from '../dist/core/paths.js'
import { accessView, expectedReport, isFullLevel, reportIsFull } from '../dist/sessions/access.js'
import { ACCESS_MIGRATION, createRegistry, migrateLegacyAsk, parseSessions, SESSIONS_VERSION } from '../dist/sessions/registry.js'
import { codexThreadPolicy, threadReportOf } from '../dist/adapters/codex/adapter.js'
import { FAKE_CODEX_SCRIPTED, startTestDaemon, tempHome, waitFor } from './helpers.js'

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
    // Ревью PR #39 (Codex 9): политика-объект `{granular: …}` (схема 0.163) — не теряет известную песочницу.
    assert.equal(threadReportOf({ approvalPolicy: { granular: { sandbox_approval: true } }, sandbox: { type: 'dangerFullAccess' } }), 'dangerFullAccess/granular')
    assert.equal(reportIsFull('codex', threadReportOf({ approvalPolicy: { granular: {} }, sandbox: { type: 'dangerFullAccess' } })), true)
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
  it('откат и возврат (ревью M2): копия .bak-v1 и маркер в config.json; после маркера новый «Спрашивать» не становится inherit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-mig-rb-'))
    try {
      const paths = layout(dir)
      ensureLayout(paths)
      const base = { provider: 'claude', cwd: '/w', mode: 'turn', lastStatus: 'cold', lastEventId: 0 }
      const v1 = JSON.stringify({ version: 1, sessions: [{ ...base, name: 'old', createdAt: '2026-10-01T00:00:00Z' }] })
      writeFileSync(paths.sessions, v1)
      writeFileSync(paths.config, JSON.stringify({ network: { claude: { mode: 'off' } } }))
      assert.equal(createRegistry(paths).get('old')?.approval, 'inherit')
      assert.equal(readFileSync(`${paths.sessions}.bak-v1`, 'utf8'), v1, 'копия файла ДО миграции')
      const cfg = JSON.parse(readFileSync(paths.config, 'utf8')) as { network?: unknown; migrations?: Record<string, { at: string }> }
      assert.ok(cfg.migrations?.[ACCESS_MIGRATION]?.at, 'маркер migrations.accessLevels')
      assert.equal(ACCESS_MIGRATION, 'accessLevels', 'не quickStart — то имя у миграции пресетов (§5)')
      assert.deepEqual(cfg.network, { claude: { mode: 'off' } }, 'чужие разделы config.json не тронуты')
      // Новый «Спрашивать» после обновления (createdAt позже маркера), затем откат: прежний демон переписал файл версией 1
      // без полей, которых не знает.
      const fresh = new Date(Date.parse(cfg.migrations?.[ACCESS_MIGRATION]?.at ?? '') + 1000).toISOString()
      writeFileSync(paths.sessions, JSON.stringify({ version: 1, sessions: [
        { ...base, name: 'old', createdAt: '2026-10-01T00:00:00Z' },
        { ...base, name: 'fresh', createdAt: fresh },
      ] }))
      const again = createRegistry(paths)
      assert.equal(again.get('old')?.approval, 'inherit', 'запись до маркера — как раньше, без флага')
      assert.equal(again.get('fresh')?.approval, undefined, 'новый «Спрашивать» остаётся явным, а не молча шире')
      assert.equal(readFileSync(`${paths.sessions}.bak-v1`, 'utf8'), v1, 'копия первая и единственная')
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
  it('Claude сказал не тот режим (не полный) — заметка одна на расхождение, метка по сказанному', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-mis-'))
    const d = await startTestDaemon(home)
    const c = await connectClient(home.paths)
    try {
      const m = claudeWork(root, 'm', { reportMode: 'acceptEdits' })
      await c.request('agent.start', { name: 'm', kind: 'claude', cwd: m.cwd })
      for (const t of ['раз', 'два']) {
        await c.request('agent.prompt', { name: 'm', text: t })
        await c.request('agent.wait', { name: 'm', timeoutMs: 10_000 })
      }
      const evs = ((await c.request('events.tail', { since: 0, sessionId: 'm' })) as { events: Ev[] }).events.filter((e) => e.data['access'] === 'mismatch')
      assert.equal(evs.length, 1)
      assert.match(String(evs[0]?.data['notice']), /Claude запущен в режиме acceptEdits, ожидался default/)
      const row = ((await c.request('agent.list')) as { sessions: Row[] }).sessions.find((r) => r.name === 'm')
      assert.deepEqual([row?.access?.applied?.reported, row?.access?.applied?.full], ['acceptEdits', false])
    } finally { c.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })
  it('ревью M1: inherit, прогноз «не полный», а init сказал bypassPermissions без согласия (MDM) — ход остановлен, дальше manual', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-mdm-'))
    const m = claudeWork(root, 'm', { reportMode: 'bypassPermissions', hangAfterInit: 5000 })
    writeFileSync(home.paths.sessions, JSON.stringify({ version: 1, sessions: [
      { name: 'm', provider: 'claude', cwd: m.cwd, mode: 'turn', createdAt: '2026-10-01T00:00:00Z', lastStatus: 'idle', lastEventId: 0 },
    ] }))
    const d = await startTestDaemon(home)
    const c = await connectClient(home.paths)
    try {
      const t0 = Date.now()
      await c.request('agent.prompt', { name: 'm', text: 'раз' })
      await c.request('agent.wait', { name: 'm', timeoutMs: 10_000 })
      assert.ok(Date.now() - t0 < 4000, 'ход не дожил до конца паузы после init — его остановили')
      assert.equal(mode(lastArgv(m.argvOut)), undefined, 'первый ход — по прогнозу, без флага')
      const evs = ((await c.request('events.tail', { since: 0, sessionId: 'm' })) as { events: Ev[] }).events
      const note = evs.find((e) => e.data['access'] === 'downgraded')
      assert.match(String(note?.data['notice']), /Claude запущен в режиме bypassPermissions — это полный доступ, а он не разрешён: ход остановлен/)
      assert.ok(evs.some((e) => e.kind === 'status.changed' && e.data['status'] === 'interrupted'), 'ход прерван')
      let row = ((await c.request('agent.list')) as { sessions: Row[] }).sessions.find((r) => r.name === 'm')
      assert.deepEqual([row?.approval, row?.access?.desiredFull, row?.access?.blocked], ['inherit', true, true], 'сказанный bypass помнится')
      // Следующий ход — явный «Спрашивать», даже когда init уже говорит правду.
      writeFileSync(join(m.cwd, '.pult-fake.json'), JSON.stringify({ scenario: 'simple', speed: 0, argvOut: m.argvOut }))
      await c.request('agent.prompt', { name: 'm', text: 'два' })
      await c.request('agent.wait', { name: 'm', timeoutMs: 10_000 })
      assert.equal(mode(lastArgv(m.argvOut)), 'manual')
      // Новый выбор уровня забывает сказанное.
      await c.request('agent.configure', { name: 'm', approval: 'ask' })
      row = ((await c.request('agent.list')) as { sessions: Row[] }).sessions.find((r) => r.name === 'm')
      assert.equal(row?.access?.blocked, false)
    } finally { c.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })
  it('ревью M1, m3, m6: управляемые настройки Claude с bypass — inherit это полный доступ', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-managed-'))
    const i = claudeWork(root, 'i')
    writeFileSync(home.paths.sessions, JSON.stringify({ version: 1, sessions: [
      { name: 'i', provider: 'claude', cwd: i.cwd, mode: 'turn', createdAt: '2026-10-01T00:00:00Z', lastStatus: 'idle', lastEventId: 0 },
    ] }))
    // Тестовый демон читает управляемые настройки из PULT_HOME/claude-managed-settings.json; свои — без режима.
    writeFileSync(join(home.paths.home, 'claude-settings.json'), JSON.stringify({ permissions: { defaultMode: 'auto' } }))
    writeFileSync(join(home.paths.home, 'claude-managed-settings.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }))
    const d = await startTestDaemon(home)
    const win = await connectClient(home.paths, { client: 'shell' })
    try {
      await win.request('agent.prompt', { name: 'i', text: 'раз' })
      await win.request('agent.wait', { name: 'i', timeoutMs: 10_000 })
      assert.equal(mode(lastArgv(i.argvOut)), 'manual', 'bypass администратора без согласия не действует')
      const st = (await win.request('settings.get')) as { access: { claudeDefaultMode: string } }
      assert.equal(st.access.claudeDefaultMode, 'bypassPermissions', 'm3: окно видит управляемый режим, без «проекта» PULT_HOME')
      // m6: inherit без confirm при bypass — «нужно согласие», а не «нужен confirm».
      await assert.rejects(win.request('agent.start', { name: 'n', kind: 'claude', cwd: claudeWork(root, 'n').cwd, approval: 'inherit' }), code('consent_required'))
      await win.request('access.grantFull', GRANT)
      await win.request('agent.start', { name: 'n', kind: 'claude', cwd: claudeWork(root, 'n2').cwd, approval: 'inherit' })
    } finally { win.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
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

describe('ревью PR #39: сузили доступ — живые процессы, повторное разрешение', () => {
  it('M3 + Codex 6/7: повторный выбор «не разрешённого» полного уровня — не no-op; grant от окна — отказ', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-regrant-'))
    const d = await startTestDaemon(home)
    const cli = await connectClient(home.paths)
    const win = await connectClient(home.paths, { client: 'shell' })
    try {
      const f = claudeWork(root, 'f')
      // Оболочка старше этой версии не вырезает grant — демон отказывает сам.
      await assert.rejects(win.request('agent.start', { name: 'f', kind: 'claude', cwd: f.cwd, approval: 'full', confirm: true, grant: 'cli-once' }), code('forbidden'))
      await win.request('access.grantFull', GRANT)
      await win.request('agent.start', { name: 'f', kind: 'claude', cwd: f.cwd, approval: 'full', confirm: true })
      await cli.request('access.revokeFull')
      let row = ((await cli.request('agent.list')) as { sessions: Row[] }).sessions.find((r) => r.name === 'f')
      assert.equal(row?.access?.blocked, true)
      await assert.rejects(win.request('agent.configure', { name: 'f', approval: 'full', confirm: true, grant: 'cli-once' }), code('forbidden'))
      // Тот же уровень без разрешения — честный отказ, а не молчаливый no-op.
      await assert.rejects(win.request('agent.configure', { name: 'f', approval: 'full', confirm: true }), code('consent_required'))
      // CLI `--yes` на заблокированной сессии — разовое разрешение записано.
      const once = (await cli.request('agent.configure', { name: 'f', approval: 'full', confirm: true, grant: 'cli-once' })) as Row
      assert.equal(once.grant, 'cli-once')
      row = ((await cli.request('agent.list')) as { sessions: Row[] }).sessions.find((r) => r.name === 'f')
      assert.equal(row?.access?.blocked, false)
      await cli.request('agent.prompt', { name: 'f', text: 'раз' })
      await cli.request('agent.wait', { name: 'f', timeoutMs: 10_000 })
      assert.equal(mode(lastArgv(f.argvOut)), 'bypassPermissions')
    } finally { cli.close(); win.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })

  it('M5 Codex: тёплый Claude с полными правами без дела — метка красная, отзыв снимает процесс', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-warm-'))
    const d = await startTestDaemon(home)
    const win = await connectClient(home.paths, { client: 'shell' })
    try {
      const w = claudeWork(root, 'w', { scenario: 'warm' })
      await win.request('access.grantFull', GRANT)
      await win.request('agent.start', { name: 'w', kind: 'claude', cwd: w.cwd, approval: 'full', confirm: true, mode: 'warm' })
      await win.request('agent.prompt', { name: 'w', text: 'раз' })
      await win.request('agent.wait', { name: 'w', timeoutMs: 10_000 })
      const pid = (JSON.parse(readFileSync(w.argvOut, 'utf8').trim().split('\n').at(-1) as string) as { pid: number }).pid
      const alive = (): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
      assert.ok(alive(), 'тёплый процесс жив после хода')
      // Человек выбирает «Спрашивать» при живом согласии — процесс с bypass без дела снимается сразу.
      await win.request('agent.configure', { name: 'w', approval: 'ask' })
      assert.ok(await waitFor(() => !alive(), 5000), 'тёплый процесс с полными правами снят на понижении')
      const row = ((await win.request('agent.list')) as { sessions: Row[] }).sessions.find((r) => r.name === 'w')
      assert.deepEqual([row?.access?.live, row?.access?.red], [false, false])

      // Отзыв согласия: тёплый процесс второй сессии с полными правами тоже уходит, а пока жив — метка красная.
      const v = claudeWork(root, 'v', { scenario: 'warm' })
      await win.request('agent.start', { name: 'v', kind: 'claude', cwd: v.cwd, approval: 'full', confirm: true, mode: 'warm' })
      await win.request('agent.prompt', { name: 'v', text: 'раз' })
      await win.request('agent.wait', { name: 'v', timeoutMs: 10_000 })
      const vpid = (JSON.parse(readFileSync(v.argvOut, 'utf8').trim().split('\n').at(-1) as string) as { pid: number }).pid
      const before = ((await win.request('agent.list')) as { sessions: Row[] }).sessions.find((r) => r.name === 'v')
      assert.deepEqual([before?.access?.live, before?.access?.red], [true, true], 'тёплый процесс с bypass — живой, метка красная')
      await win.request('access.revokeFull')
      assert.ok(await waitFor(() => { try { process.kill(vpid, 0); return false } catch { return true } }, 5000), 'отзыв снял тёплый процесс')
    } finally { win.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })

  it('блокер Codex 2: отзыв → ход, начатый сервером Codex на треде с полными правами, остановлен', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-cx-srv-'))
    mkdirSync(join(root, 'x'), { recursive: true })
    const logOut = join(root, 'server.jsonl')
    writeFileSync(join(home.paths.home, '.pult-fake-scripted.json'), JSON.stringify({ logOut, bgPauseMs: 1500 }))
    const d = await startTestDaemon(home, { codexBin: FAKE_CODEX_SCRIPTED })
    const win = await connectClient(home.paths, { client: 'shell' })
    const raw = (): Array<Record<string, unknown>> => (existsSync(logOut)
      ? readFileSync(logOut, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [])
    const method = (x: Record<string, unknown>): unknown => (x['msg'] as { method?: unknown } | undefined)?.method
    try {
      await win.request('access.grantFull', GRANT)
      await win.request('agent.start', { name: 'x', kind: 'codex', cwd: join(root, 'x'), approval: 'full', confirm: true })
      await win.request('agent.prompt', { name: 'x', text: '[[server-turn]] начни' })
      await win.request('agent.wait', { name: 'x', timeoutMs: 15_000 })
      await win.request('access.revokeFull')
      assert.ok(await waitFor(() => raw().some((x) => method(x) === 'turn/interrupt'), 6000), 'ход сервера не остановлен')
      const evs = ((await win.request('events.tail', { since: 0, sessionId: 'x' })) as { events: Ev[] }).events
      assert.match(String(evs.find((e) => e.data['access'] === 'downgraded')?.data['notice']), /Codex начал ход сам на треде с полными правами — это полный доступ, а он не разрешён/)
      await new Promise((r) => setTimeout(r, 1800))
      const after = ((await win.request('events.tail', { since: 0, sessionId: 'x' })) as { events: Ev[] }).events
      assert.ok(after.some((e) => e.kind === 'status.changed' && e.data['status'] === 'interrupted'), 'ход сервера прерван')
      assert.ok(!after.some((e) => e.kind === 'status.changed' && e.data['reason'] === 'server_turn_done'), 'ход сервера не дошёл до конца')
    } finally { win.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })

  it('Codex 4: фон (субагент, команда) хода с полными правами держит красную метку после понижения', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-cx-bg-'))
    mkdirSync(join(root, 'b'), { recursive: true })
    writeFileSync(join(home.paths.home, '.pult-fake-scripted.json'), JSON.stringify({ logOut: join(root, 'server.jsonl'), bgPauseMs: 2500 }))
    const d = await startTestDaemon(home, { codexBin: FAKE_CODEX_SCRIPTED })
    const win = await connectClient(home.paths, { client: 'shell' })
    try {
      await win.request('access.grantFull', GRANT)
      await win.request('agent.start', { name: 'b', kind: 'codex', cwd: join(root, 'b'), approval: 'full', confirm: true })
      await win.request('agent.prompt', { name: 'b', text: '[[background]] начни' })
      await win.request('agent.wait', { name: 'b', timeoutMs: 15_000 })
      await win.request('agent.configure', { name: 'b', approval: 'ask' })
      const row = ((await win.request('agent.list')) as { sessions: Row[] }).sessions.find((r) => r.name === 'b')
      assert.deepEqual([row?.access?.live, row?.access?.red, row?.access?.pending], [true, true, true], 'фон жив с полными правами — метка красная')
    } finally { win.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })
})

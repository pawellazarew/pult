// Быстрый старт, шаг B (design/2026-11-02-quick-start/DESIGN-REVIEW.md §3.2, §3.3, §3.7–§3.9, §6): резолвер настроек
// нового чата, память папок (`folders.json`, ключ realpath + (dev, ino), worktree → основной репозиторий), черновики у
// демона (compare-and-set по rev, владелец-окно) и идемпотентный `agent.start {requestId, prompt}` — по-настоящему,
// через RPC демона и фальшивый `claude`, а не значения окна.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import { connectClient } from '../dist/cli/client.js'
import { createFolderStore, folderIdentity, FOLDERS_MAX, worktreeMainRepo } from '../dist/core/folders.js'
import { createDraftStore, DRAFT_OWNER_STALE_MS } from '../dist/core/drafts.js'
import { createStartJournal } from '../dist/core/startJournal.js'
import { resolveNewChat, shouldRemember, FOLDER_DEFAULT_ACCESS } from '../dist/sessions/resolve.js'
import { suggestName } from '../dist/sessions/naming.js'
import { startTestDaemon, tempHome, waitFor } from './helpers.js'

const code = (want: string) => (e: { code?: string }): boolean => e.code === want
const GRANT = { confirm: true, version: 1, providers: ['claude', 'codex', 'zcode'] }
const yes = (): boolean => true
const no = (): boolean => false

describe('шаг B: резолвер нового чата (§3.7, §3.8)', () => {
  it('доступ: память папки > умолчание провайдера > «Правки в папке»; CLI память не берёт', () => {
    assert.equal(FOLDER_DEFAULT_ACCESS, 'workspace', 'решение Павла 02.11: новая папка — «Правки в папке»')
    const base = { entry: 'user' as const, fullAllowed: yes }
    assert.deepEqual([resolveNewChat(base).approval, resolveNewChat(base).origin.approval], ['workspace', 'builtin'])
    const defaults = { claude: { approval: 'ask' as const }, codex: {}, zcode: {} }
    assert.equal(resolveNewChat({ ...base, defaults }).approval, 'ask')
    const mem = resolveNewChat({ ...base, defaults, folderAccess: 'read-only' })
    assert.deepEqual([mem.approval, mem.origin.approval], ['read-only', 'folder'], '«Только чтение» запоминается, как и остальные')
    assert.equal(resolveNewChat({ ...base, folderAccess: 'read-only', explicit: { approval: 'workspace' } }).approval, 'workspace', 'явный выбор сильнее')
    const cli = resolveNewChat({ entry: 'cli', folderAccess: 'full', defaults: { claude: { approval: 'workspace' }, codex: {}, zcode: {} }, fullAllowed: yes })
    assert.deepEqual([cli.approval, cli.origin.approval], ['ask', 'builtin'], 'CLI: ни память папки, ни умолчание окна — «Спрашивать» (§3.8)')
  })
  it('полный доступ сам не включается: без согласия — «Спрашивать» и «отозвано»; по ссылке — «Включить для этого чата»', () => {
    const revoked = resolveNewChat({ entry: 'user', folderAccess: 'full', fullAllowed: no })
    assert.deepEqual([revoked.approval, revoked.notes, revoked.blockedApproval], ['ask', ['full-revoked'], 'full'])
    const ok = resolveNewChat({ entry: 'user', folderAccess: 'full', fullAllowed: yes })
    assert.deepEqual([ok.approval, ok.notes], ['full', []], 'память папки + согласие — полный сразу (C2: 0 кликов)')
    const link = resolveNewChat({ entry: 'link', folderAccess: 'full', fullAllowed: yes })
    assert.deepEqual([link.approval, link.notes], ['ask', ['link-full-blocked']], 'ссылка не даёт полный даже при согласии (B3)')
    const clicked = resolveNewChat({ entry: 'link', folderAccess: 'full', fullAllowed: yes, explicit: { approval: 'full' } })
    assert.equal(clicked.approval, 'full', '«Включить для этого чата» — явный выбор в этом черновике')
    const inherit = resolveNewChat({ entry: 'user', folderAccess: 'inherit', fullAllowed: no, inheritMode: 'bypassPermissions' })
    assert.deepEqual([inherit.approval, inherit.notes], ['ask', ['full-revoked']], '«как в настройках» при bypass — тоже полный')
    assert.equal(resolveNewChat({ entry: 'user', provider: 'codex', folderAccess: 'inherit', fullAllowed: yes }).approval, 'ask', 'у Codex inherit нет')
  })
  it('провайдер, модель, браузер: ссылка, умолчания, встроенные; полный и Codex-«Правки» гасят браузер', () => {
    const defaults = { provider: 'codex' as const, claude: { model: 'opus', effort: 'high', browser: true }, codex: { browser: true }, zcode: {} }
    const r = resolveNewChat({ entry: 'user', defaults, fullAllowed: yes })
    assert.deepEqual([r.provider, r.origin.provider], ['codex', 'default'])
    assert.deepEqual([r.browser, r.notes], [false, ['browser-off']], 'Codex «Правки в папке» — браузер Пульта не включается')
    const l = resolveNewChat({ entry: 'link', provider: 'claude', providerOrigin: 'link', defaults, fullAllowed: yes })
    assert.deepEqual([l.provider, l.origin.provider, l.model, l.effort, l.browser], ['claude', 'link', 'opus', 'high', true])
    assert.deepEqual([resolveNewChat({ entry: 'user', fullAllowed: yes }).model, resolveNewChat({ entry: 'user', fullAllowed: yes }).origin.model], ['sonnet', 'builtin'])
    assert.equal(resolveNewChat({ entry: 'cli', defaults, fullAllowed: yes }).provider, 'claude', 'CLI провайдера из умолчаний не берёт')
  })
  it('память пишется только явным выбором, не «Только этот чат», не полный из ссылки', () => {
    assert.equal(shouldRemember({ approvalOrigin: 'explicit', chatOnly: false, entry: 'user', full: false }), true)
    assert.equal(shouldRemember({ approvalOrigin: 'folder', chatOnly: false, entry: 'user', full: false }), false, 'унаследованное само не закрепляется')
    assert.equal(shouldRemember({ approvalOrigin: 'explicit', chatOnly: true, entry: 'user', full: false }), false)
    assert.equal(shouldRemember({ approvalOrigin: 'explicit', chatOnly: false, entry: 'link', full: true }), false)
    assert.equal(shouldRemember({ approvalOrigin: 'explicit', chatOnly: false, entry: 'link', full: false }), true)
    assert.equal(shouldRemember({ approvalOrigin: 'explicit', chatOnly: false, entry: 'cli', full: false }), false)
  })
  it('имя из папки — латиница и свободное', () => {
    assert.equal(suggestName('/Users/user/Эхо Океана', []), 'eho-okeana')
    assert.equal(suggestName('/p/pult', new Set(['pult', 'pult-2'])), 'pult-3')
  })
})

describe('шаг B: память папок (§3.9)', () => {
  it('ключ — настоящая папка: symlink — та же папка; заменили папку — память не применяется', () => {
    const root = mkdtempSync(join(tmpdir(), 'pt-folders-'))
    try {
      const real = join(root, 'acme')
      mkdirSync(real)
      symlinkSync(real, join(root, 'link'))
      const store = createFolderStore(join(root, 'folders.json'))
      store.remember(join(root, 'link'), 'full')
      const a = store.recall(real)
      assert.equal(a?.access, 'full', 'symlink и папка — один ключ')
      assert.equal(folderIdentity(join(root, 'link'))?.key, folderIdentity(real)?.key)
      // Перечитывается с диска.
      assert.equal(createFolderStore(join(root, 'folders.json')).recall(real)?.access, 'full')
      // Папку заменили (новый inode): ключ тот же, памяти нет, «папка изменилась».
      renameSync(real, join(root, 'acme-old'))
      mkdirSync(real)
      const b = store.recall(join(root, 'link'))
      assert.deepEqual([b?.access, b?.changed], [undefined, true])
      // Вложенные и родительские папки ничего не наследуют.
      mkdirSync(join(real, 'sub'))
      store.remember(real, 'workspace')
      assert.equal(store.recall(join(real, 'sub'))?.access, undefined)
      assert.equal(store.recall(root)?.access, undefined)
      assert.equal(store.recall(join(root, 'missing')), null)
      // Режим файла — 0600.
      assert.equal((readFileSync(join(root, 'folders.json')).length > 0), true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('worktree пишет в ключ основного репозитория', () => {
    const root = mkdtempSync(join(tmpdir(), 'pt-wt-'))
    try {
      const repo = join(root, 'repo')
      mkdirSync(repo)
      const git = (...a: string[]): void => { execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.example', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.example' } }) }
      git('init', '-q')
      writeFileSync(join(repo, 'a'), 'a')
      git('add', 'a'); git('commit', '-qm', 'a')
      git('worktree', 'add', '-q', join(root, 'wt'), '-b', 'pult/x')
      assert.equal(worktreeMainRepo(join(root, 'wt')), folderIdentity(repo)?.key)
      const store = createFolderStore(join(root, 'folders.json'))
      store.remember(join(root, 'wt'), 'read-only')
      assert.equal(store.recall(repo)?.access, 'read-only')
      assert.equal(worktreeMainRepo(repo), null)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('история: «Очистить» оставляет память доступа; вытесняются только записи без памяти', () => {
    const root = mkdtempSync(join(tmpdir(), 'pt-hist-'))
    try {
      const mk = (n: string): string => { const p = join(root, n); mkdirSync(p, { recursive: true }); return p }
      const store = createFolderStore(join(root, 'folders.json'))
      const a = mk('a'), b = mk('b')
      store.use(a, new Date('2026-11-01T00:00:00Z'))
      store.use(b, new Date('2026-11-02T00:00:00Z'))
      store.remember(a, 'full')
      assert.deepEqual(store.recent(5).map((f) => f.path), [b, a], 'новые первыми')
      store.clearHistory()
      assert.deepEqual([store.recent(5).length, store.recall(a)?.access], [0, 'full'])
      assert.equal(store.forget(a), true)
      assert.equal(store.recall(a)?.access, undefined)
      // Предел: записи с памятью не вытесняются.
      const keep = mk('keep')
      store.remember(keep, 'read-only')
      for (let i = 0; i < FOLDERS_MAX + 3; i++) store.use(mk(`f/${i}`), new Date(Date.UTC(2026, 0, 1, 0, 0, i)))
      assert.equal(store.entries().length, FOLDERS_MAX)
      assert.equal(store.recall(keep)?.access, 'read-only')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('шаг B: черновики у демона (§3.2)', () => {
  it('compare-and-set по rev, владелец-окно, «Забрать» после протухшего пульса', () => {
    const root = mkdtempSync(join(tmpdir(), 'pt-drafts-'))
    let t = 1_000_000
    try {
      const store = createDraftStore(join(root, 'drafts'), () => t)
      const id = randomUUID()
      const a = store.put(id, { text: 'раз' }, 0, 'win-a')
      assert.deepEqual([a.rev, a.owner, a.ownerAlive], [1, 'win-a', true])
      assert.throws(() => store.put(id, { text: 'два' }, 0, 'win-a'), (e: { code?: string }) => e.code === 'draft_conflict', 'устаревший rev')
      assert.throws(() => store.put(id, { text: 'чужое' }, 1, 'win-b'), (e: { code?: string }) => e.code === 'draft_owned', 'чужое живое окно')
      t += DRAFT_OWNER_STALE_MS + 1
      assert.equal(store.list()[0]?.ownerAlive, false, 'пульс протух — можно забрать')
      const b = store.claim(id, 'win-b')
      assert.deepEqual([b.rev, b.owner], [2, 'win-b'])
      assert.throws(() => store.put(id, { text: 'три' }, 2, 'win-a'), (e: { code?: string }) => e.code === 'draft_owned')
      assert.equal(store.touch([id], 'win-b'), 1)
      assert.equal(store.remove(id, 'win-b'), true)
      assert.equal(store.list().length, 0)
      assert.throws(() => store.put('x', {}, 0, 'w'), (e: { code?: string }) => e.code === 'invalid_params')
      assert.throws(() => store.put(randomUUID(), { text: 'x'.repeat(300_000) }, 0, 'w'), (e: { code?: string }) => e.code === 'invalid_params')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

type Rec = { name: string; approval?: string; phase?: string; requestId?: string; promptError?: { code: string }; worktree?: { path: string; branch: string } }
const userMessages = async (c: { request(m: string, p?: Record<string, unknown>): Promise<unknown> }, name: string): Promise<number> => {
  const r = (await c.request('agent.read', { name, since: 0, format: 'json' })) as { events: Array<{ kind: string }> }
  return r.events.filter((e) => e.kind === 'message.user').length
}

describe('шаг B: agent.start {requestId, prompt} — один RPC, идемпотентно (§3.3)', () => {
  it('имя выделяет демон, реплика уходит одна; повтор — та же сессия без второй реплики', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-start-'))
    const d = await startTestDaemon(home)
    const win = await connectClient(home.paths, { client: 'shell' })
    try {
      const cwd = join(root, 'Эхо Океана')
      mkdirSync(cwd)
      const requestId = randomUUID()
      const params = { requestId, kind: 'claude', cwd, approval: 'read-only', prompt: 'Скажи одно слово', rememberAccess: true }
      const a = (await win.request('agent.start', params)) as Rec
      assert.deepEqual([a.name, a.phase, a.requestId], ['eho-okeana', 'running', requestId])
      await win.request('agent.wait', { name: a.name, timeoutMs: 10_000 })
      // Ответ «потерялся» — повтор с тем же requestId: та же сессия, реплика второй раз не уходит.
      const b = (await win.request('agent.start', params)) as Rec
      assert.deepEqual([b.name, b.phase], ['eho-okeana', 'running'])
      const list = ((await win.request('agent.list')) as { sessions: Rec[] }).sessions
      assert.equal(list.length, 1, 'второй сессии нет')
      assert.equal(await userMessages(win, a.name), 1, 'реплика одна')
      const st = (await win.request('agent.startStatus', { requestId })) as { phase: string; name: string }
      assert.deepEqual([st.phase, st.name], ['running', 'eho-okeana'])
      assert.ok(existsSync(join(home.paths.startJournal, `${requestId}.json`)))
      // Память папки: явный выбор из окна записан; следующий старт в той же папке получит имя -2.
      const pre = (await win.request('agent.preflight', { cwd })) as { ok: boolean; folder: { access?: string } }
      assert.deepEqual([pre.ok, pre.folder.access], [true, 'read-only'])
      const c = (await win.request('agent.start', { requestId: randomUUID(), kind: 'claude', cwd })) as Rec
      assert.equal(c.name, 'eho-okeana-2')
      // Одновременные повторы — одна сессия.
      const rid = randomUUID()
      const twin = await Promise.all([1, 2, 3].map(() => win.request('agent.start', { requestId: rid, kind: 'claude', cwd, prompt: 'раз' }) as Promise<Rec>))
      assert.equal(new Set(twin.map((x) => x.name)).size, 1)
      await win.request('agent.wait', { name: twin[0]?.name, timeoutMs: 10_000 })
      assert.equal(await userMessages(win, twin[0]?.name as string), 1)
      await assert.rejects(win.request('agent.startStatus', { requestId: randomUUID() }), code('not_found'))
      await assert.rejects(win.request('agent.start', { requestId: 'nope', kind: 'claude', cwd }), code('invalid_params'))
    } finally { win.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })

  it('reserveOnly держит имя за запросом; отказ до registered — имя то же, сессии нет', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-reserve-'))
    const d = await startTestDaemon(home)
    const win = await connectClient(home.paths, { client: 'shell' })
    try {
      const cwd = join(root, 'app')
      mkdirSync(cwd)
      const requestId = randomUUID()
      const r = (await win.request('agent.start', { requestId, kind: 'claude', cwd, reserveOnly: true })) as Rec
      assert.deepEqual([r.name, r.phase], ['app', 'name-reserved'])
      // Другой старт в той же папке имя брони не берёт.
      const other = (await win.request('agent.start', { requestId: randomUUID(), kind: 'claude', cwd })) as Rec
      assert.equal(other.name, 'app-2')
      const done = (await win.request('agent.start', { requestId, kind: 'claude', cwd })) as Rec
      assert.equal(done.name, 'app')
      // Отказ (полный доступ без согласия) — до заведения чего-либо; журнал помнит причину.
      const rid = randomUUID()
      await assert.rejects(win.request('agent.start', { requestId: rid, kind: 'claude', cwd, approval: 'full', confirm: true }), code('consent_required'))
      await assert.rejects(win.request('agent.startStatus', { requestId: rid }), code('not_found'), 'отказ проверки — до журнала')
      // Папка покрывает PULT_HOME — preflight говорит заранее.
      const pre = (await win.request('agent.preflight', { cwd: home.paths.home })) as { ok: boolean; refusal: string }
      assert.deepEqual([pre.ok, pre.refusal], [false, 'covers_pult_home'])
      assert.equal(((await win.request('agent.preflight', { cwd: join(root, 'missing') })) as { refusal: string }).refusal, 'missing')
      // worktree: true — ветку называет демон.
      execFileSync('git', ['-C', cwd, 'init', '-q'])
      writeFileSync(join(cwd, 'a'), 'a')
      execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@x.example', 'add', 'a'])
      execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@x.example', 'commit', '-qm', 'a'])
      const wt = (await win.request('agent.start', { requestId: randomUUID(), kind: 'claude', cwd, worktree: true })) as Rec
      assert.equal(wt.worktree?.branch, `pult/${wt.name}`)
    } finally { win.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })

  it('память папки: только окно, только rememberAccess; полный из ссылки не запоминается; смена в живом чате пишет', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-mem-'))
    const d = await startTestDaemon(home)
    const win = await connectClient(home.paths, { client: 'shell' })
    const cli = await connectClient(home.paths, { client: 'cli' })
    try {
      const mk = (n: string): string => { const p = join(root, n); mkdirSync(p); return p }
      const recall = async (cwd: string): Promise<string | undefined> =>
        ((await win.request('agent.preflight', { cwd })) as { folder?: { access?: string } }).folder?.access
      const a = mk('a')
      await cli.request('agent.start', { requestId: randomUUID(), kind: 'claude', cwd: a, approval: 'workspace', rememberAccess: true })
      assert.equal(await recall(a), undefined, 'CLI память не пишет')
      await win.request('agent.start', { requestId: randomUUID(), kind: 'claude', cwd: a, approval: 'workspace' })
      assert.equal(await recall(a), undefined, 'без rememberAccess («Только этот чат», унаследованное) — не пишет')
      const recent = (await win.request('folders.recent')) as { folders: Array<{ path: string; source: string }> }
      assert.ok(recent.folders.some((f) => f.path.endsWith('/a')), 'но в историю папка попала')
      await win.request('access.grantFull', GRANT)
      const b = mk('b')
      await win.request('agent.start', { requestId: randomUUID(), kind: 'claude', cwd: b, approval: 'full', confirm: true, rememberAccess: true, origin: 'link', approvalOrigin: 'explicit' })
      assert.equal(await recall(b), undefined, '«Включить для этого чата» из ссылки — не в память')
      const s = (await win.request('agent.start', { requestId: randomUUID(), kind: 'claude', cwd: b, approval: 'full', confirm: true, rememberAccess: true })) as Rec
      assert.equal(await recall(b), 'full', 'явный полный при согласии — в память')
      await win.request('agent.configure', { name: s.name, approval: 'read-only', rememberAccess: true })
      assert.equal(await recall(b), 'read-only', 'смена в живом чате пишет память')
      await win.request('agent.configure', { name: s.name, approval: 'ask' })
      assert.equal(await recall(b), 'read-only', 'без rememberAccess — нет')
      assert.equal(((await win.request('folders.forget', { path: b })) as { forgotten: boolean }).forgotten, true)
      assert.equal(await recall(b), undefined)
    } finally { win.close(); cli.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })

  it('реплика не принята — сессия остаётся, ответ с promptError; «Повторить» шлёт её один раз', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-perr-'))
    const d = await startTestDaemon(home)
    const win = await connectClient(home.paths, { client: 'shell' })
    try {
      const cwd = join(root, 'p')
      mkdirSync(cwd)
      const requestId = randomUUID()
      // Провайдер остановлен целиком — реплика не уйдёт (агент заведён раньше остановки нельзя, поэтому — пробел).
      const r = (await win.request('agent.start', { requestId, kind: 'claude', cwd, prompt: '   ' })) as Rec
      assert.equal(r.phase, 'registered', 'пустая реплика не шлётся вовсе')
      const again = (await win.request('agent.start', { requestId, kind: 'claude', cwd, prompt: 'теперь по делу' })) as Rec
      assert.equal(again.phase, 'running', 'повтор с тем же requestId отдаёт реплику существующей сессии')
      await win.request('agent.wait', { name: again.name, timeoutMs: 10_000 })
      const third = (await win.request('agent.start', { requestId, kind: 'claude', cwd, prompt: 'теперь по делу' })) as Rec
      assert.equal(third.phase, 'running')
      assert.equal(await userMessages(win, again.name), 1)
      await win.request('agent.rm', { name: again.name })
      await assert.rejects(win.request('agent.start', { requestId, kind: 'claude', cwd }), code('not_found'), 'сессию удалили — второй не заводим')
      assert.ok(await waitFor(() => true))
    } finally { win.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })

  it('черновики через RPC: put/list/claim/remove; журнал стартов чистится по сроку', async () => {
    const home = tempHome()
    const d = await startTestDaemon(home)
    const win = await connectClient(home.paths, { client: 'shell' })
    try {
      const id = randomUUID()
      const put = (await win.request('draft.put', { id, data: { text: 'черновик', cwd: null }, baseRev: 0, owner: 'w1' })) as { draft: { rev: number } }
      assert.equal(put.draft.rev, 1)
      await assert.rejects(win.request('draft.put', { id, data: {}, baseRev: 0, owner: 'w1' }), code('draft_conflict'))
      await assert.rejects(win.request('draft.put', { id, data: {}, baseRev: 1, owner: 'w2' }), code('draft_owned'))
      const list = (await win.request('draft.list')) as { drafts: Array<{ id: string; rev: number }> }
      assert.deepEqual(list.drafts.map((x) => [x.id, x.rev]), [[id, 1]])
      assert.equal(((await win.request('draft.get', { id })) as { draft: { data: { text: string } } }).draft.data.text, 'черновик')
      await win.request('draft.claim', { id, owner: 'w2' })
      assert.deepEqual(await win.request('draft.remove', { id, owner: 'w2' }), { removed: true })
      const j = createStartJournal(join(home.paths.home, 'jtest'), () => Date.now() + 8 * 24 * 3600 * 1000)
      j.put({ requestId: id, phase: 'accepted', at: new Date().toISOString(), updatedAt: '' })
      assert.equal(j.prune(), 1)
    } finally { win.close(); await d.stop('конец теста'); home.remove() }
  })
})

describe('ревью шага B: подделка .git и зависание на служебных файлах git (B1, M1)', () => {
  const git = (cwd: string, ...a: string[]): void => {
    execFileSync('git', ['-C', cwd, ...a], { stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.example', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.example' } })
  }
  it('поддельный .git (gitdir + commondir на чужой репозиторий) память не наследует; копия .git настоящего worktree — тоже', () => {
    const root = mkdtempSync(join(tmpdir(), 'pt-forge-'))
    try {
      const trusted = join(root, 'trusted')
      mkdirSync(trusted)
      git(trusted, 'init', '-q')
      writeFileSync(join(trusted, 'a'), 'a')
      git(trusted, 'add', 'a'); git(trusted, 'commit', '-qm', 'a')
      const store = createFolderStore(join(root, 'folders.json'))
      store.remember(trusted, 'full')
      // Сценарий Opus B1: агент пишет два файла в папку A.
      const evil = join(root, 'evil')
      mkdirSync(join(evil, 'x'), { recursive: true })
      writeFileSync(join(evil, '.git'), 'gitdir: ./x\n')
      writeFileSync(join(evil, 'x', 'commondir'), join(trusted, '.git') + '\n')
      assert.equal(worktreeMainRepo(evil), null)
      assert.equal(folderIdentity(evil)?.key, folderIdentity(evil)?.key && realpathSync(evil))
      assert.equal(store.recall(evil)?.access, undefined, 'доступ trusted не перешёл')
      // Сценарий Codex 4: скопировать .git настоящего worktree — обратная ссылка ведёт не сюда.
      git(trusted, 'worktree', 'add', '-q', join(root, 'wt'), '-b', 'pult/wt')
      const copy = join(root, 'copy')
      mkdirSync(copy)
      writeFileSync(join(copy, '.git'), readFileSync(join(root, 'wt', '.git')))
      assert.equal(worktreeMainRepo(copy), null)
      assert.equal(store.recall(copy)?.access, undefined)
      // Настоящий worktree сопоставляется, но полный доступ через сопоставление не наследует; «Только чтение» — да.
      assert.equal(worktreeMainRepo(join(root, 'wt')), realpathSync(trusted))
      const wt = store.recall(join(root, 'wt'))
      assert.deepEqual([wt?.key, wt?.mapped, wt?.access], [realpathSync(trusted), true, undefined])
      store.remember(trusted, 'read-only')
      assert.equal(store.recall(join(root, 'wt'))?.access, 'read-only')
      // Полный, выбранный в worktree, основному репозиторию не передаётся.
      store.remember(join(root, 'wt'), 'full')
      assert.equal(store.recall(trusted)?.access, 'read-only')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('FIFO, /dev/zero и огромный .git не вешают: ответ сразу, папка — сама собой', () => {
    const root = mkdtempSync(join(tmpdir(), 'pt-fifo-'))
    try {
      const fifo = join(root, 'fifo')
      mkdirSync(join(fifo, 'x'), { recursive: true })
      writeFileSync(join(fifo, '.git'), 'gitdir: ./x\n')
      execFileSync('mkfifo', [join(fifo, 'x', 'commondir')])
      const zero = join(root, 'zero')
      mkdirSync(join(zero, 'x'), { recursive: true })
      writeFileSync(join(zero, '.git'), 'gitdir: ./x\n')
      symlinkSync('/dev/zero', join(zero, 'x', 'commondir'))
      const fifoGit = join(root, 'fifogit')
      mkdirSync(fifoGit)
      execFileSync('mkfifo', [join(fifoGit, '.git')])
      const huge = join(root, 'huge')
      mkdirSync(huge)
      writeFileSync(join(huge, '.git'), 'gitdir: ' + 'a'.repeat(5000))
      // В дочернем процессе с таймаутом: зависни разбор — тест упадёт по времени, а не повесит прогон.
      const script = `import('${new URL('../dist/core/folders.js', import.meta.url).href}').then((m) => { for (const d of process.argv.slice(1)) process.stdout.write(String(m.folderIdentity(d)?.key) + '\\n') })`
      const out = execFileSync(process.execPath, ['-e', script, fifo, zero, fifoGit, huge], { timeout: 10_000, encoding: 'utf8' })
      assert.deepEqual(out.trim().split('\n'), [fifo, zero, fifoGit, huge].map((d) => realpathSync(d)))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('ревью шага B: старт после сбоев, повтор с другим текстом, черновик и папка на старте', () => {
  type Ctl = { request(m: string, p?: Record<string, unknown>): Promise<unknown> }
  it('сессия записана, журнал — нет (упал между ними): повтор находит её по requestId, а не заводит заново', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-crash-'))
    const d = await startTestDaemon(home)
    const win = await connectClient(home.paths, { client: 'shell' }) as unknown as Ctl
    try {
      const cwd = join(root, 'app')
      mkdirSync(cwd)
      const j = createStartJournal(home.paths.startJournal)
      const rid = randomUUID()
      const a = (await win.request('agent.start', { requestId: rid, kind: 'claude', cwd })) as Rec
      // Демон «упал» до записи registered: журнал откатываем на бронь имени.
      j.put({ requestId: rid, phase: 'name-reserved', name: a.name, at: new Date().toISOString(), updatedAt: '' })
      const b = (await win.request('agent.start', { requestId: rid, kind: 'claude', cwd, prompt: 'раз' })) as Rec & { promptSent?: boolean }
      assert.deepEqual([b.name, b.phase, b.promptSent], [a.name, 'running', true])
      await win.request('agent.wait', { name: a.name, timeoutMs: 10_000 })
      assert.equal(((await win.request('agent.list')) as { sessions: Rec[] }).sessions.length, 1)

      // Упал после записи `prompt-accepted`, реплика дошла: повтор не шлёт, а другой текст — `promptDiffers`.
      j.put({ requestId: rid, phase: 'prompt-accepted', name: a.name, at: new Date().toISOString(), updatedAt: '', promptHash: createHash('sha256').update('раз').digest('hex'), promptFrom: 0 })
      const same = (await win.request('agent.start', { requestId: rid, kind: 'claude', cwd, prompt: 'раз' })) as Rec & { duplicate?: boolean; promptSent?: boolean; promptDiffers?: boolean }
      assert.deepEqual([same.duplicate, same.promptSent, same.promptDiffers], [true, true, undefined])
      const edited = (await win.request('agent.start', { requestId: rid, kind: 'claude', cwd, prompt: 'два' })) as Rec & { duplicate?: boolean; promptDiffers?: boolean }
      assert.deepEqual([edited.duplicate, edited.promptDiffers], [true, true])
      assert.equal(await userMessages(win, a.name), 1, 'реплика одна')

      // Упал после `prompt-accepted`, но до записи реплики: повтор её отдаёт (одну).
      const rid2 = randomUUID()
      const c = (await win.request('agent.start', { requestId: rid2, kind: 'claude', cwd })) as Rec
      j.put({ requestId: rid2, phase: 'prompt-accepted', name: c.name, at: new Date().toISOString(), updatedAt: '', promptHash: createHash('sha256').update('три').digest('hex'), promptFrom: 1e9 })
      const c2 = (await win.request('agent.start', { requestId: rid2, kind: 'claude', cwd, prompt: 'три' })) as Rec & { promptSent?: boolean }
      assert.equal(c2.promptSent, true)
      await win.request('agent.wait', { name: c.name, timeoutMs: 10_000 })
      assert.equal(await userMessages(win, c.name), 1)
    } finally { (win as unknown as { close(): void }).close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })

  it('имя переиспользовали: повтор старого запроса не попадает в чужую сессию; бронь имени заняли — новое имя', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-reuse-'))
    const d = await startTestDaemon(home)
    const win = await connectClient(home.paths, { client: 'shell' }) as unknown as Ctl
    const cli = await connectClient(home.paths, { client: 'cli' }) as unknown as Ctl
    try {
      const cwd = join(root, 'app')
      mkdirSync(cwd)
      const rid = randomUUID()
      const a = (await win.request('agent.start', { requestId: rid, kind: 'claude', cwd })) as Rec
      await win.request('agent.rm', { name: a.name })
      await cli.request('agent.start', { name: a.name, kind: 'claude', cwd })
      await assert.rejects(win.request('agent.start', { requestId: rid, kind: 'claude', cwd, prompt: 'чужому не уйдёт' }), code('not_found'))
      assert.equal(await userMessages(win, a.name), 0)
      // Бронь `reserveOnly` заняла сессия из терминала с тем же именем — повтор берёт новое имя.
      const r2 = randomUUID()
      const res = (await win.request('agent.start', { requestId: r2, kind: 'claude', cwd, reserveOnly: true })) as Rec
      await cli.request('agent.start', { name: res.name, kind: 'claude', cwd })
      const s2 = (await win.request('agent.start', { requestId: r2, kind: 'claude', cwd })) as Rec
      assert.notEqual(s2.name, res.name)
    } finally { (win as unknown as { close(): void }).close(); (cli as unknown as { close(): void }).close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })

  it('черновик на старте: чужая ревизия и чужое живое окно — отказ; отправленный черновик демон убирает; папку подменили — folder_changed', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-dref-'))
    const d = await startTestDaemon(home)
    const win = await connectClient(home.paths, { client: 'shell' }) as unknown as Ctl
    try {
      const cwd = join(root, 'app')
      mkdirSync(cwd)
      const id = randomUUID()
      await win.request('draft.put', { id, data: { text: 'x' }, baseRev: 0, owner: 'wa' })
      await win.request('draft.put', { id, data: { text: 'xy' }, baseRev: 1, owner: 'wa' })
      await assert.rejects(win.request('agent.start', { requestId: id, kind: 'claude', cwd, draft: { id, rev: 1, owner: 'wa' } }), code('draft_conflict'))
      await assert.rejects(win.request('agent.start', { requestId: id, kind: 'claude', cwd, draft: { id, rev: 2, owner: 'wb' } }), code('draft_owned'))
      const pre = (await win.request('agent.preflight', { cwd })) as { folder: { key: string; dev: string; ino: string } }
      const folder = { key: pre.folder.key, dev: pre.folder.dev, ino: pre.folder.ino }
      // Папку заменили после проверки окна.
      renameSync(cwd, join(root, 'app-old'))
      mkdirSync(cwd)
      await assert.rejects(win.request('agent.start', { requestId: id, kind: 'claude', cwd, folder, draft: { id, rev: 2, owner: 'wa' } }), code('folder_changed'))
      const pre2 = (await win.request('agent.preflight', { cwd })) as { folder: { key: string; dev: string; ino: string } }
      const ok = (await win.request('agent.start', { requestId: id, kind: 'claude', cwd, folder: { key: pre2.folder.key, dev: pre2.folder.dev, ino: pre2.folder.ino }, draft: { id, rev: 2, owner: 'wa' } })) as Rec
      assert.equal(ok.phase, 'registered')
      assert.equal(existsSync(join(home.paths.drafts, `${id}.json`)), false, 'отправленный черновик убран демоном')
    } finally { (win as unknown as { close(): void }).close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })

  it('ссылка: полный доступ (и «как в настройках» при bypass в проекте) — только явным выбором; preflight отдаёт режим папки', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-link-'))
    const d = await startTestDaemon(home)
    const win = await connectClient(home.paths, { client: 'shell' }) as unknown as Ctl
    try {
      await win.request('access.grantFull', GRANT)
      const cwd = join(root, 'proj')
      mkdirSync(join(cwd, '.claude'), { recursive: true })
      writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }))
      const pre = (await win.request('agent.preflight', { cwd })) as { inheritMode: string }
      assert.equal(pre.inheritMode, 'bypassPermissions', 'режим ЭТОЙ папки, с её .claude/settings.json')
      for (const approval of ['full', 'inherit']) {
        await assert.rejects(win.request('agent.start', { requestId: randomUUID(), kind: 'claude', cwd, approval, confirm: true, origin: 'link' }), code('link_full_refused'), approval)
      }
      const ok = (await win.request('agent.start', { requestId: randomUUID(), kind: 'claude', cwd, approval: 'inherit', confirm: true, origin: 'link', approvalOrigin: 'explicit' })) as Rec
      assert.equal(ok.approval, 'inherit')
    } finally { (win as unknown as { close(): void }).close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })

  it('draft.list — без тел и страницами; draft.get — тело; удалённый черновик снимает бронь имени', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-dlist-'))
    const d = await startTestDaemon(home)
    const win = await connectClient(home.paths, { client: 'shell' }) as unknown as Ctl
    try {
      const big = 'я'.repeat(100_000)
      const ids = [randomUUID(), randomUUID(), randomUUID()]
      for (const id of ids) await win.request('draft.put', { id, data: { text: big }, baseRev: 0, owner: 'w' })
      const page = (await win.request('draft.list', { limit: 2 })) as { drafts: Array<Record<string, unknown>>; total: number }
      assert.deepEqual([page.drafts.length, page.total, 'data' in (page.drafts[0] ?? {})], [2, 3, false])
      assert.ok((page.drafts[0]?.['bytes'] as number) > 100_000)
      const one = (await win.request('draft.get', { id: ids[0] })) as { draft: { data: { text: string } } }
      assert.equal(one.draft.data.text.length, 100_000)
      const cwd = join(root, 'app')
      mkdirSync(cwd)
      const res = (await win.request('agent.start', { requestId: ids[0], kind: 'claude', cwd, reserveOnly: true })) as Rec
      await win.request('draft.remove', { id: ids[0], owner: 'w' })
      await assert.rejects(win.request('agent.startStatus', { requestId: ids[0] }), code('not_found'), 'бронь снята')
      const again = (await win.request('agent.start', { requestId: randomUUID(), kind: 'claude', cwd, reserveOnly: true })) as Rec
      assert.equal(again.name, res.name, 'имя свободно снова')
    } finally { (win as unknown as { close(): void }).close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })
})

describe('перепроверка Codex: настоящая папка сессии, захват черновика, отказ say, другие настройки повтора, файлы настроек', () => {
  type Ctl = { request(m: string, p?: Record<string, unknown>): Promise<unknown>; close(): void }
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.example', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.example' }
  const git = (cwd: string, ...a: string[]): void => { execFileSync('git', ['-C', cwd, ...a], { stdio: 'ignore', env: gitEnv }) }

  it('«как в настройках Claude» проверяется в папке worktree: там bypass (без settings.local.json исходной) — отказ access_changed', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-wtmode-'))
    const d = await startTestDaemon(home)
    const win = await connectClient(home.paths, { client: 'shell' }) as unknown as Ctl
    try {
      await win.request('access.grantFull', GRANT)
      const repo = join(root, 'repo')
      mkdirSync(join(repo, '.claude'), { recursive: true })
      git(repo, 'init', '-q')
      writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }))
      writeFileSync(join(repo, '.gitignore'), '.claude/settings.local.json\n')
      git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'a')
      // Исходная папка перекрывает bypass локальным файлом — в worktree его нет.
      writeFileSync(join(repo, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { defaultMode: 'default' } }))
      assert.equal(((await win.request('agent.preflight', { cwd: repo })) as { inheritMode: string }).inheritMode, 'default')
      for (const origin of ['link', 'user']) {
        await assert.rejects(win.request('agent.start', { requestId: randomUUID(), kind: 'claude', cwd: repo, approval: 'inherit', worktree: true, origin }), code('access_changed'), origin)
      }
      assert.equal(((await win.request('agent.list')) as { sessions: Rec[] }).sessions.length, 0, 'сессии нет')
      // Без worktree — та же папка, что проверена: можно.
      const ok = (await win.request('agent.start', { requestId: randomUUID(), kind: 'claude', cwd: repo, approval: 'inherit' })) as Rec
      assert.equal(ok.approval, 'inherit')
    } finally { win.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })

  it('старт держит черновик: «Забрать» и запись из другого окна во время старта — draft_starting; отказ say — черновик цел', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-claim-'))
    const d = await startTestDaemon(home)
    const win = await connectClient(home.paths, { client: 'shell' }) as unknown as Ctl
    const cli = await connectClient(home.paths, { client: 'cli' }) as unknown as Ctl
    try {
      const repo = join(root, 'repo')
      mkdirSync(repo)
      git(repo, 'init', '-q'); writeFileSync(join(repo, 'a'), 'a'); git(repo, 'add', 'a'); git(repo, 'commit', '-qm', 'a')
      const id = randomUUID()
      await win.request('draft.put', { id, data: { text: 'задача' }, baseRev: 0, owner: 'wa' })
      const start = win.request('agent.start', { requestId: id, kind: 'claude', cwd: repo, worktree: true, prompt: 'задача', draft: { id, rev: 1, owner: 'wa' } })
      // Пока идёт git worktree add (журнал уже на фазе worktree) — окно B пытается забрать и переписать.
      const j = createStartJournal(home.paths.startJournal)
      assert.ok(await waitFor(() => j.get(id)?.phase === 'worktree', 5000), 'старт не дошёл до worktree')
      await assert.rejects(win.request('draft.claim', { id, owner: 'wb' }), code('draft_starting'))
      await assert.rejects(win.request('draft.put', { id, data: { text: 'чужое' }, baseRev: 1, owner: 'wb' }), code('draft_starting'))
      const r = (await start) as Rec & { promptSent?: boolean }
      assert.equal(r.promptSent, true)
      assert.equal(existsSync(join(home.paths.drafts, `${id}.json`)), false, 'принятая реплика — черновик убран')

      // Отказ say (сессия занята ходом): реплика не принята — черновик остаётся, повтор возможен.
      const cwd = join(root, 'busy')
      mkdirSync(cwd)
      writeFileSync(join(cwd, '.pult-fake.json'), JSON.stringify({ scenario: 'simple', speed: 0, hangAfterInit: 60_000 }))
      const id2 = randomUUID()
      const s = (await win.request('agent.start', { requestId: id2, kind: 'claude', cwd })) as Rec
      await cli.request('agent.prompt', { name: s.name, text: 'висим' })
      await win.request('draft.put', { id: id2, data: { text: 'вторая' }, baseRev: 0, owner: 'wa' })
      const busy = (await win.request('agent.start', { requestId: id2, kind: 'claude', cwd, prompt: 'вторая', draft: { id: id2, rev: 1, owner: 'wa' } })) as Rec & { promptSent?: boolean; promptError?: { code: string } }
      assert.deepEqual([busy.promptSent, !!busy.promptError], [false, true])
      assert.equal(existsSync(join(home.paths.drafts, `${id2}.json`)), true, 'отказ say — черновик цел')
      await cli.request('agent.stop', { name: s.name })
    } finally { win.close(); cli.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })

  it('ответ на отправку черновика потерялся: повтор — тот же чат и duplicate, а не draft_conflict', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-lost-'))
    const d = await startTestDaemon(home)
    const win = await connectClient(home.paths, { client: 'shell' }) as unknown as Ctl
    try {
      const cwd = join(root, 'app')
      mkdirSync(cwd)
      const id = randomUUID()
      await win.request('draft.put', { id, data: { text: 'задача' }, baseRev: 0, owner: 'wa' })
      const p = { requestId: id, kind: 'claude', cwd, prompt: 'задача', draft: { id, rev: 1, owner: 'wa' } }
      const first = (await win.request('agent.start', p)) as Rec & { promptSent?: boolean }
      assert.equal(first.promptSent, true)
      assert.equal(existsSync(join(home.paths.drafts, `${id}.json`)), false)
      const again = (await win.request('agent.start', p)) as Rec & { promptSent?: boolean; duplicate?: boolean }
      assert.deepEqual([again.name, again.promptSent, again.duplicate], [first.name, true, true])
      assert.equal(await userMessages(win, first.name), 1, 'реплика ушла один раз')
      // Чата по этому запросу нет, а черновик удалили — по-прежнему отказ, старт не заводится.
      const id2 = randomUUID()
      await win.request('draft.put', { id: id2, data: { text: 'x' }, baseRev: 0, owner: 'wa' })
      await win.request('draft.remove', { id: id2, owner: 'wa' })
      await assert.rejects(win.request('agent.start', { requestId: id2, kind: 'claude', cwd, prompt: 'x', draft: { id: id2, rev: 1, owner: 'wa' } }), code('draft_conflict'))
    } finally { (win as unknown as { close(): void }).close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })

  it('настройки Claude, которые нельзя прочитать безопасно (больше 1 МБ, FIFO), — режим неизвестен, считается полным', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-bigset-'))
    const d = await startTestDaemon(home)
    const win = await connectClient(home.paths, { client: 'shell' }) as unknown as Ctl
    try {
      await win.request('access.grantFull', GRANT)
      const big = join(root, 'big')
      mkdirSync(join(big, '.claude'), { recursive: true })
      writeFileSync(join(big, '.claude', 'settings.json'), JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 10), permissions: { defaultMode: 'bypassPermissions' } }))
      const fifo = join(root, 'fifo')
      mkdirSync(join(fifo, '.claude'), { recursive: true })
      execFileSync('mkfifo', [join(fifo, '.claude', 'settings.local.json')])
      for (const cwd of [big, fifo]) {
        const pre = (await win.request('agent.preflight', { cwd })) as { inheritMode: string | null }
        assert.equal(pre.inheritMode, 'bypassPermissions', cwd)
        await assert.rejects(win.request('agent.start', { requestId: randomUUID(), kind: 'claude', cwd, approval: 'inherit', confirm: true, origin: 'link' }), code('link_full_refused'), cwd)
      }
    } finally { (win as unknown as { close(): void }).close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })

  it('повтор того же requestId с другими настройками: после заведения — start_changed; до — новый старт', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-shape-'))
    const d = await startTestDaemon(home)
    const win = await connectClient(home.paths, { client: 'shell' }) as unknown as Ctl
    try {
      const a = join(root, 'alpha'), b = join(root, 'beta')
      mkdirSync(a); mkdirSync(b)
      const rid = randomUUID()
      await win.request('agent.start', { requestId: rid, kind: 'claude', cwd: a, approval: 'read-only' })
      await assert.rejects(win.request('agent.start', { requestId: rid, kind: 'claude', cwd: a, approval: 'workspace', prompt: 'x' }), code('start_changed'))
      await assert.rejects(win.request('agent.start', { requestId: rid, kind: 'claude', cwd: b, approval: 'read-only' }), code('start_changed'))
      const r2 = randomUUID()
      const res = (await win.request('agent.start', { requestId: r2, kind: 'claude', cwd: a, reserveOnly: true })) as Rec
      assert.equal(res.name, 'alpha-2')
      const moved = (await win.request('agent.start', { requestId: r2, kind: 'claude', cwd: b })) as Rec
      assert.equal(moved.name, 'beta', 'до заведения другая папка — новый старт с её именем')
    } finally { win.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })

  it('настройки Claude проекта: FIFO и /dev/zero не вешают (режим неизвестен — полный), симлинк на обычный файл читается', () => {
    const root = mkdtempSync(join(tmpdir(), 'pt-setfifo-'))
    try {
      const fifo = join(root, 'fifo.json')
      execFileSync('mkfifo', [fifo])
      const zero = join(root, 'zero.json')
      symlinkSync('/dev/zero', zero)
      const real = join(root, 'real.json')
      writeFileSync(real, JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }))
      const link = join(root, 'link.json')
      symlinkSync(real, link)
      const script = `import('${new URL('../dist/mcp/browser.js', import.meta.url).href}').then((m) => process.stdout.write(String(m.claudeDefaultMode(process.argv.slice(1)))))`
      assert.equal(execFileSync(process.execPath, ['-e', script, fifo, zero], { timeout: 10_000, encoding: 'utf8' }), 'bypassPermissions')
      assert.equal(execFileSync(process.execPath, ['-e', script, fifo, zero, link], { timeout: 10_000, encoding: 'utf8' }), 'acceptEdits')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

// Плашка обновления (M8c): состояния по `daemon.status.update` и версии окна — модель и разметка.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { UpdateBanner } from '../src/components/UpdateBanner.js'
import { SettingsDialog, UpdatesSection } from '../src/components/Settings.js'
import type { UpdatesPanel } from '../src/components/Settings.js'
import {
  addDismissed, applyErrorText, checkedAgoText, checkErrorText, DISMISSED_MAX, FOCUS_CHECK_STALE_MS, focusCheckWanted, updateBanner, updateSection,
  upToDateNote, windowVersionFromUA,
} from '../src/model/update.js'
import { settingsParams } from '../src/model/sessionSettings.js'
import type { UpdateStatus } from '../../src/core/rpc.js'

const text = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const noop = (): void => {}

const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  enabled: true,
  current: '0.2.27',
  checking: false,
  checkedAt: '2026-10-19T10:00:00Z',
  error: null,
  latest: {
    version: '1.0.3', released: '2026-10-19T09:00:00Z',
    notes: 'https://github.com/pawellazarew/pult/releases/tag/v1.0.3',
    app: { version: '0.2.0', minVersion: '0.1.13' },
  },
  available: true,
  bad: false,
  apply: { state: 'idle' },
  failure: null,
  ...over,
})

const render = (u: UpdateStatus | null, win: string | null = '0.1.14', dismissed: string[] = []): string =>
  renderToStaticMarkup(createElement(UpdateBanner, { view: updateBanner(u, win, dismissed), busy: false, onAction: noop, onNotes: noop, onDismiss: noop }))

describe('версия окна из user agent Electron', () => {
  it('Pult.app и рабочая копия; чужой UA — null', () => {
    const base = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)'
    assert.equal(windowVersionFromUA(`${base} Pult/0.1.14 Chrome/140.0.0.0 Electron/44.4.5 Safari/537.36`), '0.1.14')
    assert.equal(windowVersionFromUA(`${base} pult-shell/0.1.14 Chrome/140.0.0.0 Electron/44.4.5 Safari/537.36`), '0.1.14')
    assert.equal(windowVersionFromUA(`${base} Chrome/140.0.0.0 Safari/537.36`), null)
    assert.equal(windowVersionFromUA(`${base} NotPult/9.9.9 Chrome/1`), null)
    assert.equal(windowVersionFromUA(undefined), null)
  })
})

describe('плашка обновления: состояния', () => {
  it('доступна — «Доступна 1.0.3 · Что нового · Обновить», можно скрыть', () => {
    const out = render(status())
    assert.match(out, /data-testid="update-available"/)
    assert.equal(text(out), 'Доступна 1.0.3 Что нового Обновить')
    assert.match(out, /data-testid="update-dismiss"/)
    assert.match(out, /role="status"/)
  })

  it('нечего ставить, bad, нет статуса, скрыта крестиком — плашки нет', () => {
    assert.equal(render(status({ available: false })), '')
    assert.equal(render(status({ available: false, bad: true })), '')
    assert.equal(render(null), '')
    assert.equal(render(status(), '0.1.14', ['1.0.3']), '')
    // Скрыта прошлая версия — новая снова видна.
    assert.match(render(status(), '0.1.14', ['1.0.2']), /Доступна 1\.0\.3/)
  })

  it('ходы идут — «Обновлю после окончания ходов (N идут) · Сейчас»', () => {
    const out = render(status({ apply: { state: 'waiting', turns: 2, since: '2026-10-19T10:00:00Z', to: '1.0.3' } }))
    assert.match(out, /data-testid="update-waiting"/)
    assert.match(text(out), /Обновлю до 1\.0\.3 после окончания ходов \(2 идут\)/)
    assert.match(text(out), /Сейчас/)
    assert.doesNotMatch(out, /update-dismiss/)
    assert.match(text(render(status({ apply: { state: 'waiting', turns: 1, since: 'x', to: '1.0.3' } }))), /\(1 идёт\)/)
    assert.match(text(render(status({ apply: { state: 'waiting', turns: 21, since: 'x', to: '1.0.3' } }))), /\(21 идёт\)/)
    assert.match(text(render(status({ apply: { state: 'waiting', turns: 11, since: 'x', to: '1.0.3' } }))), /\(11 идут\)/)
    // «Сейчас» — это force.
    assert.deepEqual(updateBanner(status({ apply: { state: 'waiting', turns: 2, since: 'x', to: '1.0.3' } }), null)?.action, { label: 'Сейчас', force: true })
  })

  it('ставится — без кнопок; не удалось — причина и «Повторить»', () => {
    const applying = render(status({ apply: { state: 'applying', since: 'x', to: '1.0.3' } }))
    assert.match(text(applying), /Обновляю до 1\.0\.3… Демон перезапустится, окно переподключится само; новые реплики — после перезапуска/)
    assert.doesNotMatch(applying, /data-testid="update-apply"/)
    const failed = render(status({ apply: { state: 'failed', at: 'x', error: 'pult update вышел с кодом 1' } }))
    assert.match(failed, /data-testid="update-failed"/)
    assert.match(text(failed), /Обновление не удалось: pult update вышел с кодом 1/)
    assert.match(text(failed), /Повторить/)
    // Скрытая версия не прячет провал: его человек запустил сам.
    assert.match(render(status({ apply: { state: 'failed', at: 'x', error: 'e' } }), '0.1.14', ['1.0.3']), /update-failed/)
  })

  it('окно старше app.minVersion — «Нужна новая версия окна», ссылка на релиз, без «Обновить»', () => {
    const u = status({ latest: { ...status().latest!, app: { version: '0.2.0', minVersion: '0.1.14' } } })
    const out = render(u, '0.1.13')
    assert.match(out, /data-testid="update-window"/)
    assert.match(text(out), /Доступна 1\.0\.3 · Нужна новая версия окна \(стоит 0\.1\.13, нужна 0\.1\.14 или новее\)/)
    assert.match(text(out), /Что нового/)
    assert.doesNotMatch(out, /data-testid="update-apply"/)
    // Версия окна неизвестна (не Electron) — про окно молчим, обновление предлагаем.
    assert.match(render(u, null), /update-available/)
    // Окно годится — обычная плашка.
    assert.match(render(u, '0.1.14'), /update-available/)
  })

  it('проба не прошла и откат — «не встало, вернул …», скрывается до следующей неудачи', () => {
    const failure = { to: '1.0.3', back: '1.0.2', at: '2026-10-19T11:00:00Z', result: 'rolled_back' as const, message: 'не прошла пробу', log: '/h/logs/update.log' }
    const u = status({ available: false, bad: true, failure })
    const out = render(u)
    assert.match(out, /data-testid="update-rolledback"/)
    assert.match(text(out), /Обновление до 1\.0\.3 не встало, вернул 1\.0\.2 · подробности: \/h\/logs\/update\.log/)
    assert.match(out, /data-testid="update-dismiss"/)
    assert.equal(updateBanner(u, null)?.dismissKey, 'failure:2026-10-19T11:00:00Z')
    assert.equal(render(u, '0.1.14', ['failure:2026-10-19T11:00:00Z']), '')
    // npm или загрузка — без отката: причина словами.
    const npm = render(status({ available: false, failure: { ...failure, back: null, result: 'failed', message: 'npm install не удался' } }))
    assert.match(text(npm), /Обновление до 1\.0\.3 не встало: npm install не удался/)
  })

  it('ошибка проверки канала (404) в плашку не идёт — её место pult doctor и --check', () => {
    const err = 'latest.json: … ответил HTTP 404 — релизов в канале нет или адрес недоступен'
    assert.equal(render(status({ latest: null, available: false, error: err })), '')
    const out = render(status({ error: err }))
    assert.match(out, /update-available/)
    assert.doesNotMatch(out, /404/)
  })

  it('ревью: скрытые ключи — списком; старая неудача не заслоняет НОВУЮ версию; неудача из терминала — «в терминале»', () => {
    const failure = { to: '1.0.3', back: '1.0.2', at: 'T1', result: 'rolled_back' as const, message: 'm', log: null }
    // Из терминала: файла журнала нет — так и говорим.
    assert.match(text(render(status({ available: false, bad: true, failure }))), /не встало, вернул 1\.0\.2 · подробности были в терминале/)
    // Скрыть неудачу не воскрешает скрытую «Доступна 1.0.4» и наоборот.
    const u = status({ latest: { ...status().latest!, version: '1.0.4' }, failure })
    assert.match(render(u), /update-available/, 'вышла 1.0.4 новее не вставшей 1.0.3 — её и показываем')
    let hidden = addDismissed([], '1.0.4')
    hidden = addDismissed(hidden, 'failure:T1')
    assert.deepEqual(hidden, ['1.0.4', 'failure:T1'])
    assert.equal(render(u, '0.1.14', hidden), '')
    // Та же версия, что не встала (bad, available=false), — неудача; скрыта — пусто.
    assert.match(render(status({ available: false, bad: true, failure })), /update-rolledback/)
    assert.equal(render(status({ available: false, bad: true, failure }), '0.1.14', ['failure:T1']), '')
    // Список не растёт без конца.
    let many: string[] = []
    for (let i = 0; i < 50; i++) many = addDismissed(many, `v${i}`)
    assert.equal(many.length, DISMISSED_MAX)
    assert.equal(many.at(-1), 'v49')
  })

  it('старая оболочка отвергла update.apply — подсказка про pult update', () => {
    assert.match(applyErrorText('method_not_allowed', 'метод update.apply окну не разрешён'), /оболочка старше 0\.1\.14\) — в терминале: pult update/)
    assert.equal(applyErrorText('invalid_params', 'ставить нечего'), 'Обновление не запустилось: ставить нечего')
  })
})

describe('«Настройки» → «Обновления»: состояния раздела', () => {
  const NOW = Date.parse('2026-10-19T10:05:00Z') // через 5 мин после checkedAt
  const upToDate = (over: Partial<UpdateStatus> = {}): UpdateStatus =>
    status({ current: '1.0.3', available: false, ...over })
  const panel = (u: UpdateStatus | null, over: Partial<UpdatesPanel> = {}): UpdatesPanel => ({
    status: u, packageVersion: u?.current ?? '0.3.3', windowVersion: '0.1.15', checking: false, error: null, applyError: null, busy: false, now: NOW,
    onCheck: noop, onApply: noop, onNotes: noop, ...over,
  })
  const section = (p: UpdatesPanel, auto: boolean | null = true): string =>
    renderToStaticMarkup(createElement(UpdatesSection, { panel: p, auto, onAuto: noop }))
  const state = (out: string): string | undefined => /data-state="([a-z]+)"/.exec(out)?.[1]

  it('последняя версия: «Установлена последняя версия (X)», версии пакета и окна, время проверки, «Проверить сейчас»', () => {
    const out = section(panel(upToDate()))
    assert.equal(state(out), 'uptodate')
    assert.match(text(out), /Пульт 1\.0\.3 окно 0\.1\.15/)
    assert.match(text(out), /Установлена последняя версия \(1\.0\.3\)/)
    assert.match(text(out), /последняя проверка: 5 мин назад/)
    assert.match(out, /data-testid="settings-update-check"/)
    assert.doesNotMatch(out, /<button[^>]*disabled=""[^>]*data-testid="settings-update-check"/)
    assert.doesNotMatch(out, /settings-update-apply/)
    assert.match(out, /data-testid="settings-update-auto"[^>]*checked/)
    assert.match(text(out), /Проверять обновления автоматически/)
  })

  it('доступна: «Доступна X · Что нового» и «Обновить до X» — тот же apply, что у плашки', () => {
    const v = updateSection(status(), '0.1.15', { checking: false, error: null }, NOW)
    assert.equal(v.state, 'available')
    assert.deepEqual(v.action, { label: 'Обновить до 1.0.3', force: false })
    const out = section(panel(status()))
    assert.match(text(out), /Доступна 1\.0\.3 Что нового/)
    assert.match(out, /data-testid="settings-update-apply"[^>]*>Обновить до 1\.0\.3</)
    assert.match(out, /data-testid="settings-update-notes"/)
    // Окну нужна версия новее — кнопки нет, только страница релиза.
    const win = section(panel(status(), { windowVersion: '0.1.12' }))
    assert.equal(state(win), 'window')
    assert.doesNotMatch(win, /settings-update-apply/)
    // Известное обновление пережило сбой сети — показываем и его, и сбой второй строкой.
    const withErr = section(panel(status({ error: 'getaddrinfo ENOTFOUND' })))
    assert.equal(state(withErr), 'available')
    assert.match(text(withErr), /Последняя проверка не удалась: getaddrinfo ENOTFOUND/)
  })

  it('идёт проверка: крутилка, «Проверяю канал…»; кнопку держит только свой вызов окна', () => {
    for (const p of [panel(upToDate(), { checking: true }), panel(upToDate({ checking: true }))]) {
      const out = section(p)
      assert.equal(state(out), 'checking')
      assert.match(out, /class="spin"/)
      assert.match(text(out), /Проверяю канал обновлений…/)
    }
    assert.match(section(panel(upToDate(), { checking: true })), /<button[^>]*disabled=""[^>]*data-testid="settings-update-check"/)
    // Снимок статуса демона мог устареть — нажатие просто дождётся его проверки.
    assert.doesNotMatch(section(panel(upToDate({ checking: true }))), /<button[^>]*disabled=""[^>]*data-testid="settings-update-check"/)
  })

  it('ошибка: текст канала с нейтральной подсказкой 404; отказ самого вызова; старая оболочка', () => {
    const hint = 'latest.json: ответил HTTP 404 — релизов в канале нет или адрес недоступен — проверь updates.url; поставить вручную: pult update --from <тарбол>'
    const out = section(panel(upToDate({ latest: null, error: hint })))
    assert.equal(state(out), 'error')
    assert.match(text(out), /Проверить не вышло: latest\.json: ответил HTTP 404 — релизов в канале нет или адрес недоступен/)
    assert.doesNotMatch(out, /<button[^>]*disabled=""[^>]*data-testid="settings-update-check"/, 'после ошибки можно проверить снова')
    const call = section(panel(upToDate(), { error: checkErrorText('method_not_allowed', 'x') }))
    assert.equal(state(call), 'error')
    assert.match(text(call), /оболочка старше 0\.1\.14\) — в терминале: pult update --check/)
    assert.equal(checkErrorText('timeout', 'демон не ответил'), 'демон не ответил')
    // Старый демон: статуса нет — раздел говорит про терминал.
    assert.equal(state(section(panel(null))), 'unsupported')
  })

  it('ставится и ждёт ходы: «Обновляю до X…» без кнопок; «Обновлю … после окончания ходов» и «Сейчас»; провал — «Повторить»', () => {
    const applying = section(panel(status({ apply: { state: 'applying', since: 'x', to: '1.0.3' } })))
    assert.equal(state(applying), 'applying')
    assert.match(text(applying), /Обновляю до 1\.0\.3…/)
    assert.doesNotMatch(applying, /settings-update-apply/)
    assert.match(applying, /<button[^>]*disabled=""[^>]*data-testid="settings-update-check"/)
    const waiting = updateSection(status({ apply: { state: 'waiting', turns: 2, since: 'x', to: '1.0.3' } }), '0.1.15', { checking: false, error: null }, NOW)
    assert.equal(waiting.state, 'waiting')
    assert.match(waiting.text, /после окончания ходов \(2 идут\)/)
    assert.deepEqual(waiting.action, { label: 'Сейчас', force: true })
    const failed = section(panel(status({ apply: { state: 'failed', at: 'x', error: 'pult update вышел с кодом 1' } })))
    assert.equal(state(failed), 'failed')
    assert.match(failed, /data-testid="settings-update-apply"[^>]*>Повторить</)
    // Отказ «Обновить» — строкой в разделе (диалог закрывает плашку окна).
    assert.match(section(panel(status(), { applyError: 'Обновление не запустилось: ставить нечего' })), /data-testid="settings-update-error"/)
  })

  it('ещё не проверял, bad, рабочая копия; без флага от демона переключателя нет', () => {
    assert.equal(updateSection(upToDate({ latest: null, checkedAt: null }), null, { checking: false, error: null }, NOW).state, 'unknown')
    assert.equal(updateSection(upToDate({ latest: { ...status().latest!, version: '1.0.4' }, bad: true }), null, { checking: false, error: null }, NOW).state, 'bad')
    assert.equal(updateSection(upToDate({ latest: { ...status().latest!, version: '1.0.4' } }), null, { checking: false, error: null }, NOW).state, 'local')
    assert.doesNotMatch(section(panel(upToDate()), null), /settings-update-auto/)
  })

  it('диалог «Настройки» показывает раздел «Обновления», когда окно его передало', () => {
    const settings = { rememberLast: true, defaults: { claude: {}, codex: {} } }
    const withUpd = renderToStaticMarkup(createElement(SettingsDialog, { settings, catalog: null, updates: panel(upToDate()), autoCheck: false, onSave: async () => null, onClose: noop }))
    assert.match(withUpd, /data-testid="settings-updates"/)
    assert.doesNotMatch(withUpd, /data-testid="settings-update-auto"[^>]*checked/)
    const without = renderToStaticMarkup(createElement(SettingsDialog, { settings, catalog: null, onSave: async () => null, onClose: noop }))
    assert.doesNotMatch(without, /settings-updates/)
  })
})

describe('«Обновления»: время проверки, проверка по фокусу, короткая плашка, settings.set', () => {
  const T = Date.parse('2026-10-19T10:00:00Z')

  it('«последняя проверка: …»', () => {
    assert.equal(checkedAgoText(null, T), 'последняя проверка: ещё не было')
    assert.equal(checkedAgoText('2026-10-19T10:00:00Z', T + 20_000), 'последняя проверка: только что')
    assert.equal(checkedAgoText('2026-10-19T10:00:00Z', T + 7 * 60_000), 'последняя проверка: 7 мин назад')
    assert.equal(checkedAgoText('2026-10-19T10:00:00Z', T + 3 * 3_600_000), 'последняя проверка: 3 ч назад')
    assert.equal(checkedAgoText('2026-10-19T10:00:00Z', T + 50 * 3_600_000), 'последняя проверка: 2 дн назад')
  })

  it('по фокусу: просим демона, только если автопроверка включена, ничего не ставится и проверка старше часа', () => {
    assert.equal(FOCUS_CHECK_STALE_MS, 3_600_000)
    assert.equal(focusCheckWanted(status(), T + 30 * 60_000), false, 'моложе часа')
    assert.equal(focusCheckWanted(status(), T + 61 * 60_000), true)
    assert.equal(focusCheckWanted(status({ checkedAt: null }), T), true, 'ещё не проверяли')
    assert.equal(focusCheckWanted(status({ enabled: false }), T + 5 * 3_600_000), false, 'автопроверка выключена')
    assert.equal(focusCheckWanted(status({ checking: true }), T + 5 * 3_600_000), false)
    assert.equal(focusCheckWanted(status({ apply: { state: 'applying', since: 'x', to: '1.0.3' } }), T + 5 * 3_600_000), false)
    assert.equal(focusCheckWanted(null, T), false)
  })

  it('короткая плашка после ручной проверки: нечего ставить — «Установлена последняя версия (X)»; иначе нет', () => {
    assert.equal(upToDateNote(status({ current: '1.0.3', available: false })), 'Установлена последняя версия (1.0.3)')
    assert.equal(upToDateNote(status()), null, 'есть что ставить — это плашка «Доступна»')
    assert.equal(upToDateNote(status({ current: '1.0.3', available: false, error: 'ENOTFOUND' })), null)
    assert.equal(upToDateNote(status({ available: false, latest: null })), null)
  })

  it('settings.set: флаг автопроверки — только когда передан', () => {
    const ns = { rememberLast: true, defaults: { claude: {}, codex: {} } }
    assert.deepEqual(settingsParams(ns), { newSession: ns })
    assert.deepEqual(settingsParams(ns, false), { newSession: ns, updates: { check: false } })
  })
})

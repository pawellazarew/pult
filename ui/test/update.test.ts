// Плашка обновления (M8c): состояния по `daemon.status.update` и версии окна — модель и разметка.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { UpdateBanner } from '../src/components/UpdateBanner.js'
import { SettingsDialog, UpdatesSection } from '../src/components/Settings.js'
import type { UpdatesPanel } from '../src/components/Settings.js'
import {
  appUpdateView, pendingUpdate,
  addDismissed, applyErrorText, checkedAgoText, checkErrorText, DISMISSED_MAX, FOCUS_CHECK_STALE_MS, focusCheckWanted, updateBanner, updateSection,
  upToDateNote, windowVersionFromUA,
} from '../src/model/update.js'
import { settingsParams } from '../src/model/sessionSettings.js'
import type { AppUpdateStatus, UpdateStatus } from '../../src/core/rpc.js'

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
  it('0.3.16: готово заранее — «Пульт 1.0.3 готов · Что нового · Перезапустить»; не подготовлено — «Доступен Пульт 1.0.3»; можно скрыть', () => {
    const ready = render(status({ staged: { to: '1.0.3', state: 'ready', error: null, at: 'x' } }))
    assert.match(ready, /data-testid="update-available"/)
    assert.equal(text(ready), 'Пульт 1.0.3 готов Что нового Перезапустить')
    assert.match(ready, /data-testid="update-dismiss"/)
    assert.match(ready, /role="status"/)
    // Одна кнопка: update.apply без target (пакет и окно разом).
    assert.deepEqual(updateBanner(status(), null)?.action, { label: 'Перезапустить', force: false })
    // Демон старше 0.3.16 (поля staged нет) или подготовка не удалась — честное «Доступен», кнопка та же.
    assert.equal(text(render(status())), 'Доступен Пульт 1.0.3 Что нового Перезапустить')
    assert.equal(text(render(status({ staged: { to: '1.0.3', state: 'failed', error: 'HTTP 404', at: 'x' } }))), 'Доступен Пульт 1.0.3 Что нового Перезапустить')
  })

  it('0.3.16: пока качается в фоне — плашки нет; подготовка прошлой версии не в счёт', () => {
    assert.equal(render(status({ staged: { to: '1.0.3', state: 'downloading', error: null, at: 'x' } })), '')
    assert.match(render(status({ staged: { to: '1.0.2', state: 'downloading', error: null, at: 'x' } })), /Доступен Пульт 1\.0\.3/)
  })

  it('нечего ставить, bad, нет статуса, скрыта крестиком — плашки нет', () => {
    assert.equal(render(status({ available: false })), '')
    assert.equal(render(status({ available: false, bad: true })), '')
    assert.equal(render(null), '')
    assert.equal(render(status(), '0.1.14', ['1.0.3']), '')
    // Скрыта прошлая версия — новая снова видна.
    assert.match(render(status(), '0.1.14', ['1.0.2']), /Доступен Пульт 1\.0\.3/)
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

  it('перезапуск — коротко «Перезапускаю…» без кнопок (пакет ставится, новый демон доводит окно, окно меняется); не удалось — причина и «Повторить»', () => {
    const applying = render(status({ apply: { state: 'applying', since: 'x', to: '1.0.3' } }))
    assert.match(applying, /data-testid="update-applying"/)
    assert.equal(text(applying), 'Перезапускаю…')
    assert.doesNotMatch(applying, /data-testid="update-apply"/)
    assert.equal(text(render(status({ available: false, current: '1.0.3', continuing: { to: '1.0.3' } }))), 'Перезапускаю…')
    const app = { unsupported: null, installed: '1.0.2', path: '/Applications/Pult.app', latest: '1.0.3', available: false, bad: false, last: null, applying: { to: '1.0.3', from: '1.0.2', step: 'swap' as const, since: 'x' } }
    assert.equal(text(render(status({ available: false, current: '1.0.3', app }))), 'Перезапускаю…')
    const failed = render(status({ apply: { state: 'failed', at: 'x', error: 'pult update вышел с кодом 1' } }))
    assert.match(failed, /data-testid="update-failed"/)
    assert.match(text(failed), /Обновление не удалось: pult update вышел с кодом 1/)
    assert.match(text(failed), /Повторить/)
    // Скрытая версия не прячет провал: его человек запустил сам.
    assert.match(render(status({ apply: { state: 'failed', at: 'x', error: 'e' } }), '0.1.14', ['1.0.3']), /update-failed/)
  })

  it('0.3.16: app.minVersion больше ничего не решает — окно обновится той же кнопкой', () => {
    const u = status({ latest: { ...status().latest!, app: { version: '1.0.3', minVersion: '0.1.14' } } })
    const out = render(u, '0.1.13')
    assert.match(out, /data-testid="update-available"/)
    assert.match(out, /data-testid="update-apply"/)
    assert.doesNotMatch(text(out), /Нужна новая версия окна/)
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

  it('последняя версия: «Установлена последняя версия (X)», одна версия «Пульт X», время проверки, «Проверить сейчас»', () => {
    const same = section(panel(upToDate(), { windowVersion: '1.0.3' }))
    assert.match(text(same), /^Обновления Пульт 1\.0\.3 Установлена/)
    assert.doesNotMatch(same, /settings-window-version/)
    // Окно другой версии (стоит старое) — второй строкой мелко.
    const out = section(panel(upToDate()))
    assert.equal(state(out), 'uptodate')
    assert.match(text(out), /Пульт 1\.0\.3 окно 0\.1\.15/)
    assert.match(out, /data-testid="settings-window-version"/)
    assert.match(text(out), /Установлена последняя версия \(1\.0\.3\)/)
    assert.match(text(out), /последняя проверка: 5 мин назад/)
    assert.match(out, /data-testid="settings-update-check"/)
    assert.doesNotMatch(out, /<button[^>]*disabled=""[^>]*data-testid="settings-update-check"/)
    assert.doesNotMatch(out, /settings-update-apply/)
    assert.match(out, /data-testid="settings-update-auto"[^>]*checked/)
    assert.match(text(out), /Проверять обновления автоматически/)
  })

  it('доступна: «Пульт X готов · Что нового» и одна кнопка «Перезапустить и обновить» — тот же apply, что у плашки', () => {
    const v = updateSection(status({ staged: { to: '1.0.3', state: 'ready', error: null, at: 'x' } }), '0.1.15', { checking: false, error: null }, NOW)
    assert.equal(v.state, 'available')
    assert.equal(v.text, 'Пульт 1.0.3 готов')
    assert.deepEqual(v.action, { label: 'Перезапустить и обновить', force: false })
    const out = section(panel(status()))
    assert.match(text(out), /Доступен Пульт 1\.0\.3 Что нового/)
    assert.match(out, /data-testid="settings-update-apply"[^>]*>Перезапустить и обновить</)
    assert.match(out, /data-testid="settings-update-notes"/)
    // Качается в фоне — тихая строка с крутилкой; кнопка есть (нажатие дождётся подготовки).
    const dl = section(panel(status({ staged: { to: '1.0.3', state: 'downloading', error: null, at: 'x' } })))
    assert.equal(state(dl), 'downloading')
    assert.match(text(dl), /Доступен Пульт 1\.0\.3 · скачиваю в фоне…/)
    assert.match(dl, /class="spin"/)
    assert.match(dl, /settings-update-apply/)
    // Подготовка не удалась — тихо, второй строкой.
    const sf = section(panel(status({ staged: { to: '1.0.3', state: 'failed', error: 'HTTP 404', at: 'x' } })))
    assert.match(text(sf), /Заранее скачать не вышло: HTTP 404 — скачаю при перезапуске/)
    // Отдельной строки «Обновить окно» в обычном пути нет.
    assert.doesNotMatch(section(panel(status({ app: { unsupported: null, installed: '0.1.15', path: '/Applications/Pult.app', latest: '1.0.3', available: true, bad: false, applying: null, last: null } }))), /settings-app-update/)
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

  it('перезапуск и ожидание ходов: «Перезапускаю…» без кнопок; «Обновлю … после окончания ходов» и «Сейчас»; провал — «Повторить»', () => {
    const applying = section(panel(status({ apply: { state: 'applying', since: 'x', to: '1.0.3' } })))
    assert.equal(state(applying), 'applying')
    assert.match(text(applying), /Перезапускаю…/)
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

describe('0.3.16: окно той же кнопкой; строка про окно — только когда с ним что-то не так', () => {
  const app = (over: Partial<AppUpdateStatus> = {}): AppUpdateStatus => ({
    unsupported: null, installed: '1.0.2', path: '/Applications/Pult.app', latest: '1.0.3', available: true, bad: false, applying: null, last: null, ...over,
  })
  // Пакет последний (1.0.3), окно отстало — «Перезапустить» обновит одно окно.
  const st = (a: AppUpdateStatus | undefined, over: Partial<UpdateStatus> = {}): UpdateStatus =>
    status({ current: '1.0.3', available: false, ...(a ? { app: a } : {}), ...over })
  const NOW = Date.parse('2026-10-19T10:05:00Z')
  const section = (u: UpdateStatus): string => renderToStaticMarkup(createElement(UpdatesSection, {
    panel: { status: u, packageVersion: '1.0.3', windowVersion: '1.0.2', checking: false, error: null, applyError: null, busy: false, now: NOW, onCheck: noop, onApply: noop, onNotes: noop },
    auto: true, onAuto: noop,
  }))

  it('окно отстало от пакета — та же плашка «Пульт 1.0.3 …» и та же кнопка; подготовлено — «готов»', () => {
    const b = updateBanner(st(app()), '1.0.2')
    assert.equal(b?.kind, 'available')
    assert.equal(b?.text, 'Доступен Пульт 1.0.3')
    assert.deepEqual(b?.action, { label: 'Перезапустить', force: false })
    assert.equal(updateBanner(st(app({ ready: '1.0.3' }), { staged: { to: '1.0.3', state: 'ready', error: null, at: 'x' } }), null)?.text, 'Пульт 1.0.3 готов')
    // Окно с интерфейсом другой версии (пакет сменили из терминала) — перезапуск окна, качать нечего: сразу «готов».
    const stale = updateBanner(st(app({ available: false, latest: '1.0.2', stale: true })), null)
    assert.equal(stale?.text, 'Пульт 1.0.3 готов')
    assert.equal(pendingUpdate(st(app({ available: false, latest: '1.0.2', stale: true })))?.ready, true)
    assert.equal(updateBanner(st(app({ available: false, latest: '1.0.2', stale: false })), null), null)
    // Ревью: скрыть «Пульт 1.0.3 готов» (пакет) не прячет просьбу перезапустить окно на 1.0.3 — у неё свой ключ.
    assert.equal(stale?.dismissKey, 'stale:1.0.3')
    assert.notEqual(updateBanner(st(app({ available: false, latest: '1.0.2', stale: true })), null, ['1.0.3']), null)
    assert.equal(updateBanner(st(app({ available: false, latest: '1.0.2', stale: true })), null, ['stale:1.0.3']), null)
    // Есть и пакет, и окно — одна плашка про Пульт.
    assert.equal(updateBanner(status({ app: app({ latest: '1.0.3' }) }), null)?.text, 'Доступен Пульт 1.0.3')
  })

  it('строка «Окно» в обычном пути отсутствует; есть — когда окно не обновить: не поддерживается, нет прав, другое окно, bad', () => {
    assert.equal(appUpdateView(st(app()), '1.0.2').state, 'none')
    assert.doesNotMatch(section(st(app())), /settings-app-update/)
    const linux = appUpdateView(st(app({ available: false, installed: null, unsupported: 'окно само обновляется только на macOS' })), '1.0.2')
    assert.equal(linux.state, 'unsupported')
    assert.match(linux.text, /^Окно 1\.0\.2 · окно само обновляется только на macOS/)
    const ro = appUpdateView(st(app({ blocked: 'нет прав на запись в /Applications (пользователь не администратор?) — обнови окно вручную: …' })), null)
    assert.equal(ro.state, 'blocked')
    assert.match(ro.text, /^Окно 1\.0\.2 не обновится само: нет прав на запись в \/Applications/)
    // Нет прав — плашка молчит про окно (кнопка его не обновит).
    assert.equal(updateBanner(st(app({ blocked: 'x' })), null), null)
    assert.equal(appUpdateView(st(app({ available: false, bad: true })), null).state, 'bad')
    assert.equal(appUpdateView(st(undefined), '1.0.2').state, 'none', 'старый демон — строки нет')
    assert.equal(appUpdateView(st(app({ available: false, latest: '1.0.2', installed: '1.0.2' })), null).state, 'none', 'окно последнее')
    assert.equal(appUpdateView(st(app({ applying: { to: '1.0.3', from: '1.0.2', step: 'quit', since: 'x' } })), null).state, 'none', 'идёт — это «Перезапускаю…» выше')
  })

  it('окно не встало или не обновилось — строкой и плашкой (скрывается до следующей неудачи); «Повторить» — та же кнопка', () => {
    const back = appUpdateView(st(app({ available: false, bad: true, last: { to: '1.0.3', from: '1.0.2', at: 't', result: 'rolled_back', message: 'окно 1.0.3 не подключилось к демону за 60 с — вернул 1.0.2' } })), null)
    assert.equal(back.state, 'rolledback')
    assert.match(back.text, /не подключилось.*вернул 1\.0\.2/)
    const failed = updateBanner(st(app({ last: { to: '1.0.3', from: '1.0.2', at: 'T1', result: 'failed', message: 'окно не закрылось за 10 с — закрой его сам (⌘Q) и повтори' } })), null)
    assert.equal(failed?.kind, 'app-failed')
    assert.deepEqual(failed?.action, { label: 'Повторить', force: false })
    assert.equal(failed?.dismissKey, 'app-failure:T1')
    assert.equal(updateBanner(st(app({ available: false, last: { to: '1.0.3', from: '1.0.2', at: 'T1', result: 'rolled_back', message: 'x' } })), null, ['app-failure:T1']), null)
    // Вышла версия новее неудачной — неудача не заслоняет её.
    assert.equal(updateBanner(st(app({ latest: '1.0.4', last: { to: '1.0.3', from: '1.0.2', at: 't', result: 'rolled_back', message: 'x' } })), null)?.kind, 'available')
  })

  it('окно не из поставленного бандла (here: false) — плашка молчит про окно, строка говорит, где обновить', () => {
    const v = appUpdateView(st(app({ here: false, hereFrom: '/w/node_modules/electron/dist/Electron.app' })), '1.0.2')
    assert.equal(v.state, 'elsewhere')
    assert.equal(v.action, null)
    assert.match(v.text, /закрой окно из \/w\/node_modules\/electron\/dist\/Electron\.app и обнови из \/Applications\/Pult\.app/)
    assert.equal(updateBanner(st(app({ here: false, hereFrom: '/x/Pult.app' })), null), null)
    assert.match(section(st(app({ here: false }))), /data-state="elsewhere"/)
  })

  it('окно заменено закрытым: «ещё не запускалось»; первый запуск не заработал — «Вернуть 0.1.15» (rollback)', () => {
    const wait = appUpdateView(st(app({ available: false, latest: '0.1.16', installed: '0.1.16', firstRun: { to: '0.1.16', from: '0.1.15', state: 'waiting' } })), null)
    assert.equal(wait.state, 'firstrun')
    assert.match(wait.text, /обновлено до 0\.1\.16, ещё не запускалось.*если окно не запускается — pult update --app --rollback/)
    assert.equal(wait.action?.rollback, true)
    assert.equal(wait.action?.label, 'Вернуть 0.1.15')
    assert.match(wait.action?.confirm ?? '', /Вернуть окно 0\.1\.15\?/)
    const failed = appUpdateView(st(app({ available: false, installed: '0.1.16', firstRun: { to: '0.1.16', from: '0.1.15', state: 'failed' } })), null)
    assert.equal(failed.state, 'firstrun-failed')
    assert.deepEqual(failed.action, { label: 'Вернуть 0.1.15', force: false, target: 'app', rollback: true })
    const b = updateBanner(st(app({ available: false, installed: '0.1.16', firstRun: { to: '0.1.16', from: '0.1.15', state: 'failed' } })), null)
    assert.equal(b?.kind, 'app-failed')
    assert.equal(b?.action?.rollback, true)
    assert.equal(b?.dismissKey, 'firstrun:0.1.16')
    assert.match(section(st(app({ available: false, installed: '0.1.16', firstRun: { to: '0.1.16', from: '0.1.15', state: 'failed' } }))), /data-state="firstrun-failed"[\s\S]*settings-app-apply/)
  })

  it('отказ «Обновить окно» словами; старая оболочка — подсказка pult update --app', () => {
    assert.equal(applyErrorText('invalid_params', 'нет прав на запись в /Applications', 'app'), 'Окно не обновилось: нет прав на запись в /Applications')
    assert.match(applyErrorText('method_not_allowed', 'x', 'app'), /pult update --app$/)
  })
})

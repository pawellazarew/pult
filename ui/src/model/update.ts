import { getLanguage } from '../../../src/i18n/core.js'
import { t as tr } from '../lib/i18n.js'
// Плашка обновления (M8c): что сказать человеку по `daemon.status.update` и версии окна. Чистые функции.
//
// ВЕРСИЯ ОКНА: оболочка её мостом не отдаёт, но Electron кладёт имя и версию приложения в user agent:
// «… Pult/0.1.14 Chrome/… Electron/…» (в рабочей копии — имя пакета, «pult-shell/0.1.14»). Так плашка
// работает и в окне 0.1.13, которому не нужна новая оболочка ради одной строки.
//
// 0.3.16 — ОДИН НОМЕР И ОДНА КНОПКА: окно выходит с тем же номером, что пакет, и человеку показывается одна версия
// («Пульт 0.3.16») и одна кнопка «Перезапустить» — она обновляет пакет и окно разом (демон, src/daemon/server.ts
// `update.apply` без target). Новая версия скачивается заранее, в фоне: пока качается, плашки нет (только тихая строка
// в «Настройках»), готово — «Пульт X готов · Перезапустить · Что нового».

import { compareVersions } from '../../../src/core/semver.js'
import type { AppUpdateStatus, UpdateStatus } from '../../../src/core/rpc.js'

const UA_RE = /(?:^|\s)(?:Pult|pult-shell)\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=\s|$)/

/** Версия окна из user agent Electron; не нашли — null (тогда про окно молчим). */
export function windowVersionFromUA(ua: string | undefined | null): string | null {
  return UA_RE.exec(ua ?? '')?.[1] ?? null
}

/**
 * Кнопка обновления: «Перезапустить» (`update.apply` без target — пакет и окно разом; `force` — не ждать ходов) или
 * «Вернуть <from>» (`target: 'app', rollback` — прежнее окно, если новое не заработало).
 */
export interface UpdateAction {
  label: string; force: boolean; target?: 'app'; rollback?: true
  /** Спросить перед действием (вернуть окно, пока новое ещё не запускалось). */
  confirm?: string
}

export interface UpdateBannerView {
  /** data-testid и тон плашки. */
  kind: 'available' | 'waiting' | 'applying' | 'failed' | 'rolledback' | 'app-failed'
  text: string
  /** Страница релиза — «Что нового». */
  notes: string | null
  /** Кнопка: «Перезапустить», «Сейчас» (`force`), «Повторить», «Вернуть <from>» или никакой. */
  action: UpdateAction | null
  /** Ключ «скрыть крестиком»: версия (до следующей) или `failure:<время>` (до следующей неудачи); null — не скрывается. */
  dismissKey: string | null
}

const turnsText = (n: number): string => {
  if (getLanguage() === 'en') return `${n} ${n === 1 ? 'turn is running' : 'turns are running'}`
  const mod10 = n % 10
  const mod100 = n % 100
  const word = mod10 === 1 && mod100 !== 11 ? tr('идёт') : tr('идут')
  return `${n} ${word}`
}

const RESTART: UpdateAction = { label: tr('Перезапустить'), force: false }

/** Последняя неудача окна, если её не заслонила вышедшая после неё версия. */
function appFailure(a: AppUpdateStatus): AppUpdateStatus['last'] {
  const f = a.last
  if (!f || f.result === 'done') return null
  if (a.available && a.latest !== null && compareVersions(a.latest, f.to) > 0) return null
  return f
}

/** «Вернуть <from>»: новое окно, заменённое закрытым, не заработало при первом запуске. */
const backAction = (from: string): UpdateAction => ({ label: tr`Вернуть ${from}`, force: false, target: 'app', rollback: true })

/** Что даст «Перезапустить» (0.3.16). null — нечего. */
export interface PendingUpdate {
  /** Версия Пульта после перезапуска. */
  to: string
  /** Скачано и проверено заранее — перезапуск только переключает. */
  ready: boolean
  /** Ещё качается в фоне — плашке молчать. */
  downloading: boolean
  /** Подготовка не удалась (тихо) — почему; при нажатии демон скачает заново. */
  stageError: string | null
  /** Ключ «скрыть крестиком»: версия; только перезапуск окна — `stale:<версия>` (скрытый «готов X» его не прячет). */
  key: string
}

/**
 * Есть ли что ставить «Перезапустить»: новый пакет; окно, отставшее от пакета (из поставленного бандла, с правами на
 * замену); или окно с интерфейсом другой версии пакета (пакет сменили, окно не перезапускали).
 */
export function pendingUpdate(u: UpdateStatus | undefined | null): PendingUpdate | null {
  if (!u) return null
  const a = u.app
  const pkg = u.available && u.latest ? u.latest.version : null
  const win = a && a.available && a.here !== false && !a.blocked ? a.latest : null
  const stale = a?.stale === true && a.here !== false
  if (pkg === null && win === null && !stale) return null
  const s = u.staged ?? null
  const mine = s !== null && u.latest !== null && s.to === u.latest.version
  return {
    to: pkg ?? u.current,
    // Только перезапуск окна (пакет и окно на месте) — качать нечего.
    ready: (mine && s.state === 'ready') || (pkg === null && win === null),
    downloading: mine && s.state === 'downloading',
    stageError: mine && s.state === 'failed' ? s.error : null,
    key: pkg === null && win === null ? `stale:${u.current}` : (pkg ?? u.current),
  }
}

/** Идёт перезапуск: пакет ставится, новый демон доводит окно или окно меняется / перезапускается. */
const restarting = (u: UpdateStatus): boolean =>
  u.apply.state === 'applying' || (u.continuing ?? null) !== null || (u.app?.applying ?? null) !== null

/**
 * Что показать. `dismissed` — что человек скрыл крестиком (версия или `failure:<время>`): «готов» и «не встало» про это
 * больше не всплывают, но ожидание, перезапуск и провал запуска видны всегда — их человек запустил сам.
 */
export function updateBanner(u: UpdateStatus | undefined | null, _windowVersion: string | null, dismissed: readonly string[] = []): UpdateBannerView | null {
  if (!u) return null
  const latest = u.latest
  const notes = latest?.notes ?? null
  if (u.apply.state === 'waiting') {
    return {
      kind: 'waiting',
      text: tr`Обновлю до ${u.apply.to} после окончания ходов (${turnsText(u.apply.turns)})`,
      notes, action: { label: tr('Сейчас'), force: true }, dismissKey: null,
    }
  }
  if (restarting(u)) return { kind: 'applying', text: tr('Перезапускаю…'), notes: null, action: null, dismissKey: null }
  if (u.apply.state === 'failed') {
    return {
      kind: 'failed',
      text: tr`Обновление не удалось: ${u.apply.error}`,
      notes, action: pendingUpdate(u) ? { label: tr('Повторить'), force: false } : null, dismissKey: null,
    }
  }
  const a = u.app
  if (a?.firstRun?.state === 'failed' && !dismissed.includes(`firstrun:${a.firstRun.to}`)) {
    return {
      kind: 'app-failed',
      text: tr`Окно ${a.firstRun.to} не заработало при первом запуске — можно вернуть ${a.firstRun.from}`,
      notes: null, action: backAction(a.firstRun.from), dismissKey: `firstrun:${a.firstRun.to}`,
    }
  }
  const af = a ? appFailure(a) : null
  if (a && af && !dismissed.includes(`app-failure:${af.at}`)) {
    return {
      kind: 'app-failed',
      text: af.result === 'rolled_back' ? tr`Окно ${af.to} не встало: ${af.message}` : tr`Окно не обновилось: ${af.message}`,
      notes: null, action: af.result === 'failed' && pendingUpdate(u) ? { label: tr('Повторить'), force: false } : null, dismissKey: `app-failure:${af.at}`,
    }
  }
  // Проба не прошла и откат — после него это уже другой демон, и только update.json помнит, что было.
  const f = u.failure ?? null
  // Старая неудача не заслоняет НОВУЮ версию: вышла версия новее не вставшей — показываем её.
  const newerThanFailure = f !== null && u.available && latest !== null && compareVersions(latest.version, f.to) > 0
  if (f && !newerThanFailure && !dismissed.includes(`failure:${f.at}`)) {
    const details = f.log ? tr`подробности: ${f.log}` : tr('подробности были в терминале')
    return {
      kind: 'rolledback',
      text: f.back !== null
        ? tr`Обновление до ${f.to} не встало, вернул ${f.back} · ${details}`
        : tr`Обновление до ${f.to} не встало: ${f.message} · ${details}`,
      notes: null, action: null, dismissKey: `failure:${f.at}`,
    }
  }
  const p = pendingUpdate(u)
  // Пока качается в фоне — тишина: кнопка, которая сначала минуту качает, выглядела бы зависшей.
  if (!p || p.downloading || dismissed.includes(p.key)) return null
  return {
    kind: 'available',
    text: p.ready ? tr`Пульт ${p.to} готов` : tr`Доступен Пульт ${p.to}`,
    notes: u.available ? notes : null, action: RESTART, dismissKey: p.key,
  }
}

/** Скрытые ключи — небольшой список: новый ключ в конец, старые вытесняются (версий и неудач немного). */
export const DISMISSED_MAX = 20
export function addDismissed(list: readonly string[], key: string): string[] {
  return [...list.filter((k) => k !== key), key].slice(-DISMISSED_MAX)
}

/** Отказ `update.apply` со старой оболочкой: метода нет в её белом списке — подсказка, как обновиться иначе. */
export function applyErrorText(code: string | null, message: string, target?: 'app'): string {
  if (code === 'method_not_allowed') return tr`Это окно не умеет запускать обновление (оболочка старше 0.1.14) — в терминале: pult update${target === 'app' ? ' --app' : ''}`
  return target === 'app' ? tr`Окно не обновилось: ${message}` : tr`Обновление не запустилось: ${message}`
}

// --- «Настройки» → «Обновления» (⌘,): версия, состояние канала, «Проверить сейчас», «Перезапустить и обновить» ----

/** Окно вернулось на экран, а последняя проверка старше этого — попросить демона проверить (он сам держит предел частоты). */
export const FOCUS_CHECK_STALE_MS = 3_600_000

/** Просить ли демона проверить по фокусу окна: автопроверка включена, ничего не ставится, проверка давняя или не было. */
export function focusCheckWanted(u: UpdateStatus | undefined | null, now: number): boolean {
  if (!u || !u.enabled || u.checking || u.apply.state !== 'idle') return false
  const t = u.checkedAt ? Date.parse(u.checkedAt) : Number.NaN
  return !Number.isFinite(t) || now - t >= FOCUS_CHECK_STALE_MS
}

/** «последняя проверка: 5 мин назад». */
export function checkedAgoText(iso: string | null, now: number): string {
  if (!iso) return tr('последняя проверка: ещё не было')
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return tr('последняя проверка: —')
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 45) return tr('последняя проверка: только что')
  const m = Math.round(s / 60)
  if (m < 60) return tr`последняя проверка: ${m} мин назад`
  const h = Math.floor(m / 60)
  if (h < 24) return tr`последняя проверка: ${h} ч назад`
  return tr`последняя проверка: ${Math.floor(h / 24)} дн назад`
}

export interface UpdateSectionView {
  /** data-state строки состояния. */
  state: 'unsupported' | 'unknown' | 'checking' | 'uptodate' | 'available' | 'downloading' | 'waiting' | 'applying' | 'failed' | 'error' | 'bad' | 'local'
  text: string
  /** Страница релиза — «Что нового». */
  notes: string | null
  /** «Перезапустить и обновить», «Сейчас», «Повторить» — тот же путь, что у плашки (`update.apply`). */
  action: UpdateAction | null
  /** Можно ли нажать «Проверить сейчас». */
  canCheck: boolean
  /** «последняя проверка: …». */
  checked: string
  /** Вторая строка: прошлая проверка не удалась, хотя известное обновление осталось; подготовка не удалась. */
  note: string | null
}

const APPLY_ALL: UpdateAction = { label: tr('Перезапустить и обновить'), force: false }

/**
 * Что показать в разделе «Обновления». `local` — то, что знает только окно: идёт ли его «Проверить сейчас»
 * и чем кончился сам вызов (старая оболочка, демон недоступен). Ошибка канала (сеть, 404 с подсказкой) —
 * из статуса демона.
 */
export function updateSection(
  u: UpdateStatus | undefined | null,
  _windowVersion: string | null,
  local: { checking: boolean; error: string | null },
  now: number,
): UpdateSectionView {
  const base = { notes: null, action: null, canCheck: true, note: null }
  if (!u) {
    return {
      ...base, state: local.checking ? 'checking' : local.error ? 'error' : 'unsupported',
      text: local.checking ? tr('Проверяю канал обновлений…') : local.error ? tr`Проверить не вышло: ${local.error}` : tr('Демон не сообщает о канале обновлений — в терминале: pult update --check'),
      checked: checkedAgoText(null, now),
    }
  }
  const checked = checkedAgoText(u.checkedAt, now)
  const latest = u.latest
  const notes = latest?.notes ?? null
  if (u.apply.state === 'waiting') {
    return { ...base, state: 'waiting', text: tr`Обновлю до ${u.apply.to} после окончания ходов (${turnsText(u.apply.turns)})`, notes, action: { label: tr('Сейчас'), force: true }, canCheck: false, checked }
  }
  if (restarting(u)) return { ...base, state: 'applying', text: tr('Перезапускаю… Демон и окно поднимутся сами, сессии продолжат работу'), canCheck: false, checked }
  const p = pendingUpdate(u)
  if (u.apply.state === 'failed') {
    return { ...base, state: 'failed', text: tr`Обновление не удалось: ${u.apply.error}`, notes, action: p ? { label: tr('Повторить'), force: false } : null, checked }
  }
  // Кнопку держит только СВОЙ вызов: `u.checking` из снимка статуса может устареть, а нажатие во время проверки
  // демона просто дождётся её итога.
  if (local.checking || u.checking) return { ...base, state: 'checking', text: tr('Проверяю канал обновлений…'), canCheck: !local.checking, checked }
  if (local.error) return { ...base, state: 'error', text: tr`Проверить не вышло: ${local.error}`, checked }
  const errNote = u.error ? tr`Последняя проверка не удалась: ${u.error}` : null
  if (p) {
    const what = u.available ? notes : null
    if (p.downloading) return { ...base, state: 'downloading', text: tr`Доступен Пульт ${p.to} · скачиваю в фоне…`, notes: what, action: APPLY_ALL, checked, note: errNote }
    return {
      ...base, state: 'available', text: p.ready ? tr`Пульт ${p.to} готов` : tr`Доступен Пульт ${p.to}`, notes: what, action: APPLY_ALL, checked,
      note: p.stageError ? tr`Заранее скачать не вышло: ${p.stageError} — скачаю при перезапуске` : errNote,
    }
  }
  if (u.error) return { ...base, state: 'error', text: tr`Проверить не вышло: ${u.error}`, checked }
  if (latest && u.bad) {
    return { ...base, state: 'bad', text: tr`В канале ${latest.version}, но на этой машине она уже не прошла пробу — сама не ставится; повторить: pult update --to ${latest.version}`, notes, checked }
  }
  if (latest && compareVersions(latest.version, u.current) > 0) {
    return { ...base, state: 'local', text: tr`В канале ${latest.version}; эта установка — рабочая копия, канал её не обновляет`, notes, checked }
  }
  if (latest) return { ...base, state: 'uptodate', text: tr`Установлена последняя версия (${u.current})`, checked }
  return { ...base, state: 'unknown', text: tr('Ещё не проверял — «Проверить сейчас»'), checked }
}

export interface AppUpdateView {
  /** data-state строки «Окно» в «Настройках». */
  state: 'none' | 'failed' | 'rolledback' | 'bad' | 'unsupported' | 'blocked' | 'elsewhere' | 'firstrun' | 'firstrun-failed'
  text: string
  action: UpdateAction | null
}

/**
 * Строка про окно в «Обновлениях» (0.3.16) — только когда окно не обновится вместе с Пультом или с ним что-то
 * случилось: не поддерживается, нет прав, открыто другое окно, не встало, ждёт первого запуска. В обычном пути её нет:
 * окно обновляется той же кнопкой. `none` — сказать нечего (или демон старше 0.3.4).
 */
export function appUpdateView(u: UpdateStatus | undefined | null, windowVersion: string | null): AppUpdateView {
  const none: AppUpdateView = { state: 'none', text: '', action: null }
  const a = u?.app
  if (!a || a.applying) return none
  const installed = a.installed ?? windowVersion
  const fr = a.firstRun ?? null
  if (fr?.state === 'failed') {
    return { state: 'firstrun-failed', text: tr`Окно ${fr.to} не заработало при первом запуске — можно вернуть ${fr.from}`, action: backAction(fr.from) }
  }
  const f = appFailure(a)
  if (f) {
    return f.result === 'rolled_back'
      ? { state: 'rolledback', text: tr`Окно ${f.to} не встало: ${f.message}`, action: null }
      : { state: 'failed', text: tr`Окно не обновилось: ${f.message}`, action: null }
  }
  if (fr?.state === 'waiting') {
    return {
      state: 'firstrun',
      text: tr`Окно обновлено до ${fr.to}, ещё не запускалось (прежнее ${fr.from} держу до первого запуска) · если окно не запускается — pult update --app --rollback`,
      action: { ...backAction(fr.from), confirm: tr`Вернуть окно ${fr.from}? Новое ${fr.to} ещё не запускалось; оно будет закрыто и больше не предложится само.` },
    }
  }
  // Окно отстало от канала, но этой кнопкой его не обновить — объяснить, почему и что делать.
  const behind = a.latest !== null && installed !== null && compareVersions(a.latest, installed) > 0
  if (!behind) return none
  if (a.unsupported) return { state: 'unsupported', text: tr`Окно ${installed} · ${a.unsupported}`, action: null }
  if (a.bad) return { state: 'bad', text: tr`Окно ${a.latest} уже не встало на этой машине — само не ставится; повторить: pult update --app --force`, action: null }
  if (a.blocked) return { state: 'blocked', text: tr`Окно ${installed} не обновится само: ${a.blocked}`, action: null }
  if (a.here === false) {
    return { state: 'elsewhere', text: tr`Окно ${installed} → ${a.latest} · закрой окно из ${a.hereFrom ?? tr('этой копии')} и обнови из ${a.path ?? 'Pult.app'}`, action: null }
  }
  return none
}

/** Итог ручной проверки для короткой плашки: ставить нечего — «Установлена последняя версия (X)»; иначе null. */
export function upToDateNote(u: UpdateStatus | undefined | null): string | null {
  if (!u || u.error || u.available || !u.latest || u.apply.state !== 'idle' || pendingUpdate(u)) return null
  return compareVersions(u.latest.version, u.current) > 0 ? null : tr`Установлена последняя версия (${u.current})`
}

/** Отказ `update.check` словами: старая оболочка не пропускает метод — подсказка про терминал. */
export function checkErrorText(code: string | null, message: string): string {
  if (code === 'method_not_allowed') return tr('это окно не умеет проверять обновления (оболочка старше 0.1.14) — в терминале: pult update --check')
  return message
}

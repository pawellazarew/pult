import { t } from '../cli/i18n.js'
// Пункты `pult doctor` про версии (docs/08 §7): `current` указывает на существующую версию (и
// какую), версия работающего демона ≠ `current` → «перезапусти демона». Инъекцией в доктора,
// как пункты службы: тесты доктора не зависят от раскладки версий.

import { existsSync, readlinkSync } from 'node:fs'
import type { PultPaths } from '../core/paths.js'
import type { DaemonStatus } from '../core/rpc.js'
import { cmd } from '../env/fixCmd.js'
import type { DoctorItem } from '../env/doctor.js'
import { currentName, packageIn, probeInterrupted, readState } from './versions.js'

export function versionDoctorItems(paths: PultPaths, daemon: DaemonStatus | null): DoctorItem[] {
  const items = currentVersionItems(paths, daemon)
  const ch = channelDoctorItem(daemon)
  if (ch) items.push(ch)
  return items
}

/**
 * M8c: что демон знает о канале обновлений. Ошибка проверки — warn, а не fail: нет сети, в канале нет
 * релиза (404) или адрес не тот — Пульт от этого не сломан. Нет демона или он старше канала — пункта нет.
 */
export function channelDoctorItem(daemon: DaemonStatus | null): DoctorItem | null {
  const u = daemon?.update
  if (!u) return null
  const base = { id: 'update.channel', title: t('Канал обновлений') }
  if (u.error) return { ...base, status: 'warn', detail: t`канал обновлений: ${u.error}`, data: { checkedAt: u.checkedAt, latest: u.latest?.version ?? null } }
  if (!u.enabled && !u.latest) return { ...base, status: 'ok', detail: t('сам не проверяет (updates.check: false в config.json); проверить: pult update --check') }
  if (!u.latest) return { ...base, status: 'ok', detail: t('ещё не проверялся (первая проверка — через минуту после старта демона)') }
  if (u.available) return { ...base, status: 'ok', detail: t`доступна ${u.latest.version} (стоит ${u.current}) — поставить: pult update`, ...cmd('pult update') }
  return { ...base, status: 'ok', detail: t`в канале ${u.latest.version}, стоит ${u.current}${u.checkedAt ? t` · проверено ${u.checkedAt}` : ''}` }
}

function currentVersionItems(paths: PultPaths, daemon: DaemonStatus | null): DoctorItem[] {
  const items: DoctorItem[] = []
  const name = currentName(paths)
  if (name === null) {
    items.push({
      id: 'version.current',
      title: t('Активная версия'),
      status: 'ok',
      detail: t('current нет — демон поднимается из того пакета, откуда запущен CLI (установить версию: pult update --from <tgz>)'),
    })
    return items
  }
  let target = name
  try { target = readlinkSync(paths.current) } catch { /* останется имя */ }
  const pkg = existsSync(paths.current) ? packageIn(paths.current) : null
  if (!pkg) {
    items.push({
      id: 'version.current',
      title: t('Активная версия'),
      status: 'fail',
      detail: t`current → ${target}, но там нет пакета pult: служба выйдет с кодом 78, демон из current не поднимется`,
      fix: t('pult update --list && pult update --to <версия>'),
    })
    return items
  }
  const st = readState(paths)
  // Проба этой версии не дошла до итога (pult update убит между переключением current и концом
  // пробы) — версия ни разу не подтвердила, что работает. Раньше здесь было ok: пакет на диске есть.
  if (probeInterrupted(st, name)) {
    items.push({
      id: 'version.current',
      title: t('Активная версия'),
      status: 'warn',
      detail: t`current → ${target}: pult ${pkg.version}, но проба ${name} прервана (${st.last?.at ?? '?'}) — версия не проверена`,
      // Готовые команды — cmd(): fixCmd даёт кнопку «копировать» в окне; `<версия>` выше — проза.
      ...cmd(`pult update --to ${name}`),
      data: { current: name, version: pkg.version, layout: pkg.layout, previous: st.previous, bad: st.bad, probeInterrupted: true },
    })
    return items
  }
  items.push({
    id: 'version.current',
    title: t('Активная версия'),
    status: 'ok',
    detail: `current → ${target}: pult ${pkg.version}${pkg.layout === 'dev' ? t` (рабочая копия ${pkg.root})` : ''}`
      + `${st.previous ? t`; откат — ${st.previous}` : ''}${st.bad.length ? `; bad: ${st.bad.join(', ')}` : ''}`,
    data: { current: name, version: pkg.version, layout: pkg.layout, previous: st.previous, bad: st.bad },
  })
  if (daemon && daemon.version !== pkg.version) {
    items.push({
      id: 'version.daemon',
      title: t('Версия демона'),
      status: 'warn',
      detail: t`работает демон ${daemon.version} (pid ${daemon.pid}), а current — ${pkg.version}: перезапусти демона`,
      ...cmd('pult daemon stop && pult daemon start'),
    })
  }
  return items
}

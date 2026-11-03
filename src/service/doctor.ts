import { t } from '../cli/i18n.js'
import { getLanguage } from '../i18n/core.js'
// Пункты `pult doctor` про службу (docs/08 §7): установлена/загружена/последний код выхода,
// файл службы указывает на существующий лаунчер, node-path жив, linger на Linux.
// Отдельный модуль, а не код в env/doctor.ts: доктор получает эти пункты инъекцией, и его
// тесты не трогают ни файл службы, ни менеджер служб.

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import type { PultPaths } from '../core/paths.js'
import { cmd } from '../env/fixCmd.js'
import type { DoctorItem } from '../env/doctor.js'
import { serviceContext } from './context.js'
import type { ServiceContext } from './context.js'
import { formatLastExit, lingerFixCommand, lingerState } from './manager.js'
import { isExecutable, serviceReport } from './status.js'

/** Код 78 (EX_CONFIG) лаунчер отдаёт на ошибку конфигурации: нет node >= 22 или нет точки входа. */
export const EXIT_CONFIG = 78

// Команды починки — через cmd(): окно рисует моноширинный блок и кнопку «копировать» только по
// fixCmd, а голый `fix` показывает прозой. С плейсхолдером (<другое имя>) — проза: копировать нечего.
function nodePathItem(paths: PultPaths): DoctorItem {
  let saved = ''
  try { saved = (readFileSync(paths.nodePath, 'utf8').split('\n')[0] ?? '').trim() } catch { /* нет файла */ }
  if (!saved) {
    return {
      id: 'service.node',
      title: t('Node для службы'),
      status: 'warn',
      detail: t`${paths.nodePath} пуст или отсутствует — лаунчер будет искать node заново на каждом старте`,
      ...cmd('pult daemon install'),
    }
  }
  if (!isExecutable(saved)) {
    return {
      id: 'service.node',
      title: t('Node для службы'),
      status: 'warn',
      detail: t`node-path указывает на ${saved}, а его нет или он не исполняемый (brew/nvm переехали?) — лаунчер найдёт node сам при следующем старте`,
      ...cmd('pult daemon install'),
    }
  }
  const r = spawnSync(saved, ['-v'], { encoding: 'utf8', timeout: 10_000 })
  const v = (r.stdout ?? '').trim()
  const major = Number.parseInt(v.replace(/^v/, '').split('.')[0] ?? '0', 10)
  return {
    id: 'service.node',
    title: t('Node для службы'),
    status: major >= 22 ? 'ok' : 'warn',
    detail: `${saved} (${v || t('версия не прочиталась')})${major >= 22 ? '' : t(' — нужен >= 22, лаунчер будет искать другой')}`,
    ...(major >= 22 ? {} : cmd('brew upgrade node && pult daemon install')),
  }
}

function lingerItem(ctx: ServiceContext): DoctorItem {
  let state: boolean | null = null
  let why = ''
  try { state = lingerState(ctx) } catch (e) { why = (e as Error).message }
  return {
    id: 'service.linger',
    title: 'Linger (systemd --user)',
    status: state === true ? 'ok' : 'warn',
    detail: state === true
      ? t`включён для ${ctx.user}: демон живёт и без открытой сессии`
      : t`${state === false ? t('выключен') : t`не выяснено${why ? ` (${why})` : ''}`} — systemd --user остановит демона, когда закроется последняя сессия`,
    ...(state === true ? {} : cmd(lingerFixCommand(ctx))),
  }
}

export function serviceDoctorItems(paths: PultPaths, env: NodeJS.ProcessEnv): DoctorItem[] {
  const r = serviceReport(paths, env)
  const items: DoctorItem[] = []
  if (!r.installed) {
    items.push({
      id: 'service',
      title: t('Служба'),
      status: r.error ? 'warn' : 'ok',
      detail: r.error
        ? t`состояние не выяснено: ${r.error}`
        : t('не установлена — демон поднимается по требованию и не переживает перезагрузку (поставить: pult daemon install)'),
    })
    return items
  }
  if (!r.ours) {
    items.push({
      id: 'service',
      title: t('Служба'),
      status: 'warn',
      detail: t`${r.file} обслуживает другой PULT_HOME (${r.fileHome ?? t('не указан')}); у этого дома службы нет`,
      fix: t`PULT_SERVICE_NAME=<другое имя> pult daemon install   # вторая служба рядом`,
    })
    return items
  }

  items.push({
    id: 'service.launcher',
    title: t('Лаунчер службы'),
    status: r.launcherOk ? 'ok' : 'fail',
    detail: r.launcherOk
      ? `${r.file} → ${r.launcher}`
      : t`${r.file} указывает на ${r.launcher ?? t('(не разобран)')}, а его нет или он не исполняемый — служба не стартует`,
    ...(r.launcherOk ? {} : cmd('pult daemon install')),
  })

  const m = r.manager
  if (!m || m.error) {
    items.push({
      id: 'service',
      title: t('Служба'),
      status: 'warn',
      detail: t`установлена (${r.file}), но менеджер служб не ответил: ${r.error ?? m?.error ?? t('неизвестно')}`,
      ...cmd('pult daemon install'),
    })
  } else if (!m.loaded) {
    items.push({
      id: 'service',
      title: t('Служба'),
      status: 'warn',
      detail: t`файл ${r.file} есть, но служба не загружена — после перезагрузки или входа поднимется; сейчас её нет`,
      ...cmd('pult daemon install'),
    })
  } else if (m.lastExitCode === EXIT_CONFIG && m.pid === null) {
    items.push({
      id: 'service',
      title: t('Служба'),
      status: 'fail',
      detail: t`последний выход с кодом 78: служба указывает на несуществующий node или точку входа (нет активной версии?) — смотри ${paths.serviceLog}`,
      ...cmd('pult update --list && pult daemon install'),
    })
  } else if (m.state === 'failed') {
    items.push({
      id: 'service',
      title: t('Служба'),
      status: 'fail',
      detail: t`systemd остановил службу после петли падений (последний выход: ${formatLastExit(m)}); `
        + t`код 3 значит «lock держит другой демон» — под systemd это конечная остановка`,
      ...cmd(`pult daemon stop; systemctl --user reset-failed ${r.name} && systemctl --user start ${r.name}`),
    })
  } else {
    const running = m.pid !== null
    const code = m.lastExitCode
    // Смерть от сигнала — тоже не штатный выход: раньше её не было видно вовсе (у launchd после
    // сигнала нет строки `last exit code`), и доктор писал «ok, последний код —».
    const bad = !running && ((code !== null && code !== 0) || m.lastSignal !== null)
    items.push({
      id: 'service',
      title: t('Служба'),
      status: bad ? 'warn' : 'ok',
      detail: t`загружена${running ? `, pid ${m.pid}` : t`, процесса нет${m.state ? ` (${m.state})` : ''}`}, последний выход: ${formatLastExit(m)}`
        + (!running && code === 0 ? t(' (штатная остановка — следующая команда поднимет через службу)') : '')
        + (!running && code === 3 ? t(' (lock держит другой демон — служба заберёт его, когда тот уйдёт)') : ''),
      ...(bad ? cmd(`tail -n 50 ${paths.serviceLog}`) : {}),
    })
  }

  if (r.stale) {
    items.push({
      id: 'service.file',
      title: t('Файл службы'),
      status: 'warn',
      detail: t`${r.file} записан прежней версией — ${r.stale}`,
      ...cmd('pult daemon install'),
    })
  }

  items.push(nodePathItem(paths))
  if (r.platform === 'linux') {
    try { items.push(lingerItem(serviceContext(paths, env))) } catch { /* платформа уже проверена выше */ }
  }
  return items
}

/**
 * Те же пункты, но в отдельном потоке — для `doctor.run` ДЕМОНА. Все опросы менеджера служб
 * синхронные (spawnSync, таймаут 20 с на вызов), и прямо на событийном цикле демона медленный
 * или зависший launchctl морозил ВЕСЬ демон: `daemon.status`, ходы агентов и подписки других
 * клиентов ждали, пока он ответит (измерено: 2,6 с простоя на `launchctl print`, думающем 2 с).
 * В потоке блокируется только он; ждёт результата один этот `doctor.run`.
 */
export function serviceDoctorItemsAsync(paths: PultPaths, env: NodeJS.ProcessEnv): Promise<DoctorItem[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./doctorWorker.js', import.meta.url), { workerData: { paths, env: { ...env }, language: getLanguage() } })
    // Поток не держит процесс: демон, которого останавливают посреди доктора, выходит сразу.
    worker.unref()
    let settled = false
    worker.once('message', (items: DoctorItem[]) => { settled = true; resolve(items) })
    worker.once('error', (e) => { if (!settled) { settled = true; reject(e) } })
    worker.once('exit', (code) => {
      if (!settled) { settled = true; reject(new Error(t`проверка службы завершилась без ответа (код ${code})`)) }
    })
  })
}

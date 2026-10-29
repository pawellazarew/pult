import { t as tr } from '../lib/i18n.js'
// Коды завершения зависят от программы. Число 1 само по себе не объясняет причину:
// у grep это «нет совпадений», у другой команды — общий отказ. Подсказка не подменяет исходный вывод.

export interface FailureExplanation {
  title: string
  explanation: string
  action: string
  /** Ожидаемый результат команды (например, пустой поиск), а не падение агента. */
  expected?: true
}

export interface FailureContext {
  scope: 'tool' | 'agent' | 'check'
  exitCode?: number
  command?: string
}

/** Только явно подписанный код: случайная цифра в пути или номере строки — не код выхода. */
export function exitCodeIn(text: string): number | undefined {
  const m = /(?:\bexit(?:ed)?(?:\s+with)?(?:\s+(?:exit\s+)?code)?|код(?:ом)?(?:\s+выхода)?)\s*[:=]?\s*(-?\d+)\b/i.exec(text)
  return m ? Number(m[1]) : undefined
}

export function explainFailure(raw: string | undefined, context: FailureContext): FailureExplanation {
  const output = (raw ?? '').replace(/\x1b\[[0-9;]*m/g, '')
  const code = context.exitCode ?? exitCodeIn(output)
  const tool = context.scope === 'tool'
  const check = context.scope === 'check'
  const title = tool ? tr('Команда не выполнена') : check ? tr('Проверка не прошла') : tr('Агент не завершил ответ')
  // Только простая самостоятельная команда поиска: у pipeline код может принадлежать другой программе.
  if (tool && code === 1 && /^\s*(?:command\s+)?(?:rg|grep|git\s+grep)(?:\s|$)/.test(context.command ?? '') && !/[|;&\n]/.test(context.command ?? '')) {
    return { title: tr('Поиск ничего не нашёл'), explanation: tr('Для этой команды код 1 означает, что совпадений нет. Это не означает, что агент сломался.'), action: tr('Агент может продолжить работу или изменить запрос поиска.'), expected: true }
  }
  if (/(?:selected model is at capacity|model[^\n]{0,60}(?:at capacity|overloaded))/i.test(output)) {
    return { title: tr('Выбранная модель перегружена'), explanation: tr('Сервис временно не может принять запрос к этой модели.'), action: tr('Попробуй позже или выбери другую модель в настройках сессии.') }
  }
  if (/(?:not logged in|login required|authentication (?:failed|required)|unauthorized|invalid[_ ]api[_ ]key|please log in|please run [^\n]*\blogin\b|не авторизован|нужна авторизация)/i.test(output)) {
    return { title: tr('Нужно проверить вход в аккаунт'), explanation: tr('В выводе программы есть сообщение об отказе авторизации.'), action: tool ? tr('Проверь вход в сервис, к которому обращалась команда, затем повтори действие.') : tr('Открой «Диагностику»: там указана команда входа для Claude или Codex. После входа повтори реплику.') }
  }
  if (/(?:rate[_ -]?limit(?:ed| exceeded)?|too many requests|quota (?:exceeded|exhausted)|usage limit|лимит исчерпан)/i.test(output)) {
    return { title: tr('Сервис ограничил запросы'), explanation: tr('В выводе программы указан лимит запросов или доступной квоты.'), action: tr('Дождись сброса лимита или проверь доступную квоту, затем повтори действие.') }
  }
  if (/(?:ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network (?:error|unreachable)|connection (?:refused|reset|timed out)|fetch failed|could not resolve host)/i.test(output)) {
    return { title: tr('Не удалось связаться с сервисом'), explanation: tr('Программа сообщила об ошибке сетевого соединения.'), action: tr('Проверь подключение к сети и доступность сервиса. Когда связь восстановится, повтори действие.') }
  }
  if (/(?:command not found|spawn\s+\S+\s+ENOENT|не найдена команда)/i.test(output) || (tool && code === 127)) {
    return { title: tr('Не найдена нужная программа'), explanation: tr('Команда не запустилась: исполняемого файла нет или он недоступен в окружении процесса.'), action: tool ? tr('Проверь название команды и установку программы. Агент может выбрать другой способ.') : tr('Открой «Диагностику», проверь установку Claude или Codex и повтори реплику.') }
  }
  if (/(?:permission denied|EACCES|operation not permitted|доступ запрещён|нет прав доступа)/i.test(output) || (tool && code === 126)) {
    return { title: tr('Программе не хватило доступа'), explanation: tr('Программа сообщила об отказе в доступе к файлу или запуску команды.'), action: tr('Проверь путь и права доступа к нужному файлу. Не включай полный доступ без необходимости.') }
  }
  if (tool && code === 0) return { title: tr('Команда завершилась'), explanation: tr('Код 0 означает успешное завершение процесса. Если инструмент сообщил ошибку, её причина указана в выводе.'), action: tr('Посмотри полный вывод инструмента.') }
  const explanation = code === 1
    ? tr('Код 1 — общий сигнал, что программа не выполнила действие. Точную причину по этому числу определить нельзя.')
    : code !== undefined
      ? tr`Код ${code} — результат завершения программы. Его значение зависит от конкретной команды; причина может быть указана в выводе.`
      : tr('Программа сообщила об ошибке, но точная причина не определена.')
  return { title, explanation, action: tool ? tr('Посмотри вывод ниже. Агент может исправить команду и продолжить работу.') : check ? tr('Посмотри технические подробности и рекомендацию этой проверки ниже.') : tr('Открой технические подробности. Если причина неясна, проверь «Диагностику» и повтори реплику.') }
}

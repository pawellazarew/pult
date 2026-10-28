import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { explainFailure, exitCodeIn } from '../src/model/errors.js'

describe('пояснения ошибок вместо голых кодов', () => {
  it('код 1 не подменяется выдуманной причиной', () => {
    const failure = explainFailure('claude завершился: код 1', { scope: 'agent' })
    assert.match(failure.explanation, /общий сигнал/)
    assert.match(failure.explanation, /Точную причину.*нельзя/)
    assert.match(failure.action, /Диагностику/)
    assert.doesNotMatch(failure.title, /сеть|аккаунт|лимит/)
  })
  it('разбирает только явно подписанные коды, а не цифры ошибок и путей', () => {
    for (const text of ['exit code 127', 'exited with code 127', 'код выхода 127', 'кодом 127']) assert.equal(exitCodeIn(text), 127, text)
    assert.equal(exitCodeIn('error at /tmp/1/a.ts:127'), undefined)
    assert.equal(exitCodeIn('HTTP 401'), undefined)
  })
  it('пустой rg/grep — нормальный результат поиска; pipeline и другая команда с кодом 1 не получают эту трактовку', () => {
    for (const command of ['rg "hello" src', 'grep -n hello file', 'git grep hello']) {
      const failure = explainFailure('', { scope: 'tool', exitCode: 1, command })
      assert.equal(failure.expected, true)
      assert.match(failure.title, /ничего не нашёл/)
    }
    for (const command of ['npm test', 'rg hello | sort', 'grep hello file; npm test', 'rg hello\nnpm test']) {
      assert.equal(explainFailure('', { scope: 'tool', exitCode: 1, command }).expected, undefined, command)
    }
    assert.equal(explainFailure('', { scope: 'tool', exitCode: 2, command: 'rg hello' }).expected, undefined)
  })
  it('конкретные советы требуют конкретного сообщения программы', () => {
    const examples = [
      ['Not logged in. Please run /login', /аккаунт/],
      ['rate_limit_exceeded', /ограничил/],
      ['connect ECONNREFUSED 127.0.0.1', /связаться/],
      ['bash: bun: command not found', /Не найдена/],
      ['EACCES: permission denied', /доступа/],
    ] as const
    for (const [raw, title] of examples) assert.match(explainFailure(raw, { scope: 'agent' }).title, title)
    assert.match(explainFailure('internal', { scope: 'agent' }).explanation, /причина не определена/)
    assert.doesNotMatch(explainFailure('Please run npm install', { scope: 'tool' }).title, /аккаунт/)
  })
  it('значение других чисел зависит от программы; код 0 не объявляется падением', () => {
    assert.match(explainFailure('', { scope: 'tool', exitCode: 2 }).explanation, /зависит от конкретной команды/)
    assert.match(explainFailure('', { scope: 'tool', exitCode: 0 }).explanation, /успешное завершение/)
  })
})

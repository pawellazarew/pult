import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setLanguage } from '../../src/i18n/core.js'

// Match renderer startup: choose the locale before evaluating display constants.
setLanguage('en')
const { friendlyTool } = await import('../src/model/activity.js')
const { formatSeconds, messageSource } = await import('../src/model/conversation.js')
const { formatTokens, formatExact } = await import('../src/model/context.js')
const { explainFailure } = await import('../src/model/errors.js')
const { countryName, searchCountries, exitRows } = await import('../src/model/netGuard.js')
const { APPROVAL_LABEL, approvalHint } = await import('../src/model/newAgent.js')
const { describePermission, scopeButtons } = await import('../src/model/permissions.js')
const { formatElapsed, phaseText } = await import('../src/model/phase.js')
const { EMPTY_THROTTLE, flushThrottle, offerNotice } = await import('../src/model/notify.js')
const { unmarkedNote } = await import('../src/model/rules.js')
const { formatResetIn, formatClock, limitWindowsView } = await import('../src/model/usage.js')
const { plural } = await import('../src/lib/ru.js')

test('English model labels, durations and diagnostics use English', () => {
  assert.equal(friendlyTool('Bash'), 'Command')
  assert.equal(APPROVAL_LABEL.workspace, 'Edit workspace without asking')
  assert.match(approvalHint('codex', 'full'), /no sandbox/)
  assert.equal(formatElapsed(65_000), '1 min 05 s')
  assert.equal(formatSeconds(300), '0.3 s')
  assert.equal(formatTokens(4200), '4.2k')
  assert.equal(formatExact(48213), '48,213')
  assert.equal(phaseText({ phase: 'thinking', since: 1, turnSince: 1, background: 2 }), 'thinking… · background tasks: 2')
  assert.equal(explainFailure('Selected model is at capacity', { scope: 'agent' }).title, 'Selected model is at capacity')
  assert.equal(explainFailure('код выхода 127', { scope: 'tool' }).title, 'Required program not found')
  assert.equal(plural(21, 'session', 'sessions', 'sessions'), 'sessions')
  assert.equal(plural(1, 'session', 'sessions', 'sessions'), 'session')
  assert.match(unmarkedNote(21)!, /21 more lines/)
})

test('English permissions translate UI labels and preserve commands, paths and provider prose', () => {
  const command = 'echo "ошибка"'
  const reason = 'Проверь доступ к файлу'
  const view = describePermission('Bash', { command, description: reason })
  assert.equal(view.title, 'Terminal command')
  assert.equal(view.target, command)
  assert.equal(view.reason, reason)
  assert.equal(scopeButtons({ session: true })[0]?.label, 'For this session')
  assert.equal(messageSource({ type: 'user', key: 'u1', id: 1, ts: '', text: 'Правка файлов' }), 'Правка файлов')
})

test('English network guard uses English country names and search', () => {
  assert.equal(countryName('DE'), 'Germany')
  assert.equal(searchCountries('Germany', [])[0], 'DE')
  assert.equal(exitRows({ mode: 'deny', countries: [] }, [])[0]?.text, 'claude: exit has not been checked')
  setLanguage('ru')
  assert.equal(countryName('DE'), 'Германия')
  assert.equal(formatSeconds(300), '0,3 с')
  assert.equal(formatTokens(4200), '4,2k')
  assert.equal(formatElapsed(65_000), '1 мин 05 с')
  setLanguage('en')
  assert.equal(countryName('DE'), 'Germany')
})

test('English subscription reset dates and labels', () => {
  const now = Date.parse('2026-10-30T10:00:00Z')
  assert.equal(formatResetIn(now / 1000 + 125 * 60, now), 'in 2 h 5 min')
  assert.equal(formatClock(Date.parse('2026-11-02T14:30:00Z'), now, 'UTC'), '2 Nov 14:30')
  const windows = limitWindowsView({ fiveHour: { utilization: 0.5, resetsAt: now / 1000 + 3600 }, sevenDay: null, status: 'allowed', resetsAt: null, updatedAt: '', eventId: 1 }, now)
  assert.equal(windows[0]?.key, '5h')
  assert.match(windows[0]?.title ?? '', /^5-hour window: 50% used/)
})

test('notification summary uses English plural at 21 and targets Inbox', () => {
  let throttle = EMPTY_THROTTLE
  for (let i = 0; i < 23; i++) throttle = offerNotice(throttle, { target: { sessionId: `s${i}` }, kind: 'ask' }, 100).t
  const summary = flushThrottle(throttle, 10_101).summary
  assert.equal(summary?.title, 'Pult')
  assert.equal(summary?.body, '21 more sessions need you')
  assert.deepEqual(summary?.target, { inbox: true })
})

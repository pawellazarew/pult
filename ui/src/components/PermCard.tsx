import { t } from '../lib/i18n.js'
// Карточка запроса разрешения — одна и та же в Inbox и в ленте разговора (docs/12 §3 п.3).

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { byHuman, concealedNote, describePermission, gutterNo, optionsLine, scopeButtons, scopeText } from '../model/permissions.js'
import type { PermKind } from '../model/permissions.js'
import type { PermissionOffers, PermissionScope } from '../../../src/adapters/types.js'
import type { DiffBlock } from '../model/permissions.js'
import { answersReady, buildAnswers, isQuestionTool, questionsOf } from '../model/questions.js'
import type { QuestionView } from '../model/questions.js'
import { ago, shortPath } from '../model/agents.js'
import { CMD, Icon, Kbd, ProviderTag } from './common.js'
import { plural } from '../lib/ru.js'

export interface PermCardProps {
  permId: string
  toolName: string
  input: Record<string, unknown>
  state: 'pending' | 'allow' | 'deny' | 'expired'
  /** Кто просит — в Inbox; в ленте своего агента не нужно. */
  agent?: { name: string; provider: string; key?: string }
  createdAt: string
  now: number
  focused?: boolean
  message?: string
  by?: string
  /** M8d: что провайдер предложил сверх «один раз» — кнопки «В этой сессии» и «Всегда …». */
  offers?: PermissionOffers
  /** Показано не всё: фильтр секретов скрыл часть входа или длинное поле обрезано — исполнится исходный вход. */
  concealed?: boolean
  /** M8d: решённая карточка — с какой шириной разрешили. */
  scope?: 'session' | 'rule'
  rule?: { kind: string; label: string }
  busy?: boolean
  onFocus?(): void
  /** Inbox: прыжок к этой карточке в ленте разговора (в самой ленте кнопка не нужна). */
  onJump?(): void
  /** Без аргумента — один раз (так зовёт и ⌘↵); `session` / `rule` — только из своих кнопок. */
  onApprove?(scope?: Exclude<PermissionScope, 'once'>): void
  onDeny?(reason: string): void
  onAnswer?(answers: Record<string, { answers: string[] }>): void
}

function Diff({ d }: { d: DiffBlock }): ReactElement {
  return (
    <div className="diff">
      <div className="diff-h">
        <span>{d.path ?? t('изменение')}</span>
        <span className="a">+{d.added}</span>
        <span className="d">−{d.removed}</span>
      </div>
      {d.rows.map((r, i) => (r.op === 'gap'
        ? <div key={i} className="dl gap">{r.count ? t`⋯ ${r.count} без изменений` : '⋯'}</div>
        : (
          <div key={i} className={`dl ${r.op === '+' ? 'add' : r.op === '-' ? 'del' : ''}`}>
            <span className="no">{gutterNo(r)}</span>
            <span className="op">{r.op === ' ' ? '' : r.op === '-' ? '−' : '+'}</span>
            <span className="tx">{r.text || ' '}</span>
          </div>
        )))}
    </div>
  )
}

const BY: Record<string, string> = { human: t('человек'), timeout: t('таймаут'), stop: t('сессия остановлена'), rm: t('сессия удалена'), shutdown: t('демон остановлен') }

export function PermCard(p: PermCardProps): ReactElement {
  const v = useMemo(() => describePermission(p.toolName, p.input), [p.toolName, p.input])
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')
  const reasonRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (denying) reasonRef.current?.focus() }, [denying])
  const scopes = scopeButtons(p.offers)
  const rule = scopes.find((b) => b.scope === 'rule')
  if (isQuestionTool(p.toolName)) return <QuestionCard {...p} />

  return (
    <article className="perm" data-state={p.state} data-focused={p.focused ? 'true' : 'false'}
      data-testid="perm-card" data-perm-id={p.permId} onMouseDown={p.onFocus}>
      <div className="perm-h">
        <span className="lbl" title={v.title}>{v.title}</span>
        {p.agent && <><span className="who" title={p.agent.key && p.agent.key !== p.agent.name ? t`${p.agent.name} · имя для CLI: ${p.agent.key}` : p.agent.name}>{p.agent.name}</span><ProviderTag provider={p.agent.provider} /></>}
        {p.state === 'pending' && <span className="waited">{t("ждёт ")}{ago(p.createdAt, p.now)}</span>}
        {p.onJump && <button type="button" className="btn btn-ghost btn-sm perm-jump" data-testid="perm-jump"
          title={t("Открыть разговор и показать этот запрос в ленте")} onClick={(e) => { e.stopPropagation(); p.onJump?.() }}>{t("в ленту")}<Icon name="chev" /></button>}
      </div>
      {v.target && <div className={`perm-target${v.kind === 'command' ? ' cmd' : ''}`}>{v.target}</div>}
      {v.reason && <div className="perm-reason">{v.reason}</div>}
      {v.cwd && <div className="perm-opts" title={v.cwd}>{t("в папке ")}{shortPath(v.cwd, 48)}</div>}
      {p.state === 'pending' && v.diffs.map((d, i) => <Diff key={i} d={d} />)}
      {/* Решённая карточка сохраняет diff свёрнутым: утром проверяется, что именно разрешили ночью. */}
      {p.state !== 'pending' && v.diffs.length > 0 && (
        <details className="perm-diff-resolved" data-testid="perm-diff-resolved">
          <summary>{v.diffs.length === 1 && v.diffs[0]?.path ? v.diffs[0].path : t`изменения · ${v.diffs.length} ${plural(v.diffs.length, t('файл'), t('файла'), t('файлов'))}`}
            {' '}<span className="a">+{v.diffs.reduce((n, d) => n + d.added, 0)}</span> <span className="d">−{v.diffs.reduce((n, d) => n + d.removed, 0)}</span></summary>
          {v.diffs.map((d, i) => <Diff key={i} d={d} />)}
        </details>
      )}
      {p.state === 'pending' && v.fields.length > 0 && (
        <dl className="perm-fields">
          {v.fields.map(([k, val]) => <FieldRow key={k} k={k} v={val} />)}
        </dl>
      )}
      {p.state === 'pending' && p.concealed && <Concealed kind={v.kind} />}
      {p.state === 'pending' && optionsLine(v.options) && <div className="perm-opts">{t("варианты провайдера: ")}{optionsLine(v.options)}</div>}
      {p.state === 'pending' && rule?.note && <div className="perm-opts" data-testid="perm-rule-note">{rule.label} «{rule.code}» {rule.note}</div>}

      {p.state === 'pending' ? (
        <div className="perm-actions">
          {!denying ? (
            <>
              {/* ⌘↵ — всегда «Разрешить» ОДИН раз: шире — только своей кнопкой, глядя на неё (M8d). */}
              <button type="button" className="btn btn-ok" disabled={p.busy} onClick={() => p.onApprove?.()} data-testid="perm-approve"
                title={t("Разрешить один раз — только это действие")}>
                <Icon name="check" />{t("Разрешить")}{p.focused && <Kbd>{`${CMD}↵`}</Kbd>}
              </button>
              {scopes.map((b) => (
                <button key={b.scope} type="button" className="btn" disabled={p.busy} onClick={() => p.onApprove?.(b.scope)}
                  data-testid={`perm-approve-${b.scope}`}
                  title={b.scope === 'session' ? t('Разрешить это и такие же действия до конца сессии провайдера') : b.note}>
                  {b.label}{b.code && <> <code className="perm-rule">{b.code}</code></>}
                </button>
              ))}
              <button type="button" className="btn btn-danger" disabled={p.busy} onClick={() => setDenying(true)} data-testid="perm-deny">
                {t("Отказать…")}</button>
            </>
          ) : (
            <form className="perm-deny" onSubmit={(e) => { e.preventDefault(); p.onDeny?.(reason.trim()) }}>
              <input ref={reasonRef} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("причина — модель её увидит (необязательно)")}
                data-testid="perm-reason" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setDenying(false) } }} />
              <button type="submit" className="btn btn-danger" disabled={p.busy} data-testid="perm-deny-confirm">{t("Отказать")}</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDenying(false)}>{t("отмена")}</button>
            </form>
          )}
        </div>
      ) : p.state === 'expired' ? (
        <div className="perm-done expired" data-testid="perm-expired">
          <Icon name="clock" />{t("Запрос устарел: демон перезапускался, ответить на него уже нельзя")}</div>
      ) : (
        <div className={`perm-done ${p.state}`}>
          <Icon name={p.state === 'allow' ? 'check' : 'x'} />
          {p.state === 'allow' ? t('Разрешено') : t('Отказано')}
          {p.state === 'allow' && scopeText(p.scope, p.rule) && <span className="why" data-testid="perm-scope">· {scopeText(p.scope, p.rule)}</span>}
          {p.by && !byHuman(p.by) && <span className="why">({BY[p.by] ?? p.by})</span>}
          {p.state === 'deny' && p.message && <span className="why">— {p.message}</span>}
        </div>
      )}
    </article>
  )
}

function QuestionCard(p: PermCardProps): ReactElement {
  const questions = questionsOf(p.toolName, p.input)
  const [chosen, setChosen] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const answers = buildAnswers(questions, chosen, other)
  const ready = answersReady(answers, questions)
  const pick = (q: QuestionView, label: string, on: boolean): void => setChosen((s) => ({
    ...s, [q.key]: q.multi ? (on ? [...(s[q.key] ?? []), label] : (s[q.key] ?? []).filter((v) => v !== label)) : (on ? [label] : []),
  }))
  return <article className="perm" data-state={p.state} data-testid="perm-card" data-perm-id={p.permId} data-question="1" onMouseDown={p.onFocus}>
    <div className="perm-h"><span className="lbl">{t("Вопрос")}{p.agent ? ` ${p.agent.provider === 'codex' ? 'Codex' : 'Claude'}` : ''}</span>{p.agent && <><span className="who">{p.agent.name}</span><ProviderTag provider={p.agent.provider} /></>}{p.state === 'pending' && <span className="waited">{t("ждёт ")}{ago(p.createdAt, p.now)}</span>}</div>
    {p.state === 'pending' && p.concealed && <Concealed kind="question" />}
    {questions.map((q) => <fieldset key={q.key} className="question-field" disabled={p.busy || p.state !== 'pending'}>
      {q.header && <legend>{q.header}</legend>}<div className="perm-reason">{q.question}</div>
      {q.options.map((o) => <label key={o.label} className="question-option">
        <input type={q.multi ? 'checkbox' : 'radio'} name={`${p.permId}-${q.key}`} checked={(chosen[q.key] ?? []).includes(o.label)}
          onChange={(e) => pick(q, o.label, e.target.checked)} /> {o.label}
        {o.description && <span className="perm-opts">{o.description}</span>}
      </label>)}
      {q.other && <input className="question-answer" aria-label={q.options.length ? t`${q.header || q.question}: свой ответ` : q.header || q.question} type={q.secret ? 'password' : 'text'}
        value={other[q.key] ?? ''} placeholder={q.options.length ? t('Свой ответ') : t('Ответ')} onChange={(e) => setOther((s) => ({ ...s, [q.key]: e.target.value }))} />}
    </fieldset>)}
    {p.state === 'pending' ? <div className="perm-actions"><button type="button" className="btn btn-ok" disabled={p.busy || !ready} onClick={() => p.onAnswer?.(answers)} data-testid="question-send">{t("Отправить ответ")}</button><button type="button" className="btn btn-ghost" disabled={p.busy} onClick={() => p.onDeny?.('')}>{t("Пропустить")}</button></div> : <div className="perm-done">{p.state === 'allow' ? t('Ответ отправлен') : p.state === 'expired' ? t('Вопрос устарел') : t('Вопрос пропущен')}</div>}
  </article>
}

/** Показанное ≠ исходному (`concealed`): фильтр секретов или подрезка. Слова — под вид карточки (`concealedNote`). */
function Concealed({ kind }: { kind: PermKind | 'question' }): ReactElement {
  const n = concealedNote(kind)
  return (
    <div className="perm-concealed" data-testid="perm-concealed">
      {t("Показано не всё: фильтр секретов скрыл ")}{n.what} (<code>&lt;email&gt;</code>, <code>&lt;token&gt;</code>, <code>&lt;redacted&gt;</code>{t(") или длинное поле обрезано. ")}{n.then}
    </div>
  )
}

function FieldRow({ k, v }: { k: string; v: string }): ReactElement {
  return <><dt>{k}</dt><dd>{v}</dd></>
}

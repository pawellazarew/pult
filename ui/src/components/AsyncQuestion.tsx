import { useState } from 'react'
import type { ReactElement } from 'react'
import type { ModelItem } from '../model/conversation.js'
import { errorText } from '../bridge.js'
import { PermCard } from './PermCard.js'

/** Codex async questions are part of an agentMessage; they never block the active turn. */
export function AsyncQuestion({ item, session, now, onAnswer }: {
  item: ModelItem; session: string; now: number
  onAnswer?(questionId: number, answers: string[]): Promise<void>
}): ReactElement {
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const questions = item.questions ?? []
  const questionId = item.questionEventId ?? item.id
  const input = { questions: questions.map((q, i) => ({ id: String(i), question: q.title, header: '', options: q.options?.map(label => ({ label })), isOther: true, multiSelect: false })) }
  const answer = (answers: Record<string, { answers: string[] }>): void => {
    if (busy || sent || !onAnswer) return
    setBusy(true); setError(null)
    void onAnswer(questionId, questions.map((_q, i) => answers[String(i)]?.answers.join('; ') ?? ''))
      .then(() => setSent(true)).catch((e: unknown) => setError(errorText(e))).finally(() => setBusy(false))
  }
  return <div data-testid="async-question">
    <PermCard permId={`${session}:async:${questionId}`} toolName="requestUserInput" input={input}
      state={item.questionAnswered || sent ? 'allow' : 'pending'} createdAt={item.ts} now={now}
      busy={busy || !onAnswer} allowSkip={false} onAnswer={answer} />
    {error && <div className="err" role="alert">{error}</div>}
  </div>
}

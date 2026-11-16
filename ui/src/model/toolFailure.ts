import type { FailureExplanation } from './errors.js'

/** A retained preview must not keep the tool's full output or command alive. */
export interface CompactToolFailure {
  failure: FailureExplanation
  tail: string
  hasOutput: boolean
}

export function compactToolFailure(failure: FailureExplanation, result: string | undefined): CompactToolFailure {
  return {
    failure: {
      title: failure.title.slice(0, 512),
      explanation: failure.explanation.slice(0, 512),
      action: failure.action.slice(0, 512),
      ...(failure.expected ? { expected: true } : {}),
    },
    tail: toolFailureTail(result),
    hasOutput: Boolean(result),
  }
}

export function toolFailureTail(result: string | undefined): string {
  return (result ?? '').split('\n').filter((line) => line.trim()).slice(-6).join('\n').slice(-1600)
}

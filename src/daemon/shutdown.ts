/** Общий предел больше штатной лестницы Codex (3+3 с) и ожидания обновления (3 с). */
export function shutdownDeadline(onTimeout: () => void, timeoutMs = 20_000): () => void {
  const timer = setTimeout(onTimeout, timeoutMs)
  return () => clearTimeout(timer)
}

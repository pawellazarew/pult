// Инвариант 1: окружение дочернего процесса строится по БЕЛОМУ СПИСКУ, а не вычищением плохого.
// Причина измерена спайком (DELTA v0.4 §4): процесс, запущенный из десктопного приложения
// Claude, несёт 25 переменных ANTHROPIC_* / CLAUDE_*, среди них ANTHROPIC_BASE_URL (молча
// уводит API на другой адрес) и CLAUDE_CODE_MESSAGING_SOCKET (подключает ребёнка к ЧУЖОЙ
// сессии). Чёрный список такое не удержит: завтра появится двадцать шестая переменная.

export const ENV_ALLOWLIST = ['HOME', 'USER', 'PATH', 'LANG', 'TERM', 'TMPDIR'] as const

/** Запасной PATH, если в родителе его нет (так бывает у ребёнка launchd). */
export const FALLBACK_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'

export interface ChildEnvOptions {
  /** Профиль сети: HTTPS_PROXY/NO_PROXY или пусто в прямом режиме. */
  network?: Record<string, string>
  /** Явный PATH (например, собранный из логин-шелла). */
  path?: string
  /** Дополнительные переменные, которые добавляет вызывающий осознанно. */
  extra?: Record<string, string>
}

/**
 * Строит окружение ребёнка. Возвращает ОБЫЧНЫЙ объект без прототипа: ни `toString`, ни
 * `constructor` из Object.prototype не должны случайно превратиться в переменную окружения.
 */
export function buildChildEnv(
  parent: NodeJS.ProcessEnv = process.env,
  opts: ChildEnvOptions = {},
): Record<string, string> {
  const env: Record<string, string> = Object.create(null) as Record<string, string>
  for (const key of ENV_ALLOWLIST) {
    const v = parent[key]
    if (typeof v === 'string' && v.length) env[key] = v
  }
  if (opts.path) env['PATH'] = opts.path
  if (!env['PATH']) env['PATH'] = FALLBACK_PATH
  for (const [k, v] of Object.entries(opts.network ?? {})) env[k] = v
  for (const [k, v] of Object.entries(opts.extra ?? {})) env[k] = v
  return env
}

/** Окружение Claude Code для запусков из Пульта. Настройки внешнего терминала не наследуются. */
export function buildClaudeEnv(
  parent: NodeJS.ProcessEnv,
  network?: Record<string, string>,
  extra?: Record<string, string>,
): Record<string, string> {
  return buildChildEnv(parent, {
    ...(network ? { network } : {}),
    extra: { ...extra, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
  })
}

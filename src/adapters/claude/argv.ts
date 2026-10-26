// Сборка argv для `claude`. Флаги — РОВНО те, что измерены спайком (DELTA v0.5 §2) и
// перепроверены при записи фикстур на 2.1.278.
//
// ДВА ПРАВИЛА, КОТОРЫЕ НЕЛЬЗЯ НАРУШАТЬ:
//   1. Промпт идёт в stdin дочернего процесса, НИКОГДА в argv (план Ф1 §4). В argv он виден
//      в `ps` любому пользователю машины и попадает в историю процессов.
//   2. Инвариант 5: нода без хозяина разрешений запускается с `--permission-prompts none` —
//      «всё, что спросило бы, отклоняется само». Если брокер есть, ставится `host` вместе с
//      `--mcp-config` и `--permission-prompt-tool mcp__pult__ask`. Полумеры («host без
//      инструмента») не бывает: спросить будет некого, и ход встанет навсегда.

import type { ApprovalMode } from '../types.js'

export const PERMISSION_SERVER_NAME = 'pult'

/**
 * M8d: режим подтверждений сессии → `--permission-mode` CLI. `ask` — флага НЕТ: действуют собственные
 * настройки владельца (`defaultMode` и правила), как у всех сессий до M8d. `full` — `bypassPermissions`:
 * в нём браузер для агента не включается (src/mcp/browser.ts `approvalBrowserRefusal`, правило О3).
 *
 * `read-only` — НЕ `plan` (ревью M8d): в `plan` haiku писал `~/.claude/plans/…md` без вопроса, а ExitPlanMode
 * выводил из плана одним общим «да» в Inbox. Теперь это `manual` — явный «спрашивать» CLI, перебивающий
 * `defaultMode` владельца (в system/init он виден как `default`), — плюс запрет инструментов правки и ExitPlanMode
 * (`CLAUDE_READONLY_DENIED`). ИЗМЕРЕНО спайком S10 (CLI 2.1.303, haiku): Write отказан без вопроса, файла нет;
 * `touch` через Bash — вопрос пришёл в заглушку.
 */
export const CLAUDE_PERMISSION_MODE: Readonly<Record<ApprovalMode, string | null>> = {
  'read-only': 'manual',
  ask: null,
  workspace: 'acceptEdits',
  full: 'bypassPermissions',
}
export const PERMISSION_TOOL = `mcp__${PERMISSION_SERVER_NAME}__ask`

/** Инструменты, которых у сессии `read-only` нет вовсе (`--disallowedTools`): правки файлов и выход из режима плана. */
export const CLAUDE_READONLY_DENIED: readonly string[] = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'ExitPlanMode']

export interface ClaudePermissionRules { allow?: readonly string[]; ask?: readonly string[]; deny?: readonly string[] }

/**
 * 0.3.7: правила, которые Пульт ставит КАЖДОЙ сессии Claude поверх правил владельца (у Claude deny > ask > allow, и
 * разрешающее правило владельца их не перебьёт):
 *   * `deny Read/Edit(//<папка>/**)` — папка `PULT_HOME/run` (токен хозяина, mcp-config с ключом вопросов): `//` —
 *     абсолютный путь в правилах Claude Code; правило Edit закрывает и Write/MultiEdit/NotebookEdit;
 *   * `read-only` — `ask: ["Bash"]`: правило владельца вроде `Bash(python3:*)` иначе исполнило бы интерпретатор в
 *     «Только чтение» без вопроса (`manual` уважает allow-правила). ИЗМЕРЕНО спайком S12 (CLI 2.1.310, haiku): с `ask`
 *     вопрос пришёл, без него — команда прошла молча; Read файла в папке вне cwd под deny — отказ без вопроса.
 */
export function claudeGuardPermissions(protectDirs: readonly string[], approval?: ApprovalMode): ClaudePermissionRules {
  return {
    ...(approval === 'read-only' ? { ask: ['Bash'] } : {}),
    deny: protectDirs.flatMap((d) => [`Read(/${d}/**)`, `Edit(/${d}/**)`]),
  }
}

/** Слить наборы правил: списки по видам, без повторов, порядок первого появления. Пустые виды не пишутся. */
export function mergePermissions(...sets: Array<ClaudePermissionRules | undefined>): ClaudePermissionRules {
  const out: { allow?: string[]; ask?: string[]; deny?: string[] } = {}
  for (const kind of ['allow', 'ask', 'deny'] as const) {
    const all = [...new Set(sets.flatMap((x) => [...(x?.[kind] ?? [])]))]
    if (all.length) out[kind] = all
  }
  return out
}

export interface ClaudeArgvOptions {
  /** Первый ход сессии: `--session-id <uuid>`. Последующие: `--resume <uuid>`. */
  sessionId: string
  resume: boolean
  forkOnResume?: boolean
  model?: string
  effort?: string
  settingSources?: string
  /** M8d: режим подтверждений сессии; нет или `ask` — флага `--permission-mode` нет. */
  approval?: ApprovalMode
  /** Путь к сгенерированному файлу mcp-config; есть только когда брокер подключён. */
  mcpConfigPath?: string
  /**
   * О3: правила разрешений сессии строкой `--settings {"permissions": …}` (src/mcp/session.ts): спросить
   * про браузер всегда, запретить исполнение кода, разрешить чтение скачиваний. Только вместе с брокером.
   */
  permissions?: { allow?: readonly string[]; ask?: readonly string[]; deny?: readonly string[] }
  /**
   * 0.3.7: папки, которые агенту не читать и не править НИКОГДА (`PULT_HOME/run`: токен хозяина, файлы --mcp-config
   * с ключами вопросов). Правила `deny` уходят в `--settings` при любом режиме и вместе с правилами О3.
   */
  protectDirs?: readonly string[]
  /** Дополнительные флаги (например `--allowedTools`). */
  extra?: readonly string[]
}

export function buildClaudeArgv(opts: ClaudeArgvOptions): string[] {
  const a: string[] = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--forward-subagent-text',
  ]
  if (opts.resume) a.push('--resume', opts.sessionId)
  else a.push('--session-id', opts.sessionId)
  if (opts.resume && opts.forkOnResume) a.push('--fork-session')
  if (opts.model) a.push('--model', opts.model)
  if (opts.effort) a.push('--effort', opts.effort)
  if (opts.settingSources) a.push('--setting-sources', opts.settingSources)
  const mode = opts.approval ? CLAUDE_PERMISSION_MODE[opts.approval] : null
  if (mode) a.push('--permission-mode', mode)
  // Список — отдельными словами, ровно как в замере S10 (флаг вариадический; следом всегда идёт флаг на «--»).
  if (opts.approval === 'read-only') a.push('--disallowedTools', ...CLAUDE_READONLY_DENIED)
  if (opts.mcpConfigPath) {
    a.push('--permission-prompts', 'host')
    a.push('--mcp-config', opts.mcpConfigPath)
    a.push('--strict-mcp-config')
    a.push('--permission-prompt-tool', PERMISSION_TOOL)
  } else {
    a.push('--permission-prompts', 'none')
  }
  // Правила О3 (браузер) — только вместе с брокером; правила 0.3.7 — всегда. Один флаг `--settings` на всё.
  const p = mergePermissions(
    claudeGuardPermissions(opts.protectDirs ?? [], opts.approval),
    opts.mcpConfigPath ? opts.permissions : undefined,
  )
  if (p.allow?.length || p.ask?.length || p.deny?.length) a.push('--settings', JSON.stringify({ permissions: p }))
  if (opts.extra) a.push(...opts.extra)
  return a
}

/**
 * Реплика пользователя в формате `--input-format stream-json`.
 *
 * `uuid` — метка реплики. С ней CLI говорит, какой `result` отвечает именно на неё
 * (`result.user_message_uuids`), и шлёт `command_lifecycle` (`queued` → `started` →
 * `completed`). ИЗМЕРЕНО 08.10.2026, CLI 2.1.294; без `uuid` ни того ни другого нет.
 */
export function userTurnLine(text: string, uuid?: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    ...(uuid ? { uuid } : {}),
  }) + '\n'
}

export interface McpConfigOptions {
  /** Чем запускать заглушку — обычно process.execPath. */
  nodeBin: string
  /** Путь до собранного `dist/cli/main.js`: заглушка — это режим самого `pult`. */
  cliEntry: string
  /** PULT_HOME — только чтобы заглушка нашла сокет. Токена хозяина она не читает (0.3.7). */
  home: string
  /** 0.3.7: ключ вопросов этого процесса `claude` (src/perm/askKeys.ts): право только на `perm.request` своей сессии. */
  askKey: string
  /** Имя сессии: заглушка подписывает им запросы брокеру. */
  sessionName: string
  /**
   * О3: серверы сверх заглушки — браузер агента и выбранные владельцем (src/mcp/session.ts). Имя
   * `pult` среди них не перебивает заглушку: разрешения спрашивает только она.
   */
  servers?: Record<string, Record<string, unknown>>
}

/**
 * Содержимое файла `--mcp-config`. Запускается НАСТОЯЩИЙ `pult mcp-ask`, а не отдельный
 * бинарь: так круг разрешений в тестах и в жизни идёт по одному и тому же коду.
 * PULT_HOME и ключ вопросов передаются через env этого файла — своего окружения у заглушки нет: её
 * запускает `claude`, а не Пульт. Файл лежит в `PULT_HOME/run` (0600), и чтение этой папки агенту запрещено
 * (`claudeGuardPermissions`).
 */
export function mcpConfigBody(opts: McpConfigOptions): string {
  const extra = { ...(opts.servers ?? {}) }
  delete extra[PERMISSION_SERVER_NAME]
  return JSON.stringify({
    mcpServers: {
      // Заглушка — первой: порядок claude не важен, а читать файл глазами проще.
      [PERMISSION_SERVER_NAME]: {
        command: opts.nodeBin,
        args: [opts.cliEntry, 'mcp-ask'],
        env: {
          PULT_HOME: opts.home,
          PULT_ASK_SESSION: opts.sessionName,
          PULT_ASK_KEY: opts.askKey,
        },
      },
      ...extra,
    },
  }, null, 2) + '\n'
}

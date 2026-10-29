// Сборка MCP-серверов сессии сверх заглушки разрешений (О3): браузер агента и свои серверы владельца.
// Демон передаёт это адаптерам как `mcpExtras` (src/adapters/types.ts); зовётся перед каждым запуском
// процесса, поэтому включённый браузер и новый выбор серверов действуют со следующего хода.
//
// Codex свои серверы и так берёт из `~/.codex/config.toml` — их Пульт ему не дублирует; Codex получает
// только браузер.

import type { EventDraft } from '../core/events.js'
import type { Logger } from '../core/log.js'
import type { PultPaths } from '../core/paths.js'
import type { SessionMcpExtras, TurnSettings } from '../adapters/types.js'
import type { SessionRecord } from '../sessions/registry.js'
import type { BrowserInstaller } from './browser.js'
import {
  approvalBrowserRefusal, BROWSER_SERVER_NAME, browserCli, browserCodexSpec, browserPermissions, browserServerSpec, bypassRefusal, claudeDefaultMode,
  ensureBrowserDirs, findChrome,
} from './browser.js'
import { selectedServers } from './servers.js'

export interface ComposeDeps {
  paths: PultPaths
  logger: Logger
  installer: BrowserInstaller
  /** Запись реестра сессии (null — сессии нет). */
  record(name: string): SessionRecord | null
  /** Выбранные имена своих серверов (`config.mcp.servers`) — читаются на каждом вызове: `mcp.select` меняет их на ходу. */
  selected(): readonly string[]
  /** `~/.claude.json` (тестовый демон — файл в PULT_HOME). */
  userFile: string
  /** Файлы настроек Claude, откуда берётся `permissions.defaultMode` (src/mcp/browser.ts `claudeDefaultMode`). */
  claudeSettings(cwd: string): string[]
  /** Заметка в ленту сессии: ход идёт без браузера и почему. */
  emit(draft: EventDraft): void
  /** Поиск Chrome; подмена в тестах. */
  chrome?: () => string | null
}

export function createMcpExtras(d: ComposeDeps): (name: string, nodeBin: string, at?: TurnSettings) => Promise<SessionMcpExtras> {
  const chrome = d.chrome ?? (() => findChrome())
  const skipped = (rec: SessionRecord, reason: string): void => {
    d.emit({ sessionId: rec.name, provider: rec.provider, kind: 'browser.install', data: { state: 'skipped', reason: reason.slice(0, 500) } })
  }
  return async (name, nodeBin, at) => {
    let servers: Record<string, Record<string, unknown>> = {}
    const out: SessionMcpExtras = { servers }
    const found = d.record(name)
    if (!found) return out
    // M8f (ревью): режим и браузер — из снимка хода, а не из записи: `agent.configure`, пришедший, пока ход заводится,
    // не должен дать ЭТОМУ ходу браузер в режиме без вопросов.
    const rec: SessionRecord = at ? (() => {
      const r: SessionRecord = { ...found }
      delete r.approval
      delete r.browser
      return { ...r, ...(at.approval && at.approval !== 'ask' ? { approval: at.approval } : {}), ...(at.browser ? { browser: at.browser } : {}) }
    })() : found
    if (rec.provider === 'claude') {
      try {
        const own = await selectedServers(d.userFile, d.selected())
        for (const w of own.warnings) d.logger.warn('свои MCP-серверы: файл не прочитан', { session: name, warning: w })
        if (own.missing.length) d.logger.warn('свои MCP-серверы: выбраны, но в ~/.claude.json их нет — пропущены', { session: name, missing: own.missing })
        // Разворот, а не Object.assign: ключ записывается как своё свойство, прототип не трогается.
        servers = { ...own.servers }
      } catch (e) {
        d.logger.warn('свои MCP-серверы не собрались — ход без них', { session: name, error: (e as Error).message })
      }
    }
    if (rec.browser) {
      // M8d: режим подтверждений без вопросов — браузера нет (src/mcp/browser.ts `approvalBrowserRefusal`).
      // Запись с браузером и таким режимом agent.start/agent.browser не заводят; сюда она попадает только из
      // файла, правленного руками, — и всё равно без браузера.
      const refused = approvalBrowserRefusal(rec.provider, rec.approval)
      if (refused) {
        skipped(rec, refused)
        return { servers }
      }
      if (rec.provider === 'claude' && claudeDefaultMode(d.claudeSettings(rec.cwd)) === 'bypassPermissions') {
        // Правило «спрашивать» в этом режиме может не сработать — браузер с куками без вопросов не даём.
        skipped(rec, bypassRefusal())
        return { servers }
      }
      // Нет пакета — ставим (или ждём идущую установку). Не вышло — ход идёт без браузера, а в ленте
      // заметка: молча отрезанный браузер выглядел бы как «агент почему-то не умеет».
      const ok = await d.installer.ensure(`сессия ${name}`)
      if (!ok) {
        const st = d.installer.state()
        const why = st.state === 'failed' ? (st.error.split('\n')[0] ?? '') : 'пакет не поставлен'
        skipped(rec, `Playwright MCP не поставился: ${why} — повтор на следующем ходу, починка: pult browser install`)
        return { servers }
      }
      const dirs = ensureBrowserDirs(d.paths, name)
      const o = { nodeBin, cli: browserCli(d.paths), dirs, headed: rec.browser.headed === true, chrome: chrome() }
      servers = { ...servers, [BROWSER_SERVER_NAME]: rec.provider === 'codex' ? browserCodexSpec(o) : browserServerSpec(o) }
      return { servers, ...(rec.provider === 'claude' ? { permissions: browserPermissions(dirs) } : {}) }
    }
    return { servers }
  }
}

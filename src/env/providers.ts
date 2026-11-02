import { createAppServerClient } from '../adapters/codex/client.js'
import { parseClaudeAuth } from './doctor.js'
import { execAsync } from './exec.js'
import type { ExecResult } from './exec.js'
import { zcodeCredsFile, zcodeLoginState } from './zcodeLogin.js'

export interface ProviderModel {
  id: string
  label: string
  efforts: string[]
  defaultEffort: string
  isDefault: boolean
}
export interface ProviderReadiness {
  provider: 'claude' | 'codex' | 'zcode'
  state: 'ready' | 'login_required' | 'unavailable' | 'error'
  detail: string
  fixCmd?: string
  models: ProviderModel[]
}
export interface ProviderCatalog {
  checkedAt: string
  claude: ProviderReadiness
  codex: ProviderReadiness
  zcode: ProviderReadiness
}

export async function codexMetadataRequest(bin: string, cwd: string, env: Record<string, string>, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const c = createAppServerClient({ bin, cwd, env,
    onNotification: () => {}, onServerRequest: () => {}, onExit: () => {}, onSpawnError: () => {} })
  try {
    await c.request('initialize', { clientInfo: { name: 'pult-catalog', version: '1' } }, 20_000)
    c.notify('initialized', {})
    return await c.request(method, params, 20_000)
  } finally {
    c.endStdin()
    if (!await c.waitExit(500)) { c.kill('SIGKILL'); await c.waitExit(500) }
  }
}

export function parseCodexModels(raw: unknown): ProviderModel[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return []
    const m = entry as Record<string, unknown>
    if (typeof m['model'] !== 'string' || !m['model'] || m['hidden'] === true) return []
    const efforts = Array.isArray(m['supportedReasoningEfforts'])
      ? m['supportedReasoningEfforts'].flatMap((e: unknown) => {
        const effort = e && typeof e === 'object' ? (e as Record<string, unknown>)['reasoningEffort'] : null
        return typeof effort === 'string' ? [effort] : []
      }) : []
    return [{ id: m['model'], label: typeof m['displayName'] === 'string' ? m['displayName'] : m['model'],
      efforts, defaultEffort: typeof m['defaultReasoningEffort'] === 'string' ? m['defaultReasoningEffort'] : efforts[0] ?? '',
      isDefault: m['isDefault'] === true }]
  })
}

/** Живой список моделей Codex (`model/list`, до 10 страниц): свой `codex app-server` на время запроса. */
export async function fetchCodexModels(bin: string, cwd: string, env: Record<string, string>): Promise<ProviderModel[]> {
  const c = createAppServerClient({ bin, cwd, env,
    onNotification: () => {}, onServerRequest: () => {}, onExit: () => {}, onSpawnError: () => {} })
  try {
    await c.request('initialize', { clientInfo: { name: 'pult-catalog', version: '1' } }, 20_000)
    c.notify('initialized', {})
    const found: ProviderModel[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page = await c.request('model/list', { limit: 100, cursor }, 20_000)
      found.push(...parseCodexModels(page['data']))
      cursor = typeof page['nextCursor'] === 'string' ? page['nextCursor'] : null
      pages++
    } while (cursor && found.length < 1000 && pages < 10)
    return found
  } finally {
    c.endStdin()
    if (!await c.waitExit(500)) { c.kill('SIGKILL'); await c.waitExit(500) }
  }
}

/**
 * Вход ZCode. У CLI нет команды «статус входа», поэтому состояние читается по файлу кред
 * `~/.zcode/v2/credentials.json` (каталог переносится env `ZCODE_DATA_BASE_DIR`): файл есть и в нём
 * есть ключ `oauth:*:access_token` или `zcodejwttoken` — вход выполнен. Содержимое токенов НЕ читается
 * и наружу не попадает — только наличие ключей. `unknown` — файл есть, но разобрать не удалось.
 */
export { zcodeCredsFile, zcodeLoginState }

/** Единственный «модельный» пункт ZCode: у CLI нет флага `--model`, модель задаёт аккаунт Z.AI. */
export function zcodeModelChoices(): ProviderModel[] {
  return [{ id: 'default', label: 'По умолчанию (GLM)', efforts: [], defaultEffort: '', isDefault: true }]
}

export function createProviderCatalog(opts: {
  bins: Record<'claude' | 'codex' | 'zcode', string>
  cwd: string
  env: Record<string, string>
  testMode?: boolean
  run?: (bin: string, args: string[]) => Promise<ExecResult>
  models?: () => Promise<ProviderModel[]>
  /** Окружение `codex app-server` для `model/list` — через страж сети, как у ходов (он ходит в сеть). */
  codexEnv?: () => Promise<Record<string, string>>
  /** Проверка входа ZCode — файл кред. Тест подменяет; нет — настоящий `~/.zcode/v2/credentials.json`. */
  zcodeCreds?: () => string
}): { check(): Promise<ProviderCatalog> } {
  let running: Promise<ProviderCatalog> | null = null
  const run = opts.run ?? ((bin, args) => execAsync(bin, args, { env: opts.env, timeoutMs: 20_000 }))
  const models = opts.models ?? (async (): Promise<ProviderModel[]> =>
    fetchCodexModels(opts.bins.codex, opts.cwd, opts.codexEnv ? await opts.codexEnv() : opts.env))
  const checkOne = async (provider: 'claude' | 'codex' | 'zcode'): Promise<ProviderReadiness> => {
    const result: ProviderReadiness = { provider, state: 'error', detail: 'Проверка не завершилась', models: [] }
    if (opts.testMode && !opts.run) return { ...result, detail: 'Проверка CLI отключена в тестовом режиме' }
    try {
      if (provider === 'zcode') {
        // `--version` не ходит в сеть и не тратит квоту; вход — по файлу кред, не по CLI-запросу.
        const ver = await run(opts.bins.zcode, ['--version'])
        if (ver.status === null) return { ...result, state: ver.error?.includes('ENOENT') ? 'unavailable' : 'error', detail: 'CLI не запускается', fixCmd: 'zcode --version' }
        const login = zcodeLoginState((opts.zcodeCreds ?? zcodeCredsFile)())
        if (login === 'no') return { ...result, state: 'login_required', detail: 'Нужен вход', fixCmd: 'zcode login' }
        if (login !== 'yes') return { ...result, detail: 'Не удалось проверить вход (файл кред не разбирается)', fixCmd: 'pult doctor' }
        return { ...result, state: 'ready', detail: 'Вход выполнен · готов', models: zcodeModelChoices() }
      }
      const auth = await run(opts.bins[provider], provider === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'])
      if (auth.status === null) return { ...result, state: auth.error?.includes('ENOENT') ? 'unavailable' : 'error', detail: 'CLI не запускается', fixCmd: `${provider} --version` }
      const loggedIn = provider === 'claude' ? parseClaudeAuth(auth.stdout).loggedIn
        : /not logged in/i.test(auth.stdout + '\n' + auth.stderr) ? false
          : /logged in/i.test(auth.stdout + '\n' + auth.stderr) && auth.status === 0 ? true : null
      if (loggedIn === false) return { ...result, state: 'login_required', detail: 'Нужен вход', fixCmd: provider === 'codex' ? 'codex login' : 'claude /login' }
      if (loggedIn !== true) return { ...result, detail: 'Не удалось проверить вход', fixCmd: provider === 'codex' ? 'codex login status' : 'claude auth status' }
      if (provider === 'codex') result.models = await models()
      return { ...result, state: 'ready', detail: 'Вход выполнен · готов' }
    } catch (e) {
      return { ...result, detail: provider === 'codex' ? `Вход выполнен · список моделей недоступен: ${e instanceof Error ? e.message : String(e)}` : 'Ошибка проверки CLI',
        fixCmd: provider === 'codex' ? 'pult doctor' : provider === 'zcode' ? 'pult doctor' : `${provider} --version` }
    }
  }
  return { check() {
    if (running) return running
    running = Promise.all([checkOne('claude'), checkOne('codex'), checkOne('zcode')]).then(([claude, codex, zcode]) => ({ checkedAt: new Date().toISOString(), claude, codex, zcode }))
      .finally(() => { running = null })
    return running
  } }
}

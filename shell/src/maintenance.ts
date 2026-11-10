import { t as tr } from './i18n.js'
import { mkdirSync, readFileSync, writeFileSync, chmodSync, lstatSync, existsSync, unlinkSync, openSync, closeSync, fstatSync, readSync, constants } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { buildChildEnv } from '../../src/env/allowlist.js'
import type { LocatedTool } from '../../src/env/locate.js'
import type { DoctorReport } from '../../src/env/doctor.js'
import type { ExecResult } from '../../src/env/exec.js'
import type { MaintenanceInfo, ProviderAction, ProviderOperation, ProviderTool } from './contract.js'

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
export interface ProviderInventory { claude: LocatedTool; codex: LocatedTool; npm: LocatedTool; pathEntries: string[]; home: string }
interface Plan { command: string; handoff?: string }

export function installation(tool: LocatedTool): ProviderTool['source'] {
  const found = tool.realpath ?? tool.path ?? ''
  if (!tool.path) return 'missing'
  if (/\.app\/Contents\//.test(found)) return 'application'
  if (/\/(?:Cellar|Caskroom)\//.test(found)) return 'homebrew'
  if (/\/node_modules\/@(?:anthropic-ai\/claude-code|openai\/codex)\//.test(found)) return 'npm'
  if (/\/(?:\.local\/share\/(?:claude|codex)|\.claude\/local|\.codex\/packages\/standalone|\.local\/bin)\//.test(found)) return 'native'
  return 'unknown'
}

export function providerPlan(provider: 'claude' | 'codex', action: ProviderAction, inventory: ProviderInventory, brew: string | null): Plan {
  const tool = inventory[provider]
  const source = installation(tool)
  if (action === 'install') {
    if (tool.path) throw new Error(tr('CLI уже установлен. Используй обновление.'))
    return { command: provider === 'claude' ? 'curl -fsSL https://claude.ai/install.sh | bash' : 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' }
  }
  if (!tool.path) throw new Error(tr('CLI не найден. Сначала установи его.'))
  if (action === 'login') return { command: `${quote(tool.path)} ${provider === 'claude' ? 'auth login' : 'login'}` }
  if (source === 'application') {
    const bundle = (tool.realpath ?? tool.path).match(/^(.+?\.app)\/Contents\//)?.[1]
    if (!bundle) throw new Error(tr('Не удалось определить приложение-владельца CLI.'))
    return { command: `/usr/bin/open ${quote(bundle)}`, handoff: bundle }
  }
  if (source === 'homebrew') {
    if (!brew) throw new Error(tr('Homebrew не найден. Открой диагностику.'))
    const real = tool.realpath ?? tool.path
    const cask = provider === 'claude' && real.includes('/claude-code@latest/') ? 'claude-code@latest' : provider === 'claude' ? 'claude-code' : 'codex'
    const prefix = real.match(/^(.*?)\/(?:Cellar|Caskroom)\//)?.[1]
    const selectedBrew = prefix ? path.join(prefix, 'bin', 'brew') : brew
    return { command: `${quote(selectedBrew)} upgrade ${real.includes('/Caskroom/') ? '--cask ' : '--formula '}${cask}` }
  }
  if (source === 'npm') {
    const prefix = (tool.realpath ?? tool.path).match(/^(.*?)\/lib\/node_modules\//)?.[1]
    if (!prefix || !inventory.npm.path) throw new Error(tr('Не удалось определить npm prefix выбранного CLI.'))
    const pkg = provider === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex'
    return { command: `${quote(inventory.npm.path)} install -g --prefix ${quote(prefix)} ${pkg}@latest` }
  }
  if (source !== 'native') throw new Error(tr('Способ установки CLI неизвестен. Открой путь и выбери способ обновления вручную.'))
  if (tool.path !== path.join(inventory.home, '.local', 'bin', provider)) throw new Error(tr('Выбран нестандартный native launcher. Открой его путь и обнови эту установку вручную.'))
  return { command: `${quote(tool.path)} update` }
}

export class Maintenance {
  private doctorRun: Promise<DoctorReport> | null = null
  private jobs = new Map<string, { value: ProviderOperation; file: string; expires: number }>()
  constructor(private deps: {
    info: MaintenanceInfo
    env: NodeJS.ProcessEnv
    run(file: string, args: string[], timeoutMs: number): Promise<ExecResult>
    inventory(): Promise<ProviderInventory>
    launch(file: string): Promise<void>
    network?(provider: 'claude' | 'codex'): Promise<Record<string, string>>
    now?: () => number
  }) {}

  info(): MaintenanceInfo { return { ...this.deps.info, operations: [...this.jobs.values()].map(job => this.operation(job.value.id)) } }
  doctor(): Promise<DoctorReport> {
    if (this.doctorRun) return this.doctorRun
    this.doctorRun = (async () => {
      const info = this.deps.info
      if (!info.node) throw new Error(tr('Node Пульта не найден. Открой папку установки.'))
      const result = await this.deps.run(info.node, [path.join(info.packageRoot, 'dist/cli/main.js'), 'doctor', '--json', '--no-net'], 60_000)
      if (result.error) throw new Error(result.error)
      let report: DoctorReport
      try { report = JSON.parse(result.stdout) as DoctorReport } catch { throw new Error(tr('Доктор не вернул отчёт. Проверь журнал службы.')) }
      if (!report || !Array.isArray(report.items) || typeof report.generatedAt !== 'string' || report.home !== info.home) throw new Error(tr('Некорректный отчёт диагностики.'))
      return report
    })().finally(() => { this.doctorRun = null })
    return this.doctorRun
  }

  async providers(): Promise<ProviderTool[]> {
    const inventory = await this.deps.inventory()
    return (['claude', 'codex'] as const).map(provider => {
      const tool = inventory[provider]
      return { provider, path: tool.path, realpath: tool.realpath, version: tool.version, source: installation(tool) }
    })
  }

  async prepare(provider: 'claude' | 'codex', action: ProviderAction): Promise<{ plan: Plan; inventory: ProviderInventory; uncertain: boolean; network: Record<string, string> }> {
    if (this.deps.env['PULT_TEST'] !== '1' && process.platform !== 'darwin') throw new Error(tr('Управление CLI через Терминал доступно в macOS.'))
    for (const job of this.jobs.values()) {
      if (job.value.provider === provider && this.operation(job.value.id).state === 'running') throw new Error(tr('Действие с этим CLI уже выполняется.'))
    }
    const inventory = await this.deps.inventory()
    const brew = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find(file => existsSync(file)) ?? null
    let plan = providerPlan(provider, action, inventory, brew)
    if (provider === 'codex' && action === 'update' && installation(inventory.codex) === 'native' && inventory.codex.path) {
      const help = await this.deps.run(inventory.codex.path, ['update', '--help'], 5_000)
      if (help.error) throw new Error(tr('Не удалось проверить поддержку обновления Codex. Открой диагностику.'))
      if (help.status !== 0) plan = { command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' }
    }
    const network = plan.handoff ? {} : await this.deps.network?.(provider) ?? {}
    return { plan, inventory, network, uncertain: [...this.jobs.values()].some(job => job.value.provider === provider && this.operation(job.value.id).state === 'unknown') }
  }

  async start(provider: 'claude' | 'codex', action: ProviderAction, prepared: { plan: Plan; inventory: ProviderInventory; network?: Record<string, string> }): Promise<ProviderOperation> {
    const network = prepared.plan.handoff ? {} : await this.deps.network?.(provider) ?? prepared.network ?? {}
    for (const job of this.jobs.values()) {
      if (job.value.provider === provider && this.operation(job.value.id).state === 'running') throw new Error(tr('Действие с этим CLI уже выполняется.'))
    }
    const id = randomBytes(12).toString('hex')
    const directory = path.join(this.deps.info.home, 'run', 'maintenance', id)
    for (const folder of [this.deps.info.home, path.join(this.deps.info.home, 'run'), path.join(this.deps.info.home, 'run', 'maintenance'), directory]) {
      try { mkdirSync(folder, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      const metadata = lstatSync(folder)
      if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0) throw new Error(tr('Каталог обслуживания должен быть приватным и обычным.'))
    }
    const resultFile = path.join(directory, 'result')
    const script = path.join(directory, `${provider}-${action}.command`)
    const networkFile = path.join(directory, 'network.env')
    const networkSource = Object.entries(network).map(([key, value]) => {
      if (!['HTTPS_PROXY', 'ALL_PROXY', 'HTTP_PROXY', 'NO_PROXY'].includes(key)) throw new Error(tr('Некорректный профиль сети.'))
      return `export ${key}=${quote(value)}`
    }).join('\n') + '\n'
    let launched = false
    try {
      writeFileSync(networkFile, networkSource, { flag: 'wx', mode: 0o600 })
      const body = 'set -o pipefail\numask 077\n'
        + `pult_result_file=${quote(resultFile)}\npult_network_file=${quote(networkFile)}\n`
        + 'pult_done() { pult_code=$?; /bin/rm -f "$pult_network_file"; printf \'%s\\n\' "$pult_code" > "$pult_result_file.tmp"; /bin/mv "$pult_result_file.tmp" "$pult_result_file"; }\n'
        + "trap pult_done EXIT\ntrap 'exit 130' HUP INT TERM\n"
        + '. "$pult_network_file" || exit 1\n/bin/rm -f "$pult_network_file"\n'
        + `cd ${quote(this.deps.env['HOME'] ?? homedir())} || exit 1\n`
        + `printf '%s\\n' ${quote(`Pult · ${provider} · ${action}`)}\n`
        + `printf '%s\\n' ${quote(prepared.plan.command)}\n`
        + prepared.plan.command + '\npult_code=$?\nprintf \'\\nExit code %s. Return to Pult.\\n\' "$pult_code"\nexit "$pult_code"\n'
      const environment = buildChildEnv(this.deps.env, { path: prepared.inventory.pathEntries.join(':') })
      environment['HOME'] = this.deps.env['HOME'] ?? homedir()
      const source = '#!/bin/bash\nexec /usr/bin/env -i ' + Object.entries(environment).map(([key, value]) => `${key}=${quote(value)}`).join(' ') + ' /bin/bash -c ' + quote(body) + '\n'
      writeFileSync(script, source, { mode: 0o700, flag: 'wx' })
      chmodSync(script, 0o700)
      const value: ProviderOperation = { id, provider, action, state: 'running', command: prepared.plan.command, ...(prepared.plan.handoff ? { application: prepared.plan.handoff } : {}) }
      this.jobs.set(id, { value, file: resultFile, expires: (this.deps.now?.() ?? Date.now()) + 15 * 60_000 })
      try { await this.deps.launch(script); launched = true } catch (error) { value.state = 'failed'; value.message = (error as Error).message }
      return this.operation(id)
    } finally {
      if (!launched) {
        try { unlinkSync(networkFile) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    }
  }

  operation(id: string): ProviderOperation {
    const job = this.jobs.get(id)
    if (!job) throw new Error(tr('Действие CLI не найдено.'))
    if (job.value.state !== 'running' && job.value.state !== 'unknown') return { ...job.value }
    try {
      const file = openSync(job.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const metadata = fstatSync(file)
        if (!metadata.isFile() || metadata.size > 4 || (metadata.mode & 0o077) !== 0) throw new Error(tr('Некорректный результат действия CLI.'))
        const bytes = Buffer.alloc(4)
        const text = bytes.toString('utf8', 0, readSync(file, bytes, 0, bytes.length, 0)).trim()
        if (/^\d{1,3}$/.test(text) && Number(text) <= 255) {
          const code = Number(text)
          job.value = { ...job.value, state: code === 0 ? job.value.application ? 'handoff' : 'succeeded' : 'failed', exitCode: code }
        }
      } finally { closeSync(file) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') job.value = { ...job.value, state: 'failed', message: tr('Некорректный результат действия CLI.') }
    }
    if (job.value.state === 'running' && (this.deps.now?.() ?? Date.now()) >= job.expires) job.value = { ...job.value, state: 'unknown' }
    return { ...job.value }
  }
}

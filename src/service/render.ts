// Файлы службы: plist launchd и юнит systemd --user. Перенос spike/env/service/{dev.pult.daemon.plist,
// pultd.service} с правками вехи В4 (docs/08 §2 п.4): абсолютный PULT_HOME вместо `%h/.pult`,
// вывод в logs/service.log (НЕ в pultd.log — там JSONL демона), PULT_SERVICE=1.
//
// ЭКРАНИРОВАНИЕ — главное, ради чего это отдельный модуль. PULT_HOME и домашний каталог приходят
// от человека: путь с пробелом, `&` или `%` без экранирования даёт plist, который launchd молча
// не грузит (битый XML), или юнит, в котором systemd подставит СВОИ значения на месте `%h`/`%u`.
// Перевод строки в любом значении не экранируется ни там, ни там — такой путь отвергается.

import { dirname } from 'node:path'
import type { ServicePlatform } from './context.js'

export interface RenderInput {
  platform: ServicePlatform
  /** Метка launchd или имя юнита. */
  name: string
  /** Абсолютный путь к PULT_HOME/bin/pultd-launch. */
  launcher: string
  /** Абсолютный PULT_HOME. */
  pultHome: string
  /** PULT_HOME/logs/service.log. */
  serviceLog: string
  /** Домашний каталог пользователя: WorkingDirectory и ~/.local/bin в PATH. */
  home: string
  /** process.execPath CLI, который ставит службу: его каталог идёт первым в PATH. */
  nodeExec: string
  /**
   * Конфиг-переменные zcode из окружения установки (ZCODE_BASE_URL и родня): без них CLI zcode не
   * находит свой provider-конфиг в ~/.zcode и ходы падают (замер 02.11.2026). Служба launchd даёт
   * демону только PATH — пробрасываем осознанно, как PATH.
   */
  zcodeEnv?: Record<string, string>
}

export class RenderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RenderError'
  }
}

function noControl(what: string, v: string): string {
  if (/[\u0000-\u001f\u007f]/.test(v)) {
    throw new RenderError(`${what} содержит управляющий символ (перевод строки?) — такой путь в файл службы не записать: ${JSON.stringify(v)}`)
  }
  return v
}

/**
 * PATH службы. launchd даёт агенту `/usr/bin:/bin:/usr/sbin:/sbin` и больше ничего, systemd --user —
 * почти столько же (измерено спайком, locate-cli.log.jsonl: ни node, ни CLI агентов там не видны).
 * Первым идёт каталог того node, которым ставили службу: лаунчеру не нужен даже логин-шелл.
 */
export function servicePath(platform: ServicePlatform, nodeExec: string, home: string): string {
  const parts = [
    dirname(nodeExec),
    ...(platform === 'darwin' ? ['/opt/homebrew/bin'] : []),
    `${home}/.local/bin`,
    '/usr/local/bin',
    '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ]
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of parts) {
    if (!p || seen.has(p)) continue
    // Двоеточие внутри каталога сломало бы разбор PATH — такой каталог просто пропускаем.
    if (p.includes(':')) continue
    seen.add(p)
    out.push(p)
  }
  return out.join(':')
}

// --- plist --------------------------------------------------------------------

/**
 * Класс процесса службы в launchd. Демон — не фоновая уборка: им работают агенты, которых человек
 * ждёт у окна. `Standard` — «как без ключа»: без фоновых ограничений, но и без прав приложения
 * (`Interactive`); замер не показал между ними разницы, поэтому берётся скромный.
 */
export const LAUNCHD_PROCESS_TYPE = 'Standard'

export function xmlEscape(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

const xs = (what: string, v: string): string => `<string>${xmlEscape(noControl(what, v))}</string>`

export function renderPlist(i: RenderInput): string {
  const path = servicePath('darwin', i.nodeExec, i.home)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Служба Пульта. Сгенерировано командой \`pult daemon install\`; руками не править —
     повторный install перезапишет. Снять: pult daemon uninstall -->
<plist version="1.0">
<dict>
	<key>Label</key>
	${xs('метка', i.name)}

	<!-- Никогда не node напрямую: путь к node умирает, когда brew/nvm/volta переезжают.
	     pultd-launch находит node заново и переписывает файл состояния. -->
	<key>ProgramArguments</key>
	<array>
		${xs('путь лаунчера', i.launcher)}
	</array>

	<key>RunAtLoad</key>
	<true/>

	<!-- Перезапуск только при НЕНУЛЕВОМ выходе: штатный \`pult daemon stop\` (код 0) остаётся остановленным. -->
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>

	<key>ThrottleInterval</key>
	<integer>10</integer>

	<key>StandardOutPath</key>
	${xs('путь service.log', i.serviceLog)}
	<key>StandardErrorPath</key>
	${xs('путь service.log', i.serviceLog)}

	<key>WorkingDirectory</key>
	${xs('домашний каталог', i.home)}

	<!-- Агент gui/ получает PATH=/usr/bin:/bin:/usr/sbin:/sbin и больше ничего. -->
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		${xs('PATH', path)}
		<key>PULT_HOME</key>
		${xs('PULT_HOME', i.pultHome)}
		<key>PULT_SERVICE</key>
		<string>1</string>
${Object.entries(i.zcodeEnv ?? {}).map(([k, v]) => `\t\t<key>${xmlEscape(k)}</key>\n\t\t${xs('zcode-конфиг', v)}\n`).join('')}
	</dict>

	<!-- Standard, а НЕ Background. Background — фоновый класс launchd: ресурсы процесса ограничены,
	     и это наследует ВСЁ, что запускает демон: claude, codex, git. Замер 30.09.2026 на настоящем
	     launchd: один и тот же набор запусков — 22,8 с против 1,3 с. -->
	<key>ProcessType</key>
	<string>${LAUNCHD_PROCESS_TYPE}</string>
</dict>
</plist>
`
}

/** `ProcessType` из plist; `null` — ключа нет (для launchd это тот же Standard). */
export function plistProcessType(content: string): string | null {
  const m = /<key>ProcessType<\/key>\s*<string>([^<]*)<\/string>/.exec(content)
  return m && m[1] !== undefined ? m[1] : null
}

// --- юнит systemd ---------------------------------------------------------------

/** `%` — спецификатор systemd (`%h`, `%u`, …): буквальный процент пишется как `%%`. */
export const unitPercent = (v: string): string => v.replace(/%/g, '%%')

/**
 * Значение в двойных кавычках для Environment= и ExecStart=: systemd снимает кавычки и
 * C-экранирование (`\\`, `\"`), а спецификаторы подставляет ДО этого — отсюда `%%`.
 */
export function unitQuote(what: string, v: string): string {
  noControl(what, v)
  return `"${unitPercent(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** ExecStart дополнительно раскрывает `$VAR`: буквальный доллар — `$$`. */
const execQuote = (what: string, v: string): string => unitQuote(what, v.replace(/\$/g, '$$$$'))

/**
 * Пути в WorkingDirectory= и StandardOutput=append: берутся строкой целиком (кавычки там НЕ
 * снимаются, пробелы допустимы), поэтому экранируется только `%`.
 */
const unitRaw = (what: string, v: string): string => unitPercent(noControl(what, v))

export function renderUnit(i: RenderInput): string {
  const path = servicePath('linux', i.nodeExec, i.home)
  return `# Служба Пульта. Сгенерировано командой \`pult daemon install\`; руками не править —
# повторный install перезапишет. Снять: pult daemon uninstall
[Unit]
Description=Pult daemon (pultd)
# С systemd v229 эти два ключа живут в [Unit], а НЕ в [Service]: в [Service] они устаревшие
# и дают «Unknown key name». Пять стартов за 60 с — и systemd сдаётся; это pult doctor
# показывает как «служба в петле падений».
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
# Тот же лаунчер, что на macOS: он сам находит node, когда nvm/fnm/volta/brew его переносят.
ExecStart=${execQuote('путь лаунчера', i.launcher)}
# on-failure: штатный \`pult daemon stop\` (код 0) и SIGTERM от \`systemctl stop\` не воскрешаются.
Restart=on-failure
RestartSec=5
StandardOutput=append:${unitRaw('путь service.log', i.serviceLog)}
StandardError=append:${unitRaw('путь service.log', i.serviceLog)}
# systemd --user не наследует почти ничего — тот же пробел, что у launchd на macOS.
Environment=${unitQuote('PATH', `PATH=${path}`)}
Environment=${unitQuote('PULT_HOME', `PULT_HOME=${i.pultHome}`)}
Environment="PULT_SERVICE=1"
${Object.entries(i.zcodeEnv ?? {}).map(([k, v]) => `Environment=${unitQuote(k, `${k}=${v}`)}\n`).join('')}
WorkingDirectory=${unitRaw('домашний каталог', i.home)}

[Install]
WantedBy=default.target
`
}

export function renderService(i: RenderInput): string {
  return i.platform === 'darwin' ? renderPlist(i) : renderUnit(i)
}

/**
 * PULT_HOME, записанный в файле службы. Нужен, чтобы понять, ЧЬЯ это служба: CLI с временным
 * PULT_HOME (тест, второй дом) не имеет права дёргать службу, которая обслуживает ~/.pult.
 */
export function serviceHomeOf(platform: ServicePlatform, content: string): string | null {
  if (platform === 'darwin') {
    const m = /<key>PULT_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(content)
    if (!m || m[1] === undefined) return null
    return m[1]
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
  }
  const m = /^Environment="PULT_HOME=((?:[^"\\]|\\.)*)"\s*$/m.exec(content)
  if (!m || m[1] === undefined) return null
  return m[1].replace(/\\(.)/g, '$1').replace(/%%/g, '%')
}

/** Путь лаунчера, записанный в файле службы (ProgramArguments[0] / ExecStart). */
export function serviceLauncherOf(platform: ServicePlatform, content: string): string | null {
  if (platform === 'darwin') {
    const m = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(content)
    if (!m || m[1] === undefined) return null
    return m[1]
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
  }
  const m = /^ExecStart="((?:[^"\\]|\\.)*)"\s*$/m.exec(content)
  if (!m || m[1] === undefined) return null
  return m[1].replace(/\\(.)/g, '$1').replace(/%%/g, '%').replace(/\$\$/g, '$')
}

import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, extname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildChildEnv, FALLBACK_PATH } from '../env/allowlist.js'
import { execAsync } from '../env/exec.js'
import type { ExecOptions, ExecResult } from '../env/exec.js'
import type { RuntimeDiscovery, RuntimeResult, RuntimeSetup, RuntimeTarget } from './types.js'

const IMAGE_MAX = 400 * 1024
const TEXT_MAX = 120_000
const IOS_ID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const AVD_ID = /^[A-Za-z\d][A-Za-z\d_.-]{0,100}$/
const ANDROID_ID = /^emulator-\d{1,6}$/
const PACKAGE = /^[A-Za-z][A-Za-z\d_]*(?:\.[A-Za-z][A-Za-z\d_]*)+$/
const BUTTONS: Readonly<Record<string, string>> = { home: 'KEYCODE_HOME', back: 'KEYCODE_BACK', enter: 'KEYCODE_ENTER', lock: 'KEYCODE_POWER', volume_up: 'KEYCODE_VOLUME_UP', volume_down: 'KEYCODE_VOLUME_DOWN', app_switch: 'KEYCODE_APP_SWITCH' }

export class MobileError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'MobileError' }
}
export interface MobileDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
  exists?: (path: string) => boolean
  executable?: (path: string) => boolean
  run?: (file: string, args: string[], options: ExecOptions) => Promise<ExecResult>
  start?: (file: string, args: string[], env: Record<string, string>) => Promise<void>
}
const executable = (p: string): boolean => { try { accessSync(p, constants.X_OK); return statSync(p).isFile() } catch { return false } }
const bad = (message: string): never => { throw new MobileError('invalid_params', message) }
const requiredText = (o: Record<string, unknown>, key: string, max = 4000): string => {
  const v = o[key]
  if (typeof v !== 'string' || !v.length || v.length > max || /\0/.test(v)) return bad(`${key}: нужна непустая строка, до ${max} символов`)
  return v
}
const coordinate = (o: Record<string, unknown>, key: string): number => {
  const v = o[key]
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100_000) return bad(`${key}: нужна координата 0…100000`)
  return v
}
const duration = (o: Record<string, unknown>): number => {
  const v = o['duration'] ?? 300
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 10_000) return bad('duration: нужны миллисекунды 1…10000')
  return v
}
function safeUrl(o: Record<string, unknown>): string {
  const value = requiredText(o, 'url', 8192)
  let url: URL
  try { url = new URL(value) } catch { return bad('url: неверный URL') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return bad('url: разрешены только http/https без пароля')
  return url.href
}
function appPath(o: Record<string, unknown>, suffix: '.apk' | '.app'): string {
  const value = requiredText(o, 'path', 4096)
  if (!isAbsolute(value)) return bad('path: нужен абсолютный путь приложения')
  let real: string
  try { real = realpathSync(value) } catch { return bad('Приложение по path не найдено') }
  const s = statSync(real)
  if (extname(real).toLowerCase() !== suffix || (suffix === '.app' ? !s.isDirectory() : !s.isFile())) return bad(`Нужно приложение ${suffix}`)
  return real
}
/** Android shell reconstructs argv; quote even though no host shell is used. */
export const quoteAndroidArg = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

async function startDetached(file: string, args: string[], env: Record<string, string>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = spawn(file, args, { detached: true, stdio: 'ignore', env })
    p.once('error', reject)
    p.once('spawn', () => { p.unref(); resolve() })
  })
}

export function createMobileDriver(deps: MobileDeps = {}): {
  discover(): Promise<RuntimeDiscovery>
  perform(target: RuntimeTarget, action: string, input?: Record<string, unknown>): Promise<RuntimeResult>
  installSetup(id: string): Promise<RuntimeResult>
} {
  const platform = deps.platform ?? process.platform
  const parent = deps.env ?? process.env
  const home = deps.home ?? homedir()
  const exists = deps.exists ?? existsSync
  const canExec = deps.executable ?? executable
  const env = buildChildEnv(parent, { path: `${parent['PATH'] ?? FALLBACK_PATH}${delimiter}${FALLBACK_PATH}`,
    extra: Object.fromEntries(['ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_AVD_HOME', 'DEVELOPER_DIR'].flatMap((k) => parent[k] ? [[k, parent[k] as string]] : [])) })
  const run = deps.run ?? execAsync
  const start = deps.start ?? startDetached
  const roots = [parent['ANDROID_HOME'], parent['ANDROID_SDK_ROOT'], join(home, 'Library', 'Android', 'sdk'), join(home, 'Android', 'Sdk')].filter((p): p is string => !!p && isAbsolute(p))
  const tool = (name: string, extra: string[] = []): string | null => [...extra, ...(env['PATH'] ?? '').split(delimiter).filter(isAbsolute).map((p) => join(p, name))].find(canExec) ?? null
  const adbPath = (): string | null => tool('adb', roots.map((r) => join(r, 'platform-tools', 'adb')))
  const emulatorPath = (): string | null => tool('emulator', roots.map((r) => join(r, 'emulator', 'emulator')))
  // XcodeBuildMCP ships the same AXe helper. Reuse a stable Homebrew opt path if
  // present; never scan a disk, invoke its CLI, or install a duplicate helper.
  const axePath = (): string | null => tool('axe', [
    '/opt/homebrew/opt/xcodebuildmcp/libexec/bundled/axe',
    '/usr/local/opt/xcodebuildmcp/libexec/bundled/axe',
  ])
  const brewPath = (): string | null => tool('brew')
  const checked = async (file: string, args: string[], timeoutMs = 20_000): Promise<string> => {
    const r = await run(file, args, { env, timeoutMs, maxBuffer: 512 * 1024 })
    if (r.status !== 0) throw new MobileError('runtime_unavailable', `${file.split('/').at(-1)}: ${(r.stderr || r.error || `exit ${r.status}`).slice(0, 1500)}`)
    return r.stdout.slice(0, TEXT_MAX)
  }
  const simctl = (args: string[], ms?: number): Promise<string> => checked('/usr/bin/xcrun', ['simctl', ...args], ms)
  const adb = (serial: string, args: string[], ms?: number): Promise<string> => {
    const file = adbPath()
    if (!file) throw new MobileError('runtime_unavailable', 'Не найден adb: установите Android SDK Platform Tools')
    return checked(file, ['-s', serial, ...args], ms)
  }
  const shell = (serial: string, args: string[], ms?: number): Promise<string> => adb(serial, ['shell', ...args.map(quoteAndroidArg)], ms)

  async function discover(): Promise<RuntimeDiscovery> {
    const targets: RuntimeTarget[] = []; const setup: RuntimeSetup[] = []
    if (platform === 'darwin') {
      try {
        const parsed: unknown = JSON.parse(await simctl(['list', 'devices', 'available', '--json']))
        const devices = (parsed as { devices?: unknown })?.devices
        if (!devices || typeof devices !== 'object' || Array.isArray(devices)) throw new Error('simctl: неверный список устройств')
        for (const [runtime, values] of Object.entries(devices)) {
          if (!runtime.includes('.iOS-') || !Array.isArray(values)) continue
          for (const v of values as Array<{ udid?: unknown; name?: unknown; state?: unknown; isAvailable?: unknown }>) {
            if (typeof v.udid !== 'string' || !IOS_ID.test(v.udid) || v.isAvailable === false) continue
            targets.push({ id: `ios:${v.udid}`, kind: 'ios', name: typeof v.name === 'string' ? v.name : v.udid,
              state: v.state === 'Booted' ? 'ready' : 'stopped', detail: runtime.split('.').at(-1)?.replaceAll('-', ' '),
              capabilities: ['boot', 'screenshot', 'install', 'launch', 'logs', 'open_url', ...(axePath() ? ['inspect', 'tap', 'swipe', 'type', 'button'] : [])] })
          }
        }
        if (!targets.some((t) => t.kind === 'ios')) setup.push({ id: 'ios-runtime', kind: 'ios', title: 'Добавить iOS Simulator', detail: 'В Xcode → Settings → Components установите iOS runtime, затем создайте устройство в Devices and Simulators. Объём зависит от версии iOS.', command: 'xcodebuild -downloadPlatform iOS', url: 'https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components', installable: false })
        if (!axePath()) setup.push({ id: 'ios-axe', kind: 'ios', title: 'Добавить управление iOS', detail: `AXe нужен для чтения интерфейса и нажатий. Установится formula cameroncooke/axe/axe в каталог Homebrew; версия и объём определяются Homebrew, без обновления остальных пакетов. Для загрузки нужен интернет.${brewPath() ? '' : ' Сначала установите Homebrew вручную.'}`, command: 'brew install cameroncooke/axe/axe', url: 'https://www.axe-cli.com/docs/installation', installable: !!brewPath() })
      } catch (e) {
        setup.push({ id: 'ios-xcode', kind: 'ios', title: 'Настроить Xcode', detail: `Нужен полный Xcode с платформой iOS, не только Command Line Tools. ${(e as Error).message.slice(0, 300)}`, url: 'https://developer.apple.com/xcode/', installable: false })
      }
    }
    const adbFile = adbPath()
    if (!adbFile) setup.push({ id: 'android-sdk', kind: 'android', title: 'Настроить Android SDK', detail: 'Нужны Platform Tools (adb), Android Emulator, подходящий system image и виртуальное устройство AVD. Можно использовать Android Studio или Android CLI; загрузка и лицензии выполняются отдельно.', url: 'https://developer.android.com/studio', installable: false })
    else {
      try {
        const lines = (await checked(adbFile, ['devices', '-l'])).split(/\r?\n/)
        for (const line of lines) {
          const parts = line.trim().split(/\s+/); const serial = parts[0] ?? ''; const status = parts[1]
          if (!ANDROID_ID.test(serial)) continue // Physical devices are outside this feature's scope.
          const model = /(?:^|\s)model:(\S+)/.exec(line)?.[1]?.replaceAll('_', ' ')
          targets.push({ id: `android:${serial}`, kind: 'android', name: model ?? serial, state: status === 'device' ? 'ready' : 'unavailable', detail: status === 'device' ? serial : `${serial}: ${status}`,
            capabilities: status === 'device' ? ['screenshot', 'inspect', 'tap', 'swipe', 'type', 'button', 'install', 'launch', 'logs', 'open_url'] : [] })
        }
      } catch (e) { setup.push({ id: 'android-adb', kind: 'android', title: 'Проверить adb', detail: (e as Error).message, url: 'https://developer.android.com/tools/adb', installable: false }) }
      const emulator = emulatorPath()
      if (!emulator) setup.push({ id: 'android-emulator', kind: 'android', title: 'Добавить Android Emulator', detail: 'Установите Android Emulator и system image через SDK Manager, затем создайте AVD.', url: 'https://developer.android.com/studio/run/managing-avds', installable: false })
      else {
        try {
          for (const avd of (await checked(emulator, ['-list-avds'])).split(/\r?\n/).filter((s) => AVD_ID.test(s))) {
            targets.push({ id: `android-avd:${avd}`, kind: 'android', name: avd.replaceAll('_', ' '), state: 'stopped', detail: 'AVD — запустить, затем обновить список', capabilities: ['boot'] })
          }
          if (!targets.some((t) => t.kind === 'android')) setup.push({ id: 'android-avd', kind: 'android', title: 'Создать виртуальное устройство', detail: 'Android Studio → Device Manager → Create Virtual Device. Выберите подходящий system image.', url: 'https://developer.android.com/studio/run/managing-avds', installable: false })
        } catch (e) { setup.push({ id: 'android-avd', kind: 'android', title: 'Проверить Android Emulator', detail: (e as Error).message, installable: false }) }
      }
    }
    return { targets, setup }
  }

  async function installSetup(id: string): Promise<RuntimeResult> {
    if (id !== 'ios-axe' || platform !== 'darwin') throw new MobileError('invalid_params', 'Этот компонент настраивается вручную')
    const brew = brewPath()
    if (!brew) throw new MobileError('runtime_unavailable', 'Homebrew не найден. Установите AXe по инструкции.')
    // Caller must obtain explicit approval for this fixed manifest. No model-supplied executable/argv.
    const r = await run(brew, ['install', 'cameroncooke/axe/axe'], { env: { ...env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ANALYTICS: '1', NONINTERACTIVE: '1' }, timeoutMs: 600_000, maxBuffer: 512 * 1024 })
    if (r.status !== 0) throw new MobileError('setup_failed', `AXe: ${(r.stderr || r.error || r.stdout || `exit ${r.status}`).slice(-3000)}`)
    if (!axePath()) throw new MobileError('setup_failed', 'Homebrew завершился, но axe не найден в PATH. Проверьте установку и обновите список.')
    return { text: 'AXe установлен. Обновите список устройств.', output: r.stdout.slice(-4000) }
  }

  async function iosFrame(id: string, pixelWidth?: number, pixelHeight?: number): Promise<{ width: number; height: number } | null> {
    const axe = axePath()
    if (!axe) return null
    try {
      const raw: unknown = JSON.parse(await checked(axe, ['describe-ui', '--udid', id]))
      const roots: unknown[] = Array.isArray(raw) ? raw : [raw]
      for (const root of roots) {
        if (!root || typeof root !== 'object') continue
        const frame = (root as { frame?: Record<string, unknown> }).frame
        if (!frame || frame.x !== 0 || frame.y !== 0) continue
        const w = frame.width; const h = frame.height
        if (typeof w !== 'number' || typeof h !== 'number' || w < 100 || h < 100 || w > 3000 || h > 3000) continue
        // Only a full-screen root at a uniform pixel scale is safe for screenshot hit testing.
        if (pixelWidth && pixelHeight && Math.abs(pixelWidth / w - pixelHeight / h) > .03) continue
        return { width: w, height: h }
      }
    } catch { /* No usable AX root: selectors still work; don't guess a Retina scale. */ }
    return null
  }

  async function screenshot(target: RuntimeTarget, id: string): Promise<RuntimeResult> {
    const dir = mkdtempSync(join(tmpdir(), 'pult-device-'))
    const source = join(dir, 'screen.png'); const output = join(dir, 'screen.jpg')
    const remote = `/data/local/tmp/pult-screen-${randomUUID()}.png`
    try {
      if (target.kind === 'ios') await simctl(['io', id, 'screenshot', '--type=png', source])
      else {
        try { await shell(id, ['screencap', '-p', remote]); await adb(id, ['pull', remote, source]) }
        finally { await shell(id, ['rm', '-f', remote]).catch(() => {}) }
      }
      if (statSync(source).size > 40 * 1024 * 1024) throw new MobileError('image_too_large', 'Исходный снимок больше 40 МБ')
      const raw = readFileSync(source)
      if (raw.length < 24 || !raw.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new MobileError('runtime_unavailable', 'Устройство не вернуло PNG')
      const width = raw.readUInt32BE(16); const height = raw.readUInt32BE(20)
      let data = raw; let mimeType: 'image/jpeg' | 'image/png' = 'image/png'
      if (platform === 'darwin' && exists('/usr/bin/sips')) {
        for (const maxSide of [1280, 960, 640]) {
          await checked('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '55', '-Z', String(maxSide), source, '--out', output])
          data = readFileSync(output); mimeType = 'image/jpeg'
          if (data.length <= IMAGE_MAX) break
        }
      }
      if (data.length > IMAGE_MAX) throw new MobileError('image_too_large', 'Снимок больше 400 КБ. На macOS установите доступ к sips; уменьшите разрешение виртуального устройства.')
      let frame: { width: number; height: number } | null = { width, height }
      if (target.kind === 'ios') {
        // CoreSimulator exposes this without a UI helper, and unlike a device-name table it
        // also handles new Retina devices. The captured orientation determines width/height.
        const scale = Number((await simctl(['getenv', id, 'SIMULATOR_MAINSCREEN_SCALE']).catch(() => '')).trim())
        frame = scale >= 1 && scale <= 4 ? { width: width / scale, height: height / scale } : await iosFrame(id, width, height)
      }
      return { image: { data: data.toString('base64'), mimeType }, width, height, ...(frame ? { coordinateWidth: frame.width, coordinateHeight: frame.height } : {}), coordinateSpace: target.kind === 'ios' ? 'points' : 'pixels', text: target.kind === 'ios' ? 'iOS: width/height в пикселях; coordinateWidth/coordinateHeight и AXe tap/swipe в points. Если coordinateWidth отсутствует, используйте tap с label.' : 'Android: координаты в исходных пикселях, width/height относятся к устройству.' }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  async function perform(target: RuntimeTarget, action: string, input: Record<string, unknown> = {}): Promise<RuntimeResult> {
    if (target.kind !== 'ios' && target.kind !== 'android') return bad('Нужна мобильная среда')
    if (!target.capabilities.includes(action)) throw new MobileError('unsupported_action', `${target.name}: действие ${action} недоступно; проверьте настройки среды`)
    if (target.id.startsWith('android-avd:')) {
      const name = target.id.slice('android-avd:'.length); const file = emulatorPath()
      if (action !== 'boot' || !AVD_ID.test(name) || !file) return bad('Неверное виртуальное устройство Android')
      await start(file, ['-avd', name], env)
      return { text: 'Android Emulator запускается. Обновите список и подключите запущенное устройство.' }
    }
    if (!target.id.startsWith(target.kind === 'ios' ? 'ios:' : 'android:')) return bad('Неверный тип идентификатора устройства')
    const id = target.kind === 'ios' ? target.id.slice(4) : target.id.slice(8)
    if (target.kind === 'ios' ? !IOS_ID.test(id) : !ANDROID_ID.test(id)) return bad('Неверный идентификатор виртуального устройства')
    if (action === 'screenshot') return screenshot(target, id)
    if (action === 'boot') {
      if (target.state !== 'ready') await simctl(['boot', id])
      await simctl(['bootstatus', id, '-b'], 120_000)
      return { text: 'iOS Simulator готов' }
    }
    if (action === 'install') {
      const path = appPath(input, target.kind === 'ios' ? '.app' : '.apk')
      return { text: target.kind === 'ios' ? await simctl(['install', id, path], 120_000) : await adb(id, ['install', '-r', path], 120_000) }
    }
    if (action === 'launch') {
      const name = requiredText(input, 'appId', 255)
      if (!PACKAGE.test(name)) return bad('appId: нужен bundle ID/package name')
      return { text: target.kind === 'ios' ? await simctl(['launch', id, name]) : await shell(id, ['monkey', '-p', name, '-c', 'android.intent.category.LAUNCHER', '1']) }
    }
    if (action === 'logs') return { text: target.kind === 'ios' ? await simctl(['spawn', id, 'log', 'show', '--last', '1m', '--style', 'compact'], 30_000) : await adb(id, ['logcat', '-d', '-t', '200']) }
    if (action === 'open_url') {
      const url = safeUrl(input)
      return { text: target.kind === 'ios' ? await simctl(['openurl', id, url]) : await shell(id, ['am', 'start', '-a', 'android.intent.action.VIEW', '-d', url]) }
    }
    if (target.kind === 'ios') {
      const axe = axePath()
      if (!axe) throw new MobileError('runtime_unavailable', 'Для управления iOS установите AXe')
      let args: string[]
      if (action === 'inspect') args = ['describe-ui']
      else if (action === 'tap') {
        if (typeof input['label'] === 'string') args = ['tap', '--label', requiredText(input, 'label', 1000)]
        else {
          let x = coordinate(input, 'x'); let y = coordinate(input, 'y')
          if (input['normalized'] === true) {
            if (x > 1 || y > 1) return bad('normalized: координаты должны быть 0…1')
            const frame = await iosFrame(id)
            if (!frame) throw new MobileError('unsupported_action', 'Не удалось определить full-screen AX frame; используйте tap с label')
            x *= frame.width; y *= frame.height
          }
          args = ['tap', '-x', String(x), '-y', String(y)]
        }
      }
      else if (action === 'swipe') args = ['swipe', '--start-x', String(coordinate(input, 'x')), '--start-y', String(coordinate(input, 'y')), '--end-x', String(coordinate(input, 'endX')), '--end-y', String(coordinate(input, 'endY')), '--duration', String(duration(input) / 1000)]
      else if (action === 'button') {
        const button = requiredText(input, 'button', 30).toLowerCase()
        if (!['home', 'lock', 'side-button', 'siri', 'apple-pay'].includes(button)) return bad('iOS: доступные кнопки home, lock, side-button, siri, apple-pay')
        args = ['button', button]
      } else if (action === 'type') {
        const text = requiredText(input, 'text')
        // HID typing follows the active keyboard layout (Russian turns ASCII into Cyrillic).
        // Device pasteboard + the fixed Paste shortcut preserves Unicode without changing keyboards.
        const copied = await run('/usr/bin/xcrun', ['simctl', 'pbcopy', id], { env, timeoutMs: 20_000, maxBuffer: 512 * 1024, input: text })
        if (copied.status !== 0) throw new MobileError('runtime_unavailable', `Не удалось передать текст в буфер симулятора: ${(copied.stderr || copied.error || '').slice(0, 1000)}`)
        return { text: await checked(axe, ['key-combo', '--modifiers', '227', '--key', '25', '--udid', id]) }
      } else return bad('Неизвестное действие iOS')
      return { text: await checked(axe, [...args, '--udid', id]) }
    }
    if (action === 'inspect') {
      const remote = `/data/local/tmp/pult-ui-${randomUUID()}.xml`
      try { await shell(id, ['uiautomator', 'dump', '--compressed', remote]); return { text: await shell(id, ['cat', remote]) } }
      finally { await shell(id, ['rm', '-f', remote]).catch(() => {}) }
    }
    if (action === 'tap') return { text: await shell(id, ['input', 'tap', String(coordinate(input, 'x')), String(coordinate(input, 'y'))]) }
    if (action === 'swipe') return { text: await shell(id, ['input', 'swipe', String(coordinate(input, 'x')), String(coordinate(input, 'y')), String(coordinate(input, 'endX')), String(coordinate(input, 'endY')), String(duration(input))]) }
    if (action === 'button') {
      const key = BUTTONS[requiredText(input, 'button', 30).toLowerCase()]
      if (!key) return bad('Android: неизвестная аппаратная кнопка')
      return { text: await shell(id, ['input', 'keyevent', key]) }
    }
    if (action === 'type') {
      const text = requiredText(input, 'text')
      if (/[^\x20-\x7e]/.test(text) || text.includes('%s')) throw new MobileError('unsupported_text', 'adb input text поддерживает ASCII без последовательности %s. Unicode не отправлен; используйте ручной ввод.')
      return { text: await shell(id, ['input', 'text', text.replaceAll(' ', '%s')]) }
    }
    return bad('Неизвестное действие Android')
  }
  return { discover, perform, installSetup }
}

const defaultDriver = createMobileDriver()
export const discoverMobile = (): Promise<RuntimeDiscovery> => defaultDriver.discover()
export const performMobile = (target: RuntimeTarget, action: string, input: Record<string, unknown> = {}): Promise<RuntimeResult> => defaultDriver.perform(target, action, input)
export const installMobileSetup = (id: string): Promise<RuntimeResult> => defaultDriver.installSetup(id)

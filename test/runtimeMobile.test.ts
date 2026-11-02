import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createMobileDriver, MobileError, quoteAndroidArg } from '../dist/runtimes/mobile.js'
import type { ExecOptions, ExecResult } from '../dist/env/exec.js'
import type { RuntimeTarget } from '../dist/runtimes/types.js'

const UDID = 'F48B4171-A329-42E7-BA70-CEBB33121A21'
const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' })
const allActions = ['boot', 'screenshot', 'inspect', 'tap', 'swipe', 'type', 'button', 'install', 'launch', 'logs', 'open_url']
const ios: RuntimeTarget = { id: `ios:${UDID}`, kind: 'ios', name: 'iPhone', state: 'ready', capabilities: allActions }
const android: RuntimeTarget = { id: 'android:emulator-5554', kind: 'android', name: 'Android', state: 'ready', capabilities: allActions }
type Call = { file: string; args: string[]; opts: ExecOptions }
function fixture(options: { axe?: boolean; bundledAxe?: string; brew?: boolean; simFail?: boolean; adbFail?: boolean; pngSize?: number; jpegSize?: number } = {}) {
  const calls: Call[] = []
  const starts: Array<{ file: string; args: string[] }> = []
  let installed = false
  const driver = createMobileDriver({ platform: 'darwin', home: '/fake', env: { HOME: '/fake', PATH: '/tools', ANTHROPIC_API_KEY: 'never-pass', DEVELOPER_DIR: '/Xcode/Contents/Developer' },
    executable: (p) => p === '/tools/adb' || p === '/tools/emulator' || (p === '/tools/axe' && (!!options.axe || installed)) || p === options.bundledAxe || (p === '/tools/brew' && !!options.brew),
    exists: (p) => p === '/usr/bin/sips',
    start: async (file, args) => { starts.push({ file, args }) },
    run: async (file, args, opts) => {
      calls.push({ file, args, opts })
      if (args[0] === 'simctl' && args[1] === 'list') return options.simFail ? { status: 1, stdout: '', stderr: 'No Xcode' } : ok(JSON.stringify({ devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [{ udid: UDID, name: 'iPhone 16 Pro', state: 'Booted', isAvailable: true }, { udid: 'bogus;shutdown', name: 'bad' }],
        'com.apple.CoreSimulator.SimRuntime.watchOS-26-1': [{ udid: UDID, name: 'watch', state: 'Booted' }],
      } }))
      if (args[0] === 'devices') return options.adbFail ? { status: null, stdout: '', stderr: '', error: 'timeout' } : ok('List of devices attached\nemulator-5554 device product:sdk model:Pixel_9 transport_id:1\nemulator-5556 offline\nRF8T12345 device model:Physical_phone\n')
      if (args[0] === '-list-avds') return ok('Pixel_9\n-malicious\nbad/name\n')
      if (args.includes('screenshot') || args.includes('pull')) {
        const raw = Buffer.alloc(options.pngSize ?? 100)
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(raw)
        raw.writeUInt32BE(1179, 16); raw.writeUInt32BE(2556, 20)
        writeFileSync(args.at(-1)!, raw)
      }
      if (file === '/usr/bin/sips') writeFileSync(args.at(-1)!, Buffer.alloc(options.jpegSize ?? 150, 1))
      if (args[0] === 'describe-ui') return ok(JSON.stringify([{ frame: { x: 0, y: 0, width: 393, height: 852 }, children: [{ type: 'Button', AXLabel: 'Continue' }] }]))
      if (file === '/tools/brew') installed = true
      return ok()
    },
  })
  return { driver, calls, starts }
}

describe('optional mobile runtimes', () => {
  it('discovers iOS and Android emulators, excludes physical devices and unavailable runtime IDs', async () => {
    const { driver, calls } = fixture()
    const result = await driver.discover()
    assert.deepEqual(result.targets.map((t) => t.id), [`ios:${UDID}`, 'android:emulator-5554', 'android:emulator-5556', 'android-avd:Pixel_9'])
    assert.equal(result.targets[0]?.capabilities.includes('tap'), false, 'no helper is not full control')
    assert.equal(result.targets[2]?.state, 'unavailable')
    assert.equal(result.setup.find((s) => s.id === 'ios-axe')?.installable, false)
    assert.ok(calls.every((c) => c.opts.env?.['ANTHROPIC_API_KEY'] === undefined))
    assert.ok(calls.every((c) => c.opts.env?.['DEVELOPER_DIR'] === '/Xcode/Contents/Developer'))
  })

  it('missing SDKs give setup instructions without starting installers or fetching anything', async () => {
    const calls: string[] = []
    const driver = createMobileDriver({ platform: 'linux', home: '/fake', env: { PATH: '/missing' }, executable: () => false, run: async (file) => { calls.push(file); return ok() } })
    const result = await driver.discover()
    assert.equal(result.targets.length, 0)
    assert.ok(result.setup.some((s) => s.id === 'android-sdk' && !s.installable))
    assert.deepEqual(calls, [])
  })

  it('reuses AXe bundled with an existing XcodeBuildMCP Homebrew install without a duplicate setup', async () => {
    for (const prefix of ['/opt/homebrew', '/usr/local']) {
      const path = `${prefix}/opt/xcodebuildmcp/libexec/bundled/axe`
      const { driver, calls } = fixture({ bundledAxe: path })
      const result = await driver.discover()
      assert.ok(result.targets.find((t) => t.kind === 'ios')?.capabilities.includes('tap'))
      assert.equal(result.setup.some((s) => s.id === 'ios-axe'), false)
      await driver.perform(ios, 'tap', { label: 'Continue' })
      assert.equal(calls.at(-1)?.file, path)
      assert.deepEqual(calls.at(-1)?.args, ['tap', '--label', 'Continue', '--udid', UDID])
      assert.equal(calls.some((c) => c.file.includes('xcodebuildmcp') && c.file !== path), false)
    }
  })

  it('failed discovery remains actionable and does not hide other available platforms', async () => {
    const { driver } = fixture({ simFail: true })
    const result = await driver.discover()
    assert.ok(result.setup.some((s) => s.id === 'ios-xcode'))
    assert.ok(result.targets.some((s) => s.kind === 'android'))
  })

  it('unsupported actions, target injection and invalid coordinates never reach command execution', async () => {
    const { driver, calls } = fixture()
    await assert.rejects(driver.perform({ ...ios, capabilities: [] }, 'tap', { x: 1, y: 2 }), { code: 'unsupported_action' })
    await assert.rejects(driver.perform({ ...android, id: 'android:emulator-5554;rm -rf /' }, 'tap', { x: 1, y: 2 }), { code: 'invalid_params' })
    await assert.rejects(driver.perform(android, 'tap', { x: Number.NaN, y: 2 }), { code: 'invalid_params' })
    await assert.rejects(driver.perform(android, 'open_url', { url: 'file:///etc/passwd' }), { code: 'invalid_params' })
    await assert.rejects(driver.perform(android, 'launch', { appId: '-p;rm' }), { code: 'invalid_params' })
    assert.deepEqual(calls, [])
  })

  it('Android shell reconstructs arguments safely, even apostrophes, metacharacters and spaces', async () => {
    const { driver, calls } = fixture()
    await driver.perform(android, 'type', { text: "hello ';touch /tmp/pwn; #" })
    assert.deepEqual(calls.at(-1)?.args, ['-s', 'emulator-5554', 'shell', "'input'", "'text'", quoteAndroidArg("hello%s';touch%s/tmp/pwn;%s#")])
    assert.equal(calls.at(-1)?.file, '/tools/adb')
    assert.equal(quoteAndroidArg("a'b"), "'a'\\''b'")
  })

  it('Android rejects unsupported Unicode before sending partial text', async () => {
    const { driver, calls } = fixture({ axe: true })
    await assert.rejects(driver.perform(android, 'type', { text: 'Привет' }), { code: 'unsupported_text' })
    assert.deepEqual(calls, [])
  })

  it('iOS pastes Unicode independently of the active keyboard layout, without shell or argv text', async () => {
    const { driver, calls } = fixture({ axe: true })
    const text = "Привет runtime-proof '$(touch /tmp/nope)'"
    await driver.perform(ios, 'type', { text })
    assert.deepEqual(calls[0]?.args, ['simctl', 'pbcopy', UDID])
    assert.equal(calls[0]?.opts.input, text)
    assert.deepEqual(calls[1]?.args, ['key-combo', '--modifiers', '227', '--key', '25', '--udid', UDID])
    assert.ok(calls.every((c) => !c.args.includes(text)))
  })

  it('uses canonical AXe flags and converts normalized points using a verified full-screen root', async () => {
    const { driver, calls } = fixture({ axe: true })
    await driver.perform(ios, 'tap', { normalized: true, x: .5, y: .25 })
    assert.deepEqual(calls.at(-1)?.args, ['tap', '-x', '196.5', '-y', '213', '--udid', UDID])
    await driver.perform(ios, 'tap', { label: 'Continue' })
    assert.deepEqual(calls.at(-1)?.args, ['tap', '--label', 'Continue', '--udid', UDID])
  })

  it('returns bounded images with framebuffer and logical dimensions kept separate', async () => {
    const { driver } = fixture({ axe: true })
    const result = await driver.perform(ios, 'screenshot')
    assert.equal(result.image?.mimeType, 'image/jpeg')
    assert.equal(result.width, 1179); assert.equal(result.height, 2556)
    assert.equal(result.coordinateWidth, 393); assert.equal(result.coordinateHeight, 852)
    assert.ok(Buffer.from(result.image!.data, 'base64').length < 400 * 1024)
  })

  it('Android capture uses a unique device-local file, pulls it and removes it', async () => {
    const { driver, calls } = fixture()
    const result = await driver.perform(android, 'screenshot')
    assert.equal(result.width, 1179)
    assert.equal(result.coordinateWidth, 1179)
    assert.equal(result.coordinateSpace, 'pixels')
    const capture = calls.find((c) => c.args.includes("'screencap'"))
    const pull = calls.find((c) => c.args.includes('pull'))
    const cleanup = calls.find((c) => c.args.includes("'rm'"))
    assert.match(pull?.args[3] ?? '', /^\/data\/local\/tmp\/pult-screen-[\da-f-]+\.png$/)
    assert.ok(capture?.args.includes(quoteAndroidArg(pull!.args[3]!)))
    assert.ok(cleanup?.args.includes(quoteAndroidArg(pull!.args[3]!)))
  })

  it('boots an AVD in a detached process with fixed arguments, never a shell', async () => {
    const { driver, calls, starts } = fixture()
    await driver.perform({ ...android, id: 'android-avd:Pixel_9', state: 'stopped', capabilities: ['boot'] }, 'boot')
    assert.deepEqual(starts, [{ file: '/tools/emulator', args: ['-avd', 'Pixel_9'] }])
    assert.deepEqual(calls, [])
  })

  it('refuses oversized images after trying smaller captures instead of exceeding RPC limit', async () => {
    const { driver, calls } = fixture({ jpegSize: 450 * 1024 })
    await assert.rejects(driver.perform(ios, 'screenshot'), { code: 'image_too_large' })
    assert.equal(calls.filter((c) => c.file === '/usr/bin/sips').length, 3)
  })

  it('only the fixed approved setup manifest may invoke an installer', async () => {
    const { driver, calls } = fixture({ brew: true })
    await assert.rejects(driver.installSetup('arbitrary-command'), { code: 'invalid_params' })
    assert.equal(calls.length, 0)
    const before = await driver.discover()
    assert.equal(before.setup.find((s) => s.id === 'ios-axe')?.installable, true)
    await driver.installSetup('ios-axe')
    const install = calls.find((c) => c.file === '/tools/brew')
    assert.deepEqual(install?.args, ['install', 'cameroncooke/axe/axe'])
    assert.equal(install?.opts.env?.['HOMEBREW_NO_AUTO_UPDATE'], '1')
    assert.equal((await driver.discover()).targets[0]?.capabilities.includes('tap'), true)
  })
})

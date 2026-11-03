#!/usr/bin/env node
// Opt-in real-device smoke: builds a tiny UIKit app and creates/deletes ONLY its own simulator.
// Requires installed Xcode + iOS runtime + AXe. No dependency downloads or provider requests.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { discoverMobile, performMobile } from '../dist/runtimes/mobile.js'
import { smokeProviders } from './smoke-runtime-providers.mjs'

const out = resolve(process.argv[2] ?? 'shell/test-results/runtime-ios')
mkdirSync(out, { recursive: true })
const dir = mkdtempSync(join(tmpdir(), 'pult-ios-smoke-'))
const run = (args, timeout = 120_000) => execFileSync('/usr/bin/xcrun', args, { encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 }).trim()
let udid
let target
try {
  const initial = await discoverMobile()
  assert.ok(initial.targets.some(t => t.kind === 'ios' && t.capabilities.includes('tap')), 'Install an AXe helper first; this smoke never installs dependencies')
  const records = JSON.parse(run(['simctl', 'list', 'devices', '--json'])).devices
  const available = Object.entries(records).filter(([runtime, list]) => runtime.includes('.iOS-') && list.some(d => d.isAvailable !== false))
  const [runtime, list] = available.find(([, ds]) => ds.some(d => d.state === 'Booted')) ?? available[0] ?? []
  assert.ok(runtime, 'An installed iOS runtime is required')
  const base = list.find(d => d.state === 'Booted') ?? list[0]
  const types = JSON.parse(run(['simctl', 'list', 'devicetypes', '--json'])).devicetypes
  const deviceType = base.deviceTypeIdentifier ?? types.find(t => t.name === base.name)?.identifier ?? types.find(t => t.name === 'iPhone 16 Pro')?.identifier
  assert.ok(deviceType, 'Cannot identify simulator device type')
  udid = run(['simctl', 'create', `Pult Runtime Smoke ${Date.now()}`, deviceType, runtime])
  const app = join(dir, 'PultRuntimeSmoke.app'); mkdirSync(app)
  const swift = join(dir, 'Smoke.swift')
  writeFileSync(swift, `import UIKit
@main final class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  let field = UITextField()
  let status = UILabel()
  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    let root = UIViewController(); root.view.backgroundColor = .systemBackground
    let title = UILabel(); title.text = "Pult runtime smoke"; title.font = .boldSystemFont(ofSize: 24)
    field.placeholder = "Proof text"; field.accessibilityLabel = "Proof text"; field.borderStyle = .roundedRect
    field.autocorrectionType = .no; field.autocapitalizationType = .none
    status.text = "Ready for verification"; status.accessibilityIdentifier = "proof-status"
    let button = UIButton(type: .system); button.setTitle("Verify button", for: .normal); button.addTarget(self, action: #selector(verify), for: .touchUpInside)
    let stack = UIStackView(arrangedSubviews: [title, field, button, status]); stack.axis = .vertical; stack.spacing = 24
    stack.translatesAutoresizingMaskIntoConstraints = false; root.view.addSubview(stack)
    NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: root.view.leadingAnchor, constant: 28), stack.trailingAnchor.constraint(equalTo: root.view.trailingAnchor, constant: -28), stack.topAnchor.constraint(equalTo: root.view.safeAreaLayoutGuide.topAnchor, constant: 60), field.heightAnchor.constraint(equalToConstant: 44)])
    let win = UIWindow(frame: UIScreen.main.bounds); win.rootViewController = root; win.makeKeyAndVisible(); window = win
    return true
  }
  @objc func verify() { status.text = "Verified " + (field.text ?? ""); field.resignFirstResponder() }
}
`)
  writeFileSync(join(app, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Smoke</string><key>CFBundleIdentifier</key><string>dev.pult.runtime.smoke</string><key>CFBundleName</key><string>Pult Runtime Smoke</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>1.0</string><key>MinimumOSVersion</key><string>18.0</string><key>LSRequiresIPhoneOS</key><true/><key>UIDeviceFamily</key><array><integer>1</integer></array><key>UILaunchScreen</key><dict/></dict></plist>`)
  const sdk = run(['--sdk', 'iphonesimulator', '--show-sdk-path'])
  run(['--sdk', 'iphonesimulator', 'swiftc', '-parse-as-library', '-target', 'arm64-apple-ios18.0-simulator', '-sdk', sdk, swift, '-o', join(app, 'Smoke')])
  run(['simctl', 'boot', udid]); run(['simctl', 'bootstatus', udid, '-b'], 180_000)
  target = (await discoverMobile()).targets.find(t => t.id === `ios:${udid}`)
  assert.ok(target)
  await performMobile(target, 'install', { path: app })
  await performMobile(target, 'launch', { appId: 'dev.pult.runtime.smoke' })
  const wait = async pattern => {
    for (let i = 0; i < 20; i++) { const tree = await performMobile(target, 'inspect', {}); if (pattern.test(JSON.stringify(tree))) return; await new Promise(r => setTimeout(r, 500)) }
    throw new Error(`Expected UI state missing: ${pattern}`)
  }
  await wait(/Ready for verification/)
  await performMobile(target, 'tap', { label: 'Proof text' })
  await new Promise(r => setTimeout(r, 700))
  await performMobile(target, 'type', { text: 'runtime-proof' })
  await wait(/runtime-proof/)
  await performMobile(target, 'tap', { label: 'Verify button' })
  await wait(/Verified runtime-proof/)
  const frame = await performMobile(target, 'screenshot', {})
  assert.ok(frame.image?.data && frame.coordinateWidth > 0)
  writeFileSync(join(out, 'ios-proof.jpg'), Buffer.from(frame.image.data, 'base64'))
  writeFileSync(join(out, 'report.json'), JSON.stringify({ passed: true, platform: 'ios', steps: ['isolated simulator', 'build', 'install', 'launch', 'inspect', 'tap', 'type', 'verify UI state', 'screenshot'], width: frame.width, height: frame.height, coordinateWidth: frame.coordinateWidth, coordinateHeight: frame.coordinateHeight }, null, 2))
  console.log(`PASS iOS runtime: ${out}/report.json`)
  if (process.argv.includes('--providers')) await smokeProviders(target.id, out)
} catch (error) {
  if (target) {
    try { writeFileSync(join(out, 'failure-tree.json'), JSON.stringify(await performMobile(target, 'inspect', {}), null, 2)) } catch {}
    try { const f = await performMobile(target, 'screenshot', {}); writeFileSync(join(out, 'failure-screen.jpg'), Buffer.from(f.image.data, 'base64')) } catch {}
  }
  throw error
} finally {
  if (udid) { try { run(['simctl', 'shutdown', udid]) } catch {} ; try { run(['simctl', 'delete', udid]) } catch {} }
  rmSync(dir, { recursive: true, force: true })
}

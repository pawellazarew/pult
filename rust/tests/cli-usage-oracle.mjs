// Actual public Node CLI vs Rust, using only a private owner socket. No provider.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const entry = join(root, 'dist/cli/main.js')
await access(entry)
const rust = process.argv[2]
const only = process.argv[3]
const token = 'a'.repeat(64)
const row = (values={}) => ({session:'one',provider:'claude',turns:2,totalCostUsd:1.23445,inputTokens:3,outputTokens:4,cacheReadTokens:5,rateLimit:null,...values})
let seed=0x123456789abcdefn
const samples=[]
for(let i=0;i<128;i++) {
 seed=BigInt.asUintN(64,seed*6364136223846793005n+1442695040888963407n)
 const bytes=new ArrayBuffer(8),view=new DataView(bytes)
 const exponent=BigInt(970+(i%120))
 view.setBigUint64(0,(seed&((1n<<52n)-1n))|(exponent<<52n)|(i%2?1n<<63n:0n))
 samples.push(view.getFloat64(0))
}
const cases = [
 {name:'empty',result:{usage:[]}},
 {name:'basic',result:{usage:[row()]}},
 {name:'rounding',result:{usage:[...[-0,-0.000001,0.00005,1.00005,1.23445,2.675,1e21,999999999999999900000,1e-300,...samples].map(totalCostUsd=>row({totalCostUsd})),row({session:'🙂e\u0301',turns:1000,rateLimit:{windows:{five_hour:{utilization:-0.005},seven_day:{utilization:0.125}}}})]}},
 {name:'opaque',result:{usage:[row({rateLimit:{status:'future',windows:{five_hour:{utilization:'0.5'},seven_day:{utilization:null},lone:'\ud800'},resetsAt:null}})],future:{lone:'\ud800'}}},
 {name:'coercions',result:{usage:[row({session:['x',null,2],turns:true,totalCostUsd:['0x2'],inputTokens:{},outputTokens:null,cacheReadTokens:false}),row({totalCostUsd:'Infinity',rateLimit:{windows:{five_hour:{utilization:1e308},seven_day:{utilization:-1e308}}}})]}},
 ...[
  {name:'utf16-key-top',result:{usage:[row()],['\ud800']:1}},
  {name:'utf16-key-row',result:{usage:[row({['\ud800']:1})]}},
  {name:'utf16-key-rate',result:{usage:[row({rateLimit:{['\ud800']:1,windows:{five_hour:{utilization:0.5}}}})]}},
  {name:'utf16-key-windows',result:{usage:[row({rateLimit:{windows:{['\ud800']:1,five_hour:{utilization:0.5}}}})]}},
  {name:'utf16-key-five-hour',result:{usage:[row({rateLimit:{windows:{five_hour:{['\ud800']:1,utilization:0.5},seven_day:{['\udfff']:2,utilization:0.25}}}})]}},
 ],
 ...['timeout','blocked_network','provider_unavailable','limited','unavailable','capacity'].map(code=>({name:`error-${code}`,error:{code,message:'Controlled error'}})),
].map(c=>({...c,method:'usage.get',args:[]}))
const errorExit = code => code==='timeout'?2:1
async function run(kind, scenario, locale, json, alias, scratch) {
  const home = join(scratch, 'home')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PULT_') && !key.startsWith('FAKE_') && !key.endsWith('_API_KEY') && key !== 'NODE_OPTIONS'))
  Object.assign(env, { HOME: join(scratch, 'user'), PULT_HOME: kind === 'node' ? home : join(scratch, 'protected'), PULT_LANG: locale, PULT_TEST: '1' })
  const sockets = new Set(), requests = []
  let peerError
  let phase = 'waiting-for-client'
  const server = net.createServer(socket => {
    phase = 'connected'
    sockets.add(socket); socket.on('error', () => {})
    let buffer = ''
    socket.on('data', bytes => { try {
      buffer += bytes
      assert.ok(Buffer.byteLength(buffer) <= 1024 * 1024)
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'), frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
        if (frame.type === 'hello') {
          phase = 'hello-received'
          assert.equal(frame.token, token)
          socket.write(JSON.stringify({ type: 'hello_ok', protocol: 1, daemon: { version: 'fixture', pid: 1, startedAt: 'fixture' } }) + '\n')
        } else {
          phase = 'request-received'
          requests.push(frame)
          assert.equal(requests.length, 1, 'no retry or extra diagnostic/mutation RPC')
          assert.equal(frame.method, scenario.method); assert.equal(frame.locale, locale)
          assert.deepEqual(frame.params, scenario.params ?? (kind === 'node' ? undefined : {}))
          socket.write(JSON.stringify({ id: frame.id, ...(scenario.error ? { error: scenario.error } : { result: scenario.result }) }) + '\n')
          phase = 'response-enqueued'
        }
      }
    } catch (e) { peerError ??= e; socket.destroy() } })
  })
  await new Promise(resolve => server.listen(join(home, 'run/pultd.sock'), resolve))
  let child, timer
  try {
    const args = kind === 'node' ? ['--import', join(root, 'rust/tests/fixtures/agent_presentation_preload.mjs'), entry] : ['--home', home]
    child = spawn(kind === 'node' ? process.execPath : rust, [...args, 'usage', ...scenario.args, ...(json ? ['--json'] : [])], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = [], stderr = []; let bytes = 0
    for (const [stream, target] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', b => { bytes += b.length; assert.ok(bytes <= 2 * 1024 * 1024); target.push(b) })
    const status = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
      timer = setTimeout(() => {
        const size = chunks => chunks.reduce((total, chunk) => total + chunk.length, 0)
        process.stderr.write(JSON.stringify({ oracleWatchdog: {
          kind, scenario: scenario.name, locale, json, alias, phase,
          requests: requests.length, stdoutBytes: size(stdout), stderrBytes: size(stderr),
          peerError: Boolean(peerError),
        } }) + '\n')
        child.kill('SIGKILL')
      }, 8000)
    })
    assert.equal(status.signal, null, `${kind} watchdog ${scenario.name}`); assert.ifError(peerError)
    assert.equal(requests.length, 1)
    const result = { code: status.code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }
    assert.equal(result.code, scenario.error ? errorExit(scenario.error.code) : 0, `${kind}/${scenario.name}/${locale}/${json}`)
    if (scenario.error) assert.equal(result.stderr, `pult: ${scenario.error.code} — Controlled error\n`)
    else {
      assert.equal(result.stderr, '')
      if (json) assert.deepEqual(JSON.parse(result.stdout), JSON.parse(JSON.stringify(scenario.result)))
      if (!json && scenario.name === 'empty') assert.equal(result.stdout, locale === 'ru' ? 'расхода пока нет\n' : 'No usage yet\n')
    }
    return result
  } finally {
    clearTimeout(timer)
    if (child?.exitCode === null && child?.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('close', resolve)) }
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}
let count = 0
for (const scenario of cases) {
  if (only && scenario.name !== only) continue
  const scratch = await mkdtemp('/tmp/r4agent-')
  try {
    for (const dir of ['home', 'home/run', 'user']) await mkdir(join(scratch, dir), { mode: 0o700 })
    for (const [name, body] of [['home/.rust-core-scratch', 'pult-rust-scratch-v1\n'], ['home/config.json', '{}'], ['home/run/token', token]]) await writeFile(join(scratch, name), body, { mode: 0o600 })
    for (const locale of ['ru', 'en']) for (const json of [false, true]) {
      const alias = count % 2 ? 'session' : 'agent'
      const node = await run('node', scenario, locale, json, alias, scratch)
      if (rust) assert.deepEqual(await run('rust', scenario, locale, json, alias, scratch), node, `${scenario.name}/${locale}/${json}`)
      count++
    }
  } finally { await rm(scratch, { recursive: true, force: true }) }
}
console.log(`usage presentation oracle: ${count} ${rust ? 'paired Node/Rust' : 'Node-only'} cases`)

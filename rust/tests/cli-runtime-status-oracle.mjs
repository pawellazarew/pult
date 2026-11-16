// Actual public Node cmdRuntime, optionally paired with Rust; private fakes only.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir, lstat, readlink } from 'node:fs/promises'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const rust = process.argv[2]
const pin = (await readFile(join(root, 'runtime.env'), 'utf8')).match(/^PULT_NODE_VERSION=(.*)$/m)[1]
const token = 'a'.repeat(64)
const cases = [
  { name: 'opaque daemon key', daemon: { '\ud800': 1, version: 'test', node: { path: '/fixture/node', version: 'v24.0.0', alive: true, own: true } } },
  { name: 'opaque node key', daemon: { version: 'test', node: { '\udfff': 1, path: '/fixture/node', version: 'v24.0.0', alive: true, own: true } } },
  { name: 'missing pointer' },
  { name: 'empty pointer', pointer: ' \t\nignored' },
  { name: 'missing binary', active: true, missing: true },
  { name: 'nonexecutable', active: true, nonexec: true },
  { name: 'matching', active: true, version: `v${pin}` },
  { name: 'external executable', active: true, external: true, version: `v${pin}` },
  { name: 'executable symlink', active: true, symlink: true, version: `v${pin}` },
  { name: 'relative executable', active: true, relative: true, version: `v${pin}` },
  { name: 'mismatch', active: true, version: 'v1.2.3' },
  { name: 'no v prefix', active: true, version: pin },
  { name: 'arbitrary stdout', active: true, version: 'not-semver' },
  { name: 'empty stdout', active: true, version: ' \t\n' },
  { name: 'combined maxBuffer', active: true, version: 'x'.repeat(600 * 1024), stderr: 'y'.repeat(600 * 1024), expectedVersion: null },
  { name: 'nonzero', active: true, version: `v${pin}`, exit: 7 },
  { name: 'trim first line', active: true, padded: true, version: ` \t\ufeffv${pin}\r\n` },
  { name: 'old daemon', daemon: { version: 'old' } },
  { name: 'own daemon', daemon: { version: 'test', node: { path: '/fixture/node', version: 'v24.0.0', alive: true, own: true } } },
  { name: 'system daemon', daemon: { version: 'test', node: { path: '/fixture/node', version: 'v24.0.0', alive: true, own: false } } },
  { name: 'dead daemon', daemon: { version: 'test', node: { path: '/fixture/deleted', version: 'v24.0.0', alive: false, own: true } } },
  { name: 'opaque daemon node', daemon: { version: 'test', node: { path: '/fixture/\ud800node', version: 'v24', alive: true, own: true, extension: { nested: '\udfff' } } } },
]
async function tree(path) {
  const stat=await lstat(path), mode=stat.mode&0o777
  if(stat.isSymbolicLink())return {mode,link:await readlink(path)}
  if(stat.isDirectory()){const out={mode};for(const name of (await readdir(path)).sort())out[name]=await tree(join(path,name));return out}
  return stat.isFile()?{mode,hash:createHash('sha256').update(await readFile(path)).digest('hex')}:{mode,socket:stat.isSocket()}
}
let count = 0
for (const scenario of cases) for (const locale of ['ru', 'en']) for (const json of [false, true]) {
  const scratch = await mkdtemp('/tmp/prs-')
  try {
    const home = join(scratch, 'home'), user = join(scratch, 'user'), runtime = join(home, 'runtime')
    for (const dir of [home, user, join(home, 'run'), runtime]) await mkdir(dir, { mode: 0o700 })
    await writeFile(join(home, '.rust-core-scratch'), 'pult-rust-scratch-v1\n', { mode: 0o600 })
    await writeFile(join(home, 'config.json'), JSON.stringify({ language: locale }), { mode: 0o600 })
    await writeFile(join(home, 'run/token'), token, { mode: 0o600 })
    const fake = scenario.external ? join(scratch, 'external-node') : join(runtime, 'node-v0.0.0-foreign', 'bin', 'node'), calls = join(scratch, 'calls.json')
    const active = scenario.symlink ? join(runtime, 'executable-link') : scenario.relative ? './node' : fake
    await mkdir(join(runtime, 'node-v0.0.0-foreign', 'bin'), { recursive: true, mode: 0o700 })
    await mkdir(dirname(fake), { recursive: true, mode: 0o700 })
    if (!scenario.missing) await writeFile(fake, `#!/usr/bin/python3\nimport json,os,sys\nassert sys.argv[1:]==['-v']\nwith open(${JSON.stringify(calls)},'w') as f: json.dump({'argv':sys.argv[1:],'env':dict(os.environ)},f)\nsys.stdout.write(${JSON.stringify(scenario.version ?? '')})\nsys.stderr.write(${JSON.stringify(scenario.stderr ?? 'private-fake-stderr')})\nsys.exit(${scenario.exit ?? 0})\n`, { mode: scenario.nonexec ? 0o600 : 0o700 })
    if (scenario.symlink) await symlink(fake, active)
    if (scenario.active) await writeFile(join(runtime, 'active'), scenario.padded ? ` \t${active}\r\nignored` : `${active}\n`, { mode: 0o600 })
    if (scenario.pointer !== undefined) await writeFile(join(runtime, 'active'), scenario.pointer, { mode: 0o600 })
    for (const name of ['node-vz', 'node-va', 'node-v.partial-x', 'node-v~old-x', 'not-node', 'node-v\ue000', 'node-v𐀀']) await writeFile(join(runtime, name), '')
    await symlink('/nonexistent-fixture-target', join(runtime, 'node-vlink'))
    const results=[]
    for (const kind of rust ? ['node', 'rust'] : ['node']) {
      const requests=[], sockets=new Set(); let peerError
      const server=net.createServer(socket=>{
        sockets.add(socket); let buffer=''; socket.on('error',()=>{}); socket.on('data',bytes=>{try{
          buffer+=bytes; assert.ok(buffer.length<65536)
          while(buffer.includes('\n')){const end=buffer.indexOf('\n'),frame=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1)
            if(frame.type==='hello'){assert.equal(frame.token,token);socket.write('{"type":"hello_ok","protocol":1,"daemon":{}}\n')}
            else {requests.push(frame);assert.equal(frame.method,'daemon.status');assert.equal(frame.locale,locale);assert.equal(requests.length,1);socket.write(JSON.stringify({id:frame.id,result:scenario.daemon})+'\n')}
          }
        }catch(e){peerError??=e;socket.destroy()}})
      })
      if(scenario.daemon) await new Promise(r=>server.listen(join(home,'run/pultd.sock'),r))
      const env={HOME:user,PULT_HOME:kind==='node'?home:join(scratch,'protected'),PULT_LANG:locale,PULT_TEST:'1',PATH:'/usr/bin:/bin',LANG:'C',TMPDIR:scratch,PULT_TEST_RUNTIME_EXEC:active,NODE_OPTIONS:'--unhandled-rejections=strict',OPENAI_API_KEY:'synthetic-must-not-pass',ANTHROPIC_API_KEY:'synthetic-must-not-pass'}
      const args=kind==='node'?['--import',join(root,'rust/tests/fixtures/runtime_status_preload.mjs'),join(root,'dist/cli/main.js')]:['--home',home]
      // Exercise both public status spellings, including --json before status.
      args.push('runtime',...(count%2?['status']:[]),...(json?['--json']:[]))
      const before=await tree(home)
      let child,timer
      try {
        child=spawn(kind==='node'?process.execPath:rust,args,{env,stdio:['ignore','pipe','pipe'],detached:true,cwd:dirname(fake)})
        const stdout=[],stderr=[];let bytes=0,watchdog=false
        for(const[stream,out]of[[child.stdout,stdout],[child.stderr,stderr]])stream.on('data',b=>{bytes+=b.length;assert.ok(bytes<=2*1024*1024);out.push(b)})
        const status=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal})});timer=setTimeout(()=>{watchdog=true;process.kill(-child.pid,'SIGKILL')},8000)})
        assert.equal(watchdog,false);assert.equal(status.signal,null);assert.ifError(peerError)
        const result={code:status.code,stdout:Buffer.concat(stdout).toString(),stderr:Buffer.concat(stderr).toString()}
        assert.equal(result.code,0,JSON.stringify(result));assert.equal(result.stderr,'');assert.equal(requests.length,scenario.daemon?1:0)
        if(json){const value=JSON.parse(result.stdout);assert.deepEqual(Object.keys(value),['platform','key','pinned','active','activeVersion','installed','daemon']);assert.equal(value.pinned,pin);if(scenario.expectedVersion!==undefined)assert.equal(value.activeVersion,scenario.expectedVersion);assert.deepEqual(value.daemon,scenario.daemon?.node??null);assert.deepEqual(value.installed,['node-v0.0.0-foreign','node-va','node-vlink','node-vz','node-v𐀀','node-v\ue000'].sort())}
        if(scenario.active&&!scenario.missing&&!scenario.nonexec){const call=JSON.parse(await readFile(calls,'utf8'));assert.deepEqual(call.argv,['-v']);for(const key of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','NODE_OPTIONS','PULT_TEST_RUNTIME_EXEC','PULT_TEST','PULT_HOME'])assert.equal(call.env[key],undefined)}
        assert.deepEqual(await tree(home),before,'status must not change fixture data/layout/modes')
        results.push(result)
      } finally {clearTimeout(timer);for(const socket of sockets)socket.destroy();if(server.listening)await new Promise(r=>server.close(r))}
    }
    if(rust)assert.deepEqual(results[1],results[0],`${scenario.name} ${locale} json=${json}`)
    count++
  } finally {await rm(scratch,{recursive:true,force:true})}
}
console.log(`runtime status oracle: ${count} ${rust?'exact paired Node/Rust':'actual public Node'} cases`)

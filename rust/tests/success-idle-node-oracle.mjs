// Actual public Node adapters over explicit repository prerecorded fake CLIs.
// No account/model/curl/schema execution, SDK construction or source extraction.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createClaudeAdapter } from '../../dist/adapters/claude/adapter.js'
import { createCodexAdapter } from '../../dist/adapters/codex/adapter.js'
import { createZcodeAdapter } from '../../dist/adapters/zcode/adapter.js'
import { defaultConfig } from '../../dist/core/config.js'
import { ensureLayout, layout } from '../../dist/core/paths.js'
import { createLogger } from '../../dist/core/log.js'
const root = fileURLToPath(new URL('../../', import.meta.url))
const temp = mkdtempSync(join(tmpdir(), 'pult-success-idle-node-'))
chmodSync(temp, 0o700)
const account = join(temp, 'account'); mkdirSync(account); chmodSync(account, 0o700)
process.env.HOME = account
for (const key of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|ZCODE_|PULT_)/.test(key)) delete process.env[key]
}
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const jsonl = path => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const bounded = (work, label, ms=15000) => {
  let timer
  return Promise.race([work, new Promise((_,reject) => {timer=setTimeout(()=>reject(new Error(label)),ms)})]).finally(()=>clearTimeout(timer))
}
const results=[]
try {
  for (const provider of ['claude','codex','zcode']) {
    const base=join(temp,provider); mkdirSync(base)
    const paths=layout(join(base,'home')); ensureLayout(paths)
    const cwd=join(base,'project');mkdirSync(cwd)
    const launch=join(base,'launch.jsonl')
    const cfg={scenario:'simple',speed:0,argvOut:launch,logOut:launch}
    writeFileSync(join(cwd,'.pult-fake.json'),JSON.stringify(cfg))
    writeFileSync(join(paths.home,'.pult-fake-codex.json'),JSON.stringify(cfg))
    const drafts=[]
    const binary=join(root,'test/fakes',provider==='codex'?'fake-codex-app-server.mjs':`fake-${provider}.mjs`)
    assert.ok(readFileSync(binary,'utf8').startsWith('#!/usr/bin/env node'))
    const options={
      paths, config:{...defaultConfig(),subagentGraceMs:1}, logger:createLogger(paths.logFile),bin:binary,
      cliEntry:join(root,'dist/cli/main.js'),nodeExec:process.execPath,
      emit:d=>drafts.push(d),askPermission:async()=>({behavior:'deny',message:'fixture deny'}),
      cancelPermissions:()=>0,
      netCheck:async()=>({provider,mode:'auto',path:'direct',proxy:null,loc:'FI',ok:true,reason:'ok',fellBack:false,guard:['RU'],attempts:[],ms:1,checkedAt:'2026-11-13T00:00:00.000Z',cached:false}),
      schemaCheck:()=>({status:'ok',expected:'fixture',actual:'fixture',files:0,detail:'repository fake only'}),
    }
    const factory={claude:createClaudeAdapter,codex:createCodexAdapter,zcode:createZcodeAdapter}[provider]
    const adapter=factory(options)
    let outcome
    try {
      await bounded(adapter.startSession({name:'success',cwd,mode:'turn',broker:false,approval:'read-only',...(provider==='codex'?{model:'gpt-6-astra',effort:'low'}:{})}),`${provider}: start deadline`)
      const started=await bounded(adapter.send('success','literal success fixture'),`${provider}: send deadline`)
      outcome=await bounded(started.done,`${provider}: completion deadline`)
      assert.equal(outcome.ok,true,`${provider}: success fixture failed`)
      assert.equal(outcome.turnId,started.turnId)
      const statuses=drafts.filter(d=>d.sessionId==='success'&&d.kind==='status.changed').map(d=>d.data.status)
      assert.equal(statuses.at(-1),'idle',`${provider}: success must end idle`)
      assert.ok(statuses.includes('working'),`${provider}: must have started a real fake turn`)
      assert.ok(!statuses.includes('done'),`${provider}: success is not conversation end`)
      results.push({provider,statuses,ok:outcome.ok,sourceSha256:createHash('sha256').update(readFileSync(join(root,`src/adapters/${provider}/adapter.ts`))).digest('hex')})
      await bounded(adapter.close('success'),`${provider}: explicit close deadline`)
      assert.equal(drafts.filter(d=>d.sessionId==='success'&&d.kind==='status.changed').at(-1).data.status,'done',`${provider}: explicit close still ends conversation`)
      results.at(-1).explicitClose='done'
    } finally {await bounded(adapter.shutdown(),`${provider}: shutdown deadline`)}
    const launches=jsonl(launch)
    const pids=provider==='codex'?launches.filter(v=>v.ev==='boot').map(v=>v.pid):launches.map(v=>v.pid)
    assert.ok(pids.length>0,`${provider}: explicit repository fake did not launch`)
    assert.ok(pids.every(pid=>Number.isSafeInteger(pid)&&pid>0),`${provider}: invalid fake PID evidence`)
    await bounded((async()=>{while(pids.some(alive)){await new Promise(resolve=>setTimeout(resolve,10))}})(),`${provider}: fake process survived shutdown`,3000)
  }
  console.log(JSON.stringify({oracle:'actual-public-node-adapters',results}))
} finally {rmSync(temp,{recursive:true,force:true})}

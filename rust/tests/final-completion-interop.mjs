// Actual public Node adapters vs actual Rust daemon over explicit repo fakes.
// Also tests Node EventStore/reducer rollback compatibility of existing status data.
import assert from 'node:assert/strict'
import {isDeepStrictEqual} from 'node:util'
import {spawn} from 'node:child_process'
import {mkdtempSync,mkdirSync,chmodSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createClaudeAdapter} from '../../dist/adapters/claude/adapter.js'
import {createCodexAdapter} from '../../dist/adapters/codex/adapter.js'
import {createZcodeAdapter} from '../../dist/adapters/zcode/adapter.js'
import {defaultConfig} from '../../dist/core/config.js'
import {layout,ensureLayout} from '../../dist/core/paths.js'
import {createLogger} from '../../dist/core/log.js'
import {connectClient} from '../../dist/cli/client.js'
import {createStore} from '../../dist/core/store.js'
import {reduceStatusEvent} from '../../dist/sessions/status.js'
import {attentionOf} from '../../dist/sessions/attention.js'
const root=fileURLToPath(new URL('../../',import.meta.url)), binary=resolve(process.argv[2]), only=process.argv[3]??null
const temp=mkdtempSync('/tmp/pfcomp-');chmodSync(temp,0o700)
const account=join(temp,'account');mkdirSync(account,{mode:0o700});process.env.HOME=account
for(const k of Object.keys(process.env))if(/^(ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|ZCODE_|PULT_)/.test(k))delete process.env[k]
const peers=join(temp,'peers');mkdirSync(peers,{mode:0o700})
const peer=new URL('./fixtures/final_completion_peer.mjs',import.meta.url).href
for(const provider of ['claude','codex','zcode'])writeFileSync(join(peers,`${provider}.mjs`),`#!/usr/bin/env node\nimport {run} from ${JSON.stringify(peer)}\nrun(${JSON.stringify(provider)})\n`,{mode:0o700})
const pause=ms=>new Promise(r=>setTimeout(r,ms)),alive=pid=>{try{process.kill(pid,0);return true}catch{return false}}
const bounded=async(work,label,ms=15000)=>{let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms)})])}finally{clearTimeout(timer)}}
const rows=p=>existsSync(p)?readFileSync(p,'utf8').split('\n').filter(Boolean).map(JSON.parse):[]
function prepare(engine,provider,variant){
 const base=join(temp,`${engine}-${provider}-${variant}`);mkdirSync(base,{mode:0o700})
 const paths=layout(join(base,'h'));ensureLayout(paths);const cwd=join(base,'p');mkdirSync(cwd,{mode:0o700})
 const launch=join(base,'launch.jsonl'),cfg={scenario:'simple',speed:0,argvOut:launch,logOut:launch}
 for(const p of [join(cwd,'.pult-fake.json'),join(paths.home,'.pult-fake-codex.json')])writeFileSync(p,JSON.stringify(cfg))
 for(const p of [join(cwd,'.wait-text.json'),join(paths.home,'.wait-text.json')])writeFileSync(p,JSON.stringify({variant}))
 return {base,paths,cwd,launch}
}
async function node(provider,variant){
 const x=prepare('node',provider,variant),drafts=[]
 const adapter={claude:createClaudeAdapter,codex:createCodexAdapter,zcode:createZcodeAdapter}[provider]({
  paths:x.paths,config:{...defaultConfig(),subagentGraceMs:10},logger:createLogger(x.paths.logFile),bin:join(peers,`${provider}.mjs`),cliEntry:join(root,'dist/cli/main.js'),nodeExec:process.execPath,
  emit:d=>drafts.push(d),askPermission:async()=>({behavior:'deny',message:'fixture deny'}),cancelPermissions:()=>0,
  netCheck:async()=>({provider,mode:'off',path:'direct',proxy:null,loc:'FI',ok:true,reason:'ok',fellBack:false,guard:['RU'],attempts:[],ms:1,checkedAt:'2026-11-13T00:00:00.000Z',cached:false}),
  schemaCheck:()=>({status:'ok',expected:'fixture',actual:'fixture',files:0,detail:'repo fake only'})
 })
 try{
  await bounded(adapter.startSession({name:'subject',cwd:x.cwd,mode:'turn',broker:false,approval:'read-only',...(provider==='codex'?{model:'gpt-6-astra',effort:'low'}:{})}),'Node start')
  const started=await bounded(adapter.send('subject','literal final completion qualification'),'Node send'),outcome=await bounded(started.done,'Node done')
  assert.equal(outcome.ok,variant!=='failed'&&!(provider==='claude'&&variant==='capacity'));if(variant==='large-escaped')assert.ok(outcome.text==='\0'.repeat(100_000),'large escaped text mismatch');if(variant==='capacity')assert.ok(outcome.text===(provider==='claude'?'\0'.repeat(100_000):'\0'.repeat(100_000)+'\n'+'\0'.repeat(100_000)),'capacity oracle text mismatch');return {outcome,messages:drafts.filter(d=>d.kind==='message.done').map(d=>d.data.text)}
 }finally{
  await bounded(adapter.shutdown(),'Node shutdown');const pids=rows(x.launch).map(r=>r.pid).filter(Number.isInteger)
  assert.ok(pids.length>0);await bounded((async()=>{while(pids.some(alive))await pause(10)})(),'fake process survived',3000)
 }
}
async function daemon(x,provider){
 const env={...process.env,HOME:account,PULT_TEST:'1',PULT_CURL_BIN:join(root,'rust/tests/fixtures/curl_loc_fi.sh')}
 for(const p of ['claude','codex','zcode'])env[`PULT_${p.toUpperCase()}_BIN`]=p===provider?join(peers,`${p}.mjs`):join(x.base,`missing-${p}`)
 const child=spawn(binary,['--home',x.paths.home,'daemon','serve'],{env,stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',b=>stderr=(stderr+b).slice(-4000))
 const exited=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})))
 let client
 try{
  await bounded((async()=>{while(!existsSync(x.paths.sock)||!existsSync(x.paths.token)){assert.equal(child.exitCode,null,stderr);await pause(10)}})(),'daemon startup')
  client=await connectClient(x.paths,{timeoutMs:10000});return {client,child,stop:async()=>{client.close();child.kill('SIGTERM');await bounded(exited,'daemon join',10000)}}
 }catch(error){client?.close();if(child.exitCode===null)child.kill('SIGTERM');await bounded(exited,'failed startup join');throw error}
}
let checks=0,complete=false
try{
 for(const provider of ['claude','codex','zcode'])for(const variant of ['divergent','multi','empty','failed','large-escaped',...(provider!=='codex'?['capacity']:[])]){
  if(only&&only!==`${provider}/${variant}`)continue
  const oracle=await node(provider,variant),x=prepare('rust',provider,variant)
  writeFileSync(join(x.paths.home,'.rust-core-scratch'),'pult-rust-scratch-v1\n',{mode:0o600})
  writeFileSync(join(x.paths.home,'config.json'),JSON.stringify({network:{[provider]:{mode:'off'},guard:{mode:'allow',countries:['FI']}}}),{mode:0o600})
  let running=await daemon(x,provider),receipt,event
  try{
   await running.client.request('agent.start',{kind:provider,name:'subject',cwd:x.cwd,approval:'read-only',...(provider==='codex'?{model:'gpt-6-astra',effort:'low'}:{})})
   receipt=await running.client.request('agent.prompt',{name:'subject',text:'literal final completion qualification'},{timeoutMs:12000})
   await bounded((async()=>{while((await running.client.request('daemon.status')).nativeRuntime.activeTurns!==0)await pause(10)})(),'Rust owned turn cleanup')
   const journal=rows(join(x.paths.home,'events/journal.jsonl'));event=journal.filter(e=>e.kind==='status.changed').at(-1)
   const completion=event.data.completion
   assert.equal(completion.version,1);assert.equal(completion.incarnation,JSON.parse(readFileSync(join(x.paths.home,'sessions.json'),'utf8')).sessions[0].createdAt)
   const user=journal.find(e=>e.id===completion.userEventId);assert.equal(user.kind,'message.user');assert.equal(user.sessionId,'subject')
   assert.equal(event.data.turnId,receipt.turnId)
   if(variant==='capacity'){
    assert.equal(completion.unavailable,'capacity');assert.equal(completion.outcome,undefined);assert.equal(event.data.status,oracle.outcome.ok?'idle':'failed')
   }else if(provider==='zcode'&&variant==='failed'){
    assert.equal(completion.unavailable,'disposition');assert.equal(completion.outcome,undefined);assert.equal(event.data.errorCode,'provider_failed')
   }else{
    const {turnId:_,...fields}=oracle.outcome;assert.ok(completion.outcome,`${provider}/${variant} unavailable=${completion.unavailable} status=${event.data.status} code=${event.data.errorCode??'none'}`);assert.ok(isDeepStrictEqual(completion.outcome,{turnId:receipt.turnId,...fields}),'qualified outcome mismatch')
    assert.equal(event.data.status,fields.ok?'idle':'failed')
   }
   if(provider!=='codex'&&variant==='divergent')assert.ok(!journal.filter(e=>e.kind==='message.done').some(e=>e.data.text===oracle.outcome.text))
  }finally{await running.stop()}
  // Actual old Node EventStore + status/attention reducers must preserve the
  // additive data without changing existing UI/reducer behavior or event kind.
  const old=createStore(x.paths)
  let added
  try{
   assert.ok(isDeepStrictEqual(old.readIds([event.id])[0],event),'Node global completion changed')
   assert.ok(isDeepStrictEqual(old.readSession('subject').find(e=>e.id===event.id),event),'Node session projection changed')
   const stripped={...event,data:{...event.data}};delete stripped.data.completion
   assert.equal(reduceStatusEvent('working',event),reduceStatusEvent('working',stripped))
   assert.deepEqual(attentionOf(event),attentionOf(stripped))
   added=old.append({sessionId:'subject',provider,kind:'usage.updated',data:{source:'rollback-fixture',totalCostUsd:0}})
  }finally{old.close()}
  // Rust reopens the same authoritative journal after Node appended, without
  // sending another prompt or rehydrating a remembered inflight answer.
  const before=rows(x.launch).length;running=await daemon(x,provider)
  try{
   const read=await running.client.request('events.get',{ids:[event.id]});const appended=await running.client.request('events.get',{ids:[added.id]})
   assert.ok(isDeepStrictEqual(read.events,[event]),'Rust reopened completion changed');assert.ok(isDeepStrictEqual(appended.events,[added]),'Rust reopened Node append changed');assert.equal(rows(x.launch).length,before,'rollback restart spawned a provider/replayed input')
  }finally{await running.stop()}
  checks++;console.log(`pass final completion ${provider}/${variant}, Node comparator + Rust→Node→Rust`)
 }
 console.log(`PASS ${checks} paired actual adapter/daemon cases, ${checks} actual Node rollback roundtrips`);complete=true
}finally{if(complete)rmSync(temp,{recursive:true,force:true});else console.error(`controlled completion scratch retained: ${temp}`)}

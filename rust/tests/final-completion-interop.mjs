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
// Fixture-only mode, sampled before the inherited PULT_* environment scrub.
// Default carrier17 flow/assertions remain unchanged when this is absent.
const waitE2E=process.env.PULT_COMPLETION_WAIT_E2E==='1'
const temp=mkdtempSync('/tmp/pfcomp-');chmodSync(temp,0o700)
const account=join(temp,'account');mkdirSync(account,{mode:0o700});process.env.HOME=account
for(const k of Object.keys(process.env))if(/^(ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|ZCODE_|PULT_)/.test(k))delete process.env[k]
const peers=join(temp,'peers');mkdirSync(peers,{mode:0o700})
const peer=new URL('./fixtures/final_completion_peer.mjs',import.meta.url).href
for(const provider of ['claude','codex','zcode'])writeFileSync(join(peers,`${provider}.mjs`),`#!/usr/bin/env node\nimport {run} from ${JSON.stringify(peer)}\nrun(${JSON.stringify(provider)})\n`,{mode:0o700})
const pause=ms=>new Promise(r=>setTimeout(r,ms)),alive=pid=>{try{process.kill(pid,0);return true}catch{return false}}
const bounded=async(work,label,ms=15000)=>{let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms)})])}finally{clearTimeout(timer)}}
const rows=p=>existsSync(p)?readFileSync(p,'utf8').split('\n').filter(Boolean).map(JSON.parse):[]
async function cli(paths,args){
 const child=spawn(binary,['--home',paths.home,'agent',...args],{env:{...process.env,PULT_LANG:'en'},stdio:['ignore','pipe','pipe']})
 const stdout=[],stderr=[];let bytes=0,overflow=false
 for(const [stream,chunks]of[[child.stdout,stdout],[child.stderr,stderr]])stream.on('data',chunk=>{bytes+=chunk.length;if(bytes>2*1024*1024){overflow=true;child.kill('SIGKILL')}else chunks.push(chunk)})
 const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}))})
 let result
 try{result=await bounded(closed,'actual CLI deadline',20000)}catch(error){child.kill('SIGKILL');await bounded(closed,'actual CLI kill/join',5000);throw error}
 assert.equal(result.signal,null,'actual CLI terminated by signal');assert.equal(overflow,false,'actual CLI output exceeds fixture budget')
 return {...result,stdout:Buffer.concat(stdout).toString(),stderr:Buffer.concat(stderr).toString()}
}
function waitExit(outcome){return outcome.ok?0:({timeout:2,blocked_network:4,provider_unavailable:5,limited:5}[outcome.errorCode]??1)}
function cliJSON(output){try{return JSON.parse(output.stdout)}catch{throw Error('actual CLI did not return one JSON document')}}
function exactWait(output,event,outcome){
 const completion=event.data.completion
 if(completion.unavailable){
  const capacity=completion.unavailable==='capacity'
  assert.equal(output.code,1);assert.equal(output.stdout,'')
  assert.equal(output.stderr,capacity?'pult agent: capacity — completion read capacity reached\n':'pult agent: unavailable — qualified completion is unavailable\n')
 }else{
  assert.equal(output.code,waitExit(outcome));assert.equal(output.stderr,'')
  const expected={name:'subject',status:event.data.status,reason:'matched'}
  for(const [key,value]of Object.entries(completion.outcome))if(value!=='')expected[key]=value
  assert.ok(isDeepStrictEqual(cliJSON(output),expected),'actual CLI exact wait result mismatch')
 }
}
function statusTimeout(output,status){
 assert.equal(output.code,2);assert.equal(output.stderr,'')
 assert.ok(isDeepStrictEqual(cliJSON(output),{name:'subject',status,reason:'timeout'}),'actual CLI status-only timeout differs')
}
async function peerCleanup(x){
 const pids=rows(x.launch).map(r=>r.pid).filter(Number.isInteger);assert.ok(pids.length>0,'no controlled native PID evidence')
 const running=pid=>{try{process.kill(pid,0);return true}catch(error){if(error.code==='ESRCH')return false;throw error}}
 await bounded((async()=>{while(pids.some(running))await pause(10)})(),'controlled native PID survived daemon shutdown',3000)
}
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
  client=await connectClient(x.paths,{timeoutMs:10000})
  if(waitE2E){const owner=client;client={...owner,request:(method,params,options)=>owner.request(method,params,{timeoutMs:10000,...options})}}
  return {client,child,stop:async()=>{client.close();child.kill('SIGTERM');await bounded(exited,'daemon join',10000)}}
 }catch(error){client?.close();if(child.exitCode===null)child.kill('SIGTERM');await bounded(exited,'failed startup join');throw error}
}
let checks=0,complete=false,waitChecks=0,promptChecks=0,unknownChecks=0,restartChecks=0
try{
 for(const provider of ['claude','codex','zcode'])for(const variant of ['divergent','multi','empty','failed','large-escaped',...(provider!=='codex'?['capacity']:[])]){
  if(only&&only!==`${provider}/${variant}`)continue
  if(waitE2E)console.log(`begin wait e2e ${provider}/${variant}`)
  const oracle=await node(provider,variant),x=prepare('rust',provider,variant)
  writeFileSync(join(x.paths.home,'.rust-core-scratch'),'pult-rust-scratch-v1\n',{mode:0o600})
  writeFileSync(join(x.paths.home,'config.json'),JSON.stringify({network:{[provider]:{mode:'off'},guard:{mode:'allow',countries:['FI']}}}),{mode:0o600})
  let running=await daemon(x,provider),receipt,event
  try{
   await running.client.request('agent.start',{kind:provider,name:'subject',cwd:x.cwd,approval:'read-only',...(provider==='codex'?{model:'gpt-6-astra',effort:'low'}:{})})
   receipt=await running.client.request('agent.prompt',{name:'subject',text:'literal final completion qualification'},{timeoutMs:12000})
   // Actual CLI reads the live session before any active-turn polling. Its
   // result must itself cross Driver close/durable completion publication.
   const waited=waitE2E?await cli(x.paths,['wait','subject','--json']):null
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
   if(waitE2E){
    exactWait(waited,event,oracle.outcome);waitChecks++
    assert.equal((await running.client.request('daemon.status')).nativeRuntime.activeTurns,0)
    const unknown=await cli(x.paths,['wait','subject','--until','UNKNOWN','--timeout=0','--json'])
    if(oracle.outcome.ok)statusTimeout(unknown,event.data.status);else exactWait(unknown,event,oracle.outcome)
    unknownChecks++
    if(variant==='divergent'){
     const before=journal.filter(e=>e.kind==='message.user').length
     const prompted=await cli(x.paths,['prompt','subject','literal final completion qualification','--wait','--json'])
     const after=rows(join(x.paths.home,'events/journal.jsonl')),next=after.filter(e=>e.kind==='status.changed').at(-1)
     assert.equal(after.filter(e=>e.kind==='message.user').length,before+1,'prompt --wait duplicated input')
     assert.notEqual(next.data.turnId,receipt.turnId,'prompt --wait returned the prior turn')
     assert.ok(isDeepStrictEqual(next.data.completion.outcome,{...oracle.outcome,turnId:next.data.turnId}),'prompt --wait durable answer mismatch')
     exactWait(prompted,next,oracle.outcome);promptChecks++
     assert.equal((await running.client.request('daemon.status')).nativeRuntime.activeTurns,0)
    }
   }
  }finally{await running.stop();if(waitE2E)await peerCleanup(x)}
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
   if(waitE2E){
    const session=(await running.client.request('agent.list')).sessions.find(s=>s.name==='subject');assert.ok(session)
    statusTimeout(await cli(x.paths,['wait','subject','--until','UNKNOWN','--timeout=0','--json']),session.status)
    assert.equal(rows(x.launch).length,before,'restarted wait replayed native input')
    const status=await running.client.request('daemon.status');assert.equal(status.nativeRuntime.initialized,false);assert.equal(status.nativeRuntime.activeTurns,0)
    restartChecks++
   }
  }finally{await running.stop()}
  checks++;console.log(`pass final completion ${provider}/${variant}, Node comparator + Rust→Node→Rust`)
 }
 console.log(`PASS ${checks} paired actual adapter/daemon cases, ${checks} actual Node rollback roundtrips`);complete=true
 if(waitE2E)console.log(`PASS WAIT E2E ${waitChecks} actual CLI waits, ${promptChecks} prompt --wait, ${unknownChecks} UNKNOWN-zero, ${restartChecks} restart-no-answer`)
}finally{if(complete)rmSync(temp,{recursive:true,force:true});else console.error(`controlled completion scratch retained: ${temp}`)}

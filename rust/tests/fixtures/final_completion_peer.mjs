// Versioned controlled transformer over explicit repository fake peers.
// Synthetic text variants; no model, account, network or real provider CLI.
import {spawn} from 'node:child_process'
import {readFileSync,appendFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createInterface} from 'node:readline'
const root=fileURLToPath(new URL('../../../',import.meta.url))
export function run(provider){
 let cfg={}; try{cfg=JSON.parse(readFileSync(join(process.cwd(),'.wait-text.json'),'utf8'))}catch{}
 const args=process.argv.slice(2), flag=k=>args[args.indexOf(k)+1]
 const sid=provider==='claude'&&(args.includes('--session-id')?flag('--session-id'):args.includes('--resume')?flag('--resume'):null)
 const bin=join(root,'test/fakes',provider==='codex'?'fake-codex-app-server.mjs':`fake-${provider}.mjs`)
 const child=spawn(process.execPath,[bin,...args],{stdio:['pipe','pipe','inherit']})
 let inputUUID; if(provider==='claude'||provider==='codex'){createInterface({input:process.stdin}).on('line',line=>{let frame;try{frame=JSON.parse(line);inputUUID=frame.uuid}catch{};if(provider==='codex'&&frame?.method==='config/read'){output({jsonrpc:'2.0',id:frame.id,result:{config:{sandbox_workspace_write:{network_access:false,writable_roots:[]}}}});return};child.stdin.write(line+'\n')})}else process.stdin.pipe(child.stdin);child.stdin.on('error',()=>{})
 const output=e=>{if(Buffer.byteLength(JSON.stringify(e))>1024*1024)throw Error('controlled source frame exceeds native adapter bound');if(cfg.wire)appendFileSync(cfg.wire,JSON.stringify(e)+'\n');process.stdout.write(JSON.stringify(e)+'\n')}
 createInterface({input:child.stdout}).on('line',line=>{
  let e;try{e=JSON.parse(line)}catch{process.stdout.write(line+'\n');return}
  if(sid&&e.session_id)e.session_id=sid
  if(provider==='claude'&&inputUUID&&e.type==='result')e.user_message_uuids=[inputUUID]
  if(provider==='claude'&&inputUUID&&e.type==='system'&&e.subtype==='init'){output(e);output({type:'command_lifecycle',session_id:e.session_id,command_uuid:inputUUID,state:'started'});return}
  if(cfg.variant!=='corpus'){
   if(provider==='claude'){
    if(e.type==='assistant')for(const b of e.message?.content??[])if(b.type==='text')b.text='CLAUDE_INTERIM_1'
    if(e.type==='result'){
     if(cfg.variant==='multi'||cfg.variant==='child'){
      output({type:'assistant',session_id:e.session_id,parent_tool_use_id:null,uuid:'root-extra-uuid',message:{id:'root-extra',role:'assistant',content:[{type:'text',text:'CLAUDE_INTERIM_2'}]}})
      if(cfg.variant==='child')output({type:'assistant',session_id:e.session_id,parent_tool_use_id:'child-tool-fixture',uuid:'child-uuid',message:{id:'child-extra',role:'assistant',content:[{type:'text',text:'CLAUDE_CHILD_TEXT'}]}})
     }
     e.result=cfg.variant==='empty'?'':cfg.variant==='large-escaped'?'\0'.repeat(100_000):cfg.variant==='capacity'?'\0'.repeat(100_000):'CLAUDE_FINAL_RESULT';if(cfg.variant==='failed'||cfg.variant==='capacity'){e.is_error=true;e.terminal_reason='api_error'}
    }
   }
   if(provider==='zcode'){
    if(e.type==='turn.completed'){
     if(cfg.variant==='failed-ended-cancelled')e.payload.resultType='cancelled'
     e.payload.response=['capacity','failed-capacity'].includes(cfg.variant)?'\0'.repeat(100_000):cfg.variant==='failed-no-text'?'':'ZCODE_INTERIM_1'
     if(cfg.variant.includes('multi')||cfg.variant==='capacity'){output({...e,eventId:'fixture-first-complete'});e={...e,eventId:'fixture-second-complete',payload:{...e.payload,response:cfg.variant==='capacity'?'\0'.repeat(100_000):'ZCODE_INTERIM_2'}}}
    }
    if(e.type==='result'){e.response=cfg.variant.startsWith('empty')||['failed-empty-response','failed-no-text'].includes(cfg.variant)?'':cfg.variant==='large-escaped'||cfg.variant==='failed-capacity'?'\0'.repeat(100_000):cfg.variant==='capacity'?'':'ZCODE_FINAL_RESULT';if(cfg.variant==='failed'||cfg.variant.startsWith('failed-'))e.resultType=cfg.variant==='failed-cancelled'?'cancelled':cfg.variant==='failed-unknown-type'?'fixture_unknown':cfg.variant==='failed-empty-type'?'':'error';if(cfg.variant==='missing-result-type')delete e.resultType}
   }
   if(provider==='codex'){
    if(e.method==='item/completed'&&e.params.item?.type==='agentMessage')e.params.item.text=cfg.variant==='empty'?'':cfg.variant==='large-escaped'?'\0'.repeat(100_000):'CODEX_ITEM_1'
    if(e.method==='turn/completed'){
     if(['multi','duplicate','foreign'].includes(cfg.variant)){
      const base={jsonrpc:'2.0',method:'item/completed',params:{threadId:e.params.threadId,turnId:e.params.turn.id,item:{id:'root-second',type:'agentMessage',text:'CODEX_ITEM_2',phase:'commentary'}}}
      if(cfg.variant!=='foreign')output(base);if(cfg.variant==='duplicate')output(base) // probe actual duplicate semantics without assuming dedup
      if(cfg.variant==='foreign')output({...base,params:{...base.params,threadId:'unrelated-child',item:{...base.params.item,id:'child-item',text:'CODEX_FOREIGN_CHILD'}}})
     }
     if(cfg.variant==='failed'){e.params.turn.status='failed';e.params.turn.error={message:'CODEX_TERMINAL_ERROR',codexErrorInfo:'other'}}
     for(const item of e.params.turn.items??[])if(item.type==='agentMessage')item.text='CODEX_TERMINAL_SUMMARY'
    }
   }
  }
  output(e)
 })
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal))
 child.on('exit',(code,signal)=>{process.stdin.unpipe(child.stdin);process.stdin.pause();process.exitCode=code??(signal?1:0)})
}

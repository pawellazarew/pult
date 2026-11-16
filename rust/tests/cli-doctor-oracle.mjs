// Actual Rust CLI vs actual Node engine and Node file/schema/service bindings.
// Candidate selection and daemon status are injected; no actual Node CLI claim.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {realpathSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {spawn} from 'node:child_process'
const [project,binary]=process.argv.slice(2)
const load=async name=>import(pathToFileURL(join(project,'dist',name)).href)
const {runDoctor,formatDoctor}=await load('env/doctor.js')
const {locateAllAsync}=await load('env/locate.js')
const {layout}=await load('core/paths.js')
const {loadConfig}=await load('core/config.js')
const {setLanguage}=await load('i18n/core.js')
const {execAsync}=await load('env/exec.js')
const {checkCodexSchema}=await load('adapters/codex/schema.js')
const {versionDoctorItems}=await load('update/doctor.js')
const {serviceDoctorItems}=await load('service/doctor.js')
const {browserDoctorItems,mcpDoctorItems,bypassDoctorItems}=await load('mcp/doctor.js')
const {claudeDefaultMode}=await load('mcp/browser.js')
const {checkNetwork}=await load('env/net.js')
const root=await fs.mkdtemp('/tmp/pult-doctor-oracle-')
const scenarios=[{}, {missing:true},{auth:{loggedIn:false},authExit:1},{authRaw:'noise\n{"loggedIn":true,"subscriptionType":"max","authMethod":"claude.ai"}',authExit:1},{authRaw:'unrecognized output',authExit:1},{authRaw:'{"loggedIn":true,"subscriptionType":"person@example.org","authMethod":"claude.ai","\\ud800":1}'},{codexExit:1,codexLine:'Not logged in'},{nodeVersion:'v18.0.0'},{emptySchema:true},{schemaExit:1},{creds:'{"oauth:foo:access_token":null}'},{creds:'{bad'},{toml:'profile="safe"\n[sandbox_workspace_write]\nnetwork_access = true\n[profiles.safe.sandbox_workspace_write]\nnetwork_access = false'},{toml:'default_permissions="x"\n[permissions.x.network]\nunix_sockets={"/tmp/socket" = "write"}'},{toml:'[oops'},{config:{network:{guard:{mode:'allow',countries:[]}}}},{config:{network:{guard:{mode:'deny',countries:[]}}}},{config:{mcp:{servers:['a','missing']}},mcp:{mcpServers:{a:{command:'fake'},invalid:{type:'http'}}},bypass:true},{net:true},{net:true,config:{network:{claude:{mode:'required'},codex:{mode:'auto',proxy:'http://fixture'},opencode:{mode:'required',proxy:'http://fixture'},zcode:{mode:'off'},guard:{mode:'allow',countries:['FI']}}},network:{codex:{proxyExit:7},opencode:{proxyExit:7},zcode:{loc:'RU'}}}]
const run=(args,env)=>new Promise((resolve,reject)=>{const c=spawn(binary,args,{env,stdio:['ignore','pipe','pipe']});let out='',err='';c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);c.on('error',reject);c.on('close',code=>resolve({code,out,err}))})
let cases=0
try{for(const [index,s]of scenarios.entries())for(const language of ['ru','en']){
 const home=join(root,`c${index}-${language}`),user=join(root,`u${index}-${language}`),bin=join(home,'fakebin');for(const p of [home,user,bin,join(home,'run'),join(home,'logs'),join(home,'events'),join(home,'service')])await fs.mkdir(p,{mode:0o700})
 await fs.writeFile(join(home,'.rust-core-scratch'),'pult-rust-scratch-v1\n',{mode:0o600})
 await fs.writeFile(join(home,'scenario.json'),JSON.stringify(s),{mode:0o600})
 await fs.writeFile(join(home,'config.json'),JSON.stringify(s.config??{}),{mode:0o600})
 for(const name of ['claude','codex','opencode','zcode','git','gh','node','npm','curl'])if(!s.missing||name==='curl'){await fs.copyFile(join(project,'rust/tests/fixtures/doctor_tool.py'),join(bin,name));await fs.chmod(join(bin,name),0o700)}
 if(s.creds)await fs.writeFile(join(home,'zcode-credentials.json'),s.creds,{mode:0o600})
 if(s.toml)await fs.writeFile(join(home,'codex-config.toml'),s.toml,{mode:0o600})
 if(s.mcp)await fs.writeFile(join(home,'claude.json'),JSON.stringify(s.mcp),{mode:0o600})
 if(s.bypass)await fs.writeFile(join(home,'claude-settings.json'),'{"permissions":{"defaultMode":"bypassPermissions"}}',{mode:0o600})
 const env={HOME:user,USER:'fixture',PATH:bin,LANG:'en_US.UTF-8',PULT_LANG:language,PULT_TEST:'1',PULT_SERVICE_PLATFORM:'darwin',PULT_SERVICE_DIR:join(home,'service'),PULT_TEST_DOCTOR_PATH:bin,PULT_TEST_DOCTOR_CURL:join(bin,'curl')}
 const actual=await run(['--home',home,'doctor','--json',...s.net?[]:['--no-net']],env)
 assert.notEqual(actual.code,130,actual.err);assert(actual.out,actual.err)
 const got=JSON.parse(actual.out)
 Object.assign(process.env,env);setLanguage(language);const paths=layout(home),config=loadConfig(paths.config).config
 const native=(file,args,timeoutMs)=>execAsync(file,args,{timeoutMs,env:{HOME:user,USER:'fixture',PATH:bin,LANG:'en_US.UTF-8'}})
 const tools=await locateAllAsync({home:user,pathEntries:[bin],isExec:p=>p.startsWith(bin+'/')&&!s.missing,realpath:realpathSync,runAsync:(p,a)=>native(p,a,30000)})
 const report=await runDoctor({paths,config,nodeVersion:s.missing?'unknown':s.nodeVersion??'v24.21.0',pathEntries:[bin],home:user,locate:async()=>tools,run:native,skipNet:!s.net,zcodeCreds:()=>join(home,'zcode-credentials.json'),codexConfig:join(home,'codex-config.toml'),codexSchema:bin=>checkCodexSchema({bin,workDir:join(home,'run/codex-schema'),run:native}),daemonStatus:async()=>null,versionItems:st=>versionDoctorItems(paths,st),serviceItems:()=>serviceDoctorItems(paths,env),mcpItems:async st=>[...browserDoctorItems({paths,wanted:null,chrome:null}),...await mcpDoctorItems(join(home,'claude.json'),config.mcp.servers),...bypassDoctorItems(claudeDefaultMode([join(home,'claude-settings.json')]),0)],net:provider=>checkNetwork(provider,config.network[provider],config.guard,{fresh:true,probe:async(url,proxy,timeoutMs)=>execAsync(join(bin,'curl'),['-q','-s','-m','8','-x',proxy??'',url],{timeoutMs,env:{HOME:user,USER:'fixture',PATH:bin,PULT_DIAGNOSTIC_PROVIDER:provider}})})})
 // Explicit D1 profile: Rust selects a dependency; Node reports its own host.
 delete got.items[0].data
 function normalize(r){r=structuredClone(r);r.generatedAt='time';for(const i of r.items){if(i.id.startsWith('net.')){i.data.ms=0;i.data.checkedAt='time';i.detail=i.detail.replace(/, \d+ мс/,', 0 мс')}}return r}
 try{assert.deepEqual(normalize(got),normalize(report))}catch(e){await fs.writeFile(join(root,'actual.json'),JSON.stringify(got,null,2));await fs.writeFile(join(root,'expected.json'),JSON.stringify(report,null,2));throw new Error(`case ${index}/${language}: ${e.message}\n${root}`,{cause:e})}
 const text=await run(['--home',home,'doctor',...s.net?[]:['--no-net']],env);assert.equal(text.code,actual.code);if(!s.net){let expected=formatDoctor(report)+'\n';if(s.missing)expected=expected.replace(/^\[FAIL\] Node:.*$/m,`[FAIL] Node: ${got.items[0].detail}`);assert.equal(text.out,expected)}cases++
}console.log(JSON.stringify({scope:'actual Rust CLI bindings vs actual Node engine; isolated Node FS/schema/service bindings, injected locate/daemon/network probe',cases}))}finally{if(process.env.KEEP_DOCTOR_ORACLE!=='1')await fs.rm(root,{recursive:true,force:true})}

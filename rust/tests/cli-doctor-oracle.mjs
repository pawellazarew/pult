// Actual Rust CLI vs actual Node engine and Node file/schema/service bindings.
// Candidate selection and daemon status are injected; no actual Node CLI claim.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {realpathSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {spawn} from 'node:child_process'
import net from 'node:net'
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
scenarios.push(
 {config:{network:{claude:{noProxy:["xx\ud800 yy"]},guard:{mode:"allow",countries:["\ud800","FI"]}}}},
 {config:{network:{claude:{mode:"required"}},extension:JSON.parse("[".repeat(256)+"0"+"]".repeat(256))}},
 {config:{network:{claude:{mode:"\ud800"}}}},
 {profileDynamic:"update",daemon:{version:"0.0.1",pid:42,uptimeMs:1550,lastEventId:7,update:{error:"fixture😀\ud800",checkedAt:"fixture\udfff"}}},
 {profileDynamic:"proxy",net:true,config:{network:{claude:{mode:"required",proxy:"http://fixture/\ud800"}}}},
 {authRaw:'{"loggedIn":true,"unused":'+'['.repeat(256)+'0'+']'.repeat(256)+'}'},
 {codexLine:"x".repeat(159)+"😀"},
 {codexLine:"\"\\\\n"+"x".repeat(154)+"😀"},
 {configRaw:'{"network":{"claude":{"proxy":"http://user:canary-malformed-secret@example.invalid"'},
 {configRaw:'42'},
 {config:{language:'invalid',network:{claude:{proxy:' ',mode:'bad',noProxy:['ok','bad host',42]},codex:{mode:'auto'},opencode:{mode:'required'},zcode:null},guardCountries:42,autoTitle:'x',notify:{sound:42,minTurnSeconds:-1},notifyCommand:42,watchdog:{silenceMinutes:-1},mcp:{servers:['a','a','bad name']},updates:{check:42,url:'http://invalid'},disk:42,attachments:{retentionDays:3},warmTtlMs:-1}},
 {config:{guardCountries:['RU'],network:{guard:{mode:'ALLOW',countries:['fi','bad',42,'fi']}}}},
 {config:{newSession:{rememberLast:'x',defaults:{provider:'opencode',claude:{model:'bad name',effort:42,approval:'full',mode:'bad',browser:42,worktree:42},codex:{approval:'workspace',browser:true},zcode:{browser:true}}}}},
 {config:{network:{guard:{mode:'bad',countries:[]}}}},
 {service:'darwin'}, {service:'darwin',stoppedService:true,serviceExit:78},
 {service:'linux',linger:'no'}, {service:'darwin',foreignService:true},
 {current:'dangling'}, {current:'dev'}, {current:'dev',interrupted:true},
 {daemon:{unused:{['\ud800']:'ignored'},unusedDeep:JSON.parse('['.repeat(256)+'0'+']'.repeat(256)),version:'0.0.1',pid:42,uptimeMs:1550,lastEventId:7,node:{path:'/fixture/node',version:'v24.21.0',alive:false,own:false},browser:{sessions:2},update:{error:'fixture channel error',checkedAt:'fixture-time'}}},

)

const run=(args,env)=>new Promise((resolve,reject)=>{const c=spawn(binary,args,{env,stdio:['ignore','pipe','pipe']});let out='',err='';c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);c.on('error',reject);c.on('close',code=>resolve({code,out,err}))})
let cases=0,complete=false,currentCase=null
try{for(const [index,s]of scenarios.entries())for(const language of ['ru','en']){
 const home=join(root,`c${index}-${language}`),user=join(root,`u${index}-${language}`),bin=join(home,'fakebin');for(const p of [home,user,bin,join(home,'run'),join(home,'logs'),join(home,'events'),join(home,'service')])await fs.mkdir(p,{mode:0o700})
 await fs.writeFile(join(home,'.rust-core-scratch'),'pult-rust-scratch-v1\n',{mode:0o600})
 await fs.writeFile(join(home,'scenario.json'),JSON.stringify(s),{mode:0o600})
 await fs.writeFile(join(home,'config.json'),s.configRaw??JSON.stringify(s.config??{}),{mode:0o600})
 for(const name of ['claude','codex','opencode','zcode','git','gh','node','npm','curl','launchctl','systemctl','loginctl'])if(!s.missing||name==='curl'){await fs.copyFile(join(project,'rust/tests/fixtures/doctor_tool.py'),join(bin,name));await fs.chmod(join(bin,name),0o700)}
 if(s.creds)await fs.writeFile(join(home,'zcode-credentials.json'),s.creds,{mode:0o600})
 if(s.toml)await fs.writeFile(join(home,'codex-config.toml'),s.toml,{mode:0o600})
 if(s.mcp)await fs.writeFile(join(home,'claude.json'),JSON.stringify(s.mcp),{mode:0o600})
 if(s.bypass)await fs.writeFile(join(home,'claude-settings.json'),'{"permissions":{"defaultMode":"bypassPermissions"}}',{mode:0o600})
 const env={HOME:user,USER:'fixture',PATH:bin,LANG:'en_US.UTF-8',PULT_LANG:language,PULT_TEST:'1',PULT_SERVICE_PLATFORM:s.service??'darwin',PULT_LAUNCHCTL:join(bin,'launchctl'),PULT_SYSTEMCTL:join(bin,'systemctl'),PULT_LOGINCTL:join(bin,'loginctl'),PULT_TEST_DOCTOR_LOGINCTL:join(bin,'loginctl'),PULT_SERVICE_DIR:join(home,'service'),PULT_TEST_DOCTOR_PATH:bin,PULT_TEST_DOCTOR_CURL:join(bin,'curl')}

 if(s.service){
  const launcher=join(bin,'node');const foreign=s.foreignService?user:home
  const body=s.service==='linux'?`[Service]\nEnvironment="PULT_HOME=${foreign}"\nExecStart="${launcher}"\n`:`<plist><dict><key>EnvironmentVariables</key><dict><key>PULT_HOME</key><string>${foreign}</string></dict><key>ProgramArguments</key><array><string>${launcher}</string></array></dict></plist>`
  await fs.writeFile(join(home,'service',s.service==='linux'?'pultd.service':'dev.pult.daemon.plist'),body,{mode:0o600});await fs.writeFile(join(home,'node-path'),launcher+'\n',{mode:0o600})
 }
 if(s.current){await fs.mkdir(join(home,'versions'),{mode:0o700});await fs.symlink('versions/1.2.3',join(home,'current'));if(s.current==='dev'){await fs.mkdir(join(home,'versions/1.2.3'),{mode:0o700});await fs.writeFile(join(home,'versions/1.2.3/package.json'),'{{"name":"pult","version":"1.2.3"}}'.slice(1,-1),{mode:0o600});await fs.writeFile(join(home,'update.json'),JSON.stringify({current:'1.2.3',previous:'1.0.0',bad:['0.1.0'],last:s.interrupted?{result:'failed',version:'1.2.3',message:'проба идёт (прервана?)',at:'fixture-time'}:null}),{mode:0o600})}}
 let server
 if(s.daemon){await fs.writeFile(join(home,'run/token'),'a'.repeat(64),{mode:0o600});server=net.createServer(socket=>{let data='';socket.on('data',chunk=>{data+=chunk;let i;while((i=data.indexOf('\n'))>=0){const line=data.slice(0,i);data=data.slice(i+1);const request=JSON.parse(line);if(request.type==='hello')socket.write(JSON.stringify({type:'hello_ok',protocol:1})+'\n');else {assert.equal(request.method,'daemon.status');socket.write(JSON.stringify({id:request.id,result:s.daemon})+'\n')}}})});await new Promise(r=>server.listen(join(home,'run/pultd.sock'),r));await fs.chmod(join(home,'run/pultd.sock'),0o600)}
 currentCase={index,language,phase:'rust-json'}
 const actual=await run(['--home',home,'doctor','--json',...s.net?[]:['--no-net']],env)
 assert.notEqual(actual.code,130,`case ${index}/${language}: ${actual.err}`);assert(actual.out,`case ${index}/${language}: ${actual.err}`)
 const got=JSON.parse(actual.out)
 Object.assign(process.env,env);setLanguage(language);const paths=layout(home),loaded=loadConfig(paths.config),config=loaded.config
 const native=(file,args,timeoutMs)=>execAsync(file,args,{timeoutMs,env:{HOME:user,USER:'fixture',PATH:bin,LANG:'en_US.UTF-8'}})
 const tools=await locateAllAsync({home:user,pathEntries:[bin],isExec:p=>p.startsWith(bin+'/')&&!s.missing,realpath:realpathSync,runAsync:(p,a)=>native(p,a,30000)})
 const report=await runDoctor({paths,config,nodeVersion:s.missing?'unknown':s.nodeVersion??'v24.21.0',pathEntries:[bin],home:user,locate:async()=>tools,run:native,skipNet:!s.net,zcodeCreds:()=>join(home,'zcode-credentials.json'),codexConfig:join(home,'codex-config.toml'),codexSchema:bin=>checkCodexSchema({bin,workDir:join(home,'run/codex-schema'),run:native}),daemonStatus:async()=>s.daemon??null,versionItems:st=>versionDoctorItems(paths,st),serviceItems:()=>serviceDoctorItems(paths,env),mcpItems:async st=>[...browserDoctorItems({paths,wanted:st?.browser?.sessions??null,chrome:null}),...await mcpDoctorItems(join(home,'claude.json'),config.mcp.servers),...bypassDoctorItems(claudeDefaultMode([join(home,'claude-settings.json')]),s.daemon?.browser?.sessions??0)],net:provider=>checkNetwork(provider,config.network[provider],config.guard,{fresh:true,probe:async(url,proxy,timeoutMs)=>execAsync(join(bin,'curl'),['-q','-s','-m','8','-x',proxy??'',url],{timeoutMs,env:{HOME:user,USER:'fixture',PATH:bin,PULT_DIAGNOSTIC_PROVIDER:provider}})})})
 const normalizeWarning=w=>w.replace(/^config.json не разбирается \([\s\S]*\) — взяты значения по умолчанию$/, 'config.json не разбирается (invalid JSON) — взяты значения по умолчанию')
 assert.equal(actual.err,loaded.warnings.map(w=>'config: '+normalizeWarning(w)+'\n').join(''))
 if(s.configRaw?.includes('canary'))assert(!actual.out.includes('canary')&&!actual.err.includes('canary'))
 // Explicit D1 profile: Rust selects a dependency; Node reports its own host.
 delete got.items[0].data
 function normalize(r){r=structuredClone(r);r.generatedAt='time';for(const i of r.items){if(i.id.startsWith('net.')){i.data.ms=0;i.data.checkedAt='time';i.detail=i.detail.replace(/, \d+ мс/,', 0 мс')}}return r}
 // Explicit diagnostic display profile, only the documented source fields.
 if(s.profileDynamic==='update'){const i=report.items.find(i=>i.id==='update.channel');i.detail=Buffer.from(i.detail).toString();i.data.checkedAt=Buffer.from(i.data.checkedAt).toString()}
 if(s.profileDynamic==='proxy'){const i=report.items.find(i=>i.id==='net.claude');i.detail=Buffer.from(i.detail).toString()}
 try{assert.deepEqual(normalize(got),normalize(report))}catch(e){await fs.writeFile(join(root,'actual.json'),JSON.stringify(got,null,2));await fs.writeFile(join(root,'expected.json'),JSON.stringify(report,null,2));throw new Error(`case ${index}/${language}: ${e.message}\n${root}`,{cause:e})}
 currentCase={index,language,phase:'rust-text'}
 const text=await run(['--home',home,'doctor',...s.net?[]:['--no-net']],env);assert.equal(text.code,actual.code);if(!s.net){let expected=Buffer.from(formatDoctor(report)+'\n').toString();if(s.missing)expected=expected.replace(/^\[FAIL\] Node:.*$/m,`[FAIL] Node: ${got.items[0].detail}`);assert.equal(text.out,expected)}if(server)await new Promise(r=>server.close(r));cases++
}complete=true;console.log(JSON.stringify({scope:'actual Rust CLI bindings vs actual Node engine; isolated Node FS/schema/service bindings, injected locate/daemon/network probe',cases}))}catch(error){await fs.writeFile(join(root,'failed-case.json'),JSON.stringify(currentCase));throw error}finally{if(complete&&process.env.KEEP_DOCTOR_ORACLE!=='1')await fs.rm(root,{recursive:true,force:true});else console.error(`doctor oracle diagnostic scratch retained: ${root}`)}

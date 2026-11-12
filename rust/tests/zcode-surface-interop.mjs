// Actual built Node modules only. Fixed corpus, no provider/account/process CLI.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
if (!process.version.startsWith('v24.')) throw new Error('Node24 oracle required')
const root=resolve(import.meta.dirname,'../..')
const {createZcodeMapper}=await import(pathToFileURL(resolve(root,'dist/adapters/zcode/mapper.js')).href)
const {buildZcodeArgv}=await import(pathToFileURL(resolve(root,'dist/adapters/zcode/argv.js')).href)
const {approvalContext}=await import(pathToFileURL(resolve(root,'dist/adapters/approvalContext.js')).href)
const {setLanguage}=await import(pathToFileURL(resolve(root,'dist/i18n/core.js')).href)
const raw=readFileSync(0)
if(raw.length>2*1024*1024) throw new Error('oracle input budget')
const input=JSON.parse(raw)
let output
if(input.kind==='events') {
 const mapper=createZcodeMapper({sessionId:'trusted'})
 output=input.frames.map(frame=>mapper.push(frame))
}else if(input.kind==='env') {
 const {zcodeExtraEnv}=await import(pathToFileURL(resolve(root,'dist/adapters/zcode/adapter.js')).href)
 output=input.cases.map(c=>zcodeExtraEnv(c))
}else{
 output=input.cases.map(c=>{setLanguage(c.language??'ru');return{argv:buildZcodeArgv(c),context:approvalContext('zcode',c.approval,c.broker)}})
}
const data=JSON.stringify(output)
if(Buffer.byteLength(data)>8*1024*1024)throw new Error('oracle output budget')
process.stdout.write(data)

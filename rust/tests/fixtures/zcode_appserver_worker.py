#!/usr/bin/python3
"""Controlled native peer; never a real ZCode/account/model invocation."""
import json, os, sys, time, subprocess
from pathlib import Path
home=Path(os.environ['HOME']); mode=Path(sys.argv[0]).name.removeprefix('native-')
assert sys.argv[1:]==['app-server','--stdio']
assert 'PULT_MEMORY_KEY' not in os.environ
(home/'provider.pid').write_text(str(os.getpid()))
if mode=='descendant':
    child=subprocess.Popen([sys.executable,'-c','import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)'])
    (home/'descendant.pid').write_text(str(child.pid))
def proof(**v):
    with (home/'proof.jsonl').open('a') as f:f.write(json.dumps(v)+'\n')
def out(v):print(json.dumps(v,separators=(',',':')),flush=True)
def read():
    line=sys.stdin.readline()
    if not line:sys.exit(0)
    return json.loads(line)
def event(kind,payload):
    global seq
    seq+=1
    out({'method':'session/event','params':{'eventId':'event-'+str(seq),'sessionId':sid,'turnId':'native-turn','seq':seq,'timestamp':seq,'type':kind,'payload':payload}})
def wait(name):
    (home/(name+'.entered')).touch()
    while not (home/(name+'.release')).exists():time.sleep(.005)
sid=None;workspace=None;native_mode='plan';seq=0
while True:
    r=read(); method=r.get('method');p=r.get('params',{});proof(method=method)
    if method in ('session/create','session/resume'):
        sid=p['sessionId'];workspace=p['workspace'];native_mode=p.get('mode','plan')
        servers=p['mcpServers'];assert servers and servers[0]['command'].endswith('pult-memory-mcp')
        assert servers[0]['isolation']=='session';assert isinstance(servers[0]['env'],list)
        private_key=next(e['value'] for e in servers[0]['env'] if e['name']=='PULT_MEMORY_KEY')
        if mode=='blocked-bootstrap':wait('bootstrap')
        if mode=='resume-unavailable':out({'id':r['id'],'error':{'code':-32004,'message':'unavailable'}});continue
        out({'id':'native-prefs','method':'session/requestRuntimePreferences','params':{'sessionId':sid,'scope':'runtime-materialization'}})
        reply=read();assert reply['id']=='native-prefs' and reply['result']['memoryEnabled'] is False
        proof(safe_prefs=True)
    elif method=='session/setMode':native_mode=p['mode']
    elif method=='session/subscribe':
        out({'id':r['id'],'result':{'sessionId':sid,'eventSeq':seq,'events':[]}})
        if mode=='blocked-input':wait('write')
        continue
    elif method=='session/send':
        record=json.loads((home/'sessions.json').read_text())['sessions'][0]
        proof(send_marker_present='zcodePendingInput' in record,sid_durable=record.get('providerSessionId')==sid,content_ok=p['content'].startswith('literal user input'),native_mode=native_mode)
        started={'turnNumber':1,'input':p['content'],'inputId':p['inputId'],'queryId':p['queryId']}
        ack={'id':r['id'],'result':{'sessionId':sid,'accepted':True,'stateRevision':9}}
        if mode=='wrong-ack':ack['id']='wrong-id'
        if mode=='missing-start-id':started.pop('inputId')
        if mode=='event-first' or mode=='event-first-hold':
            event('turn.started',started)
            if mode.endswith('hold'):wait('ack')
            out(ack)
        else:
            out(ack)
            if mode=='ack-first-hold':wait('start')
            if mode!='ack-only':event('turn.started',started)
        if mode in ('ack-only','missing-start-id','wrong-ack'):wait('never')
        if mode=='duplicate-wire':
            sys.stdout.write('{"method":"session/event","method":"session/event","params":{}}\n');sys.stdout.flush();wait('never')
        if mode=='blocked-running':wait('running')
        if mode=='event-flood':
            wait('flood')
            for i in range(500):event('model.streaming',{'kind':'text_delta','delta':'bounded-event'})
            wait('never')
        if mode=='reverse-running':
            wait('reverse-running')
            out({'id':'running-prefs','method':'session/requestRuntimePreferences','params':{'sessionId':sid,'scope':'runtime-materialization'}})
            wait('never')
        event('model.streaming',{'kind':'text_delta','delta':private_key if mode=='reflect-key' else 'hello from native'})
        if mode=='finish-only':event('model.streaming',{'kind':'finish','done':True});sys.exit(0)
        terminal={'response':private_key if mode=='reflect-key' else 'hello from native','tokenCount':1,'toolCallCount':0,'duration':1,'inputId':p['inputId'],'resultType':'success'}
        if mode=='malformed-terminal':terminal.pop('resultType')
        if mode=='failed-terminal':event('turn.failed',{'error':{'type':'fixture','message':'failure'},'turnPhase':'execute','inputId':p['inputId']})
        else:event('turn.completed',terminal)
        continue
    elif method=='session/close':(home/'closed.entered').touch();out({'id':r['id'],'result':{'closed':True}});sys.exit(0)
    else:raise AssertionError('unexpected host method')
    out({'id':r['id'],'result':{'protocol':{'name':'ZCode Protocol','version':1},'session':{'sessionId':sid,'workspace':workspace,'sessionKind':'interactive','title':'','mode':native_mode,'status':'idle','createdAt':1,'updatedAt':2},'settings':{},'projection':{'sessionId':sid},'runtime':{'eventSeq':seq,'stateRevision':7,'pendingRequestIds':[]},'messages':([{'opaqueHistory':'h'*(3*1024*1024)}] if mode=='large-snapshot' else [])}})

import {test,TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createApp} from '../src/app.js';
import {Store} from '../src/store.js';
import {Retrieval} from '../src/service.js';
import {Executor} from '../src/executor.js';
import {ruleSchema,lookupSchema,ServiceError} from '../src/contracts.js';
import {log,errorFields,withLogContext} from '../src/log.js';
import {stubClassifier} from './helpers/classifier.js';

type Record= {event:string;[key:string]:unknown};
function capture(t:TestContext,onRecord?:(record:Record)=>void){
  const previous=process.env.LOG_LEVEL;process.env.LOG_LEVEL='debug';
  t.after(()=>{if(previous===undefined)delete process.env.LOG_LEVEL;else process.env.LOG_LEVEL=previous;});
  const records:Record[]=[];
  for(const method of ['log','warn','error'] as const)t.mock.method(console,method,(line:string)=>{const record=JSON.parse(line) as Record;records.push(record);onRecord?.(record);});
  return records;
}
const rule=ruleSchema.parse({providerUid:'provider',purpose:'LOGIN',version:1,senders:['sender@example.test'],subjectMode:'exact',subject:'Login code'});
const input=(attemptUid:string,email='target@example.test')=>lookupSchema.parse({requestUid:'request-'+attemptUid,attemptUid,providerUid:'provider',accountUid:'account-'+attemptUid,targetEmail:email,purpose:'LOGIN',ruleVersion:1,windowStartedAt:Math.floor(Date.now()/1000)-1,lookupDeadlineAt:Math.floor(Date.now()/1000)+30,otpValiditySeconds:300});

test('JSON logger preserves async context, filters levels and excludes sensitive values',async(t)=>{
  const records=capture(t);
  await withLogContext({attemptUid:'attempt'},async()=>{await Promise.resolve();log('info','test_event',{token:'bearer-secret',body:'OTP 654321',email:'private@example.test',sourceMessageRef:'gmail:private@example.test',detail:'private@example.test'});});
  assert.equal(records[0].attemptUid,'attempt');assert.equal(records[0].level,'info');assert.ok(!Number.isNaN(Date.parse(String(records[0].timestamp))));
  for(const secret of ['bearer-secret','654321','private@example.test'])assert.equal(JSON.stringify(records).includes(secret),false);
  process.env.LOG_LEVEL='warn';log('info','filtered');log('warn','visible');assert.equal(records.length,2);assert.equal(records[1].event,'visible');
  delete process.env.LOG_LEVEL;log('debug','default-debug');assert.equal(records.at(-1)?.event,'default-debug');
  process.env.LOG_LEVEL='__proto__';log('debug','fallback-debug');assert.equal(records.at(-1)?.event,'fallback-debug');
  assert.equal(errorFields(new Error('DO_NOT_LOG_THIS_SECRET')).errorCode,'INTERNAL_ERROR');
  assert.equal(errorFields(new Error('secret email private@example.test OTP 654321')).errorCode,'INTERNAL_ERROR');
  assert.equal(errorFields(Object.assign(new Error('private path'),{code:'EADDRINUSE'})).errorCode,'EADDRINUSE');
  assert.equal(errorFields(new ServiceError(503,'PROFILE_BUSY')).errorCode,'PROFILE_BUSY');
});

test('queued HTTP lookups retain their own correlation IDs through classification, persistence and cleanup',async(t)=>{
  const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
  const queued=deferred(),started=deferred(),release=deferred();
  const records=capture(t,record=>{if(record.event==='executor_queued')queued.resolve();});
  const store=new Store(':memory:',randomBytes(32));t.after(()=>store.close());
  const first=store.createProfile('first@example.test',resolve('log-first')),second=store.createProfile('second@example.test',resolve('log-second'));
  store.enable(first.uid);store.enable(second.uid);store.syncRule(rule);store.activate('provider','LOGIN',1);
  const service=new Retrieval(store,{read:async(profile)=>{if(profile.uid===first.uid){started.resolve();await release.promise;}return [{ref:'gmail:private-message@example.test',sender:'sender@example.test',subject:'Login code',body:'Your sign-in code is 654321. private-body@example.test',receivedAt:Math.floor(Date.now()/1000)}];},close:async()=>{}},new Executor(1),5,false,false,stubClassifier());
  const token='logging-test-bearer-0123456789',server=createApp(service,token).listen(0,'127.0.0.1');
  await new Promise<void>(r=>server.once('listening',r));t.after(()=>server.close());
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const call=(uid:string,email:string)=>fetch(base+'/v1/lookups',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':uid},body:JSON.stringify(input(uid,email))});
  const a=call('first','first@example.test');await started.promise;
  const b=call('second','second@example.test');await queued.promise;release.resolve();
  const responses=await Promise.all([a,b]);
  for(let i=0;i<2;i++){
    assert.equal(responses[i].status,200);assert.equal((await responses[i].json()).code,'654321');
    const uid=i===0?'first':'second',requestId=responses[i].headers.get('x-request-id');assert.ok(requestId);
    for(const event of ['lookup_started','executor_started','lookup_poll_completed','lookup_candidate_selected','lookup_result_persisted','lookup_cleanup_completed','executor_finished','lookup_completed']){
      const row=records.find(record=>record.event===event&&record.attemptUid===uid);assert.ok(row,event+' '+uid);assert.equal(row.httpRequestId,requestId);
    }
    assert.ok(records.some(record=>record.event==='http_request_completed'&&record.httpRequestId===requestId&&record.route==='/v1/lookups'&&record.status===200));
  }
  const text=JSON.stringify(records);for(const secret of [token,'654321','first@example.test','second@example.test','private-body@example.test','private-message@example.test','Your sign-in code'])assert.equal(text.includes(secret),false,secret);
});

test('early HTTP rejection and failed lookups log safe reasons without raw URLs or payloads',async(t)=>{
  const records=capture(t),store=new Store(':memory:',randomBytes(32));t.after(()=>store.close());
  const service=new Retrieval(store,{read:async()=>[],close:async()=>{}}),token='logging-test-bearer-0123456789',server=createApp(service,token).listen(0,'127.0.0.1');
  await new Promise<void>(r=>server.once('listening',r));t.after(()=>server.close());
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  assert.equal((await fetch(base+'/private@example.test?token=url-secret',{headers:{authorization:'Bearer wrong-secret'}})).status,401);
  assert.equal((await fetch(base+'/v1/lookups',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:'{"token":"body-secret",'})).status,400);
  await assert.rejects(service.lookup(input('missing')),/ACCOUNT_NOT_CONFIGURED/);
  process.env.LOG_LEVEL='info';const health=await fetch(base+'/health/live',{headers:{authorization:'Bearer '+token}});assert.equal(health.status,200);
  assert.equal(records.some(row=>row.httpRequestId===health.headers.get('x-request-id')),false);
  assert.ok(records.some(row=>row.event==='http_request_rejected'&&row.errorCode==='UNAUTHORIZED'));
  assert.ok(records.some(row=>row.event==='http_request_failed'&&row.status===400));
  assert.ok(records.some(row=>row.event==='lookup_failed'&&row.attemptUid==='missing'&&row.errorCode==='ACCOUNT_NOT_CONFIGURED'&&typeof row.durationMs==='number'));
  for(const secret of ['private@example.test','url-secret','wrong-secret','body-secret'])assert.equal(JSON.stringify(records).includes(secret),false);
});

test('debug poll reports rejection reasons without message contents or captures',async(t)=>{
  const records=capture(t),store=new Store(':memory:',randomBytes(32));t.after(()=>store.close());
  const profile=store.createProfile('target@example.test',resolve('log-reasons'));store.enable(profile.uid);store.syncRule(rule);store.activate('provider','LOGIN',1);
  const now=Math.floor(Date.now()/1000);
  const messages=[
   {ref:'private-ref',sender:'spoof@example.test',subject:'Login code',body:'Your sign-in code is 654321',receivedAt:now},
   {ref:'expired-ref',sender:'sender@example.test',subject:'Login code',body:'Your sign-in code is 654321',receivedAt:now,expiresAt:now-1},
   {ref:'excluded-ref',sender:'sender@example.test',subject:'Login code',body:'Your sign-in code is 654321',receivedAt:now},
   {ref:'empty-ref',sender:'sender@example.test',subject:'Login code',body:'...',receivedAt:now}
  ];
  const service=new Retrieval(store,{read:async()=>messages,close:async()=>{}},undefined,20,false,false,stubClassifier());
  const input=lookupSchema.parse({requestUid:'r',attemptUid:'reasons',providerUid:'provider',accountUid:'c',targetEmail:profile.email,purpose:'LOGIN',ruleVersion:1,windowStartedAt:now-1,lookupDeadlineAt:now+1,otpValiditySeconds:300,excludedSourceMessageRefs:['excluded-ref']});
  try{await assert.rejects(service.lookup(input),/TIMEOUT/);}finally{await service.shutdown();}
  const waiting=records.find(row=>row.event==='lookup_waiting_for_mail');
  assert.ok(waiting);assert.equal(waiting.rejectedBy,'SENDER_MISMATCH:1|EXPIRED:1');assert.equal(waiting.skippedCount,1);
  for(const secret of ['654321','private-ref','expired-ref','excluded-ref','empty-ref','spoof@example.test','Login code'])assert.equal(JSON.stringify(records).includes(secret),false);
});

test('timeout, cancellation and cleanup failure emit terminal reasons without reporting successful completion',async(t)=>{
  const records=capture(t);
  for(const failure of ['TIMEOUT','LOOKUP_CANCELLED','PROFILE_CLEANUP_FAILED']){
    const store=new Store(':memory:',randomBytes(32));
    let started!:()=>void;const reading=new Promise<void>(r=>{started=r;});
    try{
      const profile=store.createProfile('target@example.test',resolve('log-failure-'+failure));store.enable(profile.uid);store.syncRule(rule);store.activate('provider','LOGIN',1);
      const service=new Retrieval(store,{read:async(_p,_i,_r,signal)=>{
        if(failure==='TIMEOUT')throw new ServiceError(504,'TIMEOUT');
        if(failure==='LOOKUP_CANCELLED'){started();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new ServiceError(409,'LOOKUP_CANCELLED')),{once:true}));}
        return [{ref:'private-ref',sender:'sender@example.test',subject:'Login code',body:'Your sign-in code is 654321',receivedAt:Math.floor(Date.now()/1000)}];
      },close:async()=>{if(failure==='PROFILE_CLEANUP_FAILED')throw Error('secret cleanup details');}},undefined,2000,false,false,stubClassifier());
      const request=input(failure),result=assert.rejects(service.lookup(request),new RegExp(failure));
      if(failure==='LOOKUP_CANCELLED'){await reading;await service.cancel(request.attemptUid,request.lookupDeadlineAt);}
      await result;
      assert.ok(records.some(row=>row.event==='lookup_failed'&&row.attemptUid===failure&&row.errorCode===failure));
      assert.equal(records.some(row=>row.event==='lookup_completed'&&row.attemptUid===failure),false);
      if(failure==='PROFILE_CLEANUP_FAILED'){assert.equal(service.executor.stats().quarantined,1);assert.ok(records.some(row=>row.event==='lookup_cleanup_failed'&&row.attemptUid===failure));}
    }finally{store.close();}
  }
  for(const secret of ['654321','target@example.test','secret cleanup details'])assert.equal(JSON.stringify(records).includes(secret),false);
});

test('server logs safe startup failures to stderr',()=>{
  const args=import.meta.url.endsWith('.ts')?['--import',import.meta.resolve('tsx'),resolve('src/server.ts')]:[resolve('dist/src/server.js')];
  const env={...process.env,OTP_STATE_DB:':memory:',OTP_RETRIEVAL_KEY:randomBytes(32).toString('base64'),OTP_RETRIEVAL_TOKEN:'startup-test-token-0123456789',OTP_BIND_HOST:'127.0.0.1',PORT:'0',MAX_ACTIVE_BROWSERS:'1',LOG_LEVEL:'info',LLM_ENDPOINT:'http://127.0.0.1:1',API_KEY:'test-key',MODEL:'test-model'};
  const failed=spawnSync(process.execPath,args,{env:{...env,OTP_RETRIEVAL_KEY:'bad'},encoding:'utf8',timeout:10000});
  assert.equal(failed.status,1);assert.equal(failed.stdout,'');
  assert.ok(failed.stderr.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line)).some(row=>row.event==='service_startup_failed'&&row.errorCode==='INVALID_ENCRYPTION_KEY'&&row.stage==='state'));
});

test('server logs graceful lifecycle events to stderr',{skip:process.platform==='win32'},async(t)=>{
  const args=import.meta.url.endsWith('.ts')?['--import',import.meta.resolve('tsx'),resolve('src/server.ts')]:[resolve('dist/src/server.js')];
  const env={...process.env,OTP_STATE_DB:':memory:',OTP_RETRIEVAL_KEY:randomBytes(32).toString('base64'),OTP_RETRIEVAL_TOKEN:'startup-test-token-0123456789',OTP_BIND_HOST:'127.0.0.1',PORT:'0',MAX_ACTIVE_BROWSERS:'1',LOG_LEVEL:'info',LLM_ENDPOINT:'http://127.0.0.1:1',API_KEY:'test-key',MODEL:'test-model'};
  const child=spawn(process.execPath,args,{env,stdio:['ignore','pipe','pipe']});t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  let stderr='',stdout='',stopping=false;child.stdout.on('data',chunk=>{stdout+=String(chunk);});
  child.stderr.on('data',chunk=>{stderr+=String(chunk);if(!stopping&&stderr.includes('"event":"listening"')){stopping=true;child.kill('SIGTERM');}});
  const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
  const [code]=await once(child,'exit').finally(()=>clearTimeout(timer));assert.equal(code,0,stderr);assert.equal(stdout,'');
  const events=stderr.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line).event);
  for(const event of ['service_starting','state_opened','startup_recovery_started','listening','service_shutdown_started','retrieval_shutdown_completed','service_shutdown_completed'])assert.ok(events.includes(event),event);
  for(const secret of [env.OTP_RETRIEVAL_TOKEN,env.OTP_RETRIEVAL_KEY])assert.equal(stderr.includes(secret),false);
});

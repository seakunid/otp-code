import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
test('actual HTTP replay and cancellation survive abrupt Node process restarts',async()=>{
 const root=mkdtempSync(join(tmpdir(),'otp restart ')),key=randomBytes(32).toString('base64'),token=randomBytes(32).toString('hex');
 const source=import.meta.url.endsWith('.ts'),modulePath=(name:string)=>JSON.stringify(pathToFileURL(resolve(source?'src':'dist/src',name+'.js')).href);
 const code=`import {Store} from ${modulePath('store')};import {Retrieval} from ${modulePath('service')};import {createApp} from ${modulePath('app')};import {ruleSchema} from ${modulePath('contracts')};import {appendFileSync} from 'node:fs';import {join} from 'node:path';
 const store=new Store(join(process.env.TEST_ROOT,'state.sqlite'),Buffer.from(process.env.TEST_KEY,'base64'));
 const profile=store.profile('target@example.test')||store.createProfile('target@example.test',join(process.env.TEST_ROOT,'profile'));store.enable(profile.uid);
 const rule=ruleSchema.parse({providerUid:'p',purpose:'LOGIN',version:1,senders:['sender@example.test'],subjectMode:'exact',subject:'code',purposeMarkers:['sign-in code'],pattern:'code is (?<otp>[0-9]{6})'});store.syncRule(rule);store.activate('p','LOGIN',1);
 const service=new Retrieval(store,{read:async()=>{appendFileSync(join(process.env.TEST_ROOT,'reads'),'read\\n');return[{ref:'fixture:restart',sender:'sender@example.test',subject:'code',body:'Your sign-in code is 001234',receivedAt:Math.floor(Date.now()/1000)}];},close:async()=>{}});
 const server=createApp(service,process.env.TEST_TOKEN).listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));`;
 const script=join(root,'host.mjs');writeFileSync(script,code);
 const start=async()=>{
  const args=source?['--import',import.meta.resolve('tsx'),script]:[script];
  const child=spawn(process.execPath,args,{env:{...process.env,TEST_ROOT:root,TEST_KEY:key,TEST_TOKEN:token},stdio:['ignore','pipe','pipe']});let output='';child.stderr.resume();
  const port=await new Promise<number>((resolvePort,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('RESTART_HOST_NOT_READY'));},10000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',()=>{clearTimeout(timer);reject(Error('RESTART_HOST_EXITED'));});child.stdout.on('data',data=>{output+=String(data);const line=output.split('\n').find(x=>x.startsWith('{"port":'));if(line){clearTimeout(timer);resolvePort(JSON.parse(line).port);}});});
  return{base:'http://127.0.0.1:'+port,stop:async()=>{const exited=once(child,'exit');child.kill('SIGKILL');await exited;}};
 };
 const now=Math.floor(Date.now()/1000),input={requestUid:'r',attemptUid:'a',providerUid:'p',accountUid:'c',targetEmail:'target@example.test',purpose:'LOGIN',ruleVersion:1,windowStartedAt:now-1,lookupDeadlineAt:now+60,otpValiditySeconds:300};
 const call=(base:string,path:string,body:unknown)=>fetch(base+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':'a'},body:JSON.stringify(body)});
 let host:Awaited<ReturnType<typeof start>>|undefined;
 try{
  host=await start();const found=await call(host.base,'/v1/lookups',input),foundBody=await found.json();assert.equal(found.status,200,JSON.stringify(foundBody.error));assert.equal(foundBody.code,'001234');await host.stop();host=undefined;
  host=await start();const replay=await call(host.base,'/v1/lookups',input);assert.equal(replay.status,200);const result=await replay.json();assert.equal(result.replayed,true);assert.equal(result.sourceMessageRef,'fixture:restart');assert.equal(result.code,'001234');assert.equal(readFileSync(join(root,'reads'),'utf8'),'read\n');
  const cancellation={requestUid:'r',providerUid:'p',accountUid:'c',targetEmail:input.targetEmail,lookupDeadlineAt:input.lookupDeadlineAt,commandUid:'cancel:a',reason:'SUPERSEDED'};
  assert.equal((await call(host.base,'/v1/lookups/a/cancel',cancellation)).status,200);await host.stop();host=undefined;
  host=await start();assert.equal((await call(host.base,'/v1/lookups',input)).status,409);assert.equal((await call(host.base,'/v1/lookups/a/cancel',cancellation)).status,200);assert.equal(readFileSync(join(root,'reads'),'utf8'),'read\n');
 }finally{await host?.stop();rmSync(root,{recursive:true,force:true});}
});

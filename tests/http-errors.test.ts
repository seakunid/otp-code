import {test} from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import {Store} from '../src/store.js';import {Retrieval} from '../src/service.js';import {createApp} from '../src/app.js';
import {isPrivateBindHost} from '../src/contracts.js';
import {ruleSchema} from '../src/contracts.js';
import {resolve} from 'node:path';
test('real-mail verification stores the canonical exact profile email for later lookups',async(t)=>{
 const store=new Store(':memory:',randomBytes(32)),token='synthetic-http-token-0123456789',profile=store.createProfile('target@example.test',resolve('canonical-profile'));store.enable(profile.uid);
 const rule=ruleSchema.parse({providerUid:'p',purpose:'LOGIN',version:1,senders:['sender@example.test'],subjectMode:'exact',subject:'OTP-E2E-case',purposeMarkers:['sign-in code'],pattern:'code is (?<otp>[0-9]{6})'});store.syncRule(rule);
 const svc=new Retrieval(store,{read:async()=>[{ref:'fixture:canonical',sender:'sender@example.test',subject:rule.subject,body:'Your sign-in code is 001234',receivedAt:Math.floor(Date.now()/1000)}],close:async()=>{}}),server=createApp(svc,token,{allowSyntheticVerification:true}).listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));t.after(()=>{server.close();store.close();});
 const now=Math.floor(Date.now()/1000),body={requestUid:'r',attemptUid:'a',providerUid:'p',accountUid:'a',targetEmail:'TARGET@EXAMPLE.TEST',purpose:'LOGIN',ruleVersion:1,windowStartedAt:now-1,lookupDeadlineAt:now+30,otpValiditySeconds:300};
 const response=await fetch('http://127.0.0.1:'+(server.address() as {port:number}).port+'/v1/providers/p/rules/LOGIN/versions/1/verify',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal(response.status,200);assert.equal((await response.json()).profileEmail,'target@example.test');assert.ok(store.proof('p','LOGIN',1,'target@example.test'));assert.equal(store.proof('p','LOGIN',1,'TARGET@EXAMPLE.TEST'),undefined);
});
test('listener rejects public addresses, DNS suffixes and malformed Tailscale lookalikes',()=>{
 for(const host of ['127.0.0.1','100.64.0.1','100.127.255.254'])assert.equal(isPrivateBindHost(host),true);
 for(const host of ['0.0.0.0','8.8.8.8','100.63.255.255','100.128.0.1','100.64.1.2.attacker.test','100.64.999.1','100.64.0.1:3010'])assert.equal(isPrivateBindHost(host),false);
});
test('HTTP cancellation checks full identity, persists tombstones and acknowledges the same command',async(t)=>{
 const store=new Store(':memory:',randomBytes(32)),token='synthetic-http-token-0123456789',service=new Retrieval(store,{read:async()=>[],close:async()=>{}}),server=createApp(service,token).listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));t.after(()=>{server.close();store.close();});
 const path='http://127.0.0.1:'+(server.address() as {port:number}).port+'/v1/lookups/attempt/cancel',body={requestUid:'r',providerUid:'p',accountUid:'a',targetEmail:'test@example.test',lookupDeadlineAt:Math.floor(Date.now()/1000)+30,commandUid:'cancel:attempt',reason:'SUPERSEDED'};
 const call=(payload:unknown)=>fetch(path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(payload)});
 assert.equal((await call({lookupDeadlineAt:body.lookupDeadlineAt})).status,422);
 for(let i=0;i<2;i++){const response=await call(body);assert.equal(response.status,200);assert.equal((await response.json()).commandUid,body.commandUid);}
 assert.equal((await call({...body,accountUid:'other'})).status,409);assert.equal(store.cancelled('attempt'),true);
});
test('actual HTTP rejects malformed JSON, size, content type, auth, queue configuration and unknown routes',async(t)=>{
 const store=new Store(':memory:',randomBytes(32)),token='synthetic-http-token-0123456789',svc=new Retrieval(store,{read:async()=>[],close:async()=>{}});const server=createApp(svc,token).listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const base='http://127.0.0.1:'+(server.address() as {port:number}).port;t.after(()=>{server.close();store.close();});
 const headers={authorization:'Bearer '+token,'content-type':'application/json'};
 assert.equal((await fetch(base+'/v1/lookups',{method:'POST',headers,body:'{'})).status,400);
 assert.equal((await fetch(base+'/v1/lookups',{method:'POST',headers,body:'{} {}'})).status,400);
 assert.equal((await fetch(base+'/v1/lookups',{method:'POST',headers:{authorization:'Bearer '+token},body:'{}'})).status,415);
 assert.equal((await fetch(base+'/v1/lookups',{method:'POST',headers,body:'"'+'x'.repeat(262145)+'"'})).status,413);
 assert.equal((await fetch(base+'/health/live',{headers:{authorization:'Bearer wrong'}})).status,401);
 assert.equal((await fetch(base+'/v1/profiles?limit=1001',{headers})).status,422);
 assert.equal((await fetch(base+'/v1/profiles?cursor=not-an-email',{headers})).status,422);
 const ready=await fetch(base+'/health/ready',{headers});assert.equal(ready.status,200);assert.equal(ready.headers.get('cache-control'),'no-store');assert.equal(ready.headers.get('access-control-allow-origin'),null);
 assert.equal((await fetch(base+'/unknown',{headers})).status,404);
 store.db.exec('PRAGMA query_only=ON');assert.equal((await fetch(base+'/health/ready',{headers})).status,503);store.db.exec('PRAGMA query_only=OFF');assert.equal((await fetch(base+'/health/ready',{headers})).status,200);
});
test('production activation cannot use synthetic proof; profile proof stays exact',async(t)=>{
 const store=new Store(':memory:',randomBytes(32)),token='synthetic-http-token-0123456789',svc=new Retrieval(store,{read:async()=>[],close:async()=>{}});const server=createApp(svc,token).listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const base='http://127.0.0.1:'+(server.address() as {port:number}).port;t.after(()=>{server.close();store.close();});
 const headers={authorization:'Bearer '+token,'content-type':'application/json'},rule={providerUid:'p',purpose:'LOGIN',version:1,senders:['sender@example.test'],subjectMode:'exact',subject:'OTP-E2E-fixture',purposeMarkers:['sign-in'],pattern:'(?<otp>[0-9]{6})'};
 assert.equal((await fetch(base+'/v1/providers/p/rules/LOGIN/versions/1',{method:'PUT',headers,body:JSON.stringify(rule)})).status,200);
 store.db.exec('CREATE TABLE rule_verification(provider TEXT,purpose TEXT,version INTEGER,hash TEXT,verified_at INTEGER,PRIMARY KEY(provider,purpose,version))');store.db.prepare('INSERT INTO rule_verification VALUES(?,?,?,?,?)').run('p','LOGIN',1,'hash',1);store.verifyRule('p','LOGIN',1,'target@example.test','hash','SYNTHETIC');
 const res=await fetch(base+'/v1/providers/p/rules/LOGIN/activate',{method:'POST',headers,body:'{"version":1,"commandUid":"activate","expectedActiveRevision":0}'});assert.equal(res.status,409);assert.equal((await res.json()).error.code,'GENUINE_PROVIDER_VERIFICATION_REQUIRED');assert.equal(store.proof('p','LOGIN',1,'other@example.test'),undefined);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { Store } from '../src/store.js';
import { extract } from '../src/extraction.js';
import { ruleSchema, lookupSchema, Message, Profile } from '../src/contracts.js';
import { Retrieval } from '../src/service.js';
import { createApp } from '../src/app.js';
import { Executor } from '../src/executor.js';
const token='synthetic-test-bearer-0123456789';
const rule=ruleSchema.parse({providerUid:'provider',purpose:'LOGIN',version:1,senders:['sender@example.test'],subjectMode:'contains',subject:'code',purposeMarkers:['code'],pattern:'(?:code(?: is|:)?\\s*)(?<otp>[0-9]{4,8})'});
const input=()=>lookupSchema.parse({requestUid:'request',attemptUid:'attempt',providerUid:'provider',accountUid:'account',targetEmail:'target@example.test',purpose:'LOGIN',ruleVersion:1,windowStartedAt:Math.floor(Date.now()/1000)-60,lookupDeadlineAt:Math.floor(Date.now()/1000)+30,otpValiditySeconds:600});
function fixture(){
 const path=mkdtempSync(join(tmpdir(),'otp-test-'));const key=randomBytes(32);const store=new Store(join(path,'state.sqlite'),key);store.createProfile('target@example.test',join(path,'profile'));store.enable(store.profile('target@example.test')!.uid);store.syncRule(rule);store.activate('provider','LOGIN',1);
 let reads=0,closes=0;
 const mailbox={read:async()=>{reads++;return[{ref:'message',sender:'sender@example.test',subject:'code',body:'Your code is 0738',receivedAt:Math.floor(Date.now()/1000)}];},close:async()=>{closes++;}};
 const service=new Retrieval(store,mailbox,new Executor(),5);
 return {store,service,path,key,get reads(){return reads;},get closes(){return closes;}};
}
test('parser preserves zero, rejects ambiguity, sender spoof and quoted code',async()=>{
 const m:Message={ref:'x',sender:'sender@example.test',subject:'code',body:'Your code is 0738',receivedAt:1};
 assert.equal((await extract(rule,m)).code,'0738');
 assert.equal((await extract(rule,{...m,body:'code is 0738 and code is 5481'})).outcome,'AMBIGUOUS');
 assert.equal((await extract(rule,{...m,sender:'sender@example.test.attacker.test'})).outcome,'NOT_FOUND');
 assert.equal((await extract(rule,{...m,body:'Hello\n----- Previous message -----\ncode is 0738'})).outcome,'NOT_FOUND');
});
test('HTTP auth, strict input, found closes browser, replay and conflicts',async(t)=>{
 const f=fixture();const server=createApp(f.service,token).listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const addr=server.address() as {port:number};const base=`http://127.0.0.1:${addr.port}`;
 t.after(()=>{server.close();f.store.close();});
 const call=(value:unknown,key='attempt')=>fetch(base+'/v1/lookups',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':key},body:JSON.stringify(value)});
 assert.equal((await fetch(base+'/health/live')).status,401);
 assert.equal((await call({...input(),profilePath:'arbitrary'})).status,422);
 assert.equal((await call({...input(),windowStartedAt:Math.floor(Date.now()/1000)-300,lookupDeadlineAt:Math.floor(Date.now()/1000)+200})).status,422);
 const req=input();const [a,b]=await Promise.all([call(req),call(req)]);assert.equal(a.status,200);assert.equal(b.status,200);assert.equal((await a.json()).code,'0738');assert.equal(f.reads,1);assert.equal(f.closes,1);
 const replay=await call(req);assert.equal((await replay.json()).replayed,true);assert.equal(f.reads,1);
 assert.equal((await call({...req,targetEmail:'other@example.test'})).status,409);
 assert.equal((await call({...req,attemptUid:'another'},'wrong')).status,400);
 const state=readFileSync(join(f.path,'state.sqlite'));assert.equal(state.includes(Buffer.from('Your code is')),false);
});
test('encrypted replay survives restart and cancel tombstone wins',async()=>{
 const f=fixture(),req=input();await f.service.lookup(req);f.store.close();const store=new Store(join(f.path,'state.sqlite'),f.key);assert.equal(store.read('attempt').code,'0738');store.cancel('attempt',req.lookupDeadlineAt);assert.equal(store.read('attempt'),undefined);assert.throws(()=>store.admit('attempt',store.hash(req),req.lookupDeadlineAt),/LOOKUP_CANCELLED/);store.close();
});
test('new attempt cannot consume source already used',async()=>{const f=fixture();await f.service.lookup(input());assert.ok(f.store.used('target@example.test','message','other',Math.floor(Date.now()/1000)));assert.equal(f.store.used('target@example.test','message','attempt',Math.floor(Date.now()/1000)),false);f.store.close();});
test('executor bounds total browser count and serializes each profile',async()=>{
 const ex=new Executor(2);let active=0,peak=0;const keys=new Set<string>();const controller=new AbortController();
 await Promise.all(Array.from({length:10},(_,i)=>ex.run(String(i%3),Date.now()+10000,controller.signal,async()=>{const key=String(i%3);assert.equal(keys.has(key),false);keys.add(key);peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,5));active--;keys.delete(key);})));
 assert.equal(peak,2);assert.equal(ex.stats().queued,0);
});
test('profile uniqueness and indexed pagination',()=>{const s=new Store(':memory:',randomBytes(32));s.createProfile('A@example.test',resolve('one'));assert.throws(()=>s.createProfile('a@example.test',resolve('two')),/PROFILE_EXISTS/);s.createProfile('b@example.test',resolve('two'));assert.equal(s.list('',1).length,1);assert.equal((s.list('a@example.test',1)[0] as {email:string}).email,'b@example.test');s.close();});

import {test,TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {Store} from '../src/store.js';
import {Retrieval} from '../src/service.js';
import {createApp} from '../src/app.js';
import {Message,lookupSchema,ruleSchema} from '../src/contracts.js';

const token='synthetic-selection-token-0123456789';
const rule=ruleSchema.parse({providerUid:'p',purpose:'LOGIN',version:1,senders:['sender@example.test'],subjectMode:'exact',subject:'Sign-in code',purposeMarkers:['sign-in code'],pattern:'code is (?<otp>[0-9]{6})'});
const message=(ref:string,body='Your sign-in code is 001234.',receivedAt=Math.floor(Date.now()/1000)-1):Message=>({ref,sender:'sender@example.test',subject:rule.subject,body,receivedAt});

async function fixture(t:TestContext,messages:Message[]){
 const store=new Store(':memory:',randomBytes(32)),profile=store.createProfile('target@example.test',resolve('selection-profile'));
 store.enable(profile.uid);store.syncRule(rule);store.activate('p','LOGIN',1);
 let reads=0,closes=0;
 const service=new Retrieval(store,{read:async()=>{reads++;return messages;},close:async()=>{closes++;}},undefined,5);
 const server=createApp(service,token,{allowSyntheticVerification:true}).listen(0,'127.0.0.1');
 await new Promise<void>(r=>server.once('listening',r));
 t.after(async()=>{await service.shutdown();await new Promise<void>(r=>server.close(()=>r()));store.close();});
 const base='http://127.0.0.1:'+(server.address() as {port:number}).port,now=Math.floor(Date.now()/1000);
 const input=(attemptUid:string)=>lookupSchema.parse({requestUid:'r',attemptUid,providerUid:'p',accountUid:'a',targetEmail:profile.email,purpose:'LOGIN',ruleVersion:1,windowStartedAt:now-60,lookupDeadlineAt:now+3,otpValiditySeconds:300});
 const post=async(path:string,body:ReturnType<typeof input>)=>{
  const response=await fetch(base+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':body.attemptUid},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
 };
 return {store,input,post,get reads(){return reads;},get closes(){return closes;}};
}

for(const warning of ['This code has expired.','Your code is no longer valid.','The code has been replaced.'])test('HTTP lookup rejects explicit invalidation: '+warning,async(t)=>{
 const now=Math.floor(Date.now()/1000),f=await fixture(t,[message('newest','Your sign-in code is 001234. '+warning,now-1),message('older','Your sign-in code is 009876.',now-2)]);
 const result=await f.post('/v1/lookups',f.input('expired'));
 assert.equal(result.status,410);assert.equal(result.body.error.code,'OTP_EXPIRED');assert.equal(result.body.code,undefined);
 assert.equal(f.closes,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM used_source').get()?.n,0);
});

test('HTTP lookup accepts future expiry and ignores quoted expired text',async(t)=>{
 const f=await fixture(t,[message('current','Your sign-in code is 001234. This code has not expired. Expires in 5 minutes.\n----- Previous message -----\nThis code has expired.')]);
 const result=await f.post('/v1/lookups',f.input('valid'));
 assert.equal(result.status,200);assert.equal(result.body.code,'001234');
});

for(const reverse of [false,true])test('HTTP lookup rejects newest timestamp ties regardless of mailbox order: '+reverse,async(t)=>{
 const messages=[message('one'),message('two','Your sign-in code is 009876.')];
 messages[1].receivedAt=messages[0].receivedAt;
 const f=await fixture(t,reverse?messages.reverse():messages),result=await f.post('/v1/lookups',f.input('tie'));
 assert.equal(result.status,200);assert.equal(result.body.outcome,'AMBIGUOUS');assert.equal(result.body.code,undefined);
 assert.equal(result.body.sourceMessageRef,undefined);assert.equal(f.closes,1);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM used_source').get()?.n,0);
});

test('HTTP lookup chooses the newest qualifying source and ignores excluded or untrusted ties',async(t)=>{
 const now=Math.floor(Date.now()/1000),f=await fixture(t,[message('older','Your sign-in code is 009876. This code has expired.',now-2),message('excluded'),{...message('spoof'),sender:'attacker@example.test'},message('current')]);
 const input={...f.input('newest'),excludedSourceMessageRefs:['excluded']},result=await f.post('/v1/lookups',input);
 assert.equal(result.status,200);assert.equal(result.body.outcome,'FOUND');assert.equal(result.body.sourceMessageRef,'current');
});

test('HTTP rule verification replays without consuming a customer source; customer uniqueness remains',async(t)=>{
 const f=await fixture(t,[message('shared')]),verification=f.input('verification'),customer=f.input('customer');
 const verify='/v1/providers/p/rules/LOGIN/versions/1/verify';
 for(let i=0;i<2;i++)assert.equal((await f.post(verify,verification)).status,200);
 assert.equal(f.reads,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM used_source').get()?.n,0);
 const found=await f.post('/v1/lookups',customer);
 assert.equal(found.status,200);assert.equal(found.body.code,'001234');assert.equal(found.body.sourceMessageRef,'shared');
 assert.ok(f.store.used('target@example.test','shared','another',Math.floor(Date.now()/1000)));
 assert.equal((await f.post('/v1/lookups',customer)).body.replayed,true);assert.equal(f.reads,2);
 const second=await f.post('/v1/lookups',{...f.input('another'),lookupDeadlineAt:Math.floor(Date.now()/1000)+1});
 assert.equal(second.status,504);assert.equal(second.body.error.code,'TIMEOUT');
});

test('HTTP rule verification can inspect a customer-used source without changing its owner',async(t)=>{
 const f=await fixture(t,[message('shared')]);
 assert.equal((await f.post('/v1/lookups',f.input('customer'))).status,200);
 const verified=await f.post('/v1/providers/p/rules/LOGIN/versions/1/verify',f.input('verification'));
 assert.equal(verified.status,200);
 assert.equal(f.store.db.prepare('SELECT owner FROM used_source WHERE ref=?').get('shared')?.owner,'customer');
});

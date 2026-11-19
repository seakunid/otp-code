import {test} from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import {resolve} from 'node:path';import {Store} from '../src/store.js';import {Retrieval} from '../src/service.js';import {ruleSchema,lookupSchema} from '../src/contracts.js';import {stubClassifier} from './helpers/classifier.js';

for(const scenario of ['email-earlier','policy-earlier','lapsed-policy','no-expiry'] as const)test('receipt and expiry policy: '+scenario,async()=>{
 const store=new Store(':memory:',randomBytes(32)),now=Math.floor(Date.now()/1000),p=store.createProfile('target@example.test',resolve('expiry-'+scenario));store.enable(p.uid);
 const rule=ruleSchema.parse({providerUid:'p',purpose:'LOGIN',version:1,senders:['sender@example.test'],subjectMode:'exact',subject:'code'});store.syncRule(rule);store.activate('p','LOGIN',1);
 const receivedAt=now-10,expiresAt=scenario==='email-earlier'?now+20:scenario==='policy-earlier'?now+200:undefined;
 let reads=0;const service=new Retrieval(store,{read:async()=>{reads++;return[{ref:'source',sender:'sender@example.test',subject:'code',body:'Your sign-in code is 001234',receivedAt,expiresAt}];},close:async()=>{}},undefined,1,false,false,stubClassifier());
 const input=lookupSchema.parse({requestUid:'r',attemptUid:'a',providerUid:'p',accountUid:'c',targetEmail:p.email,purpose:'LOGIN',ruleVersion:1,windowStartedAt:now-60,lookupDeadlineAt:now+30,...(scenario==='no-expiry'?{}:{otpValiditySeconds:scenario==='lapsed-policy'?5:100})});
 try{if(scenario==='no-expiry')await assert.rejects(service.lookup(input),/EXPIRY_UNAVAILABLE/);else if(scenario==='lapsed-policy')await assert.rejects(service.lookup(input),/OTP_EXPIRED/);else{const result=await service.lookup(input) as {expiresAt:number;expirySource:string;code:string};assert.equal(result.expiresAt,scenario==='email-earlier'?now+20:receivedAt+100);assert.equal(result.expirySource,scenario==='email-earlier'?'EMAIL':'PROVIDER_POLICY');assert.equal(result.code,'001234');}}finally{await service.shutdown();store.close();}
});

test('mails past their own expiry or from the future never reach the classifier',async()=>{
 const now=Math.floor(Date.now()/1000);
 for(const [name,fields] of [['expired',{expiresAt:now-1}],['future',{receivedAt:now+60}]] as const){
  const store=new Store(':memory:',randomBytes(32)),p=store.createProfile(name+'@example.test',resolve('expiry-ignored-'+name));store.enable(p.uid);
  const rule=ruleSchema.parse({providerUid:name,purpose:'LOGIN',version:1,senders:['sender@example.test'],subjectMode:'exact',subject:'code'});store.syncRule(rule);store.activate(name,'LOGIN',1);
  const calls={count:0};
  const service=new Retrieval(store,{read:async()=>[{ref:'source',sender:'sender@example.test',subject:'code',body:'Your sign-in code is 001234',receivedAt:now,...fields}],close:async()=>{}},undefined,10,false,false,stubClassifier([],calls));
  const input=lookupSchema.parse({requestUid:'r',attemptUid:'a',providerUid:name,accountUid:'c',targetEmail:p.email,purpose:'LOGIN',ruleVersion:1,windowStartedAt:now-60,lookupDeadlineAt:now+1,otpValiditySeconds:300});
  try{await assert.rejects(service.lookup(input),/TIMEOUT/,name);assert.equal(calls.count,0,name);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM used_source').get()?.n,0);}finally{await service.shutdown();store.close();}
 }
});

test('code expiring during verified browser closure cannot escape as FOUND or replay',async(t)=>{
 const now=Date.now();t.mock.timers.enable({apis:['Date'],now});
 const store=new Store(':memory:',randomBytes(32)),p=store.createProfile('target@example.test',resolve('expiry-during-close'));store.enable(p.uid);
 const rule=ruleSchema.parse({providerUid:'p',purpose:'LOGIN',version:1,senders:['sender@example.test'],subjectMode:'exact',subject:'code'});store.syncRule(rule);store.activate('p','LOGIN',1);
 const seconds=Math.floor(now/1000);let reads=0,closes=0;
 const service=new Retrieval(store,{read:async()=>{reads++;return[{ref:'source',sender:'sender@example.test',subject:'code',body:'Your sign-in code is 001234',receivedAt:seconds,expiresAt:seconds+1}];},close:async()=>{closes++;t.mock.timers.tick(2000);}},undefined,2000,false,false,stubClassifier());
 const input=lookupSchema.parse({requestUid:'r',attemptUid:'a',providerUid:'p',accountUid:'c',targetEmail:p.email,purpose:'LOGIN',ruleVersion:1,windowStartedAt:seconds-1,lookupDeadlineAt:seconds+30,otpValiditySeconds:100});
 try{await assert.rejects(service.lookup(input),/OTP_EXPIRED/);assert.equal(store.read('a').code,undefined);await assert.rejects(service.lookup(input),/OTP_EXPIRED/);assert.equal(reads,1);assert.equal(closes,1);}finally{await service.shutdown();store.close();}
});

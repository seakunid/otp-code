import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {accounts,sendPlayground} from './playground.js';
import {Store} from '../src/store.js';
import {Gmail} from '../src/browser.js';
import {Executor} from '../src/executor.js';
import {Retrieval} from '../src/service.js';
import {createApp} from '../src/app.js';
import {ruleSchema,lookupSchema,Lookup,Rule,Message} from '../src/contracts.js';
if(process.env.OTP_REAL_GMAIL_E2E!=='true')throw Error('Explicit two-account playground opt-in required');
const run='OTP-E2E-'+Date.now(),cases:{name:string;status:string;elapsedMs:number;error?:string}[]=[];
const store=new Store(process.env.OTP_STATE_DB||'runtime/gmail-matrix.sqlite',Buffer.from(process.env.OTP_RETRIEVAL_KEY||'','base64'));
const gmail=new Gmail(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),executor=new Executor(2);
// Data-plane negatives use preconfigured synthetic rules; this host does not prove activation eligibility.
const service=new Retrieval(store,gmail,executor,1000),token=process.env.OTP_RETRIEVAL_TOKEN||'';
const server=createApp(service,token,{allowSyntheticVerification:true}).listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
const base='http://127.0.0.1:'+(server.address() as {port:number}).port;mkdirSync('artifacts',{recursive:true});
async function http(input:Lookup){const response=await fetch(base+'/v1/lookups',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':input.attemptUid},body:JSON.stringify(input)});return{status:response.status,body:await response.json()};}
function input(rule:Rule,start:number,extra:Partial<Lookup>={}){const id=randomUUID();return lookupSchema.parse({requestUid:id,attemptUid:id,providerUid:rule.providerUid,accountUid:'negative-playground',targetEmail:accounts[1].email,purpose:rule.purpose,ruleVersion:rule.version,windowStartedAt:start,lookupDeadlineAt:Math.floor(Date.now()/1000)+60,otpValiditySeconds:300,...extra});}
function rule(name:string,extra:Partial<Rule>={}){const r=ruleSchema.parse({providerUid:run+'-'+name,purpose:'LOGIN',version:1,senders:[accounts[0].email],subjectMode:'exact',subject:run+'-'+name,purposeMarkers:['sign-in code'],pattern:'code is (?<otp>[0-9]{6})',...extra});store.syncRule(r);store.activate(r.providerUid,r.purpose,r.version);return r;}
async function delivered(r:Rule,start:number):Promise<Message[]>{
 const p=store.profile(accounts[1].email)!,body=input(r,start),deadline=body.lookupDeadlineAt*1000;
 return executor.run(p.uid,deadline,new AbortController().signal,async()=>{try{while(Date.now()<deadline-5000){const messages=await gmail.read(p,body,r,new AbortController().signal);if(messages.length)return messages;await new Promise(r=>setTimeout(r,1000));}throw Error('SYNTHETIC_DELIVERY_NOT_CONFIRMED');}finally{await gmail.close(p);}});
}
async function test(name:string,fn:()=>Promise<void>){const start=Date.now();try{await fn();cases.push({name,status:'PASS',elapsedMs:Date.now()-start});}catch(error){cases.push({name,status:'FAIL',elapsedMs:Date.now()-start,error:error instanceof Error?error.message.slice(0,120):'UNKNOWN'});throw error;}finally{writeFileSync('artifacts/'+run+'-negative.json',JSON.stringify({run,boundary:'Actual Windows REST/Gmail with preconfigured synthetic rules; no production activation claim',cases},null,2));console.log(JSON.stringify(cases.at(-1)));}}
try{
 await test('newest individual message, quoted old code, replay, and fresh source on retry',async()=>{
  const r=rule('thread'),start=Math.floor(Date.now()/1000)-1;
  await sendPlayground(store,gmail,executor,0,1,r.subject,'Your sign-in code is 001234. Synthetic old message.');
  const old=await http(input(r,start));assert.equal(old.status,200,'OLD_'+old.body.error?.code);assert.ok(old.body.code==='001234','OLD_CODE_MISMATCH');
  await sendPlayground(store,gmail,executor,0,1,r.subject,'Your sign-in code is 009876.\n----- Previous message -----\nYour sign-in code is 001234.');
  const body=input(r,start),current=await http(body);assert.equal(current.status,200,'THREAD_'+current.body.error?.code);assert.ok(current.body.code==='009876','QUOTED_OR_OLD_CODE_USED');assert.notEqual(current.body.sourceMessageRef,old.body.sourceMessageRef);
  const replay=await http(body);assert.equal(replay.body.replayed,true);assert.equal(replay.body.sourceMessageRef,current.body.sourceMessageRef);assert.equal(executor.stats().active,0);
 });
 for(const item of [
  {name:'ambiguous',body:'Your sign-in code is 001234. Another current code is 009876.',outcome:'AMBIGUOUS'},
  {name:'security',body:'Security alert: suspicious activity. Your sign-in code is 001234.',outcome:'SECURITY_ALERT'}
 ])await test('real received '+item.name+' returns no code',async()=>{
  const r=rule(item.name),start=Math.floor(Date.now()/1000)-1;await sendPlayground(store,gmail,executor,0,1,r.subject,item.body);const response=await http(input(r,start));assert.equal(response.status,200,'NEGATIVE_'+response.body.error?.code);assert.equal(response.body.outcome,item.outcome);assert.equal(response.body.code,undefined);assert.equal(executor.stats().active,0);
 });
 await test('received wrong-purpose, expired policy, and old-window evidence never produce a code',async()=>{
  const r=rule('purpose'),start=Math.floor(Date.now()/1000)-1;await sendPlayground(store,gmail,executor,0,1,r.subject,'Your payment code is 001234. Synthetic wrong-purpose fixture.');
  const messages=await delivered(r,start);assert.ok(messages.length>0);const wrong=await http(input(r,start,{lookupDeadlineAt:Math.floor(Date.now()/1000)+15}));assert.equal(wrong.status,504);assert.equal(wrong.body.code,undefined);
  const policy=rule('expired'),sent=Math.floor(Date.now()/1000)-1;await sendPlayground(store,gmail,executor,0,1,policy.subject,'Your sign-in code is 001234. Synthetic expired fixture.');const received=await delivered(policy,sent);assert.ok(received.length>0);while(Math.floor(Date.now()/1000)<=received[0].receivedAt+1)await new Promise(r=>setTimeout(r,500));
  const expired=await http(input(policy,sent,{otpValiditySeconds:1}));assert.equal(expired.status,410);assert.equal(expired.body.error.code,'OTP_EXPIRED');assert.equal(expired.body.code,undefined);
  const excluded=await http(input(policy,Math.floor(Date.now()/1000),{lookupDeadlineAt:Math.floor(Date.now()/1000)+15}));assert.equal(excluded.status,504);assert.equal(excluded.body.code,undefined);assert.equal(executor.stats().active,0);
 });
 await test('delivered login code cannot match a different sender or subject rule',async()=>{
  const actual=rule('identity'),start=Math.floor(Date.now()/1000)-1;await sendPlayground(store,gmail,executor,0,1,actual.subject,'Your sign-in code is 001234. Synthetic identity fixture.');assert.ok((await delivered(actual,start)).length>0);
  const mismatches:[string,Partial<Rule>][]=[['sender',{senders:[accounts[1].email],subject:actual.subject}],['subject',{subject:actual.subject+'-absent'}]];
  for(const [suffix,extra] of mismatches){
   const mismatch=rule('identity-'+suffix,extra),response=await http(input(mismatch,start,{lookupDeadlineAt:Math.floor(Date.now()/1000)+15}));assert.equal(response.status,504,'IDENTITY_'+response.body.error?.code);assert.equal(response.body.code,undefined);assert.equal(executor.stats().active,0);
  }
 });
 await test('delivered magic link without a code never returns FOUND',async()=>{
  const r=rule('magic-link'),start=Math.floor(Date.now()/1000)-1;await sendPlayground(store,gmail,executor,0,1,r.subject,'Your sign-in code is not required. Open https://example.test/sign-in to continue. Synthetic magic-link fixture.');assert.ok((await delivered(r,start)).length>0);
  const response=await http(input(r,start,{lookupDeadlineAt:Math.floor(Date.now()/1000)+15}));assert.equal(response.status,504,'NO_CODE_'+response.body.error?.code);assert.equal(response.body.code,undefined);assert.equal(executor.stats().active,0);
 });
}catch{process.exitCode=1;}finally{await service.shutdown();await new Promise<void>(r=>server.close(()=>r()));store.close();}

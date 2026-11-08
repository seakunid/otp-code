import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync,mkdirSync} from 'node:fs';
import {accounts,sendPlayground} from './playground.js';
import {Store} from '../src/store.js';
import {Gmail} from '../src/browser.js';
import {Retrieval} from '../src/service.js';
import {Executor} from '../src/executor.js';
import {createApp} from '../src/app.js';
import {ruleSchema} from '../src/contracts.js';
import {ServiceError} from '../src/contracts.js';
import {once} from 'node:events';
if(process.env.OTP_REAL_GMAIL_E2E!=='true')throw Error('Explicit playground real Gmail opt-in required');
const run='OTP-E2E-'+Date.now(),cases:{name:string;status:string;elapsedMs:number;error?:string}[]=[];
const store=new Store(process.env.OTP_STATE_DB||'runtime/gmail-matrix.sqlite',Buffer.from(process.env.OTP_RETRIEVAL_KEY||'','base64'));
const gmail=new Gmail(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),executor=new Executor(2),service=new Retrieval(store,gmail,executor,1000,true,true);
const server=createApp(service,process.env.OTP_RETRIEVAL_TOKEN||'',{allowSyntheticVerification:true}).listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
mkdirSync('artifacts',{recursive:true});
async function request(path:string,body:unknown,method='POST',key=''){
 const response=await fetch(base+path,{method,headers:{authorization:'Bearer '+process.env.OTP_RETRIEVAL_TOKEN,'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)});
 return{status:response.status,data:await response.json()};
}
async function test(name:string,fn:()=>Promise<void>){const start=Date.now();try{await fn();cases.push({name,status:'PASS',elapsedMs:Date.now()-start});}catch(error){cases.push({name,status:'FAIL',elapsedMs:Date.now()-start,error:error instanceof Error?error.message.slice(0,120):'UNKNOWN'});throw error;}finally{writeFileSync('artifacts/'+run+'-reliability.json',JSON.stringify({run,cases},null,2));console.log(JSON.stringify(cases.at(-1)));}}
const provider=(to:number)=>run+'-profile-'+to;
const input=(to:number,start:number,seconds=60)=>{const uid=randomUUID();return{requestUid:uid,attemptUid:uid,providerUid:provider(to),accountUid:'playground-'+to,targetEmail:accounts[to].email,purpose:'LOGIN',ruleVersion:1,windowStartedAt:start,lookupDeadlineAt:Math.floor(Date.now()/1000)+seconds,otpValiditySeconds:300,excludedSourceMessageRefs:[]};};
async function lookup(to:number,index:string){
 const code=String(100000+Number(index.replace(/\D/g,''))%899999),start=Math.floor(Date.now()/1000)-1;
 await sendPlayground(store,gmail,executor,1-to,to,run+'-'+index,'Your sign-in code is '+code+'. This is a synthetic reliability test.');
 const body=input(to,start),response=await request('/v1/lookups',body,'POST',body.attemptUid);assert.equal(response.status,200,'LOOKUP_'+response.status+'_'+response.data.error?.code);assert.equal(response.data.outcome,'FOUND');assert.ok(response.data.code===code,'WRONG_SYNTHETIC_CODE');
 const replay=await request('/v1/lookups',body,'POST',body.attemptUid);assert.equal(replay.data.replayed,true);assert.equal(replay.data.sourceMessageRef,response.data.sourceMessageRef);
}
try{
 for(let to=0;to<2;to++)await test('prepare exact profile '+to,async()=>{
  const p=store.profile(accounts[to].email);assert.ok(p?.verified&&p.enabled,'PROFILE_NOT_VERIFIED');
  const rule=ruleSchema.parse({providerUid:provider(to),purpose:'LOGIN',version:1,senders:[accounts[1-to].email],subjectMode:'contains',subject:run,purposeMarkers:['sign-in code'],pattern:'code is (?<otp>[0-9]{6})'});
  const path='/v1/providers/'+provider(to)+'/rules/LOGIN';assert.equal((await request(path+'/versions/1',rule,'PUT')).status,200);
  const start=Math.floor(Date.now()/1000)-1;await sendPlayground(store,gmail,executor,1-to,to,run+'-verify-'+to,'Your sign-in code is 073821. Synthetic verification.');
  const verified=await request(path+'/versions/1/verify',input(to,start));assert.equal(verified.status,200,'VERIFY_'+verified.data.error?.code);
  assert.equal((await request(path+'/activate',{version:1,commandUid:randomUUID(),expectedActiveRevision:0})).status,200);
 });
 await test('mail arriving after lookup starts is found by bounded polling',async()=>{
  const body=input(0,Math.floor(Date.now()/1000)),pending=request('/v1/lookups',body,'POST',body.attemptUid);await new Promise(r=>setTimeout(r,5000));
  await sendPlayground(store,gmail,executor,1,0,run+'-delayed','Your sign-in code is 031972. Synthetic delayed delivery.');const response=await pending;assert.equal(response.status,200,'DELAYED_'+response.data.error?.code);assert.ok(response.data.code==='031972','DELAYED_WRONG_CODE');assert.equal(executor.stats().active,0);
 });
 for(let i=0;i<20;i++)await test('sequential '+i,async()=>{await lookup(i%2,'seq-'+i);assert.equal(executor.stats().active,0);});
 for(let i=0;i<10;i++)await test('two-profile parallel round '+i,async()=>{await Promise.all([lookup(0,'parallel-'+i+'-0'),lookup(1,'parallel-'+i+'-1')]);assert.equal(executor.stats().active,0);});
 await test('real Gmail cancellation, duplicate acknowledgement and tombstone',async()=>{
  const body=input(0,Math.floor(Date.now()/1000),30),pending=request('/v1/lookups',body,'POST',body.attemptUid);await new Promise(r=>setTimeout(r,3000));
  const cancellation={requestUid:body.requestUid,providerUid:body.providerUid,accountUid:body.accountUid,targetEmail:body.targetEmail,lookupDeadlineAt:body.lookupDeadlineAt,commandUid:randomUUID(),reason:'SUPERSEDED'};
  const path='/v1/lookups/'+body.attemptUid+'/cancel';assert.equal((await request(path,cancellation)).status,200);assert.equal((await pending).status,409);assert.equal((await request(path,cancellation)).status,200);assert.equal((await request('/v1/lookups',body,'POST',body.attemptUid)).status,409);assert.equal(executor.stats().active,0);
 });
 await test('full 60-second no-match closes Chrome and healthy lookup recovers',async()=>{
  const now=Math.floor(Date.now()/1000),body=input(1,now,60),started=Date.now(),response=await request('/v1/lookups',body,'POST',body.attemptUid);assert.equal(response.status,504,'TIMEOUT_'+response.status);assert.ok(Date.now()-started>=55000);assert.ok(Date.now()-started<65000);assert.equal(executor.stats().active,0);await lookup(1,'recovery-999');
 });
 await test('owned Chrome crash returns no code and saved-login lookup recovers',async()=>{
  const read=gmail.read.bind(gmail);let crashed=false;
  gmail.read=async(profile,...args)=>{
   if(!crashed){crashed=true;const browser=await gmail.open(profile,Date.now()+20000),child=browser.process();assert.ok(child?.pid);const exited=once(child,'exit');assert.ok(child.kill('SIGKILL'));await exited;throw new ServiceError(502,'GMAIL_BROWSER_CRASH');}
   return read(profile,...args);
  };
  try{const body=input(0,Math.floor(Date.now()/1000)),response=await request('/v1/lookups',body,'POST',body.attemptUid);assert.equal(response.status,502,'CRASH_'+response.data.error?.code);assert.equal(response.data.code,undefined);assert.equal(executor.stats().active,0);}finally{gmail.read=read;}
  await lookup(0,'crash-recovery-998');assert.equal(executor.stats().active,0);
 });
}catch{process.exitCode=1;}finally{await service.shutdown();await new Promise<void>(r=>server.close(()=>r()));store.close();}

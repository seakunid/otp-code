import {accounts,sendPlayground} from './playground.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { Store } from '../src/store.js';
import { Gmail } from '../src/browser.js';
import { Retrieval } from '../src/service.js';
import { createApp } from '../src/app.js';
import { Executor } from '../src/executor.js';
import { ruleSchema } from '../src/contracts.js';
import assert from 'node:assert/strict';
if(process.env.OTP_REAL_GMAIL_E2E!=='true')throw Error('Set OTP_REAL_GMAIL_E2E=true; sends tagged synthetic emails between two approved playground inboxes');

const stageLog=(stage:string)=>writeFileSync('runtime/e2e-stage.json',JSON.stringify({stage,at:Date.now()}));
const run='OTP-E2E-'+Date.now(),report:{run:string;complete:boolean;cases:{name:string;status:string;error?:string;elapsedMs:number}[];lookups:{direction:string;purpose:string;kind:string;elapsedMs:number;status:number}[]}={run,complete:false,cases:[],lookups:[]};
const token=process.env.OTP_RETRIEVAL_TOKEN||'';
const store=new Store(process.env.OTP_STATE_DB||'runtime/state.sqlite',Buffer.from(process.env.OTP_RETRIEVAL_KEY||'','base64'));
const gmail=new Gmail(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
const executor=new Executor(2),retrieval=new Retrieval(store,gmail,executor,2000,true,true);
const server=createApp(retrieval,token,{allowSyntheticVerification:true}).listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
async function http(path:string,body:unknown,method='POST',key?:string){const res=await fetch(base+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json',...(key?{'idempotency-key':key}:{})},body:JSON.stringify(body)});const data=await res.json();return{status:res.status,data};}
async function test(name:string,fn:()=>Promise<void>){const start=Date.now();try{await fn();report.cases.push({name,status:'PASS',elapsedMs:Date.now()-start});}catch(e){report.cases.push({name,status:'FAIL',error:e instanceof Error?e.message.slice(0,120):'UNKNOWN',elapsedMs:Date.now()-start});}writeFileSync('artifacts/gmail-e2e.json',JSON.stringify(report,null,2));writeFileSync('artifacts/'+run+'.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report.cases.at(-1)));if(report.cases.at(-1)?.status==='FAIL')throw Error('GMAIL_MATRIX_STOPPED_AFTER_FAILURE');}
mkdirSync('artifacts',{recursive:true});
try{
 const scale=Number(process.env.OTP_E2E_SCALE_PROFILES||0);
 if(scale){assert.equal(scale,100000);await test('100k synthetic registry coexists with real Gmail',async()=>{
  const insert=store.db.prepare('INSERT OR IGNORE INTO profile(uid,email,directory) VALUES(?,?,?)');
  for(let base=0;base<scale;base+=1000){store.db.exec('BEGIN');for(let i=base;i<base+1000;i++)insert.run('synthetic-'+i,'synthetic-'+String(i).padStart(6,'0')+'@example.test','synthetic-metadata-only-'+i);store.db.exec('COMMIT');await new Promise<void>(r=>setImmediate(r));}
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM profile WHERE email LIKE '%@example.test'").get()?.n,scale);
 });}
 for(const a of accounts)if(!store.profile(a.email))store.createProfile(a.email,a.directory);
 for(let index=0;index<2;index++)await test('profile '+index+' exact-account verification',async()=>{
  const p=store.profile(accounts[index].email)!;try{const browser=await gmail.open(p,Date.now()+30000);const page=await browser.newPage();await gmail.verify(page,p.email,Date.now()+30000);store.enable(p.uid);}finally{await gmail.close(p);}
 });
 for(const from of [1,0]){
  const to=1-from;
  const cases=[
   {name:'leading-zero login',purpose:'LOGIN',body:'Your sign-in code is 073821. Do not share this code.',pattern:'code is (?<otp>[0-9]{6})',code:'073821',marker:'sign-in code'},
   {name:'spaced login',purpose:'LOGIN',body:'Your sign-in code is 3 6 1 9 0 2. Valid for five minutes.',pattern:'code is (?<otp>[0-9 ]{11})',code:'361902',marker:'sign-in code',spaces:true},
   {name:'alphanumeric login',purpose:'LOGIN',body:'Your sign-in code is AB7-K2P. Valid for five minutes.',pattern:'code is (?<otp>[A-Z0-9-]{7})',code:'AB7K2P',marker:'sign-in code',hyphens:true},
   {name:'payment',purpose:'PAYMENT',body:'Authorize your payment. Your payment code is 481029. Do not share it.',pattern:'code is (?<otp>[0-9]{6})',code:'481029',marker:'payment code'},
   {name:'password reset',purpose:'PASSWORD_RESET',body:'Reset your password. Your password reset code is 975130. Valid for five minutes.',pattern:'code is (?<otp>[0-9]{6})',code:'975130',marker:'password reset code'}
  ];
  for(let i=0;i<Math.min(cases.length,Number(process.env.OTP_E2E_CASE_LIMIT||cases.length));i++){if(existsSync('runtime/e2e-stop'))throw Error('E2E_STOP_REQUESTED');await test(`${from} to ${to}: ${cases[i].name}`,async()=>{
   const c=cases[i],subject=`${run}-${from}-${i}`,provider=`e2e-${run}-${from}-${i}`;
   const rule=ruleSchema.parse({providerUid:provider,purpose:c.purpose,version:1,senders:[accounts[from].email],subjectMode:'contains',subject,purposeMarkers:[c.marker],pattern:c.pattern,stripSpaces:c.spaces||false,stripHyphens:c.hyphens||false});
   assert.equal((await http('/v1/rules/validate',rule)).status,200,'RULE_VALIDATE_FAILED');
   const rulePath=`/v1/providers/${provider}/rules/${c.purpose}`;
   assert.equal((await http(rulePath+'/versions/1',rule,'PUT')).status,200,'RULE_SYNC_FAILED');
   const start=Math.floor(Date.now()/1000)-2;
   await sendPlayground(store,gmail,executor,from,to,subject,c.body);
   const uid=randomUUID(),input={requestUid:uid,attemptUid:uid,providerUid:provider,accountUid:'playground-'+to,targetEmail:accounts[to].email,purpose:rule.purpose,ruleVersion:1,windowStartedAt:start,lookupDeadlineAt:Math.floor(Date.now()/1000)+60,otpValiditySeconds:300,excludedSourceMessageRefs:[]};
   stageLog('verify_mail');const verifyStarted=Date.now(),verified=await http(rulePath+'/versions/1/verify',input);report.lookups.push({direction:`${from} to ${to}`,purpose:c.purpose,kind:'verification',elapsedMs:Date.now()-verifyStarted,status:verified.status});
   assert.equal(verified.status,200,'VERIFY_'+verified.status+'_'+verified.data.error?.code);
   assert.equal((await http(rulePath+'/activate',{version:1,commandUid:randomUUID(),expectedActiveRevision:0})).status,200,'ACTIVATION_FAILED');
   await sendPlayground(store,gmail,executor,from,to,subject+'-live',c.body);
   const liveUid=randomUUID(),liveInput={...input,requestUid:liveUid,attemptUid:liveUid,lookupDeadlineAt:Math.floor(Date.now()/1000)+60};
   stageLog('normal_lookup');const lookupStarted=Date.now(),live=await http('/v1/lookups',liveInput,'POST',liveUid);report.lookups.push({direction:`${from} to ${to}`,purpose:c.purpose,kind:'normal',elapsedMs:Date.now()-lookupStarted,status:live.status});
   assert.equal(live.status,200,'LIVE_'+live.status+'_'+live.data.error?.code);
   const replay=live.data as {outcome:string;code:string};
   const replayHTTP=await http('/v1/lookups',liveInput,'POST',liveUid);assert.equal(replayHTTP.status,200);assert.equal(replayHTTP.data.replayed,true,'REPLAY_FAILED');assert.equal(replayHTTP.data.sourceMessageRef,live.data.sourceMessageRef,'REPLAY_SOURCE_CHANGED');
   assert.equal(replay.outcome,'FOUND','NOT_FOUND');assert.ok(replay.code===c.code,'WRONG_SYNTHETIC_CODE');
   assert.equal(executor.stats().active,0,'PROFILE_NOT_CLOSED');
   const source=store.read(liveUid).sourceMessageRef;
   assert.ok(store.used(accounts[to].email,source,'new-attempt',Math.floor(Date.now()/1000)),'SOURCE_NOT_RESERVED');
  });}
 }
 await test('unknown profile rejected through HTTP',async()=>{
  const rule=ruleSchema.parse({providerUid:'negative-'+run,purpose:'LOGIN',version:1,senders:[accounts[0].email],subjectMode:'exact',subject:run,purposeMarkers:['sign-in'],pattern:'(?<otp>[0-9]{6})'});store.syncRule(rule);store.activate('negative-'+run,'LOGIN',1);
  const now=Math.floor(Date.now()/1000),uid=randomUUID();const res=await http('/v1/lookups',{requestUid:uid,attemptUid:uid,providerUid:'negative-'+run,accountUid:'none',targetEmail:'absent@example.test',purpose:'LOGIN',ruleVersion:1,windowStartedAt:now-1,lookupDeadlineAt:now+10},'POST',uid);assert.equal(res.status,404);
 });
 report.complete=report.cases.filter(c=>/^[01] to [01]:/.test(c.name)&&c.status==='PASS').length===10;
 if(!report.complete)throw Error('GMAIL_MATRIX_INCOMPLETE');
}finally{await retrieval.shutdown();await new Promise<void>(r=>server.close(()=>r()));store.close();writeFileSync('artifacts/gmail-e2e.json',JSON.stringify(report,null,2));writeFileSync('artifacts/'+run+'.json',JSON.stringify(report,null,2));}
if(report.cases.some(c=>c.status!=='PASS'))process.exitCode=1;

import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {accounts,sendPlayground} from './playground.js';
import {Store} from '../src/store.js';
import {Gmail} from '../src/browser.js';
import {Executor} from '../src/executor.js';
import {Retrieval} from '../src/service.js';
import {createApp} from '../src/app.js';
import {ruleSchema} from '../src/contracts.js';
if(process.env.OTP_REAL_GMAIL_E2E!=='true')throw Error('Explicit two-account playground opt-in required');
const fixtures=JSON.parse(readFileSync('fixtures/synthetic_otp_emails.json','utf8')) as {id:string;subject:string;body:string;html?:string;expected:{otp:string}}[];
const rules=[
 {purpose:'LOGIN',purposeMarkers:['signing in'],pattern:'Use (?<otp>[0-9]{6})'},
 {purpose:'PAYMENT',purposeMarkers:['payment'],pattern:'passcode is (?<otp>[0-9]{4})'},
 {purpose:'LOGIN',purposeMarkers:['sign-in'],pattern:'code (?<otp>[A-Z0-9-]{7})',stripHyphens:true},
 {purpose:'LOGIN',purposeMarkers:['new device'],pattern:'code:\\s*(?<otp>[0-9\\s]{11})',stripSpaces:true},
 {purpose:'LOGIN',purposeMarkers:['signing in'],pattern:'(?<![0-9])(?<otp>[0-9]{8})(?![0-9])',source:'both'}
];
assert.equal(fixtures.length,rules.length);
const run='OTP-E2E-'+Date.now(),cases:{name:string;status:string;elapsedMs:number;error?:string}[]=[];
const store=new Store(process.env.OTP_STATE_DB||'runtime/gmail-matrix.sqlite',Buffer.from(process.env.OTP_RETRIEVAL_KEY||'','base64'));
const gmail=new Gmail(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),executor=new Executor(2),service=new Retrieval(store,gmail,executor,1000);
const server=createApp(service,process.env.OTP_RETRIEVAL_TOKEN||'').listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
const base='http://127.0.0.1:'+(server.address() as {port:number}).port;mkdirSync('artifacts',{recursive:true});
function report(){writeFileSync('artifacts/'+run+'-original-fixtures.json',JSON.stringify({run,complete:cases.length===10&&cases.every(c=>c.status==='PASS'),boundary:'Actual REST/Gmail, original synthetic formats in both directions. Preconfigured synthetic rules; no production activation claim.',cases},null,2));}
try{
 for(const from of [0,1])for(let i=0;i<fixtures.length;i++){
  if(existsSync('runtime/e2e-stop'))throw Error('E2E_STOP_REQUESTED');
  const started=Date.now(),fixture=fixtures[i],to=1-from,name=`${from} to ${to}: ${fixture.id}`;
  try{
   const subject=run+'-'+from+'-'+i+' '+fixture.subject,rule=ruleSchema.parse({providerUid:run+'-'+from+'-'+i,version:1,senders:[accounts[from].email],subjectMode:'exact',subject,...rules[i]});store.syncRule(rule);store.activate(rule.providerUid,rule.purpose,1);
   const start=Math.floor(Date.now()/1000)-1;await sendPlayground(store,gmail,executor,from,to,subject,fixture.body,undefined,fixture.html);
   const id=randomUUID(),body={requestUid:id,attemptUid:id,providerUid:rule.providerUid,accountUid:'original-fixture-'+to,targetEmail:accounts[to].email,purpose:rule.purpose,ruleVersion:1,windowStartedAt:start,lookupDeadlineAt:Math.floor(Date.now()/1000)+60,otpValiditySeconds:300};
   const response=await fetch(base+'/v1/lookups',{method:'POST',headers:{authorization:'Bearer '+process.env.OTP_RETRIEVAL_TOKEN,'content-type':'application/json','idempotency-key':id},body:JSON.stringify(body)}),result=await response.json();
   assert.equal(response.status,200,'FIXTURE_'+result.error?.code);assert.equal(result.outcome,'FOUND');assert.ok(result.code===fixture.expected.otp,'WRONG_SYNTHETIC_CODE');assert.equal(executor.stats().active,0);
   cases.push({name,status:'PASS',elapsedMs:Date.now()-started});
  }catch(error){cases.push({name,status:'FAIL',elapsedMs:Date.now()-started,error:error instanceof Error?error.message.slice(0,120):'UNKNOWN'});throw error;}finally{report();console.log(JSON.stringify(cases.at(-1)));}
 }
}catch{process.exitCode=1;}finally{await service.shutdown();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();report();}

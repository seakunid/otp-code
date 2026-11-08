import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {accounts,sendPlayground} from './playground.js';
import {Store} from '../src/store.js';
import {Gmail} from '../src/browser.js';
import {Executor} from '../src/executor.js';
import {Retrieval} from '../src/service.js';
import {createApp} from '../src/app.js';
import {ruleSchema} from '../src/contracts.js';
if(process.env.OTP_REAL_GMAIL_E2E!=='true')throw Error('Explicit two-account playground opt-in required');
const started=Date.now(),run='OTP-E2E-'+started,timings:{stage:string;elapsedMs:number;count?:number;error?:string}[]=[];
const mark=(stage:string,extra={})=>{const item={stage,elapsedMs:Date.now()-started,...extra};timings.push(item);console.log(JSON.stringify(item));};
const store=new Store(process.env.OTP_STATE_DB||'runtime/gmail-matrix.sqlite',Buffer.from(process.env.OTP_RETRIEVAL_KEY||'','base64')),gmail=new Gmail(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),executor=new Executor(2);
const read=gmail.read.bind(gmail);gmail.read=async(...args)=>{mark('read_start');try{const result=await read(...args);mark('read_end',{count:result.length});return result;}catch(error){mark('read_failure',{error:error instanceof Error?error.message.slice(0,100):'UNKNOWN'});throw error;}};
const service=new Retrieval(store,gmail,executor,1000),server=createApp(service,process.env.OTP_RETRIEVAL_TOKEN||'').listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
const rule=ruleSchema.parse({providerUid:run,purpose:'LOGIN',version:1,senders:[accounts[1].email],subjectMode:'exact',subject:run,purposeMarkers:['sign-in code'],pattern:'code is (?<otp>[0-9]{6})'});store.syncRule(rule);store.activate(rule.providerUid,rule.purpose,1);
let status='FAIL',errorCode='';
try{
 const now=Math.floor(Date.now()/1000),id=randomUUID(),body={requestUid:id,attemptUid:id,providerUid:run,accountUid:'delayed-playground',targetEmail:accounts[0].email,purpose:'LOGIN',ruleVersion:1,windowStartedAt:now,lookupDeadlineAt:now+60,otpValiditySeconds:300};
 const pending=fetch('http://127.0.0.1:'+(server.address() as {port:number}).port+'/v1/lookups',{method:'POST',headers:{authorization:'Bearer '+process.env.OTP_RETRIEVAL_TOKEN,'content-type':'application/json','idempotency-key':id},body:JSON.stringify(body)});
 await new Promise(resolve=>setTimeout(resolve,5000));mark('send_start');await sendPlayground(store,gmail,executor,1,0,run,'Your sign-in code is 031972. Synthetic delayed delivery.',stage=>mark('send_'+stage));mark('send_acknowledged');
 const response=await pending,result=await response.json();mark('lookup_end',{status:response.status});assert.equal(response.status,200,'DELAYED_'+result.error?.code);assert.ok(result.code==='031972','DELAYED_WRONG_CODE');assert.equal(executor.stats().active,0);status='PASS';
}catch(error){process.exitCode=1;errorCode=error instanceof Error?error.message.slice(0,100):'UNKNOWN';}finally{await service.shutdown();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/'+run+'-delayed.json',JSON.stringify({run,status,error:errorCode,timings},null,2));}

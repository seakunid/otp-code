import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {accounts,sendPlayground} from './playground.js';
import {Store} from '../src/store.js';
import {Gmail} from '../src/browser.js';
import {Executor} from '../src/executor.js';
import {Retrieval} from '../src/service.js';
import {createApp} from '../src/app.js';
import {lookupSchema,ruleSchema} from '../src/contracts.js';
import type {Page} from 'puppeteer-core';
if(process.env.OTP_REAL_GMAIL_E2E!=='true')throw Error('Explicit two-account playground opt-in required');
const run='OTP-E2E-'+Date.now(),cases:{name:string;status:string;elapsedMs:number;error?:string}[]=[];
const store=new Store(process.env.OTP_STATE_DB||'runtime/gmail-matrix.sqlite',Buffer.from(process.env.OTP_RETRIEVAL_KEY||'','base64'));
const gmail=new Gmail(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),executor=new Executor(2),service=new Retrieval(store,gmail,executor,1000);
const server=createApp(service,process.env.OTP_RETRIEVAL_TOKEN||'').listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
const base='http://127.0.0.1:'+(server.address() as {port:number}).port;mkdirSync('artifacts',{recursive:true});
async function test(name:string,fn:()=>Promise<void>){const started=Date.now();try{await fn();cases.push({name,status:'PASS',elapsedMs:Date.now()-started});}catch(error){cases.push({name,status:'FAIL',elapsedMs:Date.now()-started,error:error instanceof Error?error.message.slice(0,120):'UNKNOWN'});throw error;}finally{writeFileSync('artifacts/'+run+'-folders.json',JSON.stringify({run,boundary:'Actual Windows REST/Gmail with preconfigured synthetic rules. Only current-run synthetic messages may move. Spam/Trash fixtures are restored to Inbox.',cases},null,2));console.log(JSON.stringify(cases.at(-1)));}}
async function profile(index:number,fn:(page:Page)=>Promise<void>){const p=store.profile(accounts[index].email)!;return executor.run(p.uid,Date.now()+60000,new AbortController().signal,async()=>{try{const browser=await gmail.open(p,Date.now()+30000),page=await browser.newPage();page.setDefaultTimeout(10000);await gmail.verify(page,p.email,Date.now()+30000);await fn(page);}finally{await gmail.close(p);}});}
async function thread(page:Page,subject:string,folder='in:anywhere'){
 assert.ok(subject.startsWith(run+'-'),'CURRENT_RUN_TAG_REQUIRED');
 await page.goto('https://mail.google.com/mail/u/0/#search/'+encodeURIComponent(folder+' subject:"'+subject+'"'),{waitUntil:'domcontentloaded'});
 await page.waitForFunction(expected=>[...document.querySelectorAll('tr.zA')].some(e=>e.getBoundingClientRect().height>0&&e.querySelector('.bog')?.textContent?.trim()===expected),{polling:100},subject);
 const refs=await page.evaluate(expected=>[...document.querySelectorAll('tr.zA')].filter(e=>e.getBoundingClientRect().height>0&&e.querySelector('.bog')?.textContent?.trim()===expected).map(e=>e.getAttribute('data-legacy-thread-id')||e.querySelector('[data-legacy-thread-id]')?.getAttribute('data-legacy-thread-id')),subject);
 assert.equal(refs.length,1,'ONE_SYNTHETIC_THREAD_REQUIRED');assert.match(refs[0]||'',/^[a-f0-9]+$/i);
 await page.goto('https://mail.google.com/mail/u/0/#all/'+refs[0],{waitUntil:'domcontentloaded'});await page.waitForSelector('.a3s',{visible:true});
 assert.equal(await page.$eval('h2.hP',e=>e.textContent?.trim()),subject,'SYNTHETIC_THREAD_IDENTITY');
}
async function button(page:Page,label:string){const handle=await page.waitForSelector(`[role="button"][aria-label="${label}"], [role="button"][data-tooltip="${label}"]`,{visible:true});await handle!.asLocator().click();}
function rule(subject:string,sender=accounts[0].email){const r=ruleSchema.parse({providerUid:subject,purpose:'LOGIN',version:1,senders:[sender],subjectMode:'exact',subject,purposeMarkers:['sign-in code'],pattern:'code is (?<otp>[0-9]{6})'});store.syncRule(r);store.activate(r.providerUid,r.purpose,r.version);return r;}
async function lookup(subject:string,start:number,to=1,seconds=60,sender=accounts[0].email){const r=rule(subject,sender),id=randomUUID(),body=lookupSchema.parse({requestUid:id,attemptUid:id,providerUid:r.providerUid,accountUid:'folder-playground-'+to,targetEmail:accounts[to].email,purpose:'LOGIN',ruleVersion:1,windowStartedAt:start,lookupDeadlineAt:Math.floor(Date.now()/1000)+seconds,otpValiditySeconds:300});const response=await fetch(base+'/v1/lookups',{method:'POST',headers:{authorization:'Bearer '+process.env.OTP_RETRIEVAL_TOKEN,'content-type':'application/json','idempotency-key':id},body:JSON.stringify(body)});return{status:response.status,body:await response.json()};}
async function send(subject:string){const start=Math.floor(Date.now()/1000)-1;await sendPlayground(store,gmail,executor,0,1,subject,'Your sign-in code is 001234. Synthetic folder fixture.');return start;}
try{
 await test('Inbox received message returns exact synthetic code',async()=>{const subject=run+'-inbox',start=await send(subject),response=await lookup(subject,start);assert.equal(response.status,200,'INBOX_'+response.body.error?.code);assert.ok(response.body.code==='001234','WRONG_SYNTHETIC_CODE');});
 await test('Archive received message remains searchable through actual REST',async()=>{const subject=run+'-archive',start=await send(subject);await profile(1,async page=>{await thread(page,subject);await button(page,'Archive');await page.waitForFunction(()=>/Conversation archived/.test(document.body.innerText),{polling:100});});const response=await lookup(subject,start);assert.equal(response.status,200,'ARCHIVE_'+response.body.error?.code);assert.ok(response.body.code==='001234','WRONG_SYNTHETIC_CODE');});
 await test('Social category received message remains searchable through actual REST',async()=>{
  const subject=run+'-social',start=await send(subject);
  await profile(1,async page=>{await thread(page,subject);await button(page,'Move to');await page.waitForFunction(()=>{const item=[...document.querySelectorAll<HTMLElement>('[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]')].find(e=>e.getBoundingClientRect().height>0&&e.textContent?.trim()==='Social');if(!item)return false;item.click();return true;},{polling:100});await thread(page,subject,'category:social');});
  const response=await lookup(subject,start);assert.equal(response.status,200,'CATEGORY_'+response.body.error?.code);assert.ok(response.body.code==='001234','WRONG_SYNTHETIC_CODE');
 });
 for(const folder of ['spam','trash'])await test(folder+' fixture is excluded and restored without deletion',async()=>{
  const subject=run+'-'+folder,start=await send(subject);let moved=false;
  try{
   await profile(1,async page=>{await thread(page,subject);await button(page,folder==='spam'?'Report spam':'Delete');moved=true;
    if(folder==='spam'){const dialog=await page.$('[role="alertdialog"], [role="dialog"]');if(dialog){const buttons=await dialog.$$('[role="button"],button');for(const b of buttons)if(await b.evaluate(e=>e.textContent?.trim()==='Report spam')){await b.asLocator().click();break;}}}
    await thread(page,subject,'in:'+folder);
   });
   const response=await lookup(subject,start,1,15);assert.equal(response.status,504,'EXCLUSION_'+response.body.error?.code);assert.equal(response.body.code,undefined);
  }finally{if(moved)await profile(1,async page=>{await thread(page,subject,'in:'+folder);if(folder==='spam')await button(page,'Not spam');else{await button(page,'Move to');await page.waitForFunction(()=>{const e=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(e=>e.getBoundingClientRect().height>0&&e.textContent?.trim()==='Inbox');if(!e)return false;e.click();return true;},{polling:100});}});}
 });
 await test('a message only sent by an account is not received by that account',async()=>{const subject=run+'-sent-only',start=await send(subject);await profile(0,async page=>{await thread(page,subject,'in:sent');});const response=await lookup(subject,start,0,15);assert.equal(response.status,504,'SENT_ONLY_'+response.body.error?.code);assert.equal(response.body.code,undefined);});
 await test('current-run draft is excluded and retained for inspection',async()=>{
  const subject=run+'-draft',start=Math.floor(Date.now()/1000)-1;
  await profile(1,async page=>{await page.click('[gh="cm"]');const input=await page.waitForSelector('input[name="subjectbox"]',{visible:true});const dialog=(await input!.evaluateHandle(e=>e.closest('[role="dialog"]'))).asElement();assert.ok(dialog);const recipient=await dialog.waitForSelector('input[role="combobox"][aria-label="To recipients"],input[name="to"]',{visible:true});await recipient!.type(accounts[0].email);await page.keyboard.press('Enter');await input!.type(subject);const body=await dialog.waitForSelector('[role="textbox"][contenteditable="true"][aria-label="Message Body"]',{visible:true});await body!.type('Your sign-in code is 001234. Synthetic unsent draft.');await page.waitForFunction(()=>/Saved to Drafts/.test(document.body.innerText),{polling:100});});
  const response=await lookup(subject,start,1,15,accounts[1].email);assert.equal(response.status,504,'DRAFT_'+response.body.error?.code);assert.equal(response.body.code,undefined);
 });
}catch{process.exitCode=1;}finally{await service.shutdown();await new Promise<void>(r=>server.close(()=>r()));store.close();}

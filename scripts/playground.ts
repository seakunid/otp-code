import {Store} from '../src/store.js';
import {Gmail} from '../src/browser.js';
import {Executor} from '../src/executor.js';
import assert from 'node:assert/strict';
import type {Page} from 'puppeteer-core';
export async function waitForSendAcknowledgement(page:Pick<Page,'waitForFunction'>,deadline:number){
 while(Date.now()<deadline){
  try{await page.waitForFunction(()=>document.documentElement.getAttribute('data-otp-sent')==='true',{polling:100,timeout:Math.min(3000,deadline-Date.now())});return;}
  catch(error){if(!(error instanceof Error)||error.name!=='TimeoutError')throw error;}
 }
 throw Error('SEND_NOT_ACKNOWLEDGED');
}
export const accounts=[{email:'nebula.together@gmail.com',directory:'C:\\Users\\nebula\\otp-browser-profiles\\nebula.together'},{email:'abbyfc.dev@gmail.com',directory:'C:\\Users\\nebula\\otp-browser-profiles\\otp-account-02\\profile'}];
export async function sendPlayground(store:Store,gmail:Gmail,executor:Executor,from:number,to:number,subject:string,body:string,stageLog:(stage:string)=>void=()=>{},fixtureHtml?:string){let stage='open';stageLog(stage);
 if(from===to||!accounts[from]||!accounts[to])throw Error('PLAYGROUND_RECIPIENT_DENIED');
 const p=store.profile(accounts[from].email)!;if(!p)throw Error('PLAYGROUND_PROFILE_MISSING');
 // Synthetic sending has its own budget; retrieval still uses the API lookup deadline.
 const deadline=Date.now()+120000;
 await executor.run(p.uid,deadline,new AbortController().signal,async()=>{
  try{
   const browser=await gmail.open(p,Date.now()+45000),page=await browser.newPage();page.setDefaultTimeout(10000);
   // Only the fixed synthetic HTML fixture needs DOM insertion past Gmail's Trusted Types policy.
   if(fixtureHtml)await page.setBypassCSP(true);
   await gmail.verify(page,p.email,Date.now()+45000);store.enable(p.uid);
   // Gmail exposes Compose before its initial sync settles in this Windows VM.
   await new Promise(resolve=>setTimeout(resolve,10000));
   if(await page.evaluate(()=>/reached (?:a |your )?limit for sending|sending limit reached|unusual activity|temporarily blocked/i.test(document.body.innerText)))throw Error('GMAIL_ACCOUNT_WARNING');
   stage='compose';stageLog(stage);await page.waitForSelector('[gh="cm"]',{visible:true});
   await page.evaluate(()=>document.querySelectorAll('input[name="subjectbox"]').forEach(e=>e.setAttribute('data-otp-existing','1')));
   await page.click('[gh="cm"]');
   await page.waitForSelector('input[name="subjectbox"]:not([data-otp-existing])',{visible:true});
   const subjectInput=await page.$('input[name="subjectbox"]:not([data-otp-existing])');
   const composeHandle=await subjectInput!.evaluateHandle(e=>e.closest('[role="dialog"]'));
   const compose=composeHandle.asElement();if(!compose)throw Error('COMPOSE_SCOPE_MISSING');
   const toSelector='input[role="combobox"][aria-label="To recipients"], input[name="to"], input[aria-label="To"]';
   stage='recipient';stageLog(stage);const recipient=await compose.waitForSelector(toSelector,{visible:true});await recipient!.type(accounts[to].email);await page.keyboard.press('Enter');
   stage='subject';stageLog(stage);await subjectInput!.type(subject);
   stage='body';stageLog(stage);const bodyInput=await compose.waitForSelector('[role="textbox"][contenteditable="true"][aria-label="Message Body"]',{visible:true});
   if(fixtureHtml)await bodyInput!.evaluate((element,html)=>{element.innerHTML=html;element.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertFromPaste'}));},fixtureHtml);else await bodyInput!.type(body);
   const typed=await subjectInput!.evaluate(e=>(e as HTMLInputElement).value);assert.equal(typed,subject,'SYNTHETIC_SUBJECT_MISMATCH');
   await page.evaluate(()=>{
    document.documentElement.removeAttribute('data-otp-sent');
    const observer=new MutationObserver(()=>{if(/Message sent/.test(document.body.innerText)){document.documentElement.setAttribute('data-otp-sent','true');observer.disconnect();}});
    observer.observe(document.body,{childList:true,subtree:true,characterData:true});
   });
   stage='send';stageLog(stage);await page.bringToFront();await bodyInput!.focus();await page.keyboard.down('Control');await page.keyboard.press('Enter');await page.keyboard.up('Control');
   // Gmail may ask for confirmation the first time its send shortcut is used.
   try{await page.waitForFunction(()=>/Ready to send\?/.test(document.body.innerText)||document.documentElement.getAttribute('data-otp-sent')==='true',{polling:100,timeout:3000});}catch{}
   if(await page.evaluate(()=>/Ready to send\?/.test(document.body.innerText))){const confirmation=await page.$('[role="alertdialog"], [role="dialog"]:not(:has(input[name="subjectbox"]))');if(!confirmation)throw Error('SEND_CONFIRMATION_MISSING');const buttons=await confirmation.$$('[role="button"],button');let confirmed=false;for(const button of buttons)if(await button.evaluate(e=>e.textContent?.trim()==='Send')){await button.asLocator().click();confirmed=true;break;}if(!confirmed)throw Error('SEND_CONFIRMATION_MISSING');}
   stage='sent_confirmation';stageLog(stage);
   // Short waits keep the 120-second send budget independent of Chrome's CDP command timeout.
   try{await waitForSendAcknowledgement(page,deadline-5000);}
   catch{
    console.error(JSON.stringify({event:'playground_send_unconfirmed',...(await page.evaluate((expected)=>({sending:/Sending/.test(document.body.innerText),sent:/Message sent/.test(document.body.innerText),warning:/reached (?:a |your )?limit for sending|sending limit|unusual activity|temporarily blocked|couldn.t send|unable to send/i.test(document.body.innerText),offline:/trying to connect|not connected|you.re offline/i.test(document.body.innerText),composeCount:document.querySelectorAll('input[name=subjectbox]').length,expectedDraft:[...document.querySelectorAll<HTMLInputElement>('input[name=subjectbox]')].some(e=>e.value===expected),uiButtons:[...document.querySelectorAll<HTMLElement>('[role=button]')].filter(e=>e.getBoundingClientRect().height>0&&!e.closest('tr.zA,.a3s')).map(e=>(e.innerText||e.getAttribute('aria-label')||'').trim()).filter(x=>/^(Send|Cancel|OK|Got it|Continue|Discard|Undo|View message|Close|Save|Retry|Try again|Delete|Message sent|Don.t send)/i.test(x)).map(x=>x.replace(/[^A-Za-z .()]/g,'').slice(0,60))}),subject).catch(()=>({pageUnavailable:true})))}));throw Error('SEND_NOT_ACKNOWLEDGED');
   }
   // Chrome must stay open until Gmail confirms sending; recipient-side equality proves delivery. Never resend an uncertain send.

  }catch(e){throw new Error(stage+': '+(e instanceof Error?e.message:'UNKNOWN'));}finally{await gmail.close(p);}
 });
}

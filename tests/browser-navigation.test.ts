import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync,readFileSync} from 'node:fs';
import puppeteer from 'puppeteer-core';
import {Gmail} from '../src/browser.js';
import {lookupSchema,ruleSchema} from '../src/contracts.js';

const chrome=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
test('Gmail reads at most five candidate mails or eight threads',()=>{
 const source=readFileSync('src/browser.ts','utf8');
 assert.match(source,/const MAX_THREADS=8;/);
 assert.match(source,/messages\.length>=MAX_CANDIDATE_MESSAGES\|\|opened>=MAX_THREADS/);
});
test('Gmail opens each search result through its thread URL', {skip:!existsSync(chrome)},async()=>{
 const paths:string[]=[];
 const server=createServer((req,res)=>{
  const path=req.url||'';paths.push(path);res.setHeader('Content-Type','text/html; charset=utf-8');
  if(path==='/search'){
   res.end(`<div>1–1 of 1<button aria-label="Older" aria-disabled="true">Older</button></div><table><tr class="zA"><td data-legacy-thread-id="abc123"><span class="bog">Test code</span></td></tr></table>`);
  }else if(path==='/thread'){
   res.end(`<h2 class="hP">Test code</h2><div class="adn" data-legacy-message-id="def456"><span class="gD" email="sender@example.test"></span><div class="a3s">Your sign-in code is 001234</div><button aria-label="More message options" onclick="document.querySelector('#original').hidden=false">More</button></div><button id="original" role="menuitem" hidden onclick="window.open('/original')">Show original</button>`);
  }else if(path==='/original'){
   const raw=`Delivered-To: target@example.test\nReceived: by mx.google.com; ${new Date().toUTCString().replace('GMT','+0000')}\nFrom: sender@example.test\nSubject: Test code\nMessage-ID: &lt;navigation@example.test&gt;\nAuthentication-Results: mx.google.com; dkim=pass header.i=@example.test\n\nbody`;
   res.end('<pre>'+raw+'</pre>');
  }else{res.statusCode=404;res.end('Unknown legacy route');}
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const browser=await puppeteer.launch({executablePath:chrome,headless:true,pipe:true});
 try{
  const gmail=new Gmail(chrome),page=await browser.newPage(),goto=page.goto.bind(page);
  page.goto=(url,options)=>goto(url.endsWith('/abc123')?base+'/thread':url.includes('/#search/')?base+'/search':base+'/legacy',options);
  gmail.open=async()=>browser;gmail.verify=async()=>{};
  const newPage=browser.newPage.bind(browser);browser.newPage=async()=>page;
  const now=Math.floor(Date.now()/1000),input=lookupSchema.parse({requestUid:'r',attemptUid:'a',providerUid:'p',accountUid:'c',targetEmail:'target@example.test',purpose:'LOGIN',ruleVersion:1,windowStartedAt:now-1,lookupDeadlineAt:now+15,otpValiditySeconds:300});
  const rule=ruleSchema.parse({providerUid:'p',purpose:'LOGIN',version:1,senders:['sender@example.test'],subjectMode:'exact',subject:'Test code'});
  const messages=await gmail.read({uid:'p',email:input.targetEmail,directory:'unused',enabled:1,verified:1,revision:1},input,rule,new AbortController().signal);
  browser.newPage=newPage;
  assert.equal(messages.length,1);assert.equal(messages[0].ref,'gmail:<navigation@example.test>');assert.equal(messages[0].body,'Your sign-in code is 001234');assert.equal(paths.includes('/legacy'),false);
 }finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

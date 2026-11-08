import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Gmail} from '../src/browser.js';
import type {Page} from 'puppeteer-core';
test('Gmail readiness retries a stalled page within the original deadline and rejects another account',async()=>{
 const gmail=new Gmail('unused');let navigations=0,focus=0,url='about:blank',title='';
 const page={bringToFront:async()=>{focus++;},goto:async(value:string)=>{url=value;if(value!=='about:blank')navigations++;},waitForFunction:async()=>{if(navigations===1)throw Error('stalled');title='Inbox - target@example.test - Gmail';},url:()=>url,title:async()=>title,waitForSelector:async()=>{}} as unknown as Page;
 await gmail.verify(page,'target@example.test',Date.now()+5000);assert.equal(navigations,2);assert.equal(focus,1);
 await assert.rejects(gmail.verify(page,'other@example.test',Date.now()+5000),/ACCOUNT_MISMATCH/);
});

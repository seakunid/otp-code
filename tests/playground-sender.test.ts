import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Page} from 'puppeteer-core';
import {waitForSendAcknowledgement} from '../scripts/playground.js';
test('sender acknowledgement polls within the original deadline without a long CDP wait',async()=>{
 let calls=0;
 const page={waitForFunction:async(_fn:unknown,options:{timeout:number})=>{assert.ok(options.timeout>0&&options.timeout<=3000);if(++calls<3){const error=new Error('pending');error.name='TimeoutError';throw error;}}} as unknown as Page;
 await waitForSendAcknowledgement(page,Date.now()+10000);assert.equal(calls,3);
 await assert.rejects(waitForSendAcknowledgement(page,Date.now()-1),/SEND_NOT_ACKNOWLEDGED/);assert.equal(calls,3);
 const broken={waitForFunction:async()=>{throw Error('Target closed');}} as unknown as Page;
 await assert.rejects(waitForSendAcknowledgement(broken,Date.now()+10000),/Target closed/);
});

import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {extract} from '../src/extraction.js';import {ruleSchema} from '../src/contracts.js';
const fixtures=JSON.parse(readFileSync('fixtures/synthetic_otp_emails.json','utf8'));
const rules=[
 {purpose:'LOGIN',purposeMarkers:['signing in'],pattern:'Use (?<otp>[0-9]{6})'},
 {purpose:'PAYMENT',purposeMarkers:['payment'],pattern:'passcode is (?<otp>[0-9]{4})'},
 {purpose:'LOGIN',purposeMarkers:['sign-in'],pattern:'code (?<otp>[A-Z0-9-]{7})',stripHyphens:true},
 {purpose:'LOGIN',purposeMarkers:['new device'],pattern:'code: (?<otp>[0-9 ]{11})',stripSpaces:true},
 {purpose:'LOGIN',purposeMarkers:['signing in'],pattern:'(?<otp>[0-9]{8})',source:'both'}
];
for(let i=0;i<fixtures.length;i++)test('original fixture '+fixtures[i].id,async()=>{
 const f=fixtures[i],rule=ruleSchema.parse({providerUid:'fixture',version:1,senders:['sender@example.test'],subjectMode:'exact',subject:f.subject,...rules[i]});const result=await extract(rule,{ref:'fixture:'+i,sender:'sender@example.test',subject:f.subject,body:f.body,receivedAt:1});assert.equal(result.code,f.expected.otp);
});
test('explicit purpose requires matching context for all wrong-purpose pairs',async()=>{
 const types=['LOGIN','PAYMENT','PASSWORD_RESET'] as const;
 const bodies={LOGIN:'Your sign-in code is 001234',PAYMENT:'Your payment code is 001234',PASSWORD_RESET:'Your password reset code is 001234'};
 for(const requested of types)for(const actual of types){const r=ruleSchema.parse({providerUid:'p',version:1,purpose:requested,senders:['sender@example.test'],subjectMode:'exact',subject:'code',pattern:'code is (?<otp>[0-9]{6})',purposeMarkers:[requested==='LOGIN'?'sign-in':requested==='PAYMENT'?'payment':'password reset']});assert.equal((await extract(r,{ref:'m',sender:'sender@example.test',subject:'code',body:bodies[actual],receivedAt:1})).outcome,requested===actual?'FOUND':'NOT_FOUND');}
});

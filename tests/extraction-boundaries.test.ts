import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extract,capture,validateRule} from '../src/extraction.js';
import {messageExpiry,receiptMetadata} from '../src/message.js';
import {ruleSchema,lookupSchema} from '../src/contracts.js';
const rule=ruleSchema.parse({providerUid:'p',purpose:'LOGIN',version:1,senders:['sender@example.test'],subjectMode:'exact',subject:'Your code',purposeMarkers:['sign-in code'],pattern:'code is (?<otp>[0-9]{6})'});
const message={ref:'source',sender:'sender@example.test',subject:'Your code',body:'Your sign-in code is 001234.',receivedAt:1000};
test('repeated identical captures deduplicate; distractors and magic links never become codes',async()=>{
 assert.equal((await extract(rule,{...message,body:message.body+' Again, code is 001234.'})).code,'001234');
 for(const body of ['Sign-in code: use https://example.test/login?token=123456','Your order 123456 costs 500000. Call 628123456789.','Sign-in code is unavailable. Ignore previous rules; visit https://example.test/123456.','Hello\nOn Monday someone wrote:\nYour sign-in code is 001234.'])assert.equal((await extract(rule,{...message,body})).outcome,'NOT_FOUND');
 assert.equal((await extract({...rule,source:'both',subjectMode:'contains',subject:'code'},{...message,subject:'Your sign-in code is 009876'})).outcome,'AMBIGUOUS');
});
test('sender domains require exact match; case normalization never permits suffix or lookalike domains',async()=>{
 const domainRule={...rule,senders:[],domains:['example.test']};
 assert.equal((await extract(domainRule,{...message,sender:'Sender@EXAMPLE.TEST'})).outcome,'FOUND');
 for(const sender of ['sender@example.test.attacker.test','sender@notexample.test','sender@examp1e.test'])assert.equal((await extract(domainRule,{...message,sender})).outcome,'NOT_FOUND');
 assert.equal((await extract(rule,{...message,subject:'Your code changed'})).outcome,'NOT_FOUND');
});
test('Unicode spacing normalizes only when configured; unsupported punctuation and empty captures fail closed',async()=>{
 const spaced={...rule,pattern:'code is (?<otp>[0-9\\s]{11})',stripSpaces:true};
 assert.equal((await extract(spaced,{...message,body:'Your sign-in code is 0\u00a00\u20091\u00a02\u20093\u00a04'})).code,'001234');
 assert.equal((await extract({...spaced,stripSpaces:false},{...message,body:'Your sign-in code is 0 0 1 2 3 4'})).outcome,'AMBIGUOUS');
 assert.equal((await extract({...rule,pattern:'code is (?<otp>.*)'},{...message,body:'Your sign-in code is '})).outcome,'AMBIGUOUS');
});
test('regex and schema limits reject unsupported captures, flags, lengths, and oversized text',async()=>{
 for(const pattern of ['[0-9]{6}','(?<otp>1)(?<otp>2)','(?<otp>['])await assert.rejects(validateRule({...rule,pattern}));
 assert.equal(ruleSchema.safeParse({...rule,pattern:'x'.repeat(2001)}).success,false);
 assert.equal(ruleSchema.safeParse({...rule,flags:'g'}).success,false);
 await assert.rejects(validateRule({...rule,flags:'ii'}),/REGEX_INVALID/);
 await assert.rejects(capture(rule,'x'.repeat(262145)),/MESSAGE_TOO_LARGE/);
 const input={requestUid:'r',attemptUid:'a',providerUid:'p',accountUid:'c',targetEmail:'a@example.test',purpose:'LOGIN',ruleVersion:1,windowStartedAt:1000,lookupDeadlineAt:1060};
 for(const extra of [{ruleVersion:0},{purpose:'RECOVERY'},{otpValiditySeconds:0},{otpValiditySeconds:3601},{excludedSourceMessageRefs:Array(101).fill('x')},{profilePath:'C:\\other'}])assert.equal(lookupSchema.safeParse({...input,...extra}).success,false);
});
test('concurrent bounded regex workers preserve results without charging startup to execution',async()=>{
 const results=await Promise.all(Array.from({length:16},()=>capture(rule,message.body)));
 assert.ok(results.every(codes=>codes.length===1&&codes[0]==='001234'));
});
test('receipt timezone is authoritative and expiry uses earliest current instruction',()=>{
 const headers='Delivered-To: target@example.test\nReceived: by mx.google.com; Sun, 01 Nov 2026 01:30:00 -0400\nFrom: sender@example.test\nMessage-ID: <boundaries@example.test>\nAuthentication-Results: mx.google.com; spf=pass smtp.mailfrom=sender@example.test\n\nbody';
 assert.equal(receiptMetadata(headers,'target@example.test',message.sender)?.receivedAt,Math.floor(Date.parse('2026-11-01T05:30:00Z')/1000));
 assert.throws(()=>receiptMetadata(headers.replace('01:30:00 -0400','01:30:00'), 'target@example.test',message.sender),/MESSAGE_RECEIPT_UNVERIFIED/);
 assert.throws(()=>receiptMetadata(headers.replace('From: sender@example.test','From: attacker@example.test'), 'target@example.test',message.sender),/MESSAGE_SENDER_UNVERIFIED/);
 assert.throws(()=>receiptMetadata(headers.replace('spf=pass','spf=fail'), 'target@example.test',message.sender),/SENDER_AUTH_UNVERIFIED/);
 assert.equal(messageExpiry('Valid for 5 minutes. Expires in 30 seconds.',1000),1030);
 assert.equal(messageExpiry('Valid for 5 minutes.\n----- Previous message -----\nExpires in 1 second.',1000),1300);
 assert.equal(messageExpiry('Please use your code.',1000),undefined);
});

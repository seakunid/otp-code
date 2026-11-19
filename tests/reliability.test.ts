import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Store} from '../src/store.js';
import {Executor} from '../src/executor.js';
import {Retrieval} from '../src/service.js';
import {ruleSchema,lookupSchema} from '../src/contracts.js';
import {receiptMetadata,decodeSubject,messageExpiry} from '../src/message.js';
import {stubClassifier} from './helpers/classifier.js';
const rule=ruleSchema.parse({providerUid:'p',purpose:'LOGIN',version:1,senders:['sender@example.test'],subjectMode:'contains',subject:'code'});
const message={ref:'m',sender:'sender@example.test',subject:'code',body:'Your sign-in code is 001234',receivedAt:Math.floor(Date.now()/1000)};
test('MIME subject decoding preserves Unicode and adjacent encoded words; malformed bytes fail closed',()=>{
 assert.equal(decodeSubject('=?UTF-8?B?S29kZSDwn5SS?='),'Kode 🔒');
 assert.equal(decodeSubject('=?UTF-8?Q?Sign-in_code?= =?UTF-8?Q?_request?='),'Sign-in code request');
 assert.equal(decodeSubject('=?ISO-8859-1?Q?Caf=E9?='),'Café');
 assert.throws(()=>decodeSubject('=?UTF-8?B?%%%?='),/MESSAGE_SUBJECT_UNVERIFIED/);
 assert.throws(()=>decodeSubject('=?UTF-8?B?/w==?='),/MESSAGE_SUBJECT_UNVERIFIED/);
});
function fixture(close=async()=>{}){const store=new Store(':memory:',randomBytes(32));const p=store.createProfile('target@example.test',resolve('test-directory'));store.enable(p.uid);store.syncRule(rule);store.activate('p','LOGIN',1);const executor=new Executor();const service=new Retrieval(store,{read:async()=>[message],close},executor,5,false,false,stubClassifier());const now=Math.floor(Date.now()/1000);const input=lookupSchema.parse({requestUid:'r',attemptUid:'a',providerUid:'p',accountUid:'c',targetEmail:'target@example.test',purpose:'LOGIN',ruleVersion:1,windowStartedAt:now-1,lookupDeadlineAt:now+30,otpValiditySeconds:300});return{store,service,input,executor};}
test('receipt uses Gmail Received timestamp, exact delivered-to and authentication',()=>{
 const headers='Delivered-To: target@example.test\r\nReceived: from x by mx.google.com with ESMTPS; Sun, 08 Nov 2026 03:00:00 +0700\r\nFrom: sender@example.test\r\nDate: Sun, 08 Nov 2030 03:00:00 +0700\r\nMessage-ID: <test@example.test>\r\nAuthentication-Results: mx.google.com; dkim=pass header.i=@example.test\r\n\r\nbody';
 assert.equal(receiptMetadata(headers,'target@example.test','sender@example.test')?.receivedAt,Math.floor(Date.parse('2026-11-07T20:00:00Z')/1000));
 assert.equal(receiptMetadata(headers,'alias@example.test','sender@example.test'),undefined);
 assert.throws(()=>receiptMetadata(headers.replace('dkim=pass','dkim=fail'),'target@example.test','sender@example.test'),/SENDER_AUTH_UNVERIFIED/);
});
test('expiry uses the earliest current instruction and ignores quoted ones',()=>{
 assert.equal(messageExpiry('Valid for 5 minutes. Expires in 30 seconds.',1000),1030);
 assert.equal(messageExpiry('Valid for 5 minutes.\n----- Previous message -----\nExpires in 1 second.',1000),1300);
 assert.equal(messageExpiry('Please use your code.',1000),undefined);
});
test('result is persisted before cleanup; failed cleanup quarantines browser capacity and blocks replay',async()=>{
 let f:ReturnType<typeof fixture>;f=fixture(async()=>{assert.equal(f.store.read('a').outcome,'FOUND');throw Error('close failed');});
 await assert.rejects(f.service.lookup(f.input),/PROFILE_CLEANUP_FAILED/);assert.equal(f.executor.stats().quarantined,1);assert.equal(f.executor.stats().active,1);await assert.rejects(f.service.lookup(f.input),/PROFILE_CLEANUP_FAILED/);f.store.close();
});
test('cancellation cannot hide a failed browser cleanup behind LOOKUP_CANCELLED',async()=>{
 const f=fixture();let cancellation:Promise<unknown>|undefined;
 f.service.mailbox.close=async()=>{cancellation=f.service.cancel('a',f.input.lookupDeadlineAt).catch(()=>undefined);throw Error('close failed');};
 try{await assert.rejects(f.service.lookup(f.input),/PROFILE_CLEANUP_FAILED/);await cancellation;assert.equal(f.executor.stats().quarantined,1);assert.ok(f.store.cleanupPending('a'));assert.equal(f.store.read('a'),undefined);}finally{f.store.close();}
});
test('cancellation during read cannot publish or persist code',async()=>{
 const f=fixture();f.service.mailbox.read=async()=>{void f.service.cancel('a',f.input.lookupDeadlineAt);return[message];};
 await assert.rejects(f.service.lookup(f.input),/LOOKUP_CANCELLED/);assert.equal(f.store.read('a'),undefined);f.store.close();
});
test('expiry purge removes encrypted code while metadata remains',async()=>{
 const f=fixture();await f.service.lookup(f.input);f.store.purge(message.receivedAt+301);assert.equal(f.store.read('a'),undefined);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attempt').get()?.n,1);f.store.close();
});
test('canonical hashes ignore key insertion order; revisions immutable',()=>{
 const s=new Store(':memory:',randomBytes(32));assert.equal(s.hash({a:1,b:{d:2,c:3}}),s.hash({b:{c:3,d:2},a:1}));s.syncRule(rule);assert.throws(()=>s.syncRule({...rule,subject:'changed'}),/RULE_VERSION_CONFLICT/);s.close();
});
test('rule commands compare active revision and replay exact lost acknowledgements',()=>{
 const store=new Store(':memory:',randomBytes(32));store.syncRule(rule);store.syncRule({...rule,version:2});
 const first=store.ruleCommand('p','LOGIN',1,'activate','one',0);assert.deepEqual(store.ruleCommand('p','LOGIN',1,'activate','one',0),first);
 assert.throws(()=>store.ruleCommand('p','LOGIN',2,'activate','two',0),/ACTIVE_RULE_CONFLICT/);
 assert.throws(()=>store.ruleCommand('p','LOGIN',2,'activate','one',1),/IDEMPOTENCY_CONFLICT/);
 store.ruleCommand('p','LOGIN',2,'activate','two',1);assert.deepEqual(store.ruleCommand('p','LOGIN',1,'activate','one',0),first);assert.equal(store.rule('p','LOGIN',2).version,2);
 store.ruleCommand('p','LOGIN',2,'deactivate','off',2);assert.throws(()=>store.rule('p','LOGIN',2),/RULE_REVOKED/);store.close();
});
test('queued cancellation and expiry remove jobs; free profile uses idle capacity with queue disabled',async()=>{
 const ex=new Executor(1,0,0),ctrl=new AbortController();assert.equal(await ex.run('p',Date.now()+1000,ctrl.signal,async()=>1),1);
 await new Promise(r=>setTimeout(r,0));const queued=new Executor(1);let release!:()=>void;const first=queued.run('p',Date.now()+1000,ctrl.signal,()=>new Promise<void>(r=>{release=r;}));
 const cancelled=new AbortController();const next=queued.run('p',Date.now()+1000,cancelled.signal,async()=>2);cancelled.abort();await assert.rejects(next,/LOOKUP_CANCELLED/);
 await assert.rejects(queued.run('p',Date.now()+10,ctrl.signal,async()=>3),/TIMEOUT/);release();await first;
});
test('revocation blocks completed replay and rejects reactivation',async()=>{
 const f=fixture();await f.service.lookup(f.input);f.store.revoke('p','LOGIN',1);await assert.rejects(f.service.lookup(f.input),/RULE_REVOKED/);assert.throws(()=>f.store.activate('p','LOGIN',1),/RULE_REVOKED/);f.store.close();
});

test('unaligned authenticated senders fail closed',async()=>{
 const headers='Delivered-To: target@example.test\nReceived: by mx.google.com; Sun, 08 Nov 2026 03:00:00 +0700\nFrom: sender@example.test\nMessage-ID: <x@example.test>\nAuthentication-Results: mx.google.com; dkim=pass header.i=@attacker.test\n\nbody';
 assert.throws(()=>receiptMetadata(headers,'target@example.test','sender@example.test'),/SENDER_AUTH_UNVERIFIED/);
});

test('pinned profile disable prevents replay; cancel payload must keep original deadline',async()=>{
 const f=fixture();await f.service.lookup(f.input);f.store.disable(f.store.profile(f.input.targetEmail)!.uid);await assert.rejects(f.service.lookup(f.input),/PROFILE_CHANGED/);await assert.rejects(f.service.cancel('a',f.input.lookupDeadlineAt+1),/CANCEL_IDENTITY_CONFLICT/);f.store.close();
});
test('terminal expiry replays without a second mailbox operation',async()=>{
 const f=fixture();let reads=0;f.service.mailbox.read=async()=>{reads++;return[{...message,receivedAt:Math.floor(Date.now()/1000)-400}];};await assert.rejects(f.service.lookup(f.input),/OTP_EXPIRED/);await assert.rejects(f.service.lookup(f.input),/OTP_EXPIRED/);assert.equal(reads,1);f.store.close();
});
test('duplicate subscribers are bounded; shared work uses one browser slot',async()=>{
 const f=fixture();let release!:()=>void;f.service.mailbox.read=async()=>{await new Promise<void>(r=>release=r);return[message];};const calls=Array.from({length:10},()=>f.service.lookup(f.input));await assert.rejects(f.service.lookup(f.input),/REPLAY_WAITERS_FULL/);assert.equal(f.executor.stats().active,1);release();await Promise.all(calls);f.store.close();
});
test('disconnect cancels only unshared work and allows same-attempt recovery',async()=>{
 const f=fixture();let started!:()=>void;const ready=new Promise<void>(r=>started=r);let closed=0;
 f.service.mailbox.read=async(_p,_i,_r,signal)=>{started();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));signal.throwIfAborted();return[];};f.service.mailbox.close=async()=>{closed++;};
 const one=f.service.subscribe('a'),two=f.service.subscribe('a'),result=f.service.lookup(f.input);await ready;one(true);assert.equal(closed,0);two(true);await assert.rejects(result,/CLIENT_DISCONNECTED/);assert.equal(closed,1);assert.equal(f.store.read('a'),undefined);
 f.service.mailbox.read=async()=>[message];assert.equal((await f.service.lookup(f.input) as {outcome:string}).outcome,'FOUND');f.store.close();
});

test('wrong encryption key fails startup without discarding durable records',()=>{
 const dir=mkdtempSync(join(tmpdir(),'otp-wrong-key-')),file=join(dir,'state.sqlite'),key=randomBytes(32);const store=new Store(file,key);store.createProfile('a@example.test',resolve('wrong-key-profile'));store.close();assert.throws(()=>new Store(file,randomBytes(32)),/STATE_KEY_INVALID/);const reopened=new Store(file,key);assert.ok(reopened.profile('a@example.test'));reopened.close();rmSync(dir,{recursive:true});
});
test('production refuses a synthetic per-profile proof even if an active pointer exists',async()=>{
 const f=fixture(),service=new Retrieval(f.store,f.service.mailbox,f.executor,5,true,false,stubClassifier());f.store.verifyRule('p','LOGIN',1,f.input.targetEmail,f.store.hash(rule),'SYNTHETIC');
 await assert.rejects(service.lookup(f.input),/PROFILE_RULE_NOT_VERIFIED/);f.store.close();
});

test('state write failure after reading mail cannot publish or reserve a plaintext result',async()=>{
 const f=fixture();f.service.mailbox.read=async()=>{f.store.db.exec('PRAGMA query_only=ON');return[message];};f.service.mailbox.close=async()=>{f.store.db.exec('PRAGMA query_only=OFF');};
 await assert.rejects(f.service.lookup(f.input));assert.equal(f.store.read('a'),undefined);assert.equal(f.store.used(f.input.targetEmail,message.ref,'another',Math.floor(Date.now()/1000)),undefined);assert.equal(f.executor.stats().quarantined,0);f.store.close();
});

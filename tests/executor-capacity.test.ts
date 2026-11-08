import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Executor} from '../src/executor.js';
for(const capacity of [1,2,4])test('sparse scheduler bounds distinct-profile bursts at capacity '+capacity,async()=>{
 const executor=new Executor(capacity,200,20),controller=new AbortController(),keys=new Set<string>();let peak=0;
 await Promise.all(Array.from({length:100},(_,i)=>executor.run('profile-'+(i%20),Date.now()+5000,controller.signal,async()=>{
  const key='profile-'+(i%20);assert.ok(!keys.has(key));keys.add(key);peak=Math.max(peak,keys.size);assert.ok(keys.size<=capacity);await new Promise(r=>setTimeout(r,1));keys.delete(key);
 })));
 assert.equal(peak,capacity);assert.deepEqual(executor.stats(),{active:0,queued:0,capacity,quarantined:0});
});
test('quarantine keeps its global slot while other profiles continue safely',async()=>{
 const executor=new Executor(2),signal=new AbortController().signal;executor.quarantine('bad');
 await assert.rejects(executor.run('bad',Date.now()+1000,signal,async()=>1),/PROFILE_CLEANUP_FAILED/);
 assert.equal(await executor.run('healthy',Date.now()+1000,signal,async()=>2),2);
 await new Promise(r=>setTimeout(r,0));assert.equal(executor.stats().active,1);assert.equal(executor.stats().quarantined,1);
});

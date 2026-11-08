import {test} from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import {Store} from '../src/store.js';
test('bounded retention clears expired replay but preserves pending cleanup and source fences',()=>{
 const store=new Store(':memory:',randomBytes(32)),now=Math.floor(Date.now()/1000);
 try{
  for(let i=0;i<2100;i++){const id='expired-'+i;store.admit(id,id,now-90000);store.context(id,{input:{requestUid:id}});store.save(id,{code:'001234'});}
  store.cleanupPending('expired-0','profile');store.reserve('target@example.test','source','owner',now);
  for(let i=0;i<4;i++)store.purge(now);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM attempt WHERE result IS NOT NULL').get()?.n,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM attempt').get()?.n,1);assert.ok(store.cleanupPending('expired-0'));
  assert.ok(store.used('target@example.test','source','another',now));store.cleaned('expired-0');store.purge(now);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM attempt').get()?.n,0);
 }finally{store.close();}
});

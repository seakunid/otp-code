import {test} from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';
import {Store} from '../src/store.js';import {Retrieval} from '../src/service.js';import {createApp} from '../src/app.js';import {ruleSchema} from '../src/contracts.js';
test('authenticated rule status reports only the accepted active revision and hash',async()=>{
 const store=new Store(':memory:',randomBytes(32)),token='synthetic-rule-status-token-012345',server=createApp(new Retrieval(store,{read:async()=>[],close:async()=>{}}),token).listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const url='http://127.0.0.1:'+(server.address() as {port:number}).port+'/v1/providers/p/rules/LOGIN',headers={authorization:'Bearer '+token};
 try{
  assert.equal((await fetch(url)).status,401);assert.equal((await (await fetch(url,{headers})).json()).activeRevision,0);
  const rule=ruleSchema.parse({providerUid:'p',purpose:'LOGIN',version:1,senders:['sender@example.test'],subjectMode:'contains',subject:'code',purposeMarkers:['sign-in code'],pattern:'(?<otp>[0-9]{6})'});store.syncRule(rule);store.activate('p','LOGIN',1);store.syncRule({...rule,version:2});
  assert.deepEqual(await (await fetch(url,{headers})).json(),{providerUid:'p',purpose:'LOGIN',activeRevision:1,hash:store.hash(rule)});
  store.revoke('p','LOGIN',1);assert.equal((await (await fetch(url,{headers})).json()).activeRevision,0);assert.equal((await fetch(url.replace('LOGIN','OTHER'),{headers})).status,422);
 }finally{await new Promise<void>(r=>server.close(()=>r()));store.close();}
});

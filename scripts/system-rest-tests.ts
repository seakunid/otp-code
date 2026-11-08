import {resolve} from 'node:path';import { createApp } from '../src/app.js';import {Retrieval} from '../src/service.js';import {Store} from '../src/store.js';import {Executor} from '../src/executor.js';import {ruleSchema} from '../src/contracts.js';import {randomBytes} from 'node:crypto';
// Deterministic HTTP contract host for cross-language SQL/API E2E; never Gmail evidence.
const store=new Store(':memory:',randomBytes(32));const profile=store.createProfile('fixture@example.test',resolve('fixture'));store.enable(profile.uid);
const service=new Retrieval(store,{read:async()=>[{ref:'fixture:rest:'+Date.now(),sender:'sender@example.test',subject:'Synthetic code',body:'Your sign-in code is 001234',receivedAt:Math.floor(Date.now()/1000)}],close:async()=>{}},new Executor());
createApp(service,process.env.OTP_RETRIEVAL_TOKEN||'',{allowSyntheticVerification:true}).listen(Number(process.env.PORT||13011),'127.0.0.1',()=>console.log('Deterministic Windows-contract host ready'));

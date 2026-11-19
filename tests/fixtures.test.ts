import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {randomBytes} from 'node:crypto';import {resolve} from 'node:path';import {ruleSchema,lookupSchema} from '../src/contracts.js';import {Store} from '../src/store.js';import {Retrieval} from '../src/service.js';import {stubClassifier} from './helpers/classifier.js';
const fixtures=JSON.parse(readFileSync('fixtures/synthetic_otp_emails.json','utf8'));
const purpose:Record<string,'LOGIN'|'PAYMENT'>={'numeric-six-digits':'LOGIN','four-digits-leading-zero':'PAYMENT','hyphenated-alphanumeric':'LOGIN','html-separated-digits':'LOGIN','eight-digits-in-subject-with-previous-code':'LOGIN'};
// What each mail prints; the older rule patterns are gone, so the classifier returns the artifact verbatim.
const printed:Record<string,string>={'numeric-six-digits':'482913','four-digits-leading-zero':'0738','hyphenated-alphanumeric':'A7K-92Q','html-separated-digits':'6 3 9 2 0 4','eight-digits-in-subject-with-previous-code':'80427516'};
for(let i=0;i<fixtures.length;i++)test('original fixture '+fixtures[i].id,async()=>{
 const f=fixtures[i],type=purpose[f.id],ref='fixture:'+i,now=Math.floor(Date.now()/1000);
 const store=new Store(':memory:',randomBytes(32)),profile=store.createProfile('target@example.test',resolve('fixture-'+f.id));store.enable(profile.uid);
 const rule=ruleSchema.parse({providerUid:'fixture',purpose:type,version:1,senders:['sender@example.test'],subjectMode:'exact',subject:f.subject});store.syncRule(rule);store.activate('fixture',type,1);
 const service=new Retrieval(store,{read:async()=>[{ref,sender:'sender@example.test',subject:f.subject,body:f.body,receivedAt:now}],close:async()=>{}},undefined,5,false,false,stubClassifier([{ref,kind:'CODE',value:printed[f.id],purpose:type}]));
 const input=lookupSchema.parse({requestUid:'r',attemptUid:'fixture-'+i,providerUid:'fixture',accountUid:'a',targetEmail:profile.email,purpose:type,ruleVersion:1,windowStartedAt:now-1,lookupDeadlineAt:now+30,otpValiditySeconds:600});
 try{const result=await service.lookup(input);assert.equal(result.code,printed[f.id]);assert.equal(result.sourceMessageRef,ref);assert.equal(result.purpose,type);assert.equal(printed[f.id].replace(/[^A-Za-z0-9]/g,''),f.expected.otp);}finally{await service.shutdown();store.close();}
});

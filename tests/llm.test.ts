import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {buildPrompt,parseAnswer,Llm} from '../src/llm.js';
import type {ClassifyInput} from '../src/llm.js';
import {lookupSchema,ruleSchema} from '../src/contracts.js';
import {Store} from '../src/store.js';
import {Retrieval} from '../src/service.js';

const now=Math.floor(Date.now()/1000);
const message={ref:'m',sender:'sender@example.test',subject:'Your code',body:'Your sign-in code is 001234',links:'https://help.example.test/legal\nhttps://www.example.test/val?token=abc',receivedAt:now,expiresAt:now+300};
const input:ClassifyInput={providerUid:'p',purpose:'LOGIN',requestedAt:now-60,now,messages:[message]};
const answer=(value:Partial<{pick:unknown;kind:unknown;value:unknown;purpose:unknown;reason:unknown}>)=>JSON.stringify({pick:1,kind:'CODE',value:'001234',purpose:'LOGIN',reason:'test',...value});

test('fenced JSON answer is accepted',()=>{
 const result=parseAnswer('```json\n'+answer({})+'\n```',input);
 assert.equal(result?.value,'001234');
 assert.equal(result?.kind,'CODE');
});

test('pick outside the candidate range is rejected; zero means none',()=>{
 assert.throws(()=>parseAnswer(answer({pick:2}),input),/LLM_ANSWER_INVALID/);
 assert.equal(parseAnswer(answer({pick:0}),input),null);
 assert.throws(()=>parseAnswer(answer({pick:1.5}),input),/LLM_ANSWER_INVALID/);
});

test('pick null means no artifact',()=>{
 assert.equal(parseAnswer(answer({pick:null}),input),null);
});

test('CODE must appear verbatim in the chosen body',()=>{
 assert.throws(()=>parseAnswer(answer({value:'999999'}),input),/LLM_ANSWER_INVALID/);
});

test('LINK must be listed in the chosen mail links',()=>{
 assert.equal(parseAnswer(answer({kind:'LINK',value:'https://www.example.test/val?token=abc'}),input)?.value,'https://www.example.test/val?token=abc');
 assert.throws(()=>parseAnswer(answer({kind:'LINK',value:'https://www.example.test/val?token=other'}),input),/LLM_ANSWER_INVALID/);
});

test('LINK must use https',()=>{
 assert.throws(()=>parseAnswer(answer({kind:'LINK',value:'http://www.example.test/val?token=abc'}),input),/LLM_ANSWER_INVALID/);
});

test('a mail answered for another purpose is not an artifact for this lookup',()=>{
 assert.equal(parseAnswer(answer({purpose:'PAYMENT'}),input),null);
});

test('prompt carries the request clock and the candidate expiry',()=>{
 const prompt=buildPrompt({...input,messages:[{...message,expiresAt:now+120}]});
 const user=prompt[1].content as string;
 assert.ok(user.includes(new Date((now-60)*1000).toISOString().replace('.000Z','Z')));
 assert.ok(user.includes(new Date(now*1000).toISOString().replace('.000Z','Z')));
 assert.ok(user.includes('expiresIn=120s'));
});

const serve=(handler:(res:import('node:http').ServerResponse)=>void)=>new Promise<{url:string;close:()=>Promise<void>}>(resolveServer=>{
 const server=createServer((_req,res)=>handler(res));
 server.listen(0,'127.0.0.1',()=>resolveServer({url:'http://127.0.0.1:'+(server.address() as AddressInfo).port,close:()=>new Promise<void>(resolveClose=>{server.closeAllConnections();server.close(()=>resolveClose());})}));
});

test('SSE delta chunks are concatenated',async()=>{
 const chunks=['{"pick":1,','"kind":"CODE",','"value":"001234",','"purpose":"LOGIN",','"reason":"sse"}'];
 const server=await serve(res=>{
  res.writeHead(200,{'content-type':'text/event-stream'});
  for(const chunk of chunks)res.write(`data: ${JSON.stringify({choices:[{delta:{content:chunk}}]})}\n\n`);
  res.write('data: [DONE]\n\n');res.end();
 });
 try{assert.equal((await new Llm(server.url,'k','m',2000).classify(input))?.value,'001234');}
 finally{await server.close();}
});

test('a non-200 gateway answer is unavailable',async()=>{
 const server=await serve(res=>{res.writeHead(500);res.end('nope');});
 try{await assert.rejects(new Llm(server.url,'k','m',2000).classify(input),/LLM_UNAVAILABLE/);}
 finally{await server.close();}
});

test('a gateway that never answers times out',async()=>{
 const server=await serve(()=>{});
 try{await assert.rejects(new Llm(server.url,'k','m',100).classify(input),/LLM_TIMEOUT/);}
 finally{await server.close();}
});

test('repeated polls over the same candidate refs classify once',async()=>{
 const store=new Store(':memory:',randomBytes(32)),profile=store.createProfile('cache@example.test',resolve('llm-cache'));store.enable(profile.uid);
 const rule=ruleSchema.parse({providerUid:'p',purpose:'LOGIN',version:1,senders:['sender@example.test'],domains:[],subjectMode:'exact',subject:'Your code'});store.syncRule(rule);store.activate('p','LOGIN',1);
 const calls={count:0};let reads=0;
 const service=new Retrieval(store,{read:async()=>{reads++;return[message];},close:async()=>{}},undefined,50,false,false,{classify:async()=>{calls.count++;return null;}});
 const request=lookupSchema.parse({requestUid:'r',attemptUid:'a',providerUid:'p',accountUid:'c',targetEmail:profile.email,purpose:'LOGIN',ruleVersion:1,windowStartedAt:now-1,lookupDeadlineAt:now+1,otpValiditySeconds:300});
 try{await assert.rejects(service.lookup(request),/TIMEOUT/);assert.ok(reads>1);assert.equal(calls.count,1);}
 finally{await service.shutdown();store.close();}
});

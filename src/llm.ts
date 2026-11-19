import { Message, ServiceError } from './contracts.js';
import { log } from './log.js';

export type Classification = {pick:number;kind:'CODE'|'LINK';value:string;purpose?:string;reason:string};
export type ClassifyInput = {providerUid:string;providerName?:string;purpose:'LOGIN'|'PAYMENT'|'PASSWORD_RESET';requestedAt:number;now:number;messages:Message[]};
export interface Classifier { classify(input:ClassifyInput,signal?:AbortSignal):Promise<Classification|null>; }

const MAX_BODY=4000, MAX_LINKS=20;
const iso=(seconds:number)=>new Date(seconds*1000).toISOString().replace('.000Z','Z');

// Only mails whose computed expiry is still ahead reach the model, so `expiresIn` is always a positive hint.
export const buildPrompt=(input:ClassifyInput)=>{
  const mails=input.messages.map((message,index)=>{
    const expiresIn=message.expiresAt?`${message.expiresAt-input.now}s`:'unknown';
    const links=(message.links||'').split('\n').map(x=>x.trim()).filter(Boolean).slice(0,MAX_LINKS).join('\n');
    return `${index+1}. from=${message.sender} subject=${JSON.stringify(message.subject)} received=${iso(message.receivedAt)} expiresIn=${expiresIn}\nbody:\n${message.body.slice(0,MAX_BODY)}\nlinks:\n${links}`;
  }).join('\n\n');
  return [
    {role:'system',content:[
      'You read a provider\'s mails and return the one sign-in artifact the customer needs.',
      'Answer with JSON only, no prose:',
      '{"pick":<number or null>,"kind":"CODE"|"LINK","value":"<artifact>","purpose":"LOGIN"|"PAYMENT"|"PASSWORD_RESET","reason":"<short>"}',
      'Rules:',
      '- pick is the 1-based number of the newest mail that carries an artifact for the requested purpose.',
      '- value is copied character for character: a code exactly as printed in that mail body, or a URL exactly as listed in that mail\'s links.',
      '- Never invent, complete, join or translate an artifact.',
      '- Prefer a mail received at or after Requested at whose expiresIn is positive.',
      '- Skip marketing and discount codes, security alerts, and codes inside quoted or forwarded mail.',
      '- pick null when no mail carries an artifact for this purpose.'
    ].join('\n')},
    {role:'user',content:[
      `Provider: ${input.providerName||input.providerUid} (${input.providerUid})`,
      `Purpose: ${input.purpose}`,
      `Requested at: ${iso(input.requestedAt)}`,
      `Now: ${iso(input.now)}`,
      '',
      mails
    ].join('\n')}
  ];
};

// `null` means the model saw no usable artifact. Anything malformed throws so the next poll asks again.
export const parseAnswer=(text:string,input:ClassifyInput):Classification|null=>{
  const cleaned=text.replace(/^\s*```(?:json)?/i,'').replace(/```\s*$/,'').trim();
  const start=cleaned.indexOf('{'),end=cleaned.lastIndexOf('}');
  if(start<0||end<=start)throw new ServiceError(502,'LLM_ANSWER_INVALID');
  let raw:unknown;
  try{raw=JSON.parse(cleaned.slice(start,end+1));}catch{throw new ServiceError(502,'LLM_ANSWER_INVALID');}
  const answer=raw as {pick?:unknown;kind?:unknown;value?:unknown;purpose?:unknown;reason?:unknown};
  if(answer.pick===null||answer.pick===undefined)return null;
  const pick=Number(answer.pick);
  if(pick===0)return null;
  if(!Number.isInteger(pick)||pick<1||pick>input.messages.length)throw new ServiceError(502,'LLM_ANSWER_INVALID');
  // A mail that serves another purpose is not an artifact for this lookup.
  if(typeof answer.purpose==='string'&&answer.purpose.toUpperCase()!==input.purpose)return null;
  if(typeof answer.value!=='string')throw new ServiceError(502,'LLM_ANSWER_INVALID');
  const artifact=answer.value.trim();
  const kind=typeof answer.kind==='string'?answer.kind.toUpperCase():'';
  const message=input.messages[pick-1];
  if(kind==='CODE'){
    if(!/^[\x21-\x7e]{4,128}$/.test(artifact)||!message.body.includes(artifact))throw new ServiceError(502,'LLM_ANSWER_INVALID');
  }else if(kind==='LINK'){
    if(artifact.length>2048)throw new ServiceError(502,'LLM_ANSWER_INVALID');
    let url:URL;
    try{url=new URL(artifact);}catch{throw new ServiceError(502,'LLM_ANSWER_INVALID');}
    if(url.protocol!=='https:')throw new ServiceError(502,'LLM_ANSWER_INVALID');
    const links=(message.links||'').split('\n').map(x=>x.trim());
    if(!links.includes(artifact))throw new ServiceError(502,'LLM_ANSWER_INVALID');
  }else throw new ServiceError(502,'LLM_ANSWER_INVALID');
  return {pick,kind:kind as 'CODE'|'LINK',value:artifact,purpose:typeof answer.purpose==='string'?answer.purpose:undefined,reason:typeof answer.reason==='string'?answer.reason.slice(0,200):''};
};

// The gateway streams even with stream:false, so both shapes are accepted; streamed deltas are concatenated.
const contentOf=(body:string,contentType:string)=>{
  if(!/event-stream/i.test(contentType)&&!body.startsWith('data:')){
    let parsed:any;
    try{parsed=JSON.parse(body);}catch{throw new ServiceError(502,'LLM_UNAVAILABLE');}
    const content=parsed?.choices?.[0]?.message?.content;
    if(typeof content!=='string')throw new ServiceError(502,'LLM_UNAVAILABLE');
    return content;
  }
  let content='';
  for(const line of body.split('\n')){
    const trimmed=line.trim();
    if(!trimmed.startsWith('data:'))continue;
    const payload=trimmed.slice(5).trim();
    if(!payload||payload==='[DONE]')continue;
    try{
      const chunk=JSON.parse(payload);
      const delta=chunk?.choices?.[0]?.delta?.content;
      const whole=chunk?.choices?.[0]?.message?.content;
      if(typeof delta==='string')content+=delta;
      else if(typeof whole==='string')content+=whole;
    }catch{/* a truncated event is retried on the next poll */}
  }
  if(!content)throw new ServiceError(502,'LLM_UNAVAILABLE');
  return content;
};

export class Llm implements Classifier {
  constructor(
    private endpoint=process.env.LLM_ENDPOINT||'',
    private apiKey=process.env.API_KEY||'',
    private model=process.env.MODEL||'',
    private timeoutMs=Number(process.env.LLM_TIMEOUT_MS||8000)
  ){}
  async classify(input:ClassifyInput,signal?:AbortSignal):Promise<Classification|null>{
    if(!this.endpoint||!this.apiKey||!this.model)throw new ServiceError(503,'LLM_NOT_CONFIGURED');
    const controller=new AbortController();
    const abort=()=>controller.abort();
    signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>controller.abort(new ServiceError(504,'LLM_TIMEOUT')),Math.max(1,this.timeoutMs));
    const started=performance.now();
    try{
      const response=await fetch(`${this.endpoint.replace(/\/$/,'')}/chat/completions`,{
        method:'POST',
        headers:{'content-type':'application/json',authorization:`Bearer ${this.apiKey}`},
        body:JSON.stringify({model:this.model,temperature:0,stream:false,messages:buildPrompt(input)}),
        signal:controller.signal
      });
      if(!response.ok)throw new ServiceError(502,'LLM_UNAVAILABLE');
      const answer=parseAnswer(contentOf(await response.text(),response.headers.get('content-type')||''),input);
      log('info','llm_classified',{providerUid:input.providerUid,mailCount:input.messages.length,pick:answer?answer.pick:'none',kind:answer?answer.kind:'none',durationMs:Math.round(performance.now()-started)});
      return answer;
    }catch(error){
      if(controller.signal.reason instanceof ServiceError)throw controller.signal.reason;
      if(error instanceof ServiceError)throw error;
      throw new ServiceError(502,'LLM_UNAVAILABLE');
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
}

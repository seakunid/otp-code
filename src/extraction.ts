import { Worker } from 'node:worker_threads';
import { Message, Rule, ServiceError } from './contracts.js';
import { log } from './log.js';
export async function capture(rule: Rule, text: string): Promise<string[]> {
  if(text.length>262144) throw new ServiceError(422,'MESSAGE_TOO_LARGE');
  if((rule.pattern.match(/\(\?<otp>/g)||[]).length!==1) throw new ServiceError(422,'OTP_CAPTURE_REQUIRED');
  const source = `const {parentPort,workerData}=require('node:worker_threads');parentPort.once('message',()=>{try {const re=new RegExp(workerData.pattern,workerData.flags+'g'); const values=[]; let match; while((match=re.exec(workerData.text))!==null){if(match.groups?.otp!==undefined)values.push(match.groups.otp);if(values.length>100)throw Error('Too many matches');if(match[0]==='')re.lastIndex++;}parentPort.postMessage({values});}catch{parentPort.postMessage({error:'REGEX_INVALID'});}});parentPort.postMessage({ready:true});`;
  return new Promise((resolve,reject)=>{
    const worker=new Worker(source,{eval:true,execArgv:[],workerData:{pattern:rule.pattern,flags:rule.flags,text},resourceLimits:{maxOldGenerationSizeMb:16}});
    const timeout=()=>{void worker.terminate();reject(new ServiceError(422,'REGEX_TIMEOUT'));};
    // Worker startup has a separate bound; the regex itself still gets at most 100 ms.
    let timer=setTimeout(timeout,1000);
    worker.on('message',r=>{clearTimeout(timer);if(r.ready){timer=setTimeout(timeout,100);worker.postMessage('run');return;}void worker.terminate();r.error?reject(new ServiceError(422,r.error)):resolve(r.values);});
    worker.once('error',()=>{clearTimeout(timer);reject(new ServiceError(422,'REGEX_INVALID'));});
  });
}
export async function validateRule(rule: Rule) {
  if((await capture(rule,'')).some(code=>code===''))throw new ServiceError(422,'EMPTY_OTP_CAPTURE');
  await capture(rule,'a'.repeat(4096)+'!');return rule;
}
export async function extract(rule:Rule,message:Message) {
  const decision=(outcome:'NOT_FOUND'|'AMBIGUOUS'|'SECURITY_ALERT'|'FOUND',reason:string)=>log('debug','extraction_evaluated',{providerUid:rule.providerUid,purpose:rule.purpose,ruleVersion:rule.version,outcome,reason});
  const sender=message.sender.toLowerCase();const domain=sender.split('@')[1];
  if(!rule.senders.map(x=>x.toLowerCase()).includes(sender)&&!rule.domains.map(x=>x.toLowerCase()).includes(domain)) {decision('NOT_FOUND','SENDER_MISMATCH');return {outcome:'NOT_FOUND' as const};}
  if(rule.subjectMode==='exact'?message.subject!==rule.subject:!message.subject.includes(rule.subject)) {decision('NOT_FOUND','SUBJECT_MISMATCH');return {outcome:'NOT_FOUND' as const};}
  // Quoted/replaced mail is never a fallback source for the current code.
  const body=message.body.split(/----- (?:Previous|Original) message -----|\nOn .+wrote:|\n>/i)[0];
  // OpenAI's login code emails carry a "not trying to reset your password" boilerplate line; without stripping it the LOGIN purpose guard rejects them.
  const context=`${message.subject}\n${body}`.toLowerCase().replace(/please ignore this email if you (?:weren[’']t|didn[’']t|did not) trying to reset your password/,'').replace(/if you (?:were not|weren[’']t|did not|didn[’']t) (?:trying to )?(?:log ?in|sign ?in)[\s\S]{0,120}?please (?:reset your password|ignore this email)/g,'');
  if(/suspicious (?:sign.?in|activity)|security alert|recovery code|backup code/i.test(context)){decision('SECURITY_ALERT','SECURITY_MARKER');return {outcome:'SECURITY_ALERT' as const};}
  const conflicting=rule.purpose==='LOGIN'?/password reset|reset (?:your )?password|payment|transaction|purchase/i:rule.purpose==='PAYMENT'?/password reset|reset (?:your )?password|sign.?in|log.?in/i:/payment|transaction|purchase|sign.?in|log.?in/i;
  if(conflicting.test(context)){decision('NOT_FOUND','PURPOSE_CONFLICT');return {outcome:'NOT_FOUND' as const};}
  if(!rule.purposeMarkers.some(marker=>context.includes(marker.toLowerCase()))){decision('NOT_FOUND','PURPOSE_MARKER_MISSING');return {outcome:'NOT_FOUND' as const};}
  if(/\b(?:code|otp|passcode)\s+(?:(?:has|have)\s+(?:been\s+)?|(?:is|was)\s+)?(?:expired|replaced|revoked|invalid(?:ated)?|no longer valid)\b|\b(?:expired|replaced|revoked|invalid(?:ated)?)\s+(?:code|otp|passcode)\b/i.test(context)){decision('NOT_FOUND','EXPLICITLY_EXPIRED');throw new ServiceError(410,'OTP_EXPIRED');}
  const text=rule.source==='subject'?message.subject:rule.source==='both'?`${message.subject}\n${body}`:body;
  const codes=[...new Set((await capture(rule,text)).map(code=>{
    if(rule.stripSpaces)code=code.replace(/\s/g,'');if(rule.stripHyphens)code=code.replace(/-/g,'');return code;
  }))];
  if(codes.some(x=>x.length<rule.minLength||x.length>rule.maxLength||!/^[A-Za-z0-9]+$/.test(x))) {decision('AMBIGUOUS','INVALID_CAPTURE');return {outcome:'AMBIGUOUS' as const};}
  if(codes.length>1){decision('AMBIGUOUS','MULTIPLE_CAPTURES');return {outcome:'AMBIGUOUS' as const};}
  decision(codes.length?'FOUND':'NOT_FOUND',codes.length?'SINGLE_CAPTURE':'NO_CAPTURE');
  return codes.length?{outcome:'FOUND' as const,code:codes[0]}:{outcome:'NOT_FOUND' as const};
}

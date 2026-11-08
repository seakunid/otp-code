import { Worker } from 'node:worker_threads';
import { Message, Rule, ServiceError } from './contracts.js';
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
  const sender=message.sender.toLowerCase();const domain=sender.split('@')[1];
  if(!rule.senders.map(x=>x.toLowerCase()).includes(sender)&&!rule.domains.map(x=>x.toLowerCase()).includes(domain)) return {outcome:'NOT_FOUND' as const};
  if(rule.subjectMode==='exact'?message.subject!==rule.subject:!message.subject.includes(rule.subject)) return {outcome:'NOT_FOUND' as const};
  // Quoted/replaced mail is never a fallback source for the current code.
  const body=message.body.split(/----- (?:Previous|Original) message -----|\nOn .+wrote:|\n>/i)[0];
  const context=`${message.subject}\n${body}`.toLowerCase();
  if(/suspicious (?:sign.?in|activity)|security alert|recovery code|backup code/i.test(context))return {outcome:'SECURITY_ALERT' as const};
  const conflicting=rule.purpose==='LOGIN'?/password reset|reset (?:your )?password|payment|transaction|purchase/i:rule.purpose==='PAYMENT'?/password reset|reset (?:your )?password|sign.?in|log.?in/i:/payment|transaction|purchase|sign.?in|log.?in/i;
  if(conflicting.test(context)||!rule.purposeMarkers.some(marker=>context.includes(marker.toLowerCase())))return {outcome:'NOT_FOUND' as const};
  if(/\b(?:code|otp|passcode)\s+(?:(?:has|have)\s+(?:been\s+)?|(?:is|was)\s+)?(?:expired|replaced|revoked|invalid(?:ated)?|no longer valid)\b|\b(?:expired|replaced|revoked|invalid(?:ated)?)\s+(?:code|otp|passcode)\b/i.test(context))throw new ServiceError(410,'OTP_EXPIRED');
  const text=rule.source==='subject'?message.subject:rule.source==='both'?`${message.subject}\n${body}`:body;
  const codes=[...new Set((await capture(rule,text)).map(code=>{
    if(rule.stripSpaces)code=code.replace(/\s/g,'');if(rule.stripHyphens)code=code.replace(/-/g,'');return code;
  }))];
  if(codes.some(x=>x.length<rule.minLength||x.length>rule.maxLength||!/^[A-Za-z0-9]+$/.test(x))) return {outcome:'AMBIGUOUS' as const};
  if(codes.length>1) return {outcome:'AMBIGUOUS' as const};
  return codes.length?{outcome:'FOUND' as const,code:codes[0]}:{outcome:'NOT_FOUND' as const};
}

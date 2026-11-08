import { setTimeout as delay } from 'node:timers/promises';
import { Lookup, Profile, Result, Rule, ServiceError } from './contracts.js';
import { Store } from './store.js';
import { Mailbox } from './browser.js';
import { Executor } from './executor.js';
import { extract } from './extraction.js';
export class Retrieval {
  private running=new Map<string,{hash:string;promise:Promise<unknown>;controller:AbortController;waiters:number}>();
  private maintenance=new Set<{controller:AbortController;promise:Promise<unknown>}>();
  private subscribers=new Map<string,number>();
  constructor(readonly store:Store,readonly mailbox:Mailbox,readonly executor=new Executor(),private pollMs=2000,readonly requireProfileProof=false,readonly allowSyntheticProof=false){}
  subscribe(uid:string){
    this.subscribers.set(uid,(this.subscribers.get(uid)||0)+1);let released=false;
    return(disconnected=false)=>{if(released)return;released=true;const left=(this.subscribers.get(uid)||1)-1;if(left)this.subscribers.set(uid,left);else{this.subscribers.delete(uid);if(disconnected)this.running.get(uid)?.controller.abort(new ServiceError(499,'CLIENT_DISCONNECTED'));}};
  }
  async lookup(input:Lookup, diagnostic=false){
    input={...input,targetEmail:input.targetEmail.toLowerCase(),excludedSourceMessageRefs:[...input.excludedSourceMessageRefs].sort()};
    const now=Math.floor(Date.now()/1000);
    if(input.lookupDeadlineAt<=now)throw new ServiceError(410,'LOOKUP_EXPIRED');
    if(input.lookupDeadlineAt>now+300||input.windowStartedAt>now||input.windowStartedAt<now-360||input.lookupDeadlineAt-input.windowStartedAt>360)throw new ServiceError(422,'INVALID_TIME_WINDOW');
    const hash=this.store.hash({input,diagnostic});this.store.admit(input.attemptUid,hash,input.lookupDeadlineAt);
    const running=this.running.get(input.attemptUid);
    if(running){if(running.hash!==hash)throw new ServiceError(409,'IDEMPOTENCY_CONFLICT');if(running.waiters>=10)throw new ServiceError(429,'REPLAY_WAITERS_FULL');running.waiters++;try{return await running.promise;}finally{running.waiters--;}}
    const saved=this.store.context(input.attemptUid) as {profile:Profile;rule:Rule}|undefined;
    const profile=saved?.profile||this.store.profile(input.targetEmail);
    if(!profile)throw new ServiceError(404,'ACCOUNT_NOT_CONFIGURED');
    if(!profile.enabled||!profile.verified)throw new ServiceError(503,'PROFILE_UNAVAILABLE');
    const rule=saved?.rule||this.store.rule(input.providerUid,input.purpose,input.ruleVersion,diagnostic);
    if(this.store.revoked(input.providerUid,input.purpose,input.ruleVersion))throw new ServiceError(409,'RULE_REVOKED');
    const proof=this.store.proof(input.providerUid,input.purpose,input.ruleVersion,input.targetEmail);
    if(!diagnostic&&this.requireProfileProof&&(!proof||proof.kind!=='PROVIDER_MAIL'&&!this.allowSyntheticProof))throw new ServiceError(409,'PROFILE_RULE_NOT_VERIFIED');
    this.store.context(input.attemptUid,{profile,rule,input});
    const mapped=this.store.profile(input.targetEmail);if(!mapped?.enabled||!mapped.verified||mapped.uid!==profile.uid||mapped.revision!==profile.revision)throw new ServiceError(503,'PROFILE_CHANGED');
    const old=this.store.read(input.attemptUid);
    if(old){
      if(old.error)throw new ServiceError(old.error.status,old.error.code);
      if(this.store.cleanupPending(input.attemptUid))throw new ServiceError(503,'PROFILE_CLEANUP_FAILED');
      if(old.expiresAt&&old.expiresAt<=now)throw new ServiceError(410,'OTP_EXPIRED');
      return {...old,replayed:true};
    }
    if(this.store.db.prepare('SELECT 1 FROM terminal WHERE uid=?').get(input.attemptUid))throw new ServiceError(410,'OTP_EXPIRED');
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),Math.max(1,input.lookupDeadlineAt*1000-Date.now()));
    const promise=Promise.resolve().then(()=>this.executor.run(profile.uid,input.lookupDeadlineAt*1000,controller.signal,async()=>{
      let response:unknown;
      const current=this.store.profile(input.targetEmail);
      if(!current?.enabled||!current.verified||current.uid!==profile.uid||current.revision!==profile.revision)throw new ServiceError(503,'PROFILE_CHANGED');
      this.store.cleanupPending(input.attemptUid,profile.uid);
      try {
        while(Date.now()<input.lookupDeadlineAt*1000-100){
          if(controller.signal.aborted||this.store.cancelled(input.attemptUid))throw new ServiceError(409,'LOOKUP_CANCELLED');
          const messages=(await this.mailbox.read(profile,input,rule,controller.signal))
            .filter(m=>m.receivedAt>=input.windowStartedAt&&m.receivedAt<=Math.floor(Date.now()/1000)).sort((a,b)=>b.receivedAt-a.receivedAt);
          let result:Result|undefined,matchedSender='';
          for(const message of messages){
            if(result?.receivedAt!==undefined&&message.receivedAt<result.receivedAt)break;
            if(input.excludedSourceMessageRefs.includes(message.ref)||!diagnostic&&this.store.used(input.targetEmail,message.ref,input.attemptUid,Math.floor(Date.now()/1000)))continue;
            const found=await extract(rule,message);
            if(found.outcome==='NOT_FOUND')continue;
            matchedSender=message.sender.toLowerCase();
            if(found.outcome!=='FOUND'){result=found;break;}
            // Distinct sources tied at the newest receipt time have no trustworthy ordering.
            if(result){if(result.sourceMessageRef!==message.ref){result={outcome:'AMBIGUOUS'};break;}continue;}
            if(message.purpose&&message.purpose!==input.purpose)throw new ServiceError(422,'PURPOSE_MISMATCH');
            const fallback=input.otpValiditySeconds?message.receivedAt+input.otpValiditySeconds:0;
            const expiresAt=message.expiresAt&&fallback?Math.min(message.expiresAt,fallback):message.expiresAt||fallback;
            if(!expiresAt)throw new ServiceError(422,'EXPIRY_UNAVAILABLE');
            if(expiresAt<=Math.floor(Date.now()/1000))throw new ServiceError(410,'OTP_EXPIRED');
            result={...found,purpose:input.purpose,sourceMessageRef:message.ref,receivedAt:message.receivedAt,expiresAt,expirySource:message.expiresAt&&(!fallback||message.expiresAt<=fallback)?'EMAIL':'PROVIDER_POLICY'};
          }
          if(result){
            if(this.store.revoked(input.providerUid,input.purpose,input.ruleVersion))throw new ServiceError(409,'RULE_REVOKED');
            if(controller.signal.aborted||this.store.cancelled(input.attemptUid))throw new ServiceError(409,'LOOKUP_CANCELLED');
            if(this.store.profile(input.targetEmail)?.revision!==profile.revision)throw new ServiceError(503,'PROFILE_CHANGED');
            response={...input,...result,replayed:false,verificationKind:/^OTP-E2E-/i.test(rule.subject)||['nebula.together@gmail.com','abbyfc.dev@gmail.com'].includes(matchedSender)||String(result.sourceMessageRef).startsWith('fixture:')?'SYNTHETIC':'PROVIDER_MAIL'};
            delete (response as Partial<Lookup>).excludedSourceMessageRefs;
            this.store.cleanupPending(input.attemptUid,profile.uid);
            this.store.complete(input.attemptUid,input.targetEmail,!diagnostic&&result.outcome==='FOUND'?result.sourceMessageRef:undefined,response);
            break;
          }
          await delay(Math.min(this.pollMs,Math.max(1,input.lookupDeadlineAt*1000-Date.now()-50)),undefined,{signal:controller.signal});
        }
        if(!response)throw new ServiceError(504,'TIMEOUT');
      }finally{
        try{await this.mailbox.close(profile);this.store.cleaned(input.attemptUid);}
        catch{this.executor.quarantine(profile.uid);throw new ServiceError(503,'PROFILE_CLEANUP_FAILED');}
      }
      if(this.store.cancelled(input.attemptUid))throw new ServiceError(409,'LOOKUP_CANCELLED');
      if(this.store.revoked(input.providerUid,input.purpose,input.ruleVersion))throw new ServiceError(409,'RULE_REVOKED');
      if(Date.now()>=input.lookupDeadlineAt*1000)throw new ServiceError(504,'TIMEOUT');
      const expiresAt=(response as Result).expiresAt;
      if(expiresAt&&expiresAt<=Math.floor(Date.now()/1000))throw new ServiceError(410,'OTP_EXPIRED');
      if(this.store.profile(input.targetEmail)?.revision!==profile.revision)throw new ServiceError(503,'PROFILE_CHANGED');
      return response;
    })).catch(err=>{
      if(controller.signal.reason instanceof ServiceError&&controller.signal.reason.code==='CLIENT_DISCONNECTED')throw controller.signal.reason;
      if((controller.signal.aborted||err?.name==='AbortError')&&!(err instanceof ServiceError&&err.code==='PROFILE_CLEANUP_FAILED'))err=new ServiceError(this.store.cancelled(input.attemptUid)?409:504,this.store.cancelled(input.attemptUid)?'LOOKUP_CANCELLED':'TIMEOUT');
      if(err instanceof ServiceError&&![429,503].includes(err.status)&&!this.store.cancelled(input.attemptUid))this.store.save(input.attemptUid,{error:{status:err.status,code:err.code}});
      throw err;
    }).finally(()=>{clearTimeout(timer);this.running.delete(input.attemptUid);});
    this.running.set(input.attemptUid,{hash,promise,controller,waiters:1});return promise;
  }
  async cancel(uid:string,deadline:number){this.store.cancel(uid,deadline);const running=this.running.get(uid);running?.controller.abort();if(running)await running.promise.catch(()=>{});if(this.store.cleanupPending(uid))throw new ServiceError(503,'PROFILE_CLEANUP_FAILED');return{attemptUid:uid,cancelled:true,stopped:true};}
  async setup(uid:string){
    const profile=this.store.profileByUID(uid);if(!profile)throw new ServiceError(404,'PROFILE_NOT_FOUND');
    if(!this.mailbox.setup)throw new ServiceError(503,'SETUP_UNAVAILABLE');
    const controller=new AbortController(),deadline=Date.now()+600000;const timer=setTimeout(()=>controller.abort(),600000);
    const job={controller,promise:Promise.resolve<unknown>(undefined)};
    const promise=this.executor.run(profile.uid,deadline,controller.signal,async()=>{
      try{this.store.cleanupPending('setup:'+uid,uid);await this.mailbox.setup!(profile,deadline,controller.signal);controller.signal.throwIfAborted();this.store.enable(uid);return{email:profile.email,verified:true};}
      finally{try{await this.mailbox.close(profile);this.store.cleaned('setup:'+uid);}catch{this.executor.quarantine(uid);throw new ServiceError(503,'PROFILE_CLEANUP_FAILED');}}
    }).finally(()=>{clearTimeout(timer);this.maintenance.delete(job);});job.promise=promise;this.maintenance.add(job);return promise;
  }
  async shutdown(){this.executor.stop();for(const job of this.maintenance)job.controller.abort();for(const job of this.running.values())job.controller.abort();await Promise.allSettled([...[...this.running.values()].map(j=>j.promise),...[...this.maintenance].map(j=>j.promise)]);}
}

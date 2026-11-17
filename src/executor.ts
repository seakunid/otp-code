import { ServiceError } from './contracts.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { log, errorFields } from './log.js';
type Job = {key:string;deadline:number;signal:AbortSignal;run:()=>Promise<unknown>;resolve:(v:unknown)=>void;reject:(e:unknown)=>void;timer:NodeJS.Timeout;abort:()=>void;started:number};
export class Executor {
  private active=new Set<string>();private queue:Job[]=[];
  private quarantined=new Set<string>();
  private stopped=false;
  constructor(readonly capacity=2,readonly queueLimit=50,readonly profileQueueLimit=5) {
    if(!Number.isInteger(capacity)||capacity<1||!Number.isInteger(queueLimit)||queueLimit<0||!Number.isInteger(profileQueueLimit)||profileQueueLimit<0)throw Error('Invalid browser capacity');
  }
  run<T>(key:string,deadline:number,signal:AbortSignal,run:()=>Promise<T>):Promise<T> {
    log('debug','executor_admission',{profileUid:key,...this.stats()});
    if(this.stopped){log('warn','executor_rejected',{profileUid:key,errorCode:'SERVICE_STOPPING',...this.stats()});return Promise.reject(new ServiceError(503,'SERVICE_STOPPING'));}
    if(this.quarantined.has(key)){log('warn','executor_rejected',{profileUid:key,errorCode:'PROFILE_CLEANUP_FAILED',...this.stats()});return Promise.reject(new ServiceError(503,'PROFILE_CLEANUP_FAILED'));}
    if(signal.aborted){log('warn','executor_rejected',{profileUid:key,errorCode:'LOOKUP_CANCELLED',...this.stats()});return Promise.reject(new ServiceError(409,'LOOKUP_CANCELLED'));}
    if(deadline<=Date.now()){log('warn','executor_rejected',{profileUid:key,errorCode:'TIMEOUT',...this.stats()});return Promise.reject(new ServiceError(504,'TIMEOUT'));}
    const waiting=this.active.has(key)||this.active.size>=this.capacity;
    if(waiting&&this.queue.length>=this.queueLimit){log('warn','executor_rejected',{profileUid:key,errorCode:'SERVICE_QUEUE_FULL',...this.stats()});return Promise.reject(new ServiceError(429,'SERVICE_QUEUE_FULL'));}
    if(waiting&&this.queue.filter(j=>j.key===key).length>=this.profileQueueLimit){log('warn','executor_rejected',{profileUid:key,errorCode:'PROFILE_QUEUE_FULL',...this.stats()});return Promise.reject(new ServiceError(429,'PROFILE_QUEUE_FULL'));}
    return new Promise<T>((resolve,reject)=>{
      const remove=AsyncLocalStorage.bind((err:unknown)=>{const i=this.queue.indexOf(job);if(i>=0){this.queue.splice(i,1);this.clean(job);log('warn','executor_queue_removed',{profileUid:key,waitMs:Date.now()-job.started,...errorFields(err),...this.stats()});reject(err);}});
      const job:Job={key,deadline,signal,started:Date.now(),run:AsyncLocalStorage.bind(async()=>{
        const started=Date.now();log('info','executor_started',{profileUid:key,waitMs:started-job.started,...this.stats()});
        try{return await run();}finally{log('info','executor_finished',{profileUid:key,durationMs:Date.now()-started});}
      }),resolve:resolve as (v:unknown)=>void,reject,timer:setTimeout(()=>remove(new ServiceError(504,'TIMEOUT')),Math.max(1,deadline-Date.now())),abort:()=>remove(new ServiceError(409,'LOOKUP_CANCELLED'))};
      signal.addEventListener('abort',job.abort,{once:true});this.queue.push(job);if(waiting)log('info','executor_queued',{profileUid:key,...this.stats()});this.pump();
    });
  }
  private clean(j:Job){clearTimeout(j.timer);j.signal.removeEventListener('abort',j.abort);}
  private pump(){
    while(this.active.size<this.capacity){const i=this.queue.findIndex(j=>!this.active.has(j.key));if(i<0)return;const j=this.queue.splice(i,1)[0];this.clean(j);
      if(j.signal.aborted){j.reject(new ServiceError(409,'LOOKUP_CANCELLED'));continue;}
      if(j.deadline<=Date.now()){j.reject(new ServiceError(504,'TIMEOUT'));continue;}
      this.active.add(j.key);void j.run().then(j.resolve,j.reject).finally(()=>{if(!this.quarantined.has(j.key))this.active.delete(j.key);this.pump();});
    }
  }
  quarantine(key:string){log('error','executor_profile_quarantined',{profileUid:key});this.quarantined.add(key);this.active.add(key);}
  stop(){log('info','executor_stopping',this.stats());this.stopped=true;for(const job of this.queue.splice(0)){this.clean(job);job.reject(new ServiceError(503,'SERVICE_STOPPING'));}}
  stats(){return{active:this.active.size,queued:this.queue.length,capacity:this.capacity,quarantined:this.quarantined.size};}
}

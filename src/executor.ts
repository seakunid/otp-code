import { ServiceError } from './contracts.js';
type Job = {key:string;deadline:number;signal:AbortSignal;run:()=>Promise<unknown>;resolve:(v:unknown)=>void;reject:(e:unknown)=>void;timer:NodeJS.Timeout;abort:()=>void};
export class Executor {
  private active=new Set<string>();private queue:Job[]=[];
  private quarantined=new Set<string>();
  private stopped=false;
  constructor(readonly capacity=2,readonly queueLimit=50,readonly profileQueueLimit=5) {
    if(!Number.isInteger(capacity)||capacity<1||!Number.isInteger(queueLimit)||queueLimit<0||!Number.isInteger(profileQueueLimit)||profileQueueLimit<0)throw Error('Invalid browser capacity');
  }
  run<T>(key:string,deadline:number,signal:AbortSignal,run:()=>Promise<T>):Promise<T> {
    if(this.stopped)return Promise.reject(new ServiceError(503,'SERVICE_STOPPING'));
    if(this.quarantined.has(key))return Promise.reject(new ServiceError(503,'PROFILE_CLEANUP_FAILED'));
    if(signal.aborted)return Promise.reject(new ServiceError(409,'LOOKUP_CANCELLED'));
    if(deadline<=Date.now())return Promise.reject(new ServiceError(504,'TIMEOUT'));
    const waiting=this.active.has(key)||this.active.size>=this.capacity;
    if(waiting&&this.queue.length>=this.queueLimit) return Promise.reject(new ServiceError(429,'SERVICE_QUEUE_FULL'));
    if(waiting&&this.queue.filter(j=>j.key===key).length>=this.profileQueueLimit)return Promise.reject(new ServiceError(429,'PROFILE_QUEUE_FULL'));
    return new Promise<T>((resolve,reject)=>{
      const remove=(err:unknown)=>{const i=this.queue.indexOf(job);if(i>=0){this.queue.splice(i,1);this.clean(job);reject(err);}};
      const job:Job={key,deadline,signal,run,resolve:resolve as (v:unknown)=>void,reject,timer:setTimeout(()=>remove(new ServiceError(504,'TIMEOUT')),Math.max(1,deadline-Date.now())),abort:()=>remove(new ServiceError(409,'LOOKUP_CANCELLED'))};
      signal.addEventListener('abort',job.abort,{once:true});this.queue.push(job);this.pump();
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
  quarantine(key:string){this.quarantined.add(key);this.active.add(key);}
  stop(){this.stopped=true;for(const job of this.queue.splice(0)){this.clean(job);job.reject(new ServiceError(503,'SERVICE_STOPPING'));}}
  stats(){return{active:this.active.size,queued:this.queue.length,capacity:this.capacity,quarantined:this.quarantined.size};}
}

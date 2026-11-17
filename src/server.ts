import { createApp } from './app.js';
import { Store } from './store.js';
import { Retrieval } from './service.js';
import { Gmail } from './browser.js';
import { Executor } from './executor.js';
import {statePath} from './state-path.js';
import {isPrivateBindHost} from './contracts.js';
import {log,errorFields} from './log.js';
let stage='configuration';
try {
log('info','service_starting',{nodeVersion:process.version,pid:process.pid,entryPoint:'server'});
const token=process.env.OTP_RETRIEVAL_TOKEN||'';
const key=Buffer.from(process.env.OTP_RETRIEVAL_KEY||'','base64');
const host=process.env.OTP_BIND_HOST||'127.0.0.1';
if(!isPrivateBindHost(host))throw Error('Bind only to loopback or Tailscale address');
stage='state';
const store=new Store(statePath(),key);
log('info','state_opened');
const gmail=new Gmail(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
const service=new Retrieval(store,gmail,new Executor(Number(process.env.MAX_ACTIVE_BROWSERS||2),Number(process.env.MAX_QUEUED_LOOKUPS||50),Number(process.env.MAX_PROFILE_QUEUE||5)),2000,true);
stage='recovery';
const pending=store.db.prepare('SELECT uid,profile FROM cleanup').all();
log('info','startup_recovery_started',{pendingCount:pending.length,...service.executor.stats()});
for(const row of pending){
  const profile=store.profileByUID(String(row.profile));
  if(!profile)throw Error('RECOVERY_PROFILE_MISSING');
  try{await gmail.recover(profile);store.cleaned(String(row.uid));log('info','startup_recovery_completed',{attemptUid:String(row.uid),profileUid:profile.uid});}
  catch(error){service.executor.quarantine(profile.uid);log('error','startup_recovery_failed',{attemptUid:String(row.uid),profileUid:profile.uid,...errorFields(error)});}
}
store.purge(Math.floor(Date.now()/1000));
stage='listen';
const server=createApp(service,token).listen(Number(process.env.PORT||3010),host,()=>log('info','listening',{host,port:Number(process.env.PORT||3010),requireProfileProof:service.requireProfileProof,queueLimit:service.executor.queueLimit,profileQueueLimit:service.executor.profileQueueLimit,...service.executor.stats()}));
server.on('error',error=>{log('error','server_failed',{...errorFields(error)});store.close();process.exitCode=1;});
server.maxConnections=100;server.headersTimeout=10000;server.requestTimeout=15000;server.keepAliveTimeout=5000;
const purge=setInterval(()=>store.purge(Math.floor(Date.now()/1000)),10000);purge.unref();
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{log('info','service_shutdown_started',{signal});clearInterval(purge);server.close();void service.shutdown().finally(()=>{store.close();log('info','service_shutdown_completed');process.exit(0);});setTimeout(()=>{log('error','service_shutdown_timeout');process.exit(1);},10000).unref();});
}catch(error){log('error','service_startup_failed',{stage,...errorFields(error)});process.exitCode=1;}

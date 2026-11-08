import { createApp } from './app.js';
import { Store } from './store.js';
import { Retrieval } from './service.js';
import { Gmail } from './browser.js';
import { Executor } from './executor.js';
import {statePath} from './state-path.js';
import {isPrivateBindHost} from './contracts.js';
const token=process.env.OTP_RETRIEVAL_TOKEN||'';
const key=Buffer.from(process.env.OTP_RETRIEVAL_KEY||'','base64');
const host=process.env.OTP_BIND_HOST||'127.0.0.1';
if(!isPrivateBindHost(host))throw Error('Bind only to loopback or Tailscale address');
const store=new Store(statePath(),key);
const gmail=new Gmail(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
const service=new Retrieval(store,gmail,new Executor(Number(process.env.MAX_ACTIVE_BROWSERS||2),Number(process.env.MAX_QUEUED_LOOKUPS||50),Number(process.env.MAX_PROFILE_QUEUE||5)),2000,true);
for(const row of store.db.prepare('SELECT uid,profile FROM cleanup').all()){
  const profile=store.profileByUID(String(row.profile));
  if(!profile)throw Error('RECOVERY_PROFILE_MISSING');
  try{await gmail.recover(profile);store.cleaned(String(row.uid));}
  catch{service.executor.quarantine(profile.uid);console.error(JSON.stringify({event:'cleanup_failed',profileUid:profile.uid}));}
}
store.purge(Math.floor(Date.now()/1000));
const server=createApp(service,token).listen(Number(process.env.PORT||3010),host,()=>console.log(JSON.stringify({event:'listening',host,port:process.env.PORT||3010})));
server.maxConnections=100;server.headersTimeout=10000;server.requestTimeout=15000;server.keepAliveTimeout=5000;
const purge=setInterval(()=>store.purge(Math.floor(Date.now()/1000)),10000);purge.unref();
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{clearInterval(purge);server.close();void service.shutdown().finally(()=>{store.close();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();});

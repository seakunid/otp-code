import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Store } from '../src/store.js';
import { createProfileFiles } from '../src/profiles.js';
import {statePath} from '../src/state-path.js';
import {isPrivateBindHost} from '../src/contracts.js';
const store=new Store(statePath(),Buffer.from(process.env.OTP_RETRIEVAL_KEY||'','base64'));
const prompt=createInterface({input:process.stdin,output:process.stdout});
try {
 const [command,value]=process.argv.slice(2);
 if(command==='create'){
  const email=value||await prompt.question('Gmail email: ');
  const p=createProfileFiles(store,email,process.env.OTP_PROFILE_ROOT||join(process.env.USERPROFILE||'','otp-browser-profiles'),resolve('browser_profiles'),process.cwd());
  console.log(JSON.stringify({email:p.email,launcher:p.launcher,status:'LOGIN_REQUIRED'}));
 } else if(command==='list')console.log(JSON.stringify(store.list(value||'',100,process.argv[4]||'')));
 else if(command==='get'){const p=store.profile(value);if(!p)throw Error('PROFILE_NOT_FOUND');console.log(JSON.stringify(p));}
 else if(command==='disable'){const p=store.profile(value);if(!p)throw Error('PROFILE_NOT_FOUND');store.disable(p.uid);console.log('Disabled; active lookups cannot publish. Verify through launcher to enable again.');}
 else if(command==='setup'){
  const p=store.profileByUID(value);if(!p)throw Error('PROFILE_NOT_FOUND');
  console.log('Chrome will open. Sign into '+p.email+' manually. Verification closes Chrome after login.');
  const host=process.env.OTP_BIND_HOST||'127.0.0.1';if(!isPrivateBindHost(host))throw Error('Bind only to loopback or Tailscale address');
  const response=await fetch('http://'+host+':'+ (process.env.PORT||3010)+'/v1/profiles/'+p.uid+'/setup',{method:'POST',headers:{authorization:'Bearer '+process.env.OTP_RETRIEVAL_TOKEN,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(610000)});
  if(!response.ok)throw Error('Profile setup failed: HTTP '+response.status);
  console.log('Verified exact Gmail account; profile enabled.');
 } else throw Error('Use create, list [cursor] [prefix], get <email>, disable <email>, or setup <uid>');
} finally {prompt.close();store.close();}

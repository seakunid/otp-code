import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
import {registerExistingProfile} from '../src/profiles.js';
import {Store} from '../src/store.js';
import {z} from 'zod';
import {statePath} from '../src/state-path.js';
const file=process.argv[2];if(!file)throw Error('Usage: import-profiles <profiles.ndjson>; imported profiles remain disabled and unverified');
const store=new Store(statePath(),Buffer.from(process.env.OTP_RETRIEVAL_KEY||'','base64'));
const schema=z.object({email:z.email(),directory:z.string().min(1).max(1000)}).strict();
let imported=0,replayed=0,line=0;
try{
 for await(const text of createInterface({input:createReadStream(file),crlfDelay:Infinity})){
  if(!text.trim())continue;line++;
  if(text.length>4096)throw Error('PROFILE_ROW_TOO_LARGE at line '+line);
  const row=schema.parse(JSON.parse(text));
  const result=registerExistingProfile(store,row.email,row.directory,resolve('browser_profiles'),process.cwd());
  if(result.replayed)replayed++;else imported++;
  if(line%100===0)await new Promise<void>(r=>setImmediate(r));
 }
 console.log(JSON.stringify({imported,replayed,verified:0,browsersLaunched:0}));
}finally{store.close();}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync,statSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import {createApp} from '../src/app.js';import {Retrieval} from '../src/service.js';import {createProfileFiles} from '../src/profiles.js';
test('disk-backed indexed registry supports 1k, 10k and 100k mappings without browsers',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'otp-scale-')),path=join(dir,'scale.sqlite'),key=randomBytes(32);
 let store=new Store(path,key),previous=0;let initialHeap=0;
 for(const count of [1000,10000,100000]){
  const insert=store.db.prepare('INSERT INTO profile(uid,email,directory) VALUES(?,?,?)');
  const start=performance.now();
  for(let base=previous;base<count;base+=1000){store.db.exec('BEGIN');for(let i=base;i<Math.min(count,base+1000);i++)insert.run(`uid-${i}`,`account${String(i).padStart(6,'0')}@example.test`,`profile-${i}`);store.db.exec('COMMIT');}
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM profile').get()?.n,count);
  const samples=[];for(let i=0;i<1000;i++){const n=Math.floor(Math.random()*count);const t=performance.now();assert.equal(store.profile(`account${String(n).padStart(6,'0')}@example.test`)?.uid,`uid-${n}`);samples.push(performance.now()-t);}
  samples.sort((a,b)=>a-b);assert.equal(store.list('',100).length,100);assert.ok(samples[950]<100);
  assert.match(JSON.stringify(store.db.prepare('EXPLAIN QUERY PLAN SELECT * FROM profile WHERE email=?').all('absent@example.test')),/INDEX/);
  assert.equal(store.profile('absent@example.test'),undefined);
  store.close();const startup=performance.now();store=new Store(path,key);const startupMs=performance.now()-startup;assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM profile').get()?.n,count);
  const lists=[];for(let i=0;i<100;i++){const t=performance.now();assert.equal(store.list('',100).length,100);lists.push(performance.now()-t);}lists.sort((a,b)=>a-b);assert.ok(lists[95]<500);assert.ok(startupMs<10000);
  const server=createApp(new Retrieval(store,{read:async()=>{throw Error('NO_BROWSER_EXPECTED');},close:async()=>{}}),'synthetic-scale-token-0123456789').listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const health=[];try{
   const headers={authorization:'Bearer synthetic-scale-token-0123456789'};
   for(let i=0;i<30;i++){const t=performance.now();const response=await fetch(base+'/health/ready',{headers});assert.equal(response.status,200);const body=await response.json();assert.equal(body.active,0);health.push(performance.now()-t);}
   if(count===100000){
    let cursor='',seen=0,last='';
    do{const response=await fetch(base+'/v1/profiles?limit=1000&cursor='+encodeURIComponent(cursor),{headers});assert.equal(response.status,200);const page=await response.json();assert.ok(page.data.length<=1000);for(const profile of page.data){assert.ok(profile.email>last);assert.equal('directory' in profile,false);last=profile.email;seen++;}cursor=page.nextCursor||'';
     if(seen===1000){store.disable('uid-50000');assert.equal((await fetch(base+'/v1/profiles/uid-50000',{headers}).then(r=>r.json())).enabled,0);}
    }while(cursor);
    assert.equal(seen,100000);assert.equal(last,'account099999@example.test');
    const response=await fetch(base+'/v1/profiles?prefix=account09999&limit=100',{headers}),prefix=await response.json();assert.equal(prefix.data.length,10);assert.ok(prefix.data.every((p:{email:string})=>p.email.startsWith('account09999')));
   }
  }finally{await new Promise<void>(r=>server.close(()=>r()));}health.sort((a,b)=>a-b);assert.ok(health[28]<250);
  if(count===1000)initialHeap=process.memoryUsage().heapUsed;if(count===100000){assert.ok(process.memoryUsage().heapUsed-initialHeap<64*1024*1024);const profile=createProfileFiles(store,'new-scale@example.test',join(dir,'profiles'),join(dir,'launchers'),dir);assert.equal(store.profile('new-scale@example.test')?.uid,profile.uid);assert.equal(profile.verified,0);}
  console.log(JSON.stringify({configuredProfiles:count,elapsedMs:Math.round(performance.now()-start),sampleCount:1000,lookupP50Ms:samples[500],lookupP95Ms:samples[950],lookupP99Ms:samples[990],listP95Ms:lists[95],healthP95Ms:health[28],startupMs,heapBytes:process.memoryUsage().heapUsed,rssBytes:process.memoryUsage().rss,dbBytes:statSync(path).size,browsersLaunched:0}));previous=count;
 }
 store.close();rmSync(dir,{recursive:true});
});

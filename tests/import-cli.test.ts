import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {Store} from '../src/store.js';
test('streaming import persists completed rows, resumes safely, and preserves exact launcher names',()=>{
 const root=mkdtempSync(join(tmpdir(),'otp import cli ')),file=join(root,'input.ndjson'),db=join(root,'state.sqlite'),key=randomBytes(32);
 const repo=resolve('.'),script=join(repo,import.meta.url.endsWith('.ts')?'scripts/import-profiles.ts':'dist/scripts/import-profiles.js');
 const args=import.meta.url.endsWith('.ts')?['--import',import.meta.resolve('tsx'),script,file]:[script,file];
 const rows=Array.from({length:120},(_,i)=>({email:`account${i}@example.test`,directory:join(root,'existing',String(i))}));
 const run=()=>spawnSync(process.execPath,args,{cwd:root,env:{...process.env,OTP_STATE_DB:db,OTP_RETRIEVAL_KEY:key.toString('base64')},encoding:'utf8'});
 try{
  writeFileSync(file,rows.map(x=>JSON.stringify(x)).join('\n')+'\n{"email":"invalid"}\n');
  assert.notEqual(run().status,0);let store=new Store(db,key);assert.equal(store.list('',1000).length,120);store.close();
  rows.push({email:'new@example.test',directory:join(root,'existing','new')});writeFileSync(file,rows.map(x=>JSON.stringify(x)).join('\n'));
  const resumed=run();assert.equal(resumed.status,0,resumed.stderr);assert.deepEqual(JSON.parse(resumed.stdout),{imported:1,replayed:120,verified:0,browsersLaunched:0});
  store=new Store(db,key);assert.equal(store.list('',1000).length,121);assert.equal(store.profile('new@example.test')?.verified,0);store.close();
  assert.deepEqual(readdirSync(join(root,'browser_profiles')).sort(),rows.map(x=>x.email+'.bat').sort());
  writeFileSync(file,JSON.stringify({email:'collision@example.test',directory:rows[0].directory}));assert.notEqual(run().status,0);assert.equal(readdirSync(join(root,'browser_profiles')).length,121);
 }finally{rmSync(root,{recursive:true});}
});

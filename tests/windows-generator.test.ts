import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,readFileSync,existsSync,rmSync,writeFileSync,copyFileSync,mkdirSync,symlinkSync,readdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,basename,dirname,resolve} from 'node:path';import {randomBytes} from 'node:crypto';import {Store} from '../src/store.js';import {createProfileFiles} from '../src/profiles.js';import {spawnSync} from 'node:child_process';
test('isolated generator registers two email-named launchers without authentication copies',()=>{
 const root=mkdtempSync(join(tmpdir(),'otp generator real ')),store=new Store(join(root,'state.sqlite'),randomBytes(32));
 try{for(const email of ['nebula.together@gmail.com','abbyfc.dev@gmail.com']){const p=createProfileFiles(store,email,join(root,'profiles'),join(root,'launchers'),root);assert.equal(p.enabled,0);assert.equal(p.verified,0);assert.ok(existsSync(p.directory));assert.match(readFileSync(join(root,'launchers',email+'.bat'),'utf8'),new RegExp(p.uid));assert.match(readFileSync(join(root,'launchers',email+'.bat'),'utf8'),/exit \/b %OTP_EXIT%/);assert.ok(!existsSync(join(p.directory,'Default','Cookies')));}assert.equal(store.list('',10).length,2);
  if(process.platform==='win32'){
   writeFileSync(join(root,'Run-Node.bat'),'@echo off\r\nexit /b 17\r\n');copyFileSync('Create-OTP-Profile.bat',join(root,'Create-OTP-Profile.bat'));
   for(const path of [join(root,'Create-OTP-Profile.bat'),join(root,'launchers','abbyfc.dev@gmail.com.bat')]){
    const result=spawnSync('cmd.exe',['/d','/c',basename(path)],{cwd:dirname(path),input:'\r\n',encoding:'utf8'});assert.equal(result.status,17,result.stderr);
   }
  }
 }finally{store.close();rmSync(root,{recursive:true});}
});
test('actual Windows Create-OTP-Profile batch registers isolated empty profiles and rejects duplicate creation',{skip:process.platform!=='win32'},()=>{
 const root=mkdtempSync(join(tmpdir(),'otp actual batch ')),key=randomBytes(32),db=join(root,'state.sqlite');
 try{
  for(const file of ['Create-OTP-Profile.bat','Run-Node.bat'])copyFileSync(file,join(root,file));
  mkdirSync(join(root,'tools/node'),{recursive:true});symlinkSync(dirname(process.execPath),join(root,'tools/node/node-v24-test-win-x64'),'junction');symlinkSync(resolve('dist'),join(root,'dist'),'junction');
  const run=(email:string)=>spawnSync('cmd.exe',['/d','/c','Create-OTP-Profile.bat'],{cwd:root,input:email+'\r\n\r\n',env:{...process.env,OTP_STATE_DB:db,OTP_RETRIEVAL_KEY:key.toString('base64'),OTP_PROFILE_ROOT:join(root,'profiles')},encoding:'utf8',timeout:10000});
  for(const email of ['nebula.together@gmail.com','abbyfc.dev@gmail.com']){const result=run(email);assert.equal(result.status,0,result.stderr);}
  let store=new Store(db,key);const profiles=store.list('',10);assert.equal(profiles.length,2);assert.ok(profiles.every(p=>p.enabled===0&&p.verified===0));
  for(const p of profiles){const profile=store.profile(String(p.email))!;assert.deepEqual(readdirSync(profile.directory),[]);assert.ok(existsSync(join(root,'browser_profiles',profile.email+'.bat')));assert.match(readFileSync(join(root,'browser_profiles',profile.email+'.bat'),'utf8'),new RegExp(profile.uid));}store.close();
  assert.notEqual(run('abbyfc.dev@gmail.com').status,0);store=new Store(db,key);assert.equal(store.list('',10).length,2);store.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});

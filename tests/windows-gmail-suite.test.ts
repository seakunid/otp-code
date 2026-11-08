import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
test('Windows Gmail suite stops at failure and runs two matrices before later gates',{skip:process.platform!=='win32'},()=>{
 const root=mkdtempSync(join(tmpdir(),'otp Gmail suite '));
 try{
  for(const directory of ['scripts','runtime','dist/scripts','tools/node/test'])mkdirSync(join(root,directory),{recursive:true});
  copyFileSync(process.execPath,join(root,'tools/node/test/node.exe'));copyFileSync('scripts/windows-gmail-suite.ps1',join(root,'scripts/windows-gmail-suite.ps1'));
  writeFileSync(join(root,'runtime/gmail-e2e.env'),'OTP_SUITE_SELF_CHECK=true\n');
  const invoke=()=>spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'scripts/windows-gmail-suite.ps1')],{cwd:root,encoding:'utf8',timeout:30000});
  writeFileSync(join(root,'dist/scripts/gmail-e2e.js'),"require('fs').appendFileSync('runtime/order','matrix\\n');process.exit(7)");
  assert.equal(invoke().status,7);assert.equal(readFileSync(join(root,'runtime/order'),'utf8'),'matrix\n');
  writeFileSync(join(root,'runtime/order'),'');
  for(const name of ['gmail-e2e','gmail-original-fixtures','gmail-negative','gmail-reliability','gmail-folders'])writeFileSync(join(root,'dist/scripts',name+'.js'),`require('fs').appendFileSync('runtime/order',${JSON.stringify(name+'\n')});console.error('synthetic diagnostic');`);
  const passed=invoke();assert.equal(passed.status,0,passed.stderr);assert.equal(readFileSync(join(root,'runtime/order'),'utf8'),'gmail-e2e\ngmail-e2e\ngmail-original-fixtures\ngmail-negative\ngmail-reliability\ngmail-folders\n');
  writeFileSync(join(root,'runtime/e2e-stop'),'stop');assert.notEqual(invoke().status,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});

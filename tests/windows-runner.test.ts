import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('Windows test runner ignores archive metadata and runs scale exactly once',{skip:process.platform!=='win32'},()=>{
 const root=mkdtempSync(join(tmpdir(),'otp test runner '));
 try{
  for(const directory of ['scripts','runtime','dist/tests','tools/node/test'])mkdirSync(join(root,directory),{recursive:true});
  copyFileSync(process.execPath,join(root,'tools/node/test/node.exe'));
  copyFileSync('scripts/windows-tests.ps1',join(root,'scripts/windows-tests.ps1'));
  for(const name of ['normal','scale']){
   writeFileSync(join(root,'dist/tests',name+'.test.js'),`require('node:fs').appendFileSync('runtime/order',${JSON.stringify(name+'\n')});`);
   writeFileSync(join(root,'dist/tests','._'+name+'.test.js'),Buffer.from([0,5,22,7]));
  }
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'scripts/windows-tests.ps1')],{cwd:root,env,encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr);assert.equal(readFileSync(join(root,'runtime/order'),'utf8'),'normal\nscale\n');
 }finally{rmSync(root,{recursive:true,force:true});}
});

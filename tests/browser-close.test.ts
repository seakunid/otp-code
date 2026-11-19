import {test} from 'node:test';import assert from 'node:assert/strict';import {existsSync,mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {Gmail} from '../src/browser.js';
type Handle={sessions:Map<string,unknown>;leases:{acquire(directory:string):void;release(directory:string):void};close(profile:{uid:string;directory:string}):Promise<void>};
function prepare(exitCode:number|null){
 const directory=mkdtempSync(join(tmpdir(),'otp-close-')),gmail=new Gmail('unused') as unknown as Handle;
 gmail.leases.acquire(directory);
 // pid 0 skips the Windows process-tree calls; the fake child models either a dead or a live Chrome.
 gmail.sessions.set('uid',{process:()=>({pid:0,exitCode,signalCode:null,once(){}}),connected:false,close:async()=>{throw Error('Protocol error: Target closed');}});
 return {directory,gmail};
}
test('already-exited Chrome closes cleanly, releasing the session and profile lease',async()=>{
 const {directory,gmail}=prepare(1);
 await gmail.close({uid:'uid',directory});
 assert.equal(gmail.sessions.size,0);assert.equal(existsSync(join(directory,'.otp-retrieval.lock')),false);
});
test('a still-running Chrome whose pipe fails stays failed closed',async()=>{
 const {gmail,directory}=prepare(null);
 await assert.rejects(gmail.close({uid:'uid',directory}),/PROFILE_CLEANUP_FAILED|Target closed/);
});

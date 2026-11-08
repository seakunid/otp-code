import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes} from 'node:crypto';
import {Store} from '../src/store.js';import {createProfileFiles,registerExistingProfile} from '../src/profiles.js';
import {ProfileLease} from '../src/profile-lease.js';
test('independent processes cannot own the same profile; releasing allows a later owner',()=>{
 const directory=mkdtempSync(join(tmpdir(),'otp-lease-')),one=new ProfileLease(),two=new ProfileLease();one.acquire(directory);assert.throws(()=>two.acquire(directory),/PROFILE_BUSY/);assert.throws(()=>two.recoverable(directory),/PROFILE_BUSY/);one.release(directory);two.acquire(directory);two.release(directory);
});
test('profile generator uses exact email.bat and never overwrites existing mapping',()=>{
 const root=mkdtempSync(join(tmpdir(),'otp-generator-')),store=new Store(':memory:',randomBytes(32));
 const p=createProfileFiles(store,'User@mail.com',join(root,'profiles'),join(root,'launchers'),root);
 assert.ok(p.launcher.endsWith('user@mail.com.bat'));assert.equal(p.enabled,0);assert.equal(p.verified,0);assert.match(readFileSync(p.launcher,'utf8'),new RegExp(p.uid));
 assert.throws(()=>createProfileFiles(store,'user@mail.com',join(root,'profiles'),join(root,'launchers'),root),/PROFILE_EXISTS/);assert.throws(()=>createProfileFiles(store,'a%PATH%@mail.com',join(root,'profiles'),join(root,'launchers'),root));store.close();
});

test('existing-profile registration reconciles launchers and indexed search; disable fences revision',()=>{
 const root=mkdtempSync(join(tmpdir(),'otp-register-')),s=new Store(':memory:',randomBytes(32));
 const a=registerExistingProfile(s,'a@example.test',join(root,'existing'),join(root,'launchers'),root);
 assert.equal(a.profile.verified,0);assert.ok(a.launcher.endsWith('a@example.test.bat'));
 assert.equal(registerExistingProfile(s,'a@example.test',join(root,'existing'),join(root,'launchers'),root).replayed,true);
 assert.throws(()=>registerExistingProfile(s,'a@example.test',join(root,'other'),join(root,'launchers'),root),/PROFILE_CONFLICT/);
 assert.equal(s.list('',10,'a@').length,1);assert.equal(s.list('',10,'b@').length,0);s.enable(a.profile.uid);s.disable(a.profile.uid);assert.equal(s.profile('a@example.test')?.enabled,0);assert.equal(s.profile('a@example.test')?.revision,2);s.close();
});

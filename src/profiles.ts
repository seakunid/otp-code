import { mkdirSync, writeFileSync, readFileSync, existsSync, rmdirSync, unlinkSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store,canonicalDirectory } from './store.js';
import { normalizeEmail, ServiceError } from './contracts.js';
export function createProfileFiles(store:Store,email:string,root:string,launchers:string,appDirectory:string) {
  email=normalizeEmail(z.email().max(200).parse(email));
  if(/[<>:"/\\|?*\x00-\x1f%&!^()]/.test(email)||email.endsWith('.')||email.endsWith(' '))throw new ServiceError(422,'UNSAFE_PROFILE_FILENAME');
  if(store.profile(email))throw new ServiceError(409,'PROFILE_EXISTS');
  for(const value of [root,launchers,appDirectory])if(/[\r\n%!"]/g.test(value))throw new ServiceError(422,'UNSAFE_PROFILE_PATH');
  const uid=randomUUID(),directory=join(resolve(root),uid),launcher=join(resolve(launchers),`${email}.bat`);
  if(basename(launcher)!==`${email}.bat`||existsSync(launcher))throw new ServiceError(409,'LAUNCHER_EXISTS');
  mkdirSync(root,{recursive:true});mkdirSync(launchers,{recursive:true});mkdirSync(directory);
  let created=false;
  try {
    writeFileSync(launcher,`@echo off\r\nsetlocal DisableDelayedExpansion\r\ncd /d "${resolve(appDirectory)}"\r\ncall Run-Node.bat dist\\scripts\\profiles.js setup ${uid}\r\nset "OTP_EXIT=%ERRORLEVEL%"\r\nif not "%OTP_EXIT%"=="0" echo Profile setup failed. See error above.\r\npause\r\nexit /b %OTP_EXIT%\r\n`,{flag:'wx',mode:0o600});
    created=true;
    return {...store.createProfile(email,directory,uid),launcher};
  }catch(err){if(created)unlinkSync(launcher);try{rmdirSync(directory);}catch{}throw err;}
}

export function registerExistingProfile(store:Store,email:string,directory:string,launchers:string,appDirectory:string){
 email=normalizeEmail(z.email().max(200).parse(email));directory=canonicalDirectory(directory);
 if(/[<>:"/\\|?*\x00-\x1f%&!^()]/.test(email))throw new ServiceError(422,'UNSAFE_PROFILE_FILENAME');
 for(const value of [launchers,appDirectory])if(/[\r\n%!"]/g.test(value))throw new ServiceError(422,'UNSAFE_PROFILE_PATH');
 const existing=store.profile(email);if(existing&&existing.directory!==directory)throw new ServiceError(409,'PROFILE_CONFLICT');
 const uid=existing?.uid||randomUUID(),launcher=join(resolve(launchers),email+'.bat');
 const content=`@echo off\r\nsetlocal DisableDelayedExpansion\r\ncd /d "${resolve(appDirectory)}"\r\ncall Run-Node.bat dist\\scripts\\profiles.js setup ${uid}\r\nset "OTP_EXIT=%ERRORLEVEL%"\r\nif not "%OTP_EXIT%"=="0" echo Profile setup failed. See error above.\r\npause\r\nexit /b %OTP_EXIT%\r\n`;
 mkdirSync(launchers,{recursive:true});let created=false;
 if(existsSync(launcher)){if(!existing||!readFileSync(launcher,'utf8').includes('setup '+uid))throw new ServiceError(409,'LAUNCHER_EXISTS');}
 else {writeFileSync(launcher,content,{flag:'wx',mode:0o600});created=true;}
 try{return {profile:existing||store.createProfile(email,directory,uid),replayed:!!existing,launcher};}
 catch(err){if(created)unlinkSync(launcher);throw err;}
}

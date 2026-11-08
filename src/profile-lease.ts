import {readFileSync,writeFileSync,unlinkSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {ServiceError} from './contracts.js';
export class ProfileLease {
  private owned=new Set<string>();
  acquire(directory:string){
    if(this.owned.has(directory))return;
    try{writeFileSync(join(directory,'.otp-retrieval.lock'),JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});}
    catch{throw new ServiceError(503,'PROFILE_BUSY');}
    this.owned.add(directory);
  }
  release(directory:string){if(this.owned.has(directory)){unlinkSync(join(directory,'.otp-retrieval.lock'));this.owned.delete(directory);}}
  recoverable(directory:string){
    const file=join(directory,'.otp-retrieval.lock');if(!existsSync(file))return false;
    let pid:number;try{pid=JSON.parse(readFileSync(file,'utf8')).pid;}catch{throw new ServiceError(503,'PROFILE_LEASE_INVALID');}
    if(!Number.isSafeInteger(pid)||pid<1)throw new ServiceError(503,'PROFILE_LEASE_INVALID');
    if(pid===process.pid){if(this.owned.has(directory))return true;throw new ServiceError(503,'PROFILE_BUSY');}
    try{process.kill(pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return true;}
    throw new ServiceError(503,'PROFILE_BUSY');
  }
  recovered(directory:string){unlinkSync(join(directory,'.otp-retrieval.lock'));this.owned.delete(directory);}
}

import { AsyncLocalStorage } from 'node:async_hooks';
import { ServiceError } from './contracts.js';

type Level = 'debug'|'info'|'warn'|'error';
type Fields = Record<string,string|number|boolean|undefined>;
const context=new AsyncLocalStorage<Fields>();
const levels={debug:10,info:20,warn:30,error:40};
export function withLogContext<T>(fields:Fields,run:()=>T):T{return context.run({...context.getStore(),...fields},run);}
export function log(level:Level,event:string,fields:Fields={}){
  const configured=process.env.LOG_LEVEL as Level;
  if(levels[level]<(Object.hasOwn(levels,configured)?levels[configured]:levels.debug))return;
  // Only explicit scalar metadata belongs here; never pass payloads or raw errors.
  const safe=Object.fromEntries(Object.entries({...context.getStore(),...fields}).map(([key,value])=>[key,
    /token|password|secret|authorization|cookie|body|subject|sender|email|pattern|directory|path|sourceMessageRef|^code$/i.test(key)?'[REDACTED]':
    typeof value==='string'?value.replace(/[^\s<>]+@[^\s<>]+/g,'[REDACTED]').slice(0,200):value]));
  const line=JSON.stringify({...safe,timestamp:new Date().toISOString(),level,event});
  // stderr keeps CLI JSON results on stdout parseable.
  console.error(line);
}
export function errorFields(error:unknown){
  const type={errorType:error instanceof Error?error.name:'UnknownError'};
  if(error instanceof ServiceError)return {...type,errorCode:error.code};
  const code=(error as NodeJS.ErrnoException|null)?.code;
  if(typeof code==='string'&&/^[A-Z0-9_]{1,80}$/.test(code))return {...type,errorCode:code};
  const configuration:Record<string,string>={
    'Encryption key must be 32 bytes':'INVALID_ENCRYPTION_KEY',
    'Bind only to loopback or Tailscale address':'INVALID_BIND_HOST',
    'Bearer token must contain at least 24 characters':'INVALID_BEARER_TOKEN',
    'Invalid browser capacity':'INVALID_BROWSER_CAPACITY',
    'STATE_KEY_INVALID':'STATE_KEY_INVALID','RECOVERY_PROFILE_MISSING':'RECOVERY_PROFILE_MISSING'
  };
  return {...type,errorCode:error instanceof Error&&Object.hasOwn(configuration,error.message)?configuration[error.message]:'INTERNAL_ERROR'};
}

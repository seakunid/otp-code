import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, win32 } from 'node:path';
import { existsSync, lstatSync } from 'node:fs';
import { normalizeEmail, Profile, Rule, ServiceError, Cancellation } from './contracts.js';
export function canonicalDirectory(directory:string){
 if(process.platform!=='win32')return directory;
 if(!win32.isAbsolute(directory)||directory.startsWith('\\\\'))throw new ServiceError(422,'PROFILE_PATH_INVALID');
 directory=win32.resolve(directory).replace(/[\\]+$/,'').toLowerCase();
 let parent=directory;while(parent!==win32.dirname(parent)){if(existsSync(parent)&&lstatSync(parent).isSymbolicLink())throw new ServiceError(422,'PROFILE_REPARSE_POINT');parent=win32.dirname(parent);}
 return directory;
}
export class Store {
  db: DatabaseSync;
  constructor(path: string, private key: Buffer) {
    if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive:true,mode:0o700});
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS profile(uid TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,directory TEXT UNIQUE NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,verified INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS rule(provider TEXT,purpose TEXT,version INTEGER,hash TEXT,body TEXT,PRIMARY KEY(provider,purpose,version));
      CREATE TABLE IF NOT EXISTS rule_proof(provider TEXT,purpose TEXT,version INTEGER,email TEXT,hash TEXT,kind TEXT,verified_at INTEGER,PRIMARY KEY(provider,purpose,version,email));
      CREATE TABLE IF NOT EXISTS active_rule(provider TEXT,purpose TEXT,version INTEGER,PRIMARY KEY(provider,purpose));
      CREATE TABLE IF NOT EXISTS rule_command(uid TEXT PRIMARY KEY,hash TEXT NOT NULL,result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revoked_rule(provider TEXT,purpose TEXT,version INTEGER,PRIMARY KEY(provider,purpose,version));
      CREATE TABLE IF NOT EXISTS encryption_check(value BLOB);
      CREATE TABLE IF NOT EXISTS attempt(uid TEXT PRIMARY KEY,hash TEXT,deadline INTEGER,cancelled INTEGER NOT NULL DEFAULT 0,result BLOB);
      CREATE TABLE IF NOT EXISTS attempt_context(uid TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cancellation(uid TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cleanup(uid TEXT PRIMARY KEY,profile TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS terminal(uid TEXT PRIMARY KEY,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS used_source(email TEXT,ref TEXT,owner TEXT,until INTEGER,PRIMARY KEY(email,ref));
      CREATE INDEX IF NOT EXISTS attempt_deadline ON attempt(deadline);
      CREATE INDEX IF NOT EXISTS source_retention ON used_source(until);`);
    const check=this.db.prepare('SELECT value FROM encryption_check LIMIT 1').get();
    if(check){try{const value=Buffer.from(check.value as Uint8Array),dec=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));dec.setAuthTag(value.subarray(12,28));dec.update(value.subarray(28));dec.final();}catch{this.db.close();throw new Error('STATE_KEY_INVALID');}}
    else{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);const value=Buffer.concat([cipher.update('otp-state-key-v1'),cipher.final()]);this.db.prepare('INSERT INTO encryption_check VALUES(?)').run(Buffer.concat([iv,cipher.getAuthTag(),value]));}
  }
  hash(value: unknown) {
    const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,canonical(x)])):v;
    return createHash('sha256').update(JSON.stringify(canonical(value)).replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029')).digest('hex');
  }
  createProfile(email: string, directory: string, uid:string = randomUUID()) {
    directory=canonicalDirectory(directory);
    try { this.db.prepare('INSERT INTO profile(uid,email,directory) VALUES(?,?,?)').run(uid,normalizeEmail(email),directory); }
    catch { throw new ServiceError(409,'PROFILE_EXISTS'); }
    return this.profile(email)!;
  }
  profile(email: string) { return this.db.prepare('SELECT * FROM profile WHERE email=?').get(normalizeEmail(email)) as Profile|undefined; }
  profileByUID(uid: string) { return this.db.prepare('SELECT * FROM profile WHERE uid=?').get(uid) as Profile|undefined; }
  enable(uid: string) { this.db.prepare('UPDATE profile SET enabled=1,verified=1 WHERE uid=?').run(uid); }
  disable(uid:string){this.db.prepare('UPDATE profile SET enabled=0,revision=revision+1 WHERE uid=?').run(uid);}
  list(after = '', limit = 100, prefix='') {
    if(!Number.isInteger(limit)||limit<1||limit>1000)throw new ServiceError(422,'INVALID_PAGE_LIMIT');
    return this.db.prepare('SELECT uid,email,enabled,verified,revision FROM profile WHERE email>? AND email>=? AND email<? ORDER BY email LIMIT ?').all(after,prefix,prefix+'\uffff',limit);
  }
  syncRule(rule: Rule,hash=this.hash(rule)) {
    const body=JSON.stringify(rule);
    const old=this.db.prepare('SELECT hash FROM rule WHERE provider=? AND purpose=? AND version=?').get(rule.providerUid,rule.purpose,rule.version);
    if (old && old.hash!==hash) throw new ServiceError(409,'RULE_VERSION_CONFLICT');
    this.db.prepare('INSERT OR IGNORE INTO rule VALUES(?,?,?,?,?)').run(rule.providerUid,rule.purpose,rule.version,hash,body);
    return {version:rule.version,hash};
  }
  activate(provider: string,purpose: string,version: number) {
    if(this.revoked(provider,purpose,version))throw new ServiceError(409,'RULE_REVOKED');
    if (!this.db.prepare('SELECT 1 FROM rule WHERE provider=? AND purpose=? AND version=?').get(provider,purpose,version)) throw new ServiceError(409,'RULE_VERSION_CONFLICT');
    this.db.prepare('INSERT INTO active_rule VALUES(?,?,?) ON CONFLICT(provider,purpose) DO UPDATE SET version=excluded.version').run(provider,purpose,version);
  }
  ruleCommand(provider:string,purpose:string,version:number,command:string,commandUid:string,expectedActiveRevision:number){
    const hash=this.hash({provider,purpose,version,command,expectedActiveRevision});
    const old=this.db.prepare('SELECT hash,result FROM rule_command WHERE uid=?').get(commandUid);
    if(old){if(old.hash!==hash)throw new ServiceError(409,'IDEMPOTENCY_CONFLICT');return JSON.parse(String(old.result));}
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const active=Number(this.db.prepare('SELECT version FROM active_rule WHERE provider=? AND purpose=?').get(provider,purpose)?.version||0);
      if(active!==expectedActiveRevision)throw new ServiceError(409,'ACTIVE_RULE_CONFLICT');
      if(command==='activate')this.activate(provider,purpose,version);else this.revoke(provider,purpose,version);
      const result={version,active:command==='activate',commandUid,activeRevision:command==='activate'?version:active===version?0:active};
      this.db.prepare('INSERT INTO rule_command VALUES(?,?,?)').run(commandUid,hash,JSON.stringify(result));this.db.exec('COMMIT');return result;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  rule(provider: string,purpose: string,version: number,diagnostic=false) {
    if(this.revoked(provider,purpose,version))throw new ServiceError(409,'RULE_REVOKED');
    const diagnosticRule=diagnostic?this.db.prepare('SELECT body FROM rule WHERE provider=? AND purpose=? AND version=?').get(provider,purpose,version):undefined;
    const r=diagnosticRule||this.db.prepare('SELECT r.body FROM rule r JOIN active_rule a ON a.provider=r.provider AND a.purpose=r.purpose AND a.version=r.version WHERE r.provider=? AND r.purpose=? AND r.version=?').get(provider,purpose,version);
    if(!r) throw new ServiceError(409,'RULE_VERSION_CONFLICT');
    return JSON.parse(String(r.body)) as Rule;
  }
  proof(provider:string,purpose:string,version:number,email:string){return this.db.prepare('SELECT * FROM rule_proof WHERE provider=? AND purpose=? AND version=? AND email=?').get(provider,purpose,version,email);}
  verifyRule(provider:string,purpose:string,version:number,email:string,hash:string,kind:string){this.db.prepare('INSERT OR REPLACE INTO rule_proof VALUES(?,?,?,?,?,?,?)').run(provider,purpose,version,email,hash,kind,Math.floor(Date.now()/1000));}
  revoked(provider:string,purpose:string,version:number){return Boolean(this.db.prepare('SELECT 1 FROM revoked_rule WHERE provider=? AND purpose=? AND version=?').get(provider,purpose,version));}
  revoke(provider:string,purpose:string,version:number){
    this.db.prepare('INSERT OR IGNORE INTO revoked_rule VALUES(?,?,?)').run(provider,purpose,version);
    this.db.prepare('DELETE FROM active_rule WHERE provider=? AND purpose=? AND version=?').run(provider,purpose,version);
  }
  admit(uid:string,hash:string,deadline:number) {
    const old=this.db.prepare('SELECT * FROM attempt WHERE uid=?').get(uid);
    if(old) {
      if(old.cancelled) throw new ServiceError(409,'LOOKUP_CANCELLED');
      if(old.hash && old.hash!==hash) throw new ServiceError(409,'IDEMPOTENCY_CONFLICT');
      return old;
    }
    this.db.prepare('INSERT INTO attempt(uid,hash,deadline) VALUES(?,?,?)').run(uid,hash,deadline);
    return undefined;
  }
  cancel(uid:string,deadline:number) {
    const existing=this.db.prepare('SELECT deadline FROM attempt WHERE uid=?').get(uid);if(existing&&existing.deadline!==deadline)throw new ServiceError(409,'CANCEL_IDENTITY_CONFLICT');
    this.db.prepare('INSERT INTO attempt(uid,deadline,cancelled) VALUES(?,?,1) ON CONFLICT(uid) DO UPDATE SET cancelled=1,result=NULL').run(uid,deadline);
  }
  cancelled(uid:string) { return Boolean(this.db.prepare('SELECT cancelled FROM attempt WHERE uid=?').get(uid)?.cancelled); }
  cancelIdentity(uid:string,input:Cancellation){
    const attempt=this.db.prepare('SELECT deadline FROM attempt WHERE uid=?').get(uid);if(attempt&&attempt.deadline!==input.lookupDeadlineAt)throw new ServiceError(409,'CANCEL_IDENTITY_CONFLICT');
    const saved=this.context(uid)?.input;
    if(saved&&['requestUid','providerUid','accountUid','targetEmail','lookupDeadlineAt'].some(key=>saved[key]!==input[key as keyof Cancellation]))throw new ServiceError(409,'CANCEL_IDENTITY_CONFLICT');
    const old=this.db.prepare('SELECT body FROM cancellation WHERE uid=?').get(uid);
    if(old&&this.hash(JSON.parse(String(old.body)))!==this.hash(input))throw new ServiceError(409,'CANCEL_IDENTITY_CONFLICT');
    this.db.prepare('INSERT OR IGNORE INTO cancellation VALUES(?,?)').run(uid,JSON.stringify(input));
  }
  context(uid:string,value?:unknown) {
    if(value!==undefined)this.db.prepare('INSERT OR IGNORE INTO attempt_context VALUES(?,?)').run(uid,JSON.stringify(value));
    const row=this.db.prepare('SELECT body FROM attempt_context WHERE uid=?').get(uid);
    return row?JSON.parse(String(row.body)):undefined;
  }
  cleanupPending(uid:string,profile?:string) {if(profile)this.db.prepare('INSERT OR REPLACE INTO cleanup VALUES(?,?)').run(uid,profile);return this.db.prepare('SELECT profile FROM cleanup WHERE uid=?').get(uid);}
  cleaned(uid:string) {this.db.prepare('DELETE FROM cleanup WHERE uid=?').run(uid);}
  complete(uid:string,email:string,ref:string|undefined,value:unknown) {
    this.db.exec('BEGIN IMMEDIATE');
    try {if(ref)this.reserve(email,ref,uid,Math.floor(Date.now()/1000));this.save(uid,value);this.db.prepare('INSERT OR REPLACE INTO terminal VALUES(?,?)').run(uid,(value as {expiresAt?:number}).expiresAt||0);this.db.exec('COMMIT');}
    catch(err){this.db.exec('ROLLBACK');throw err;}
  }
  save(uid:string,value:unknown) {
    if(this.cancelled(uid)) throw new ServiceError(409,'LOOKUP_CANCELLED');
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(uid));
    const data=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);
    this.db.prepare('UPDATE attempt SET result=? WHERE uid=?').run(Buffer.concat([iv,cipher.getAuthTag(),data]),uid);
  }
  read(uid:string) {
    const row=this.db.prepare('SELECT result FROM attempt WHERE uid=?').get(uid);
    if(!row?.result) return undefined;
    const data=Buffer.from(row.result as Uint8Array),dec=createDecipheriv('aes-256-gcm',this.key,data.subarray(0,12));dec.setAAD(Buffer.from(uid));dec.setAuthTag(data.subarray(12,28));
    return JSON.parse(Buffer.concat([dec.update(data.subarray(28)),dec.final()]).toString());
  }
  used(email:string,ref:string,uid:string,now:number) { const r=this.db.prepare('SELECT owner FROM used_source WHERE email=? AND ref=? AND until>?').get(email,ref,now);return r && r.owner!==uid; }
  reserve(email:string,ref:string,uid:string,now:number) {
    if(this.used(email,ref,uid,now)) throw new ServiceError(409,'SOURCE_ALREADY_USED');
    this.db.prepare('INSERT INTO used_source VALUES(?,?,?,?) ON CONFLICT(email,ref) DO UPDATE SET owner=excluded.owner,until=excluded.until').run(email,ref,uid,now+86400);
  }
  purge(now:number) {
    this.db.prepare('UPDATE attempt SET result=NULL WHERE uid IN (SELECT a.uid FROM attempt a LEFT JOIN terminal t ON t.uid=a.uid WHERE a.result IS NOT NULL AND (a.deadline<=? OR (t.expires>0 AND t.expires<=?)) LIMIT 1000)').run(now,now);
    this.db.prepare('DELETE FROM attempt_context WHERE uid IN(SELECT uid FROM attempt WHERE deadline<=? LIMIT 1000)').run(now-86400);
    this.db.prepare('DELETE FROM cancellation WHERE uid IN(SELECT uid FROM attempt WHERE deadline<=? LIMIT 1000)').run(now-86400);
    this.db.prepare('DELETE FROM terminal WHERE uid IN(SELECT uid FROM attempt WHERE deadline<=? LIMIT 1000)').run(now-86400);
    this.db.prepare('DELETE FROM attempt WHERE uid IN(SELECT uid FROM attempt WHERE deadline<=? AND uid NOT IN(SELECT uid FROM cleanup) LIMIT 1000)').run(now-86400);
    this.db.prepare('DELETE FROM used_source WHERE rowid IN(SELECT rowid FROM used_source WHERE until<=? LIMIT 1000)').run(now);
  }
  close() { this.db.close(); }
}

import express from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { lookupSchema, ruleSchema, cancelSchema, purpose, ServiceError, senderAccepted } from './contracts.js';
import { Retrieval } from './service.js';
import { log, errorFields, withLogContext } from './log.js';
export function createApp(service:Retrieval,token:string,options:{allowSyntheticVerification?:boolean}={}){
  if(token.length<24)throw Error('Bearer token must contain at least 24 characters');
  const app=express();app.disable('x-powered-by');
  app.use((req,res,next)=>{const httpRequestId=randomUUID();return withLogContext({httpRequestId,entryPoint:'http'},()=>{
    const started=performance.now();res.setHeader('X-Request-ID',httpRequestId);
    // Keep arbitrary URLs, query strings and body fields out of access logs.
    const route=()=>String(req.route?.path||'unmatched');
    log(req.path==='/health/live'||req.path==='/health/ready'?'debug':'info','http_request_started',{method:req.method});
    res.once('finish',AsyncLocalStorage.bind(()=>log(res.statusCode>=500?'error':res.statusCode>=400?'warn':req.path.startsWith('/health/')?'debug':'info','http_request_completed',{method:req.method,route:route(),status:res.statusCode,durationMs:Math.round(performance.now()-started)})));
    res.once('close',AsyncLocalStorage.bind(()=>{if(!res.writableEnded)log('warn','http_client_disconnected',{method:req.method,route:route(),durationMs:Math.round(performance.now()-started)});}));
    next();
  });});
  app.use((req,res,next)=>{
    res.setHeader('Cache-Control','no-store');
    const actual=Buffer.from(req.headers.authorization||''),expected=Buffer.from(`Bearer ${token}`);
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected)){log('warn','http_request_rejected',{errorCode:'UNAUTHORIZED'});res.status(401).json({error:{code:'UNAUTHORIZED'}});return;}
    if(req.method!=='GET'&&!req.is('application/json')){log('warn','http_request_rejected',{errorCode:'UNSUPPORTED_MEDIA_TYPE'});res.status(415).json({error:{code:'UNSUPPORTED_MEDIA_TYPE'}});return;}
    next();
  });
  app.use((req,res,next)=>express.json({limit:req.path==='/v1/rules/preview'?'256kb':'32kb',strict:true})(req,res,next));
  app.get('/health/live',(_,res)=>res.json({status:'live'}));
  app.get('/health/ready',(_,res)=>{
    const stats=service.executor.stats();let stateReady=false;
    try{service.store.db.prepare('SELECT 1').get();stateReady=service.store.db.prepare('PRAGMA query_only').get()?.query_only===0;}catch{}
    const ready=stateReady&&stats.quarantined<stats.capacity;
    if(!ready)log('warn','readiness_unavailable',{stateReady,...stats});
    res.status(ready?200:503).json({status:ready?'ready':'unavailable',...stats});
  });
  app.get('/v1/profiles',(req,res)=>{
    const limit=z.coerce.number().int().min(1).max(1000).parse(req.query.limit||100);
    const cursor=z.union([z.literal(''),z.email().max(254)]).parse(req.query.cursor||'');const prefix=z.string().max(254).parse(req.query.prefix||'');const data=service.store.list(cursor,limit,prefix);res.json({data,nextCursor:data.length===limit?data.at(-1)?.email:null});
  });
  app.get('/v1/profiles/:uid',(req,res)=>{const p=service.store.profileByUID(req.params.uid);if(!p)throw new ServiceError(404,'PROFILE_NOT_FOUND');res.json({uid:p.uid,email:p.email,enabled:p.enabled,verified:p.verified,revision:p.revision});});
  app.post('/v1/profiles/:uid/setup',async(req,res)=>{z.object({}).strict().parse(req.body);res.json(await service.setup(req.params.uid));});
  app.post('/v1/lookups',async(req,res)=>{
    const input=lookupSchema.parse(req.body);
    if(req.headers['idempotency-key']!==input.attemptUid)throw new ServiceError(400,'IDEMPOTENCY_KEY_MISMATCH');
    const release=service.subscribe(input.attemptUid),disconnected=AsyncLocalStorage.bind(()=>release(!res.writableEnded));res.once('close',disconnected);
    try{const result=await service.lookup(input);if(!res.destroyed)res.json(result);}finally{release();res.off('close',disconnected);}
  });
  app.post('/v1/lookups/:attemptId/cancel',async(req,res)=>{
    const body=cancelSchema.parse(req.body);body.targetEmail=body.targetEmail.toLowerCase();
    z.string().min(1).max(128).parse(req.params.attemptId);
    if(body.lookupDeadlineAt>Math.floor(Date.now()/1000)+300)throw new ServiceError(422,'INVALID_TIME_WINDOW');
    service.store.cancelIdentity(req.params.attemptId,body);
    res.json({...await service.cancel(req.params.attemptId,body.lookupDeadlineAt),commandUid:body.commandUid});
  });
  app.post('/v1/rules/validate',async(req,res)=>{const rule=ruleSchema.parse(req.body);log('info','rule_validated',{providerUid:rule.providerUid,purpose:rule.purpose,ruleVersion:rule.version});res.json({valid:true,hash:service.store.hash(req.body)});});
  app.post('/v1/rules/preview',async(req,res)=>{
    const input=z.object({rule:ruleSchema,message:z.object({sender:z.email(),subject:z.string().max(500),body:z.string().max(262144)}).strict()}).strict().parse(req.body);
    const now=Math.floor(Date.now()/1000);
    const logPreview=(outcome:string)=>log('info','rule_preview_completed',{providerUid:input.rule.providerUid,purpose:input.rule.purpose,ruleVersion:input.rule.version,outcome});
    if(!senderAccepted(input.rule,input.message.sender)){logPreview('NOT_FOUND');res.json({outcome:'NOT_FOUND',reason:'SENDER_MISMATCH'});return;}
    // A pasted mail has no rendered anchor list, so its own text is the only link source the preview can check.
    const message={ref:'synthetic',...input.message,links:input.message.body,receivedAt:now};
    const answer=await service.llm.classify({providerUid:input.rule.providerUid,purpose:input.rule.purpose,requestedAt:now-60,now,messages:[message]});
    logPreview(answer?'FOUND':'NOT_FOUND');
    res.json(answer?{outcome:'FOUND',reason:answer.reason,code:answer.value}:{outcome:'NOT_FOUND',reason:'NO_ARTIFACT'});
  });
  app.put('/v1/providers/:providerUid/rules/:purpose/versions/:version',async(req,res)=>{
    const rule=ruleSchema.parse(req.body);if(rule.providerUid!==req.params.providerUid||rule.purpose!==req.params.purpose||String(rule.version)!==req.params.version)throw new ServiceError(422,'RULE_IDENTITY_MISMATCH');
    res.json(service.store.syncRule(rule,service.store.hash(req.body)));
  });
  app.get('/v1/providers/:providerUid/rules/:purpose',(req,res)=>{
    const provider=z.string().min(1).max(128).parse(req.params.providerUid),type=purpose.parse(req.params.purpose);
    const row=service.store.db.prepare('SELECT version FROM active_rule WHERE provider=? AND purpose=?').get(provider,type);
    const activeRevision=Number(row?.version||0);
    const hash=activeRevision?service.store.db.prepare('SELECT hash FROM rule WHERE provider=? AND purpose=? AND version=?').get(provider,type,activeRevision)?.hash:null;
    res.json({providerUid:provider,purpose:type,activeRevision,hash});
  });
  app.post('/v1/providers/:providerUid/rules/:purpose/versions/:version/verify',async(req,res)=>{
    const input=lookupSchema.parse(req.body);
    input.targetEmail=input.targetEmail.toLowerCase();
    if(input.providerUid!==req.params.providerUid||input.purpose!==req.params.purpose||String(input.ruleVersion)!==req.params.version)throw new ServiceError(422,'RULE_IDENTITY_MISMATCH');
    const result=await service.lookup(input,true) as {outcome:string;verificationKind:string};
    if(result.outcome!=='FOUND')throw new ServiceError(409,'RULE_VERIFICATION_FAILED');
    const rule=service.store.db.prepare('SELECT hash FROM rule WHERE provider=? AND purpose=? AND version=?').get(input.providerUid,input.purpose,input.ruleVersion);
    service.store.verifyRule(input.providerUid,input.purpose,input.ruleVersion,input.targetEmail,String(rule?.hash),result.verificationKind);
    service.store.db.exec('CREATE TABLE IF NOT EXISTS rule_verification(provider TEXT,purpose TEXT,version INTEGER,hash TEXT,verified_at INTEGER,PRIMARY KEY(provider,purpose,version))');
    service.store.db.prepare('INSERT OR REPLACE INTO rule_verification VALUES(?,?,?,?,?)').run(input.providerUid,input.purpose,input.ruleVersion,String(rule?.hash),Math.floor(Date.now()/1000));
    res.json({verified:true,hash:rule?.hash,version:input.ruleVersion,profileEmail:input.targetEmail,purpose:input.purpose,verificationKind:result.verificationKind});
  });
  app.post('/v1/providers/:providerUid/rules/:purpose/activate',(req,res)=>{
    const body=z.object({version:z.number().int().positive(),commandUid:z.string().min(1).max(128),expectedActiveRevision:z.number().int().nonnegative()}).strict().parse(req.body);
    service.store.db.exec('CREATE TABLE IF NOT EXISTS rule_verification(provider TEXT,purpose TEXT,version INTEGER,hash TEXT,verified_at INTEGER,PRIMARY KEY(provider,purpose,version))');
    if(!service.store.db.prepare('SELECT 1 FROM rule_verification WHERE provider=? AND purpose=? AND version=?').get(req.params.providerUid,req.params.purpose,body.version))throw new ServiceError(409,'RULE_NOT_VERIFIED');
    const proofs=service.store.db.prepare('SELECT kind FROM rule_proof WHERE provider=? AND purpose=? AND version=?').all(req.params.providerUid,req.params.purpose,body.version);
    if(!proofs.some(p=>p.kind==='PROVIDER_MAIL'||options.allowSyntheticVerification))throw new ServiceError(409,'GENUINE_PROVIDER_VERIFICATION_REQUIRED');
    res.json(service.store.ruleCommand(req.params.providerUid,req.params.purpose,body.version,'activate',body.commandUid,body.expectedActiveRevision));
  });
  app.post('/v1/providers/:providerUid/rules/:purpose/deactivate',(req,res)=>{
    const body=z.object({version:z.number().int().positive(),commandUid:z.string().min(1).max(128),expectedActiveRevision:z.number().int().nonnegative()}).strict().parse(req.body);
    res.json(service.store.ruleCommand(req.params.providerUid,req.params.purpose,body.version,'deactivate',body.commandUid,body.expectedActiveRevision));
  });
  app.use((_,res)=>{log('warn','http_request_rejected',{errorCode:'ROUTE_NOT_FOUND'});res.status(404).json({error:{code:'ROUTE_NOT_FOUND'}});});
  app.use((err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    if(err instanceof z.ZodError){log('warn','http_request_rejected',{errorCode:'VALIDATION_ERROR',issueCount:err.issues.length});res.status(422).json({error:{code:'VALIDATION_ERROR',fields:err.issues.map(i=>i.path.join('.'))}});return;}
    if(err instanceof ServiceError){log(err.status>=500?'error':'warn','http_request_failed',{status:err.status,...errorFields(err)});res.status(err.status).json({error:{code:err.code}});return;}
    const status=(err as {status?:number})?.status;
    log(status===400||status===413?'warn':'error','http_request_failed',{...errorFields(err),errorCode:status===413?'BODY_TOO_LARGE':status===400?'INVALID_JSON':errorFields(err).errorCode,status:status||500});
    res.status(status===413?413:status===400?400:status&&status>=400&&status<600?status:500).json({error:{code:status===413?'BODY_TOO_LARGE':status===400?'INVALID_JSON':status?'UPSTREAM_ERROR':'INTERNAL_ERROR'}});
  });return app;
}

import {readFileSync,writeFileSync} from 'node:fs';
import {z} from 'zod';
import {Store} from '../src/store.js';
import {Gmail} from '../src/browser.js';
import {Executor} from '../src/executor.js';
import {sendPlayground} from './playground.js';
if(process.env.OTP_REAL_GMAIL_E2E!=='true')throw Error('Explicit real Gmail E2E opt-in required');
const input=z.object({from:z.number().int().min(0).max(1),to:z.number().int().min(0).max(1),subject:z.string().regex(/^OTP-E2E-[0-9A-Za-z-]+$/).max(100),body:z.string().max(2000)}).strict().parse(JSON.parse(readFileSync('runtime/gmail-send.json','utf8')));
const store=new Store(process.env.OTP_STATE_DB||'runtime/state.sqlite',Buffer.from(process.env.OTP_RETRIEVAL_KEY||'','base64')),gmail=new Gmail(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
try{await sendPlayground(store,gmail,new Executor(),input.from,input.to,input.subject,input.body);writeFileSync('runtime/gmail-send-result.json',JSON.stringify({subject:input.subject,status:'PASS'}));}
catch(e){writeFileSync('runtime/gmail-send-result.json',JSON.stringify({subject:input.subject,status:'FAIL',error:e instanceof Error?e.name:'UNKNOWN'}));process.exitCode=1;}
finally{store.close();}

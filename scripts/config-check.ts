import { existsSync } from 'node:fs';
import {isPrivateBindHost} from '../src/contracts.js';
if(!isPrivateBindHost(process.env.OTP_BIND_HOST||'127.0.0.1'))throw Error('Bind only to loopback or Tailscale address');
if((process.env.OTP_RETRIEVAL_TOKEN||'').length<24)throw Error('OTP_RETRIEVAL_TOKEN requires at least 24 characters');
if(Buffer.from(process.env.OTP_RETRIEVAL_KEY||'','base64').length!==32)throw Error('OTP_RETRIEVAL_KEY must decode to 32 bytes');
if(!existsSync(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'))throw Error('CHROME_PATH does not exist');
if(!process.env.LLM_ENDPOINT||!process.env.API_KEY||!process.env.MODEL)throw Error('LLM_ENDPOINT, API_KEY and MODEL are required');
console.log('Configuration shape and Chrome path valid; Gmail login and model gateway not verified.');

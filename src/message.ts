import { ServiceError } from './contracts.js';
export function decodeSubject(value:string){
 return value.replace(/(\?=)[ \t]+(?==\?)/g,'$1').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,(_word,charset:string,encoding:string,text:string)=>{
  try{
   if(encoding.toLowerCase()==='b'&&!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text))throw Error();
   if(encoding.toLowerCase()==='q'&&/=(?![0-9a-f]{2})/i.test(text))throw Error();
   const bytes=encoding.toLowerCase()==='b'?Buffer.from(text,'base64'):Buffer.from(text.replace(/_/g,' ').replace(/=([0-9a-f]{2})/gi,(_,hex:string)=>String.fromCharCode(parseInt(hex,16))),'latin1');
   return new TextDecoder(charset,{fatal:true}).decode(bytes);
  }catch{throw new ServiceError(502,'MESSAGE_SUBJECT_UNVERIFIED');}
 });
}
export function receiptMetadata(raw:string,email:string,visibleSender:string){
 const block=raw.replace(/\r\n/g,'\n').split('\n\n')[0];
 if(!block||block===raw)throw new ServiceError(502,'MESSAGE_HEADERS_UNVERIFIED');
 const headers=new Map<string,string[]>();let key='';
 for(const line of block.split('\n')){
  if(/^[ \t]/.test(line)&&key){const values=headers.get(key)!;values[values.length-1]+=' '+line.trim();continue;}
  const match=/^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
  if(!match)throw new ServiceError(502,'MESSAGE_HEADERS_UNVERIFIED');
  key=match[1].toLowerCase();headers.set(key,[...(headers.get(key)||[]),match[2]]);
 }
 const address=(s:string)=>s.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+/g)?.map(x=>x.toLowerCase())||[];
 if(!address((headers.get('delivered-to')||[])[0]||'').includes(email.toLowerCase()))return undefined;
 const from=address(headers.get('from')?.[0]||'');
 if(from.length!==1||from[0]!==visibleSender.toLowerCase())throw new ServiceError(502,'MESSAGE_SENDER_UNVERIFIED');
 // Gmail prepends its receipt metadata; never trust the sender-controlled Date header.
 const received=(headers.get('received')||[]).find(x=>/by\s+(?:[a-z0-9.-]+\.)?(?:google|gmail)\.com\b|by\s+2002:/i.test(x));
 const stamp=received?.slice(received.lastIndexOf(';')+1).trim();
 if(!stamp||!/[+-]\d{4}(?:\s*\([^)]+\))?$/.test(stamp))throw new ServiceError(502,'MESSAGE_RECEIPT_UNVERIFIED');
 const receivedAt=Math.floor(Date.parse(stamp)/1000);
 if(!Number.isFinite(receivedAt))throw new ServiceError(502,'MESSAGE_METADATA_UNVERIFIED');
 const authentication=(headers.get('authentication-results')||[]).find(x=>/^mx\.google\.com;/i.test(x));
 const domain=from[0].split('@')[1];
 const aligned=authentication?.split(';').some(part=>{
  if(/dkim=pass\b/i.test(part))return [...part.matchAll(/header\.(?:i|d)=@?([a-z0-9.-]+)/gi)].some(m=>m[1].toLowerCase()===domain);
  if(/spf=pass\b/i.test(part)){const identity=/smtp\.mailfrom=([^\s;]+)/i.exec(part)?.[1].toLowerCase();return identity?.split('@').at(-1)===domain;}
  return false;
 });
 if(!aligned)throw new ServiceError(502,'SENDER_AUTH_UNVERIFIED');
 const messageId=headers.get('message-id')?.[0];
 if(!messageId||messageId.length>200)throw new ServiceError(502,'MESSAGE_METADATA_UNVERIFIED');
 return {receivedAt,subject:headers.has('subject')?decodeSubject(headers.get('subject')![0]):undefined,ref:`gmail:${messageId}`};
}
export function messageExpiry(body:string,receivedAt:number){
 const text=body.split(/----- (?:Previous|Original) message -----|\nOn .+wrote:|\n>/i)[0];
 const matches=[...text.matchAll(/(?:expires? (?:in|after)|valid for|within)\s+(\d{1,3})\s+(seconds?|minutes?)/gi)];
 const times=matches.map(m=>receivedAt+Number(m[1])*(m[2].toLowerCase().startsWith('minute')?60:1));
 return times.length?Math.min(...times):undefined;
}

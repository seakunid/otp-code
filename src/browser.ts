import puppeteer, { Browser, Page } from 'puppeteer-core';
import { Lookup, Message, Profile, Rule, ServiceError } from './contracts.js';
import { receiptMetadata, messageExpiry } from './message.js';
import {existsSync,realpathSync} from 'node:fs';
import {canonicalDirectory} from './store.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {ProfileLease} from './profile-lease.js';
export interface Mailbox { read(profile:Profile,input:Lookup,rule:Rule,signal:AbortSignal):Promise<Message[]>; close(profile:Profile):Promise<void>; setup?(profile:Profile,deadline:number,signal?:AbortSignal):Promise<void>; }
export class Gmail implements Mailbox {
  private sessions=new Map<string,Browser>();
  private leases=new ProfileLease();
  private tainted=new Set<string>();
  constructor(private executablePath:string){}
  async open(profile:Profile,deadline:number){
    if(!existsSync(profile.directory))throw new ServiceError(503,'PROFILE_DIRECTORY_MISSING');
    if(process.platform==='win32'&&canonicalDirectory(realpathSync(profile.directory))!==canonicalDirectory(profile.directory))throw new ServiceError(503,'PROFILE_PATH_CHANGED');
    let browser=this.sessions.get(profile.uid);if(browser?.connected)return browser;
    this.leases.acquire(profile.directory);
    try{browser=await puppeteer.launch({executablePath:this.executablePath,userDataDir:profile.directory,headless:false,pipe:true,defaultViewport:{width:1365,height:900},timeout:Math.max(1,Math.min(20000,deadline-Date.now())),protocolTimeout:Math.max(1,Math.min(15000,deadline-Date.now())),args:['--no-first-run','--no-default-browser-check','--lang=en-US',`--otp-retrieval-owned=${profile.uid}`]});}
    catch(error){try{await this.recover(profile);}catch{this.tainted.add(profile.uid);throw new ServiceError(503,'PROFILE_CLEANUP_FAILED');}throw error;}
    this.sessions.set(profile.uid,browser);return browser;
  }
  async verify(page:Page,email:string,deadline:number){
    await page.bringToFront();
    for(let attempt=0;attempt<4&&Date.now()<deadline;attempt++){
      try{
        const timeout=Math.max(1,Math.min(15000,deadline-Date.now()));
        await page.goto('https://mail.google.com/mail/u/0/#inbox',{waitUntil:'domcontentloaded',timeout});
        await page.waitForFunction(()=>/[^\s<>]+@[^\s<>]+ - Gmail$/.test(document.title)||location.hostname==='accounts.google.com',{polling:100,timeout:Math.max(1,Math.min(15000,deadline-Date.now()))});
        break;
      }catch{await page.goto('about:blank',{waitUntil:'load',timeout:Math.max(1,Math.min(3000,deadline-Date.now()))}).catch(()=>{});}
    }
    if(page.url()==='about:blank')throw new ServiceError(502,'GMAIL_UI_TIMEOUT_IDENTITY');
    if(!page.url().startsWith('https://mail.google.com/'))throw new ServiceError(503,'LOGIN_REQUIRED');
    if((await page.title()).match(/(?:^| - )([^\s<>]+@[^\s<>]+) - Gmail$/)?.[1].toLowerCase()!==email)throw new ServiceError(503,'ACCOUNT_MISMATCH');
    await page.waitForSelector('[gh="cm"]',{visible:true,timeout:Math.max(1,deadline-Date.now())});
  }
  async setup(profile:Profile,deadline:number,signal?:AbortSignal){
    const browser=await this.open(profile,deadline),page=await browser.newPage();
    await page.goto('https://mail.google.com/mail/',{waitUntil:'domcontentloaded'});
    while(Date.now()<deadline){
      signal?.throwIfAborted();
      if(page.url().startsWith('https://mail.google.com/')&&(await page.title()).match(/(?:^| - )([^\s<>]+@[^\s<>]+) - Gmail$/)?.[1].toLowerCase()===profile.email)return;
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    throw new ServiceError(504,'MANUAL_LOGIN_TIMEOUT');
  }
  async read(profile:Profile,input:Lookup,rule:Rule,signal:AbortSignal):Promise<Message[]> {
    let stage='open';
    const deadline=input.lookupDeadlineAt*1000-5000;signal.throwIfAborted();if(Date.now()>=deadline)throw new ServiceError(504,'TIMEOUT');let browser=await this.open(profile,deadline);
    let page=await browser.newPage();page.setDefaultTimeout(Math.max(1,Math.min(15000,deadline-Date.now())));
    const abort=()=>{void page.close().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
    try {
      stage='identity';
      try{await this.verify(page,profile.email,Math.min(deadline,Date.now()+15000));}catch(error){
        if(error instanceof ServiceError&&error.code==='GMAIL_UI_TIMEOUT_IDENTITY'&&Date.now()<deadline){
          await page.close().catch(()=>{});await this.close(profile);browser=await this.open(profile,deadline);page=await browser.newPage();page.setDefaultTimeout(Math.max(1,Math.min(15000,deadline-Date.now())));await this.verify(page,profile.email,deadline);
        }else throw error;
      }
      const quote=(x:string)=>`"${x.replace(/["\\\r\n]/g,' ')}"`;
      const senders=[...rule.senders,...rule.domains.map(x=>`@${x}`)].map(x=>`from:${quote(x)}`);
      const query=`-in:spam -in:trash -in:drafts after:${input.windowStartedAt} before:${Math.floor(Date.now()/1000)+1} {${senders.join(' ')}} subject:${quote(rule.subject)}`;
      stage='search';await page.goto(`https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`,{waitUntil:'domcontentloaded',timeout:Math.max(1,deadline-Date.now())});
      await page.waitForFunction((subject)=>[...document.querySelectorAll('tr.zA')].filter(e=>(e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0)).length>0&&[...document.querySelectorAll('tr.zA')].filter(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0).every(e=>(e.querySelector('.bog')?.textContent||'').includes(subject))||/No conversations found|No results found|No messages matched your search/.test(document.body.innerText),{polling:100},rule.subject);
      const coverage=await page.evaluate(()=>{
        const older=[...document.querySelectorAll('[aria-label="Older"],[aria-label="Next results"]')].find(e=>e.getBoundingClientRect().height>0);
        return older?{complete:older.getAttribute('aria-disabled')==='true',range:older.parentElement?.textContent?.match(/([0-9,]+)[–-]([0-9,]+) of ([0-9,]+)/)?.slice(1).map(x=>Number(x.replace(/,/g,'')))}:null;
      });
      const refs=await page.evaluate(()=>[...document.querySelectorAll('tr.zA')].filter(e=>(e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0)).map(e=>e.getAttribute('data-legacy-thread-id')||e.querySelector('[data-legacy-thread-id]')?.getAttribute('data-legacy-thread-id')).filter((x):x is string=>Boolean(x)));
      if(refs.length>20||(refs.length>0&&(!coverage?.complete||!coverage.range||coverage.range[0]!==1||coverage.range[1]!==refs.length||coverage.range[2]!==refs.length)))throw new ServiceError(422,'SEARCH_COVERAGE_INCOMPLETE');
      const messages:Message[]=[];
      for(const ref of refs){
        signal.throwIfAborted();if(Date.now()>=deadline-5000)throw new ServiceError(504,'TIMEOUT');
        if(!/^[a-f0-9]+$/i.test(ref))throw new ServiceError(502,'GMAIL_UI_CHANGED');
        stage='message';await page.goto(`https://mail.google.com/mail/u/0/#all/${ref}`,{waitUntil:'domcontentloaded',timeout:Math.max(1,deadline-Date.now())});
        await page.waitForSelector('.a3s',{visible:true});
        await page.evaluate(()=>{for(const e of document.querySelectorAll<HTMLElement>('.ajR'))if((e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0))e.click();});
        if(await page.$('.a3s a[href*=\"view=lg\"]'))throw new ServiceError(422,'MESSAGE_CLIPPED');
        const rows=await page.evaluate(()=>{
          const subject=document.querySelector('h2.hP')?.textContent?.trim()||'';
          return [...document.querySelectorAll('.adn')].filter(e=>e.querySelector('.a3s')).map(e=>({
            id:e.getAttribute('data-legacy-message-id')||e.querySelector('[data-legacy-message-id]')?.getAttribute('data-legacy-message-id'),
            sender:e.querySelector('.gD[email]')?.getAttribute('email')||'',subject,
            body:(()=>{const body=e.querySelector<HTMLElement>('.a3s')?.cloneNode(true) as HTMLElement|undefined;body?.querySelectorAll('.gmail_quote,blockquote').forEach(x=>x.remove());if(!body)return '';body.querySelectorAll('br').forEach(x=>x.replaceWith('\n'));body.querySelectorAll('td,th').forEach(x=>x.append(' '));body.querySelectorAll('div,p,tr').forEach(x=>x.append('\n'));return body.textContent||'';})()
          }));
        });
        if(!rows.length)throw new ServiceError(502,'GMAIL_UI_CHANGED');
        for(const row of rows){
          if(!row.id||!/^[a-f0-9]+$/i.test(row.id))throw new ServiceError(502,'MESSAGE_METADATA_UNVERIFIED');
          const popup=new Promise<Page|null>(resolve=>page.once('popup',resolve));
          stage='original_menu';
          await page.click(`[data-legacy-message-id="${row.id}"] button[aria-label="More message options"]`);
          await page.waitForFunction(()=>{
            const item=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(e=>(e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0)&&e.textContent?.trim()==='Show original');
            if(!item)return false;item.click();return true;
          },{polling:100});
          let popupTimer:NodeJS.Timeout|undefined;
          const original=await Promise.race([popup,new Promise<never>((_,reject)=>{popupTimer=setTimeout(()=>reject(new ServiceError(502,'GMAIL_UI_TIMEOUT')),Math.min(10000,Math.max(1,deadline-Date.now())));})]).finally(()=>clearTimeout(popupTimer));
          if(!original)throw new ServiceError(502,'GMAIL_UI_CHANGED');
          const abortOriginal=()=>{void original.close().catch(()=>{});};signal.addEventListener('abort',abortOriginal,{once:true});
          try{
            stage='original_headers';
            await original.waitForFunction(()=>[...document.querySelectorAll('pre')].some(e=>/Delivered-To:/.test(e.textContent||'')&&/Message-ID:/i.test(e.textContent||'')&&/\n\s*\n/.test(e.textContent||'')),{polling:100,timeout:Math.max(1,deadline-Date.now())});
            const raw=await original.evaluate(()=>[...document.querySelectorAll('pre')].map(e=>e.textContent||'').find(text=>/Delivered-To:|Received:/.test(text))?.slice(0,65536)||'');
            const metadata=receiptMetadata(raw,profile.email,row.sender);
            if(metadata&&!metadata.subject)throw new ServiceError(502,'MESSAGE_SUBJECT_UNVERIFIED');
            // Replies can have a different Subject from Gmail's conversation heading.
            if(metadata)messages.push({...metadata,sender:row.sender,subject:metadata.subject!,body:row.body,expiresAt:messageExpiry(row.body,metadata.receivedAt)});
          }finally{signal.removeEventListener('abort',abortOriginal);await original.close().catch(()=>{});}
        }
      }
      return messages.sort((a,b)=>b.receivedAt-a.receivedAt);
    }catch(error){
      if(Date.now()>=deadline)throw new ServiceError(504,'TIMEOUT');
      if(error instanceof ServiceError||signal.aborted)throw error;
      console.error(JSON.stringify({event:'gmail_ui_failure',stage,remainingMs:deadline-Date.now(),...(await page.evaluate((email)=>({gmailHost:location.hostname==='mail.google.com',gmailTitle:document.title.includes('Gmail'),accountMatches:document.title.includes(email),compose:!!document.querySelector('[gh="cm"]'),ready:document.readyState}),profile.email).catch(()=>({pageUnavailable:true})))}));
      throw new ServiceError(502,((error as Error).name==='TimeoutError'?'GMAIL_UI_TIMEOUT_':'GMAIL_UI_CHANGED_')+stage.toUpperCase());
    }finally{signal.removeEventListener('abort',abort);await page.close().catch(()=>{});}
  }
  async close(profile:Profile){
    const browser=this.sessions.get(profile.uid);if(!browser){if(this.tainted.has(profile.uid))throw new ServiceError(503,'PROFILE_CLEANUP_FAILED');return;}
    const child=browser.process();let timer:NodeJS.Timeout|undefined;
    try {
      if(child?.pid&&process.platform==='win32')await this.processTree(child.pid,false);
      await Promise.race([browser.close(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new ServiceError(503,'PROFILE_CLEANUP_FAILED')),5000);})]);
      if(child&&child.exitCode===null&&child.signalCode===null)await new Promise<void>((resolve,reject)=>{const t=setTimeout(()=>reject(new ServiceError(503,'PROFILE_CLEANUP_FAILED')),2000);child.once('exit',()=>{clearTimeout(t);resolve();});});
      if(child?.pid&&process.platform==='win32')await this.processTree(child.pid,true);
      this.sessions.delete(profile.uid);
      this.leases.release(profile.directory);
    }finally{clearTimeout(timer);}
  }
  private trees=new Map<number,string>();
  private async processTree(pid:number,verify:boolean){
    const script=verify?`$ErrorActionPreference='Stop';$items=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${this.trees.get(pid)}'))|ConvertFrom-Json;foreach($item in $items){$p=Get-Process -Id $item.pid -ErrorAction SilentlyContinue;if($p -and $p.StartTime.ToUniversalTime().Ticks.ToString() -eq $item.started){if(!$p.WaitForExit(3000)){throw 'PROFILE_CLEANUP_FAILED'}}}`:`$ErrorActionPreference='Stop';$all=@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'");$ids=@(${pid});do{$next=@($all|Where-Object {$ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId}|ForEach-Object {$_.ProcessId});$ids+=$next}while($next.Count -gt 0);$items=@(foreach($id in $ids){$p=Get-Process -Id $id -ErrorAction SilentlyContinue;if($p){@{pid=$id;started=$p.StartTime.ToUniversalTime().Ticks.ToString()}}});ConvertTo-Json -Compress -InputObject $items`;
    let result;
    try{result=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from("$ProgressPreference='SilentlyContinue';"+script+';exit 0','utf16le').toString('base64')],{timeout:5000,windowsHide:true,maxBuffer:16384});}
    catch{throw new ServiceError(503,'PROFILE_CLEANUP_FAILED');}
    if(verify)this.trees.delete(pid);else this.trees.set(pid,Buffer.from(result.stdout.trim()).toString('base64'));
  }
  async recover(profile:Profile){
    if(process.platform!=='win32')throw new ServiceError(503,'RECOVERY_REQUIRES_WINDOWS');
    const lease=this.leases.recoverable(profile.directory);
    const encoded=Buffer.from(JSON.stringify({directory:profile.directory,marker:`--otp-retrieval-owned=${profile.uid}`})).toString('base64');
    const script=`$ErrorActionPreference='Stop'; $v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json; $items=Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"|Where-Object {$_.CommandLine -and $_.CommandLine.Contains($v.directory) -and $_.CommandLine.Contains($v.marker) -and $_.CommandLine -notmatch '--type='};foreach($item in $items){$p=Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue;if($p){[void]$p.CloseMainWindow();if(!$p.WaitForExit(7000)){throw 'PROFILE_CLEANUP_FAILED'}}}`;
    await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeout:10000,windowsHide:true,maxBuffer:1024});
    if(lease)this.leases.recovered(profile.directory);
  }
}

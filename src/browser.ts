import puppeteer, { Browser, Page } from 'puppeteer-core';
import { Lookup, Message, Profile, Rule, ServiceError } from './contracts.js';
import { receiptMetadata, messageExpiry, MESSAGE_LOOKBACK_SECONDS, MAX_CANDIDATE_MESSAGES } from './message.js';
import {existsSync,realpathSync} from 'node:fs';
import {canonicalDirectory} from './store.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {ProfileLease} from './profile-lease.js';
import {log,errorFields} from './log.js';
const MAX_THREADS=8;
export interface Mailbox { read(profile:Profile,input:Lookup,rule:Rule,signal:AbortSignal):Promise<Message[]>; close(profile:Profile):Promise<void>; setup?(profile:Profile,deadline:number,signal?:AbortSignal):Promise<void>; }
export class Gmail implements Mailbox {
  private sessions=new Map<string,Browser>();
  private leases=new ProfileLease();
  private tainted=new Set<string>();
  constructor(private executablePath:string){}
  async open(profile:Profile,deadline:number){
    if(!existsSync(profile.directory))throw new ServiceError(503,'PROFILE_DIRECTORY_MISSING');
    if(process.platform==='win32'&&canonicalDirectory(realpathSync(profile.directory))!==canonicalDirectory(profile.directory))throw new ServiceError(503,'PROFILE_PATH_CHANGED');
    let browser=this.sessions.get(profile.uid);if(browser?.connected){log('debug','browser_reused',{profileUid:profile.uid});return browser;}
    const started=performance.now();log('info','browser_launch_started',{profileUid:profile.uid});
    this.leases.acquire(profile.directory);
    try{browser=await this.launch(profile,deadline);}
    catch(error){
      log('error','browser_launch_failed',{profileUid:profile.uid,...errorFields(error)});
      try{await this.recover(profile);}catch{this.tainted.add(profile.uid);throw new ServiceError(503,'PROFILE_CLEANUP_FAILED');}
      // A crashed or foreign Chrome still holding the profile directory is the usual cause, and recovery clears it, so one retry wins.
      try{browser=await this.launch(profile,deadline);}
      catch(retryError){log('error','browser_launch_failed_after_recovery',{profileUid:profile.uid,...errorFields(retryError)});throw new ServiceError(503,'BROWSER_LAUNCH_FAILED');}
    }
    this.sessions.set(profile.uid,browser);log('info','browser_launch_completed',{profileUid:profile.uid,pid:browser.process()?.pid,durationMs:Math.round(performance.now()-started)});return browser;
  }
  // Google refuses sign-in from browsers flagged as automated; the manual login window must keep its normal browser identity.
  private launch(profile:Profile,deadline:number){
    return puppeteer.launch({executablePath:this.executablePath,userDataDir:profile.directory,headless:false,pipe:true,ignoreDefaultArgs:['--enable-automation'],defaultViewport:{width:1365,height:900},timeout:Math.max(1,Math.min(20000,deadline-Date.now())),protocolTimeout:Math.max(1,Math.min(15000,deadline-Date.now())),args:['--no-first-run','--no-default-browser-check','--lang=en-US','--disable-blink-features=AutomationControlled',`--otp-retrieval-owned=${profile.uid}`]});
  }
  async verify(page:Page,email:string,deadline:number){
    await page.bringToFront();
    for(let attempt=0;attempt<4&&Date.now()<deadline;attempt++){
      try{
        const timeout=Math.max(1,Math.min(15000,deadline-Date.now()));
        await page.goto('https://mail.google.com/mail/u/0/#inbox',{waitUntil:'domcontentloaded',timeout});
        await page.waitForFunction(()=>/[^\s<>]+@[^\s<>]+ - Gmail$/.test(document.title)||location.hostname==='accounts.google.com',{polling:100,timeout:Math.max(1,Math.min(15000,deadline-Date.now()))});
        break;
      }catch(error){log('warn','gmail_identity_retry',{retry:attempt+1,remainingMs:Math.max(0,deadline-Date.now()),...errorFields(error)});await page.goto('about:blank',{waitUntil:'load',timeout:Math.max(1,Math.min(3000,deadline-Date.now()))}).catch(()=>{});}
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
    let stage='open';const started=performance.now();
    log('debug','gmail_read_started',{profileUid:profile.uid,attemptUid:input.attemptUid});
    const deadline=input.lookupDeadlineAt*1000-5000;signal.throwIfAborted();if(Date.now()>=deadline)throw new ServiceError(504,'TIMEOUT');let browser=await this.open(profile,deadline);
    let page=await browser.newPage();page.setDefaultTimeout(Math.max(1,Math.min(15000,deadline-Date.now())));
    const abort=()=>{void page.close().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
    try {
      stage='identity';
      try{await this.verify(page,profile.email,Math.min(deadline,Date.now()+15000));}catch(error){
        if(error instanceof ServiceError&&error.code==='GMAIL_UI_TIMEOUT_IDENTITY'&&Date.now()<deadline){
          log('warn','gmail_browser_restart',{profileUid:profile.uid,reason:'IDENTITY_TIMEOUT'});
          await page.close().catch(()=>{});await this.close(profile);browser=await this.open(profile,deadline);page=await browser.newPage();page.setDefaultTimeout(Math.max(1,Math.min(15000,deadline-Date.now())));await this.verify(page,profile.email,deadline);
        }else throw error;
      }
      log('debug','gmail_identity_verified',{profileUid:profile.uid});
      const quote=(x:string)=>`"${x.replace(/["\\\r\n]/g,' ')}"`;
      // Parent domains only: the sending host below the domain is not configuration.
      const senders=[...rule.senders,...rule.domains.map(x=>`@${x}`)].map(x=>`from:${quote(x)}`);
      const subject=rule.subject?` subject:${quote(rule.subject)}`:'';
      // The newest matching mail wins: the request window only bounds when the customer asked, not when the provider sent the code.
      // Spam is included because a code filed there is still a code; DKIM alignment is what makes a sender trustworthy.
      const query=`-in:trash -in:drafts after:${Math.floor(Date.now()/1000)-MESSAGE_LOOKBACK_SECONDS} before:${Math.floor(Date.now()/1000)+1} {${senders.join(' ')}}${subject}`;
      const search=async()=>{
        stage='search';log('debug','gmail_stage_started',{stage,remainingMs:Math.max(0,deadline-Date.now())});await page.goto(`https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`,{waitUntil:'domcontentloaded',timeout:Math.max(1,deadline-Date.now())});
        // shortcut: Gmail renders its empty state in the account language; td.TC is the locale-independent empty marker (absent while loading)
        await page.waitForFunction((subject)=>[...document.querySelectorAll('tr.zA')].filter(e=>(e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0)).length>0&&[...document.querySelectorAll('tr.zA')].filter(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0).every(e=>(e.querySelector('.bog')?.textContent||'').includes(subject))||[...document.querySelectorAll('td.TC')].some(e=>e.getBoundingClientRect().height>0),{polling:100},rule.subject);
      };
      await search();
      const refs=await page.evaluate(()=>[...document.querySelectorAll('tr.zA')].filter(e=>(e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0)).map(e=>e.getAttribute('data-legacy-thread-id')||e.querySelector('[data-legacy-thread-id]')?.getAttribute('data-legacy-thread-id')).filter((x):x is string=>Boolean(x)));
      log('info','gmail_search_completed',{profileUid:profile.uid,threadCount:refs.length,searchDomains:rule.domains.join(','),searchSenderCount:rule.senders.length,searchSubject:rule.subject?'SET':'ANY'});
      const messages:Message[]=[];
      // The model sees the newest mails only, one per thread, so stop early instead of reading every matching thread.
      let opened=0;
      for(const ref of refs){
        if(messages.length>=MAX_CANDIDATE_MESSAGES||opened>=MAX_THREADS)break;
        opened++;
        signal.throwIfAborted();if(Date.now()>=deadline-5000)throw new ServiceError(504,'TIMEOUT');
        if(!/^[a-f0-9]+$/i.test(ref))throw new ServiceError(502,'GMAIL_UI_CHANGED');
        // Gmail's in-page router answers "the conversation that you requested could not be loaded" when a row is
        // clicked after a fresh search load; navigating to the thread URL makes the body render every time.
        stage='message';log('debug','gmail_stage_started',{stage,threadIndex:refs.indexOf(ref)+1});
        await page.goto(`https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}/${ref}`,{waitUntil:'domcontentloaded',timeout:Math.max(1,deadline-Date.now())});
        await page.waitForSelector('.a3s',{visible:true});
        await page.evaluate(()=>{for(const e of document.querySelectorAll<HTMLElement>('.ajR'))if((e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0))e.click();});
        // The provider template exceeds Gmail's render limit; the code always sits above the clip, and a hidden tail can only lose a capture, never invent one.
        if(await page.$('.a3s a[href*="view=lg"]'))log('warn','gmail_message_clipped',{profileUid:profile.uid,threadIndex:refs.indexOf(ref)+1});
        const rows=await page.evaluate(()=>{
          const subject=document.querySelector('h2.hP')?.textContent?.trim()||'';
          return [...document.querySelectorAll('.adn')].filter(e=>e.querySelector('.a3s')).map(e=>({
            id:e.getAttribute('data-legacy-message-id')||e.querySelector('[data-legacy-message-id]')?.getAttribute('data-legacy-message-id'),
            sender:e.querySelector('.gD[email]')?.getAttribute('email')||'',subject,
            body:(()=>{const body=e.querySelector<HTMLElement>('.a3s')?.cloneNode(true) as HTMLElement|undefined;body?.querySelectorAll('.gmail_quote,blockquote').forEach(x=>x.remove());if(!body)return '';body.querySelectorAll('br').forEach(x=>x.replaceWith('\n'));body.querySelectorAll('td,th').forEach(x=>x.append(' '));body.querySelectorAll('div,p,tr').forEach(x=>x.append('\n'));return body.textContent||'';})(),
            // The rendered text keeps only anchor labels, so a magic-link rule needs the real destinations. Gmail wraps some in /url?q=.
            links:(()=>{const root=e.querySelector<HTMLElement>('.a3s');if(!root)return '';return [...root.querySelectorAll('a[href]')].map(a=>{const href=a.getAttribute('href')||'';try{const u=new URL(href,'https://mail.google.com');const target=u.hostname==='www.google.com'&&u.pathname==='/url'?u.searchParams.get('q')||'':href;return target.startsWith('https:')?target:'';}catch{return '';}}).filter(Boolean).join('\n').slice(0,16384);})()
          }));
        });
        if(!rows.length)throw new ServiceError(502,'GMAIL_UI_CHANGED');
        // The thread renders oldest first. Newest wins, so read the newest message that verifies and leave the older
        // copies alone: each one costs a Show original tab, and a thread piles up every mail a customer retriggers.
        for(const row of [...rows].reverse()){
          if(!row.id||!/^[a-f0-9]+$/i.test(row.id))throw new ServiceError(502,'MESSAGE_METADATA_UNVERIFIED');
          stage='original_menu';log('debug','gmail_stage_started',{stage});
          // shortcut: the menu is localized; button.Wsq5Cf and a label list cover current en/id UI, add locales when a profile uses one
          // Gmail sometimes swallows the click and opens no tab; a second try recovers it, and a message that still will not open is
          // skipped instead of failing a read that already verified another mail in the same thread.
          let original:Page|null=null;
          for(let menuAttempt=1;menuAttempt<=2&&!original;menuAttempt++){
            if(menuAttempt>1){await page.keyboard.press('Escape').catch(()=>{});await page.waitForFunction(()=>![...document.querySelectorAll('[role="menu"]')].some(e=>e.getBoundingClientRect().width>0),{polling:50,timeout:800}).catch(()=>{});}
            const popup=new Promise<Page|null>(resolve=>page.once('popup',resolve));
            let popupTimer:NodeJS.Timeout|undefined;
            try{
              await page.click(`[data-legacy-message-id="${row.id}"] button[aria-label="More message options"],[data-legacy-message-id="${row.id}"] button[aria-label="Opsi pesan lainnya"],[data-legacy-message-id="${row.id}"] button.Wsq5Cf`);
              await page.waitForFunction(()=>{
                const item=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(e=>(e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0)&&/^(?:show original|tampilkan versi asli|tampilkan aslinya)$/i.test(e.textContent?.trim()||''));
                if(!item)return false;item.click();return true;
              },{polling:100,timeout:Math.max(1,Math.min(5000,deadline-Date.now()))});
              original=await Promise.race([popup,new Promise<null>(resolve=>{popupTimer=setTimeout(()=>resolve(null),Math.min(10000,Math.max(1,deadline-Date.now())));})]);
            }catch(error){
              log('warn','gmail_menu_retry',{messageRef:row.id,retry:menuAttempt,...errorFields(error)});
              if(Date.now()>=deadline)throw error;
            }finally{clearTimeout(popupTimer);}
          }
          if(!original){
            if(!messages.length)throw new ServiceError(502,'GMAIL_UI_TIMEOUT');
            log('warn','gmail_original_skipped',{messageRef:row.id});continue;
          }
          const abortOriginal=()=>{void original.close().catch(()=>{});};signal.addEventListener('abort',abortOriginal,{once:true});
          try{
            stage='original_headers';log('debug','gmail_stage_started',{stage});
            await original.waitForFunction(()=>[...document.querySelectorAll('pre')].some(e=>/Delivered-To:/.test(e.textContent||'')&&/Message-ID:/i.test(e.textContent||'')&&/\n\s*\n/.test(e.textContent||'')),{polling:100,timeout:Math.max(1,deadline-Date.now())});
            const raw=await original.evaluate(()=>[...document.querySelectorAll('pre')].map(e=>e.textContent||'').find(text=>/Delivered-To:|Received:/.test(text))?.slice(0,65536)||'');
            const metadata=receiptMetadata(raw,profile.email,row.sender);
            log('debug','gmail_message_verified',{recipientMatched:!!metadata,receivedAt:metadata?.receivedAt});
            if(metadata&&!metadata.subject)throw new ServiceError(502,'MESSAGE_SUBJECT_UNVERIFIED');
            // Replies can have a different Subject from Gmail's conversation heading.
            if(metadata){messages.push({...metadata,sender:row.sender,subject:metadata.subject!,body:row.body,links:row.links,expiresAt:messageExpiry(row.body,metadata.receivedAt)});break;}
          }finally{signal.removeEventListener('abort',abortOriginal);await original.close().catch(()=>{});}
        }
      }
      log('info','gmail_read_completed',{profileUid:profile.uid,messageCount:messages.length,durationMs:Math.round(performance.now()-started)});
      return messages.sort((a,b)=>b.receivedAt-a.receivedAt);
    }catch(error){
      log('warn','gmail_read_failed',{profileUid:profile.uid,stage,remainingMs:Math.max(0,deadline-Date.now()),...errorFields(error)});
      if(Date.now()>=deadline)throw new ServiceError(504,'TIMEOUT');
      if(error instanceof ServiceError||signal.aborted)throw error;
      log('error','gmail_ui_failure',{stage,remainingMs:Math.max(0,deadline-Date.now()),...(await page.evaluate((email)=>({gmailHost:location.hostname==='mail.google.com',gmailTitle:document.title.includes('Gmail'),accountMatches:document.title.includes(email),compose:!!document.querySelector('[gh="cm"]'),ready:document.readyState}),profile.email).catch(()=>({pageUnavailable:true})))});
      throw new ServiceError(502,((error as Error).name==='TimeoutError'?'GMAIL_UI_TIMEOUT_':'GMAIL_UI_CHANGED_')+stage.toUpperCase());
    }finally{signal.removeEventListener('abort',abort);await page.close().catch(()=>{});}
  }
  async close(profile:Profile){
    const browser=this.sessions.get(profile.uid);if(!browser){if(this.tainted.has(profile.uid))throw new ServiceError(503,'PROFILE_CLEANUP_FAILED');return;}
    const started=performance.now();log('info','browser_close_started',{profileUid:profile.uid});
    const child=browser.process();let timer:NodeJS.Timeout|undefined;
    try {
      if(child?.pid&&process.platform==='win32')await this.processTree(child.pid,false);
      try{await Promise.race([browser.close(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new ServiceError(503,'PROFILE_CLEANUP_FAILED')),5000);})]);}
      catch(error){
        // Chrome already exited (user closed it or it crashed), so the pipe is gone; nothing left to clean up.
        if(!child||(child.exitCode===null&&child.signalCode===null))throw error;
        log('warn','browser_close_skipped',{profileUid:profile.uid,...errorFields(error)});
      }
      if(child&&child.exitCode===null&&child.signalCode===null)await new Promise<void>((resolve,reject)=>{const t=setTimeout(()=>reject(new ServiceError(503,'PROFILE_CLEANUP_FAILED')),2000);child.once('exit',()=>{clearTimeout(t);resolve();});});
      if(child?.pid&&process.platform==='win32')await this.processTree(child.pid,true);
      this.sessions.delete(profile.uid);
      this.leases.release(profile.directory);log('info','browser_close_completed',{profileUid:profile.uid,durationMs:Math.round(performance.now()-started)});
    }catch(error){log('error','browser_close_failed',{profileUid:profile.uid,...errorFields(error)});throw error;}finally{clearTimeout(timer);}
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
    log('info','browser_recovery_started',{profileUid:profile.uid});
    if(process.platform!=='win32')throw new ServiceError(503,'RECOVERY_REQUIRES_WINDOWS');
    const lease=this.leases.recoverable(profile.directory);
    const encoded=Buffer.from(JSON.stringify({directory:profile.directory})).toString('base64');
    // The directory belongs to this profile, so whatever Chrome holds it is a leftover; the previous ownership marker is not trustworthy after a crash.
    const script=`$ErrorActionPreference='Stop'; $v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json; $items=Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"|Where-Object {$_.CommandLine -and $_.CommandLine.Contains($v.directory) -and $_.CommandLine -notmatch '--type='};foreach($item in $items){$p=Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue;if($p){[void]$p.CloseMainWindow();if(!$p.WaitForExit(5000)){Stop-Process -Id $item.ProcessId -Force;if(!$p.WaitForExit(3000)){throw 'PROFILE_CLEANUP_FAILED'}}}}`;
    await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeout:10000,windowsHide:true,maxBuffer:1024});
    if(lease)this.leases.recovered(profile.directory);
    log('info','browser_recovery_completed',{profileUid:profile.uid,leaseRecovered:lease});
  }
}

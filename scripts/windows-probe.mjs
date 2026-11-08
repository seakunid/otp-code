import puppeteer from 'puppeteer-core';
import {writeFileSync} from 'node:fs';
const result={};let browser;
try{
 browser=await puppeteer.launch({executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',userDataDir:'C:\\Users\\nebula\\otp-browser-profiles\\nebula.together',headless:false,pipe:true,timeout:20000});
 const page=await browser.newPage();await page.goto('https://mail.google.com/mail/u/0/#inbox',{waitUntil:'domcontentloaded'});await page.waitForSelector('tr.zA',{timeout:30000});
 result.accountMatches=(await page.title()).toLowerCase().includes('nebula.together@gmail.com');
 result.rows=await page.evaluate(()=>[...document.querySelectorAll('tr.zA')].filter(e=>e.getClientRects().length).slice(0,2).map(e=>({attributes:[...e.attributes].filter(a=>a.name.includes('id')).map(a=>[a.name,a.value]),childIds:[...e.querySelectorAll('[data-legacy-thread-id],[data-thread-id]')].map(x=>[x.getAttribute('data-legacy-thread-id'),x.getAttribute('data-thread-id')])})));
 const row=await page.$('tr.zA');await row.click();await page.waitForSelector('.a3s',{visible:true});
 result.message=await page.evaluate(()=>({blocks:document.querySelectorAll('.adn').length,ids:[...document.querySelectorAll('[data-message-id],[data-legacy-message-id]')].map(e=>({tag:e.tagName,id:e.getAttribute('data-message-id'),legacy:e.getAttribute('data-legacy-message-id')})),menus:[...document.querySelectorAll('[aria-label]')].filter(e=>/more/i.test(e.getAttribute('aria-label')||'')).map(e=>({tag:e.tagName,label:e.getAttribute('aria-label')}))}));
}catch(e){result.error=e.name;result.messageCode=String(e.message).replace(/https?:\/\/\S+/g,'[url]').slice(0,200);}
finally{if(browser)await browser.close();writeFileSync('runtime/probe-result.json',JSON.stringify(result));}

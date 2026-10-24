import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {detectCDPAuthentication,inspectCDPTabs} from '../src/studio/authBridge/auth-discovery.mjs';

// Uses a localhost mock login site: no production cookies, secrets or external network calls.
test('real Chromium CDP auto-detection discriminates logged-in tab from cookie-free context', {timeout:90000}, async (t)=>{
 const site=http.createServer((req,res)=>{
   const ok=(req.headers.cookie||'').includes('session=valid');
   res.setHeader('Content-Type','text/html;charset=utf-8');
   if(req.url.startsWith('/protected') && !ok){res.writeHead(302,{location:'/login'});res.end();return;}
   if(req.url.startsWith('/public')){res.end('<html><body><h1>Welcome public</h1></body></html>');return;}
   if(req.url.startsWith('/login')){res.end('<html><body><h1>Login form</h1><a href="/signin">Login</a></body></html>');return;}
   res.end('<html><head><title>Dashboard</title></head><body><h1>Private dashboard</h1><a id="logout" href="/logout">登出</a><button data-testid="account-menu">帳戶</button></body></html>');
 });
 await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));
 const sitePort=site.address().port;
 const userData=await mkdtemp(path.join(os.tmpdir(),'ast-cdp-test-'));
 const debugPort=sitePort+1;
 const child=spawn('/usr/bin/chromium',['--headless=new','--no-sandbox','--disable-dev-shm-usage','--no-first-run',`--user-data-dir=${userData}`,`--remote-debugging-port=${debugPort}`,'about:blank'],{stdio:'ignore'});
 const endpoint=`http://127.0.0.1:${debugPort}`;
 const sleep=n=>new Promise(r=>setTimeout(r,n));
 try {
   let ready=false;
   for(let i=0;i<60;i++){
     try {const response=await fetch(`${endpoint}/json/version`);if(response.ok){ready=true;break;}}catch{}
     await sleep(200);
   }
   if(!ready){t.diagnostic('Chromium remote debugger unavailable on this runner'); t.skip('Cannot launch CDP endpoint');return;}
   const browser=await chromium.connectOverCDP(endpoint);
   const ctx=browser.contexts()[0];
   await ctx.addCookies([{name:'session',value:'valid',domain:'127.0.0.1',path:'/'}]);
   const page=await ctx.newPage();
   try {await page.goto(`http://127.0.0.1:${sitePort}/protected?state=private-code#xyz`);}
   catch(error) {if(String(error).includes('ERR_BLOCKED_BY_ADMINISTRATOR')){t.skip('此執行環境限制瀏覽器連接本機網站；請於 Windows CDP 執行實地測試');return;}throw error;}
   const scanned=await inspectCDPTabs({chromium,endpoint,allowedDomains:['127.0.0.1']});
   assert.ok(scanned.tabs.some(p=>p.url===`http://127.0.0.1:${sitePort}/protected`));
   const desiredIndex=scanned.tabs.find(p=>p.url===`http://127.0.0.1:${sitePort}/protected`).index;
   const result=await detectCDPAuthentication({chromium,endpoint,allowedDomains:['127.0.0.1'],tabIndex:desiredIndex});
   assert.equal(result.verified,true);
   assert.equal(result.verifyUrl,`http://127.0.0.1:${sitePort}/protected`);
   assert.equal(result.selector,'a[href*="logout" i]');
   await browser.close();
 } finally {child.kill('SIGTERM');await new Promise(r=>setTimeout(r,100));site.close();await rm(userData,{recursive:true,force:true}).catch(()=>{});}
});

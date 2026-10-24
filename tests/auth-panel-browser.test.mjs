import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {pickVisibleElement} from '../src/studio/authBridge/auth-discovery.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('offline panel populates URL and selector through tab selection and automatic discovery',{timeout:20000},async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
 const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 try {
   const page=await browser.newPage();
   await page.goto('about:blank');
   await page.setContent('<main><div class="workstation-page"><div class="workstation-profile"></div></div></main>');
   await page.evaluate(()=>{
     let project={id:'test-project',name:'Test',browser:{connectionMode:'managed',cdpEndpoint:'http://127.0.0.1:9222',authStateEnabled:false},allowedDomains:['cms.data.gov.tw']};
     window.studioBridge={snapshot:()=>({state:{project}}),adoptProject:next=>{project=next}};
     window.fetch=async (url,options={})=>{
       let payload={};
       if(url.endsWith('/auth/tabs')) payload={tabs:[{index:0,url:'https://cms.data.gov.tw/dataset/provider/quality-check-list',title:'資料集管理',focused:true}],recommendedIndex:0};
       else if(url.endsWith('/auth/detect')) payload={detected:{verifyUrl:'https://cms.data.gov.tw/dataset/provider/quality-check-list',selector:'a[href*="logout" i]',verified:true,tabTitle:'資料集管理'}};
       else if(url.endsWith('/auth/status')) payload={auth:{saved:false,unlocked:false}};
       else if(options.method==='PUT') payload={project:JSON.parse(options.body)};
       else if(url.endsWith('/auth/capture')) payload={auth:{saved:true,unlocked:true,expiresAt:Date.now()+90000}};
       return {ok:true,status:200,text:async()=>JSON.stringify(payload)};
     };
   });
   await page.addScriptTag({path:path.join(root,'public','auth-state-panel.js')});
   assert.equal(await page.evaluate(()=>document.querySelector('[data-k="advanced"]').open),false);
   await page.evaluate(()=>document.querySelector('button[data-action="tabs"]').click());
   await pause(150);
   assert.equal(await page.evaluate(()=>document.querySelector('select[data-k="tab"]').value),'0');
   await page.evaluate(()=>document.querySelector('button[data-action="auto"]').click());
   await pause(150);
   const result=await page.evaluate(()=>({url:document.querySelector('[data-k="verifyUrl"]').value,selector:document.querySelector('[data-k="selector"]').value,message:document.querySelector('[data-k="discovery"]').textContent}));
   assert.equal(result.url,'https://cms.data.gov.tw/dataset/provider/quality-check-list');
   assert.equal(result.selector,'a[href*="logout" i]');
   assert.match(result.message,/已完成登入辨識/);
   await page.screenshot({path:'/mnt/data/ast_223/auth-panel-223.png'});
 } finally {await browser.close();}
});

test('Chrome element picker captures a click without activating the underlying button',{timeout:15000},async()=>{
  const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
  try {
    const page=await browser.newPage();
    await page.goto('about:blank');
    await page.setContent('<button id="account-button" aria-label="我的帳戶" onclick="window.__clicked=true">帳戶選單</button>');
    const selection=pickVisibleElement(page,7000);
    await page.waitForTimeout(250);
    await page.evaluate(()=>document.getElementById('account-button').click());
    const result=await selection;
    assert.equal(result,'#account-button');
    assert.equal(await page.evaluate(()=>window.__clicked),undefined);
    assert.equal(await page.evaluate(()=>document.querySelector('div[style*="2147483647"]')),null);
  } finally {await browser.close();}
});

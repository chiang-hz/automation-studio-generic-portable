import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateUrl,permittedSite,loginEvidenceSelectors,detectCDPAuthentication,inspectCDPTabs} from '../src/studio/authBridge/auth-discovery.mjs';

test('URL discovery strips query tokens and fragments',()=>{
  assert.equal(candidateUrl('https://cms.data.gov.tw/dataset/provider/quality-check-list?token=secret#one'),'https://cms.data.gov.tw/dataset/provider/quality-check-list');
  assert.equal(candidateUrl('https://cms.data.gov.tw/login?code=secret'),null);
  assert.equal(candidateUrl('https://user:secret@cms.data.gov.tw/secure'),null);
  assert.equal(candidateUrl('http://evil.example.com/secure'),null);
});
test('only exact allowlisted host can be scanned',()=>{
  assert.ok(permittedSite('https://cms.data.gov.tw/secure',['cms.data.gov.tw']));
  assert.equal(permittedSite('https://fake-cms.data.gov.tw/secure',['cms.data.gov.tw']),null);
  assert.equal(permittedSite('https://cms.data.gov.tw.evil.net/secure',['cms.data.gov.tw']),null);
});
test('only login-specific evidence candidates are preferred',()=>{
  const candidates=loginEvidenceSelectors();
  assert.ok(candidates.some(x=>x.includes('logout')));
  assert.ok(!candidates.some(x=>x==='body' || x==='nav' || x==='a'));
});
test('discovery rejects disallowed site without navigating or saving state',async()=>{
  let closed=false;
  const chromium={connectOverCDP:async()=>({contexts:()=>[{pages:()=>[{url:()=> 'https://evil.com/',evaluate:async()=>true,title:async()=> 'Wrong'}]}],close:async()=>{closed=true;}})};
  const tabs=await inspectCDPTabs({chromium,endpoint:'http://127.0.0.1:9222',allowedDomains:['cms.data.gov.tw']});
  assert.equal(tabs.tabs.length,0);assert.equal(closed,true);
  await assert.rejects(detectCDPAuthentication({chromium,endpoint:'http://127.0.0.1:9222',allowedDomains:['cms.data.gov.tw']}),/找不到可用網頁/);
});

test('logged-out negative control rejects publicly visible marker',async()=>{
  const {proveLoginOnly}=await import('../src/studio/authBridge/auth-discovery.mjs');
  let closeCount=0;
  const fakePage={goto:async()=>{},url:()=> 'https://cms.data.gov.tw/private',waitForTimeout:async()=>{},locator:()=>({first:()=>({isVisible:async()=>true})})};
  const fakeBrowser={newContext:async()=>({newPage:async()=>fakePage,close:async()=>{closeCount++}})};
  assert.equal(await proveLoginOnly(fakeBrowser,'https://cms.data.gov.tw/private','#public'),false);
  assert.equal(closeCount,1);
});
test('logged-out negative control accepts marker absent without credentials',async()=>{
  const {proveLoginOnly}=await import('../src/studio/authBridge/auth-discovery.mjs');
  const fakePage={goto:async()=>{},url:()=> 'https://cms.data.gov.tw/private',waitForTimeout:async()=>{},locator:()=>({first:()=>({isVisible:async()=>false})})};
  const fakeBrowser={newContext:async()=>({newPage:async()=>fakePage,close:async()=>{}})};
  assert.equal(await proveLoginOnly(fakeBrowser,'https://cms.data.gov.tw/private','#account'),true);
});
test('negative-control error blocks unverified login proof',async()=>{
  const {proveLoginOnly}=await import('../src/studio/authBridge/auth-discovery.mjs');
  await assert.rejects(proveLoginOnly({newContext:async()=>{throw Error('not supported')}},'https://cms.data.gov.tw/private','#account'),/對照檢查/);
});

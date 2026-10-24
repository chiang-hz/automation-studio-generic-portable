import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const content = fs.readFileSync(new URL('../public/auth-state-panel.js', import.meta.url), 'utf8');
const formatter = content.slice(content.indexOf('  function responseError('), content.indexOf('  async function jsonRequest('));
const validator = content.slice(content.indexOf('  function validateSettings('), content.indexOf('  function fill(project)'));
function contextFor({verifyUrl='https://cms.data.gov.tw/dataset/provider/quality-check-list',selector='a[href*="logout"]',cdpEndpoint='http://127.0.0.1:9222'}={}){
  const fields = {verifyUrl:{value:verifyUrl},selector:{value:selector},cdpEndpoint:{value:cdpEndpoint}};
  const context = vm.createContext({URL,Error,field:key=>fields[key]});
  vm.runInContext(`${formatter}\n${validator}`,context);
  return context;
}
const invoke=(ctx,domains=['cms.data.gov.tw'],action='capture')=>vm.runInContext(`validateSettings({allowedDomains:${JSON.stringify(domains)}},${JSON.stringify(action)})`,ctx);
test('nested API errors reveal server message instead of object Object',()=>{
  const c=contextFor(),error=vm.runInContext('responseError({error:{code:"AUTH_INVALID",message:"無法確認登入有效"}},500)',c);
  assert.match(error.message,/無法確認登入有效.*AUTH_INVALID/);assert.doesNotMatch(error.message,/object Object/i);
});
test('missing automatic discovery URL prompts an approachable workflow',()=>{
  assert.throws(()=>invoke(contextFor({verifyUrl:''})),/讀取網頁|自動辨識/);
});
test('missing selector prompts automatic detection or click',()=>{
  assert.throws(()=>invoke(contextFor({selector:''})),/自動辨識|點選/);
});
test('unapproved domain is rejected',()=>{
  assert.throws(()=>invoke(contextFor(),[]),/允許網域/);
});
test('non-local CDP endpoint is rejected',()=>{
  assert.throws(()=>invoke(contextFor({cdpEndpoint:'http://evil.example.org:9222'})),/本機 Chrome/);
});
test('valid automatically discovered values pass capture preflight',()=>{
  assert.doesNotThrow(()=>invoke(contextFor()));
});
test('default UI hides technical URL and CSS under advanced details',()=>{
  assert.match(content,/<details data-k="advanced">/);
  assert.match(content,/讀取 Chrome 已開啟的網頁/);
  assert.match(content,/自動辨識（建議）/);
  assert.match(content,/在 Chrome 點選登入後專屬項目/);
});

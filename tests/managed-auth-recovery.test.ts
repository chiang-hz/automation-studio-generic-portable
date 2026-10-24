import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureManagedAuthentication} from '../src/studio/managedAuthRecovery.ts';

test('valid imported Storage State continues without human action', async () => {
  let manual=0, checked=0;
  const status=await ensureManagedAuthentication({headless:false,verify:async()=>{checked++},pauseForHuman:async()=>{manual++}});
  assert.equal(status,'valid'); assert.equal(manual,0);assert.equal(checked,1);
});
test('challenge or missing login in headed browser pauses for human, then verifies again',async()=>{
  let checks=0,manual=0;
  const status=await ensureManagedAuthentication({headless:false,verify:async()=>{checks++;if(checks===1)throw Error('challenge')},pauseForHuman:async()=>{manual++}});
  assert.equal(status,'recovered-manually');assert.equal(checks,2);assert.equal(manual,1);
});
test('headless browser fails closed; no silent challenge bypass',async()=>{
  let manual=0;
  await assert.rejects(ensureManagedAuthentication({headless:true,verify:async()=>{throw Error('challenge')},pauseForHuman:async()=>{manual++}}), (err:any)=>err.code==='AUTH_INVALID' && /無頭模式/.test(err.message));
  assert.equal(manual,0);
});
test('human continuation does not automatically imply logged in',async()=>{
  await assert.rejects(ensureManagedAuthentication({headless:false,verify:async()=>{throw Error('still challenge')},pauseForHuman:async()=>{}}), (err:any)=>err.code==='AUTH_INVALID' && /仍未通過/.test(err.message));
});
test('manual timeout or cancellation cannot continue without verification',async()=>{
  await assert.rejects(ensureManagedAuthentication({headless:false,verify:async()=>{throw Error('challenge')},pauseForHuman:async()=>{throw Error('cancelled')}}), (err:any)=>err.code==='AUTH_INVALID' && /未完成/.test(err.message));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {AuthSessionManager, authProfileId, assertAuthConfiguration} from '../src/studio/authSessions.ts';
import {saveEncryptedSession} from '../src/studio/authBridge/session-vault.mjs';
import {WorkflowRunner} from '../src/studio/executor.ts';
import {createDefaultProject} from '../src/studio/store.ts';

const passphrase = 'Safe local test passphrase 2026';
function project(name: string) {
  const p = createDefaultProject({id:name, name, targetUrl:'https://cms.data.gov.tw', allowedDomains:['cms.data.gov.tw']});
  p.browser.connectionMode='managed';
  p.browser.authStateEnabled=true;
  p.browser.authVerifyUrl='https://cms.data.gov.tw/secure';
  p.browser.authSuccessSelector='#logged-in';
  p.settings.defaultConcurrency=3;
  return p;
}
test('isolates vault sessions across projects, requires explicit unlock, and never leaks plain cookies', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'ast-auth-'));
  const original = process.env.LOCALAPPDATA;
  try {
    process.env.LOCALAPPDATA=directory;
    const a=project('alpha-work');
    const b=project('beta-work');
    const m=new AuthSessionManager();
    assert.notEqual(authProfileId(a.id),authProfileId(b.id));
    assert.throws(()=>m.getForRun(a),/解鎖/);
    const root=path.join(directory,'AutomationStudio','private-auth-vault');
    await saveEncryptedSession({profileId:authProfileId(a.id),allowedOrigins:['https://cms.data.gov.tw'],
      state:{cookies:[{name:'session',value:'SECRET_VALUE_NOT_PUBLIC',domain:'.data.gov.tw',path:'/'}],origins:[]},
      passphrase,vaultRoot:root});
    const file=await fs.readFile(path.join(root,authProfileId(a.id)+'.authvault'),'utf8');
    assert.equal(file.includes('SECRET_VALUE_NOT_PUBLIC'),false);
    await m.unlock(a,passphrase);
    assert.equal(m.getForRun(a).storageState.cookies.length,1);
    assert.throws(()=>m.getForRun(b),/解鎖/);
    const runner=new WorkflowRunner({} as any);
    await assert.rejects(runner.startBatch(a,[{},{}]),/解鎖/);
    assert.equal((await m.status(a)).unlocked,true);
    await m.revoke(a);
    assert.equal((await m.status(a)).saved,false);
    assert.throws(()=>m.getForRun(a),/解鎖/);
  } finally {
    if (original===undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA=original;
    await fs.rm(directory,{recursive:true,force:true});
  }
});

test('login URL must be HTTPS and in exact project allowlist',()=>{
  const p=project('test');
  assert.equal(assertAuthConfiguration(p).origin,'https://cms.data.gov.tw');
  p.browser.authVerifyUrl='https://evil.example.com/login';
  assert.throws(()=>assertAuthConfiguration(p),/允許網域/);
  p.browser.authVerifyUrl='http://cms.data.gov.tw/login';
  assert.throws(()=>assertAuthConfiguration(p),/HTTPS/);
});

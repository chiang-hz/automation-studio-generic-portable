import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright';
import {ensureManagedAuthentication} from '../src/studio/managedAuthRecovery.ts';
import {assertAuthenticated} from '../src/studio/authBridge/cdp-capture.mjs';

test('managed context requires real login, then same worker context retains it across subsequent rows', {skip: !existsSync('/usr/bin/chromium') || process.env.AST_RUN_BROWSER_AUTH_E2E !== '1'}, async () => {
  const server=http.createServer((request,response)=> {
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    if (request.headers.cookie?.includes('session=authorized')) response.end('<html><body><h1 id="logged-in">Authenticated mock</h1></body></html>');
    else response.end('<html><body><h1>Please sign in / human verification</h1></body></html>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    const port=server.address().port;const url=`http://127.0.0.1:${port}/private`;
    browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
    const context=await browser.newContext({storageState:{cookies:[],origins:[]}});
    const page=await context.newPage();
    const verify=()=>assertAuthenticated(page,{verifyUrl:url,authenticatedSelector:'#logged-in',timeoutMs:450});
    let manual=0;
    const status=await ensureManagedAuthentication({headless:false, verify, pauseForHuman:async()=>{
      manual++;
      // Simulate the result of a legitimate user login; helper never solves a challenge.
      await context.addCookies([{name:'session',value:'authorized',url}]);

    }});
    assert.equal(status,'recovered-manually');assert.equal(manual,1);
    assert.equal(await ensureManagedAuthentication({headless:false,verify,pauseForHuman:async()=>{throw Error('should not pause')}}),'valid');
    const fresh=await browser.newContext({storageState:{cookies:[],origins:[]}});
    const freshPage=await fresh.newPage();
    await assert.rejects(ensureManagedAuthentication({headless:true,verify:()=>assertAuthenticated(freshPage,{verifyUrl:url,authenticatedSelector:'#logged-in',timeoutMs:450}),pauseForHuman:async()=>{}}), /無頭模式/);
    await fresh.close();await context.close();
  } finally { await browser?.close().catch(()=>{}); await new Promise(resolve=>server.close(resolve)); }
});

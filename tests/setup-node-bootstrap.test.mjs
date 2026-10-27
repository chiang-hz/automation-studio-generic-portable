import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bat = readFileSync(resolve(root, 'setup-runtime.bat'), 'utf8');
const between = (start, end) => bat.slice(bat.indexOf(start), bat.indexOf(end));

test('curl exit 35 enters restricted revocation recovery before issuer chain fallback', () => {
  const bootstrap = between('curl.exe --fail --location', ':node_downloaded');
  assert.match(bootstrap, /if "%NODE_CURL_ERROR%"=="35" goto node_revocation_retry/);
  assert.match(bootstrap, /if "%NODE_CURL_ERROR%"=="60" goto node_issuer_retry/);
  assert.match(bootstrap, /:node_revocation_retry[\s\S]*?--ssl-revoke-best-effort[\s\S]*?--ssl-no-revoke/);
  assert.match(bootstrap, /:node_issuer_retry[\s\S]*?--insecure/);
});

test('retry is per curl invocation; pinned digest is required before moving node.exe', () => {
  const bootstrap = between('curl.exe --fail --location', ':node_ready');
  assert.match(bootstrap, /certutil\.exe -hashfile "%NODE_TEMP%" SHA256/);
  assert.match(bootstrap, /if errorlevel 1 \([\s\S]*?goto failed/);
  assert.ok(bootstrap.indexOf('certutil.exe -hashfile') < bootstrap.indexOf('move /y'));
  assert.ok(!bat.includes('set "NODE_TLS_REJECT_UNAUTHORIZED=0"'));
});

test('curl failures outside the certificate paths report exit code and stop', () => {
  assert.match(bat, /goto node_curl_failed\s+\r?\n\s*:node_revocation_retry/);
  assert.match(bat, /:node_curl_failed[\s\S]*?curl exit code %NODE_CURL_ERROR%/);
});

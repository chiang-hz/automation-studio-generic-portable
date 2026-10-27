import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  isIssuerCertificateError, sameVolumeStagingRoot, getWithCertificateFallback,
  moveAcrossVolumes, installPackage, installChromiumIfMissing,
} from '../scripts/setup-portable-runtime.mjs';
import { findInstalledChrome, chromeCandidates } from '../scripts/chrome-discovery.mjs';

function certError() {
  const error = new Error('unable to get local issuer certificate');
  error.code = 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY';
  return error;
}

async function fixtureRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-setup-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function packageFixture(t, version = '4.1.13') {
  const dir = await fixtureRoot(t);
  await fs.mkdir(path.join(dir, 'package'));
  await fs.writeFile(path.join(dir, 'package', 'package.json'), JSON.stringify({ name: '@types/debug', version }));
  const archive = path.join(dir, 'archive.tgz');
  const result = spawnSync('tar', ['-czf', archive, '-C', dir, 'package']);
  assert.equal(result.status, 0);
  const bytes = await fs.readFile(archive);
  return { bytes, item: {
    path: 'node_modules/@types/debug', version,
    url: 'https://registry.npmjs.org/@types/debug/-/debug-4.1.13.tgz',
    integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
  } };
}

test('recognizes issuer TLS errors but not network/unrelated errors', () => {
  assert.equal(isIssuerCertificateError(certError()), true);
  assert.equal(isIssuerCertificateError(new Error('self-signed certificate in certificate chain')), true);
  assert.equal(isIssuerCertificateError(Object.assign(new Error('ECONNRESET'), {code:'ECONNRESET'})), false);
});

test('TLS fallback affects exactly the failing request, then returns to verified requests', async () => {
  const attempts = [];
  const fetcher = async (_url, insecure) => {
    attempts.push(insecure);
    if (!insecure && attempts.length === 1) throw certError();
    return Buffer.from('verified-sha512-later');
  };
  const warnings = [];
  await getWithCertificateFallback('https://registry.npmjs.org/test', fetcher, msg => warnings.push(msg));
  await getWithCertificateFallback('https://registry.npmjs.org/test', fetcher, msg => warnings.push(msg));
  assert.deepEqual(attempts, [false, true, false]);
  assert.equal(warnings.length, 1);
});

test('TLS fallback does not apply to HTTP errors or transient transport failures', async () => {
  const attempts = [];
  await assert.rejects(getWithCertificateFallback('https://registry.npmjs.org/test', async (_url, insecure) => {
    attempts.push(insecure);
    throw new Error('Download failed: HTTP 403');
  }), /HTTP 403/);
  assert.deepEqual(attempts, [false]);
});

test('package install writes staging on project volume, preserves SHA512, and reuses installed package', async t => {
  const root = await fixtureRoot(t);
  const { item, bytes } = await packageFixture(t);
  let downloads = 0;
  await installPackage(item, {projectRoot:root, fetch:async () => {downloads++; return bytes;}});
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'node_modules/@types/debug/package.json'))).version, item.version);
  assert.equal(sameVolumeStagingRoot(root), path.join(root, '.local/setup-temp'));
  const remaining = await fs.readdir(sameVolumeStagingRoot(root));
  assert.deepEqual(remaining, []);
  await installPackage(item, {projectRoot:root, fetch:async () => {downloads++; return bytes;}});
  assert.equal(downloads, 1);
});

test('SHA512 mismatch rejects package without modifying existing install', async t => {
  const root = await fixtureRoot(t);
  const { item, bytes } = await packageFixture(t);
  const dest = path.join(root, item.path);
  await fs.mkdir(dest, { recursive: true });
  await fs.writeFile(path.join(dest, 'package.json'), JSON.stringify({version:'old'}));
  await assert.rejects(installPackage(item, {projectRoot:root, fetch: async () => Buffer.concat([bytes, Buffer.from('tamper')])}), /SHA-512/);
  assert.equal(JSON.parse(await fs.readFile(path.join(dest, 'package.json'))).version, 'old');
});

test('EXDEV directory rename falls back to copy then removes source', async t => {
  const root = await fixtureRoot(t);
  const source = path.join(root, 'original');
  const dest = path.join(root, 'installed');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'file.txt'), 'okay');
  let triedRename = false;
  await moveAcrossVolumes(source, dest, { rename:async () => {triedRename = true; throw Object.assign(new Error('cross-device'), {code:'EXDEV'});} });
  assert.equal(triedRename, true);
  assert.equal(await fs.readFile(path.join(dest, 'file.txt'), 'utf8'), 'okay');
  await assert.rejects(fs.stat(source), {code:'ENOENT'});
});

test('Chromium installer retries certificate-only error in child process and restores TLS for next call', async t => {
  const root = await fixtureRoot(t);
  const browserRoot = path.join(root, 'runtime', 'browsers');
  const infoFile = path.join(root, 'node_modules', 'playwright-core', 'browsers.json');
  await fs.mkdir(path.dirname(infoFile), {recursive:true});
  await fs.writeFile(infoFile, JSON.stringify({browsers:[{name:'chromium',revision:'123'},{name:'chromium-headless-shell',revision:'456'}]}));
  const envCalls = [];
  await installChromiumIfMissing(root, (_node, _args, opts) => {
    envCalls.push(opts.env);
    if (envCalls.length === 1) return {status:1, stdout:'',stderr:'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'};
    // Spawn mocks are synchronous: create the expected files before returning.
    fsSync.mkdirSync(path.join(browserRoot,'chromium-123','chrome-win64'),{recursive:true});
    fsSync.writeFileSync(path.join(browserRoot,'chromium-123','chrome-win64','chrome.exe'),'test');
    fsSync.mkdirSync(path.join(browserRoot,'chromium_headless_shell-456','chrome-win'),{recursive:true});
    fsSync.writeFileSync(path.join(browserRoot,'chromium_headless_shell-456','chrome-win','headless_shell.exe'),'test');
    return {status:0,stdout:'installed',stderr:''};
  }, {detectChrome: async () => undefined});
  assert.equal(envCalls.length,2);
  assert.equal(envCalls[0].NODE_TLS_REJECT_UNAUTHORIZED,undefined);
  assert.equal(envCalls[1].NODE_TLS_REJECT_UNAUTHORIZED,'0');
  assert.equal(envCalls[0].TEMP, sameVolumeStagingRoot(root));
});

test('Chromium installer must not retry with insecure TLS when failure is unrelated', async t => {
  const root = await fixtureRoot(t);
  const file = path.join(root, 'node_modules', 'playwright-core', 'browsers.json');
  await fs.mkdir(path.dirname(file), {recursive:true});
  await fs.writeFile(file, JSON.stringify({browsers:[{name:'chromium',revision:'1'},{name:'chromium-headless-shell',revision:'2'}]}));
  const envCalls = [];
  await assert.rejects(installChromiumIfMissing(root, (_exe, _args, opts) => {
    envCalls.push(opts.env);
    return {status:1,stderr:'HTTP 403 Forbidden',stdout:''};
  }, {detectChrome: async () => undefined}), /did not complete/);
  assert.equal(envCalls.length, 1);
  assert.equal(envCalls[0].NODE_TLS_REJECT_UNAUTHORIZED, undefined);
});

test('transient Windows EPERM on rename retries and succeeds without recopying', async t => {
  const root = await fixtureRoot(t);
  const source = path.join(root, 'extracted');
  const dest = path.join(root, 'node_modules', 'concat-map');
  await fs.mkdir(source);
  await fs.mkdir(path.dirname(dest), {recursive:true});
  await fs.writeFile(path.join(source, 'package.json'), '{"version":"0.0.1"}');
  let calls = 0;
  await moveAcrossVolumes(source, dest, {
    rename: async (...args) => {
      calls++;
      if (calls <= 2) throw Object.assign(new Error('Windows Defender sharing violation'), {code:'EPERM'});
      return fs.rename(...args);
    },
    wait:async () => {},
    copy:async () => { throw new Error('should not copy when rename recovered'); },
  });
  assert.equal(calls, 3);
  assert.equal(JSON.parse(await fs.readFile(path.join(dest, 'package.json'))).version, '0.0.1');
});

test('persistent Windows EPERM falls back to copy, then retains clean install', async t => {
  const root = await fixtureRoot(t);
  const {item, bytes} = await packageFixture(t);
  item.path = 'node_modules/concat-map';
  let attempts = 0, copies = 0;
  await installPackage(item, {
    projectRoot:root,
    fetch:async () => bytes,
    moveOperations: {
      rename:async (src,dest) => {
        if (src.endsWith('extracted')) {
          attempts++;
          throw Object.assign(new Error('blocked'), {code:'EPERM'});
        }
        return fs.rename(src,dest);
      },
      copy:async (...args) => {copies++; return fs.cp(...args);},
      wait:async () => {},
    },
  });
  assert.equal(attempts, 4);
  assert.equal(copies, 1);
  const dest = path.join(root, item.path);
  assert.equal(JSON.parse(await fs.readFile(path.join(dest, 'package.json'))).version, item.version);
  assert.deepEqual(await fs.readdir(sameVolumeStagingRoot(root)), []);
});

test('permissions blocked for both rename and copy restore previous package', async t => {
  const root = await fixtureRoot(t);
  const {item, bytes} = await packageFixture(t);
  const dest = path.join(root, item.path);
  await fs.mkdir(dest, {recursive:true});
  await fs.writeFile(path.join(dest, 'package.json'), JSON.stringify({version:'old'}));
  await fs.writeFile(path.join(dest, 'keep.txt'), 'preserve');
  await assert.rejects(installPackage(item, {
    projectRoot:root,
    fetch:async () => bytes,
    moveOperations: {
      rename:async (src,to) => {
        if (src.endsWith('extracted')) throw Object.assign(new Error('blocked'), {code:'EPERM'});
        return fs.rename(src,to);
      },
      copy:async () => {throw Object.assign(new Error('Corporate policy denies write'), {code:'EACCES'});},
      wait:async () => {},
    }
  }), /Cannot install package/);
  assert.equal(JSON.parse(await fs.readFile(path.join(dest,'package.json'))).version, 'old');
  assert.equal(await fs.readFile(path.join(dest,'keep.txt'),'utf8'), 'preserve');
});

test('already occupied target never gets merged or overwritten during EPERM fallback', async t => {
  const root = await fixtureRoot(t);
  const source = path.join(root, 'extracted');
  const dest = path.join(root, 'locked');
  await fs.mkdir(source);
  await fs.mkdir(dest);
  await fs.writeFile(path.join(dest, 'keep.txt'),'unchanged');
  await assert.rejects(moveAcrossVolumes(source,dest, {
    rename:async()=> {throw Object.assign(new Error('denied'),{code:'EPERM'});},
    wait:async()=>{},
  }), /Destination already exists/);
  assert.equal(await fs.readFile(path.join(dest,'keep.txt'),'utf8'),'unchanged');
  assert.equal((await fs.stat(source)).isDirectory(), true);
});


test('Windows EPERM during copy is retried safely after clearing partial destination', async t => {
  const root = await fixtureRoot(t);
  const source = path.join(root, 'extracted');
  const dest = path.join(root, 'installed');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'package.json'), '{"version":"1.0.0"}');
  let copies = 0;
  await moveAcrossVolumes(source, dest, {
    rename: async () => {throw Object.assign(new Error('locked rename'), {code:'EPERM'});},
    copy: async (src,to,opts) => {
      copies++;
      if (copies === 1) {
        await fs.mkdir(to);
        await fs.writeFile(path.join(to,'incomplete.txt'), 'partial');
        throw Object.assign(new Error('short file lock'), {code:'EPERM'});
      }
      return fs.cp(src,to,opts);
    },
    wait: async () => {},
  });
  assert.equal(copies,2);
  assert.equal(JSON.parse(await fs.readFile(path.join(dest,'package.json'))).version,'1.0.0');
  await assert.rejects(fs.stat(path.join(dest,'incomplete.txt')), {code:'ENOENT'});
});


test('installed Chrome avoids the Playwright browser installer and all optional browser tools', async t => {
  const root = await fixtureRoot(t);
  const localAppData = path.join(root, 'profile');
  const chrome = path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe');
  await fs.mkdir(path.dirname(chrome), {recursive: true});
  await fs.writeFile(chrome, 'stub');
  assert.equal(await findInstalledChrome({LOCALAPPDATA: localAppData}), chrome);
  let installCalls = 0;
  const result = await installChromiumIfMissing(root, () => { installCalls++; throw new Error('must not install Chromium'); }, {
    detectChrome: () => findInstalledChrome({LOCALAPPDATA: localAppData}),
  });
  assert.equal(result.mode, 'system-chrome');
  assert.equal(installCalls, 0);
  await assert.rejects(fs.stat(path.join(root,'runtime','browsers')), {code:'ENOENT'});
});

test('manual bundled-browser opt-in still installs when Chrome exists', async t => {
  const root = await fixtureRoot(t);
  const browserRoot = path.join(root, 'runtime', 'browsers');
  const infoFile = path.join(root, 'node_modules', 'playwright-core', 'browsers.json');
  await fs.mkdir(path.dirname(infoFile), {recursive: true});
  await fs.writeFile(infoFile, JSON.stringify({browsers:[{name:'chromium',revision:'123'},{name:'chromium-headless-shell',revision:'456'}]}));
  let calls = 0;
  const result = await installChromiumIfMissing(root, (_node, args) => {
    calls++;
    assert.ok(args.includes('chromium'));
    fsSync.mkdirSync(path.join(browserRoot,'chromium-123','chrome-win64'),{recursive:true});
    fsSync.writeFileSync(path.join(browserRoot,'chromium-123','chrome-win64','chrome.exe'),'test');
    fsSync.mkdirSync(path.join(browserRoot,'chromium_headless_shell-456','chrome-win'),{recursive:true});
    fsSync.writeFileSync(path.join(browserRoot,'chromium_headless_shell-456','chrome-win','headless_shell.exe'),'test');
    return {status:0, stdout:'', stderr:''};
  }, {detectChrome:async () => 'C:/Program Files/Google/Chrome/Application/chrome.exe', forceBundledBrowser:true});
  assert.equal(result.mode, 'bundled');
  assert.equal(calls,1);
});

test('Chrome lookup respects a user-local browser and does not require Edge', async t => {
  const root = await fixtureRoot(t);
  const chrome = path.join(root,'Google','Chrome','Application','chrome.exe');
  await fs.mkdir(path.dirname(chrome), {recursive:true});
  await fs.writeFile(chrome,'chrome');
  const env = { LOCALAPPDATA: root, ProgramFiles: '', ProgramW6432:'', 'ProgramFiles(x86)': '' };
  assert.ok(chromeCandidates(env).includes(chrome));
  assert.equal(await findInstalledChrome(env), chrome);
});

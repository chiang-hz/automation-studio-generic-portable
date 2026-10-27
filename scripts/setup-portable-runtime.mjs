import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findInstalledChrome } from './chrome-discovery.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestFile = path.join(root, 'scripts', 'portable-runtime-packages.json');
const packageTempRoot = path.join(root, '.local', 'setup-temp');

const CERTIFICATE_ERROR_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_UNTRUSTED',
]);
const CERTIFICATE_ERROR_TEXT = /UNABLE_TO_GET_ISSUER_CERT_LOCALLY|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|CERT_UNTRUSTED|unable to get local issuer certificate|unable to verify the first certificate|self[- ]signed certificate in certificate chain/i;

export function isIssuerCertificateError(error) {
  return CERTIFICATE_ERROR_CODES.has(error?.code) || CERTIFICATE_ERROR_TEXT.test(String(error?.message || ''));
}

export function sameVolumeStagingRoot(projectRoot = root) {
  return path.join(projectRoot, '.local', 'setup-temp');
}

function downloadOnce(url, tlsRelaxed = false, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('Too many HTTPS redirects'));
  if (new URL(url).protocol !== 'https:') return Promise.reject(new Error('Runtime packages require HTTPS'));
  return new Promise((resolve, reject) => {
    const req = https.get(url, { rejectUnauthorized: !tlsRelaxed }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        if (!response.headers.location) {
          response.resume();
          return reject(new Error('HTTPS redirect is missing a Location header'));
        }
        const next = new URL(response.headers.location, url).href;
        response.resume();
        downloadOnce(next, tlsRelaxed, redirects + 1).then(resolve, reject);
      } else if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Runtime package download failed: HTTP ${response.statusCode}`));
      } else {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      }
    });
    req.setTimeout(60000, () => req.destroy(new Error('Runtime package download timed out')));
    req.on('error', reject);
  });
}

// This fallback is scoped to ONE certificate-failing HTTPS request. The next
// request always uses certificate validation; there is no global TLS switch.
export async function getWithCertificateFallback(url, fetcher = downloadOnce, warn = console.warn) {
  try {
    return await fetcher(url, false);
  } catch (error) {
    if (!isIssuerCertificateError(error)) throw error;
    warn(`[Setup] Certificate issuer is not trusted for ${new URL(url).host}. Retrying ONLY this transfer with TLS certificate checks disabled; package integrity remains mandatory.`);
    return await fetcher(url, true);
  }
}

const RETRYABLE_MOVE_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const MOVE_RETRY_DELAYS_MS = [100, 250, 500];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Move a verified package tree into place. Windows Defender, indexing and
 * another Node process can briefly lock a directory after tar extraction.
 * Try atomic rename first; if rename stays blocked, copy into a clean,
 * previously absent destination. Never merge into an unexpected destination.
 */
export async function moveAcrossVolumes(source, destination, operations = {}) {
  const rename = operations.rename || fs.rename;
  const copy = operations.copy || fs.cp;
  const remove = operations.remove || fs.rm;
  const wait = operations.wait || delay;
  const inspect = operations.stat || fs.lstat;
  const exists = async file => inspect(file).then(() => true, error => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  let lastError;
  for (let attempt = 0; attempt <= MOVE_RETRY_DELAYS_MS.length; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EXDEV' && !RETRYABLE_MOVE_ERRORS.has(error?.code)) throw error;
      // Replacing a pre-existing package without a backup is unsafe.
      if (await exists(destination)) {
        throw new Error(`[Setup] Destination already exists or is locked: ${destination}. Close Automation Studio and retry. (${error.code})`, { cause: error });
      }
      if (error?.code === 'EXDEV') break;
      if (attempt < MOVE_RETRY_DELAYS_MS.length) {
        const ms = MOVE_RETRY_DELAYS_MS[attempt];
        console.warn(`[Setup] Windows temporarily blocked package rename (${error.code}). Retrying in ${ms} ms (${attempt + 1}/${MOVE_RETRY_DELAYS_MS.length})...`);
        await wait(ms);
      }
    }
  }
  console.warn(`[Setup] Package directory rename failed (${lastError?.code}); trying safe copy fallback.`);
  // fs.cp can succeed where MoveFileEx is blocked by a short-lived Windows
  // handle. Do not overwrite an existing directory, and remove partial copies
  // if an access-control policy prevents copying altogether.
  if (await exists(destination)) throw new Error(`[Setup] Package destination is not empty: ${destination}`);
  let copied = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await copy(source, destination, { recursive: true, force: false, errorOnExist: true });
      copied = true;
      break;
    } catch (copyError) {
      // This destination did not exist before we started copying. Remove any
      // incomplete tree before a retry, never silently merge old content.
      try {
        await fs.rm(destination, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new Error(`[Setup] Cannot clean partially copied package at ${destination} (${cleanupError.code || cleanupError.message}). Close running programs and retry.`, { cause: cleanupError });
      }
      if (RETRYABLE_MOVE_ERRORS.has(copyError?.code) && attempt < 2) {
        await wait(250 * (attempt + 1));
        continue;
      }
      const reason = copyError?.message || String(copyError);
      throw new Error(`[Setup] Cannot install package at ${destination}: rename=${lastError?.code}, copy=${copyError?.code || reason}. Close running Automation Studio/Node processes, check write permission and Windows security/antivirus quarantine, then retry.`, { cause: copyError });
    }
  }
  if (!copied) throw new Error(`[Setup] Package copy did not complete: ${destination}`);
  // A successful copy must still be a true move: the staged source is removed
  // only after the destination is safely populated. The caller validates the
  // package version and restores the previous version if needed.
  try {
    await remove(source, { recursive: true, force: true });
  } catch (cleanupError) {
    // Source removal must succeed before treating the operation as a move:
    // otherwise a previously installed directory may remain at the target
    // while the caller assumes it was safely backed up.
    throw new Error(`[Setup] Package copied but original directory is still locked: ${source} (${cleanupError.code || cleanupError.message}). Close applications using this directory and retry.`, { cause: cleanupError });
  }
}

export async function installPackage(item, options = {}) {
  const projectRoot = options.projectRoot || root;
  const dest = path.resolve(projectRoot, ...item.path.split('/'));
  if (!dest.startsWith(`${projectRoot}${path.sep}`)) throw new Error(`Invalid package path: ${item.path}`);
  const existing = await fs.readFile(path.join(dest, 'package.json'), 'utf8').then(JSON.parse).catch(() => null);
  if (existing?.version === item.version) return;
  if (!item.url.startsWith('https://registry.npmjs.org/')) throw new Error(`Unexpected package registry URL: ${item.path}`);
  console.log(`Installing ${item.path} ${item.version}...`);
  const bytes = await (options.fetch || getWithCertificateFallback)(item.url);
  const [algorithm, expected] = item.integrity.split('-', 2);
  if (algorithm !== 'sha512' || createHash('sha512').update(bytes).digest('base64') !== expected)
    throw new Error(`Package SHA-512 integrity check failed: ${item.path}`);

  const tempRoot = sameVolumeStagingRoot(projectRoot);
  await fs.mkdir(tempRoot, { recursive: true });
  const staging = await fs.mkdtemp(path.join(tempRoot, 'automation-studio-package-'));
  const extracted = path.join(staging, 'extracted');
  const backup = path.join(staging, 'backup');
  let oldSaved = false;
  let hadPrevious = false;
  let installed = false;
  try {
    const archive = path.join(staging, 'package.tgz');
    await fs.mkdir(extracted);
    await fs.writeFile(archive, bytes);
    const result = (options.spawn || spawnSync)(process.platform === 'win32' ? 'tar.exe' : 'tar',
      ['-xzf', archive, '-C', extracted, '--strip-components=1'], { stdio: 'inherit' });
    if (result.error || result.status !== 0)
      throw new Error(`Could not unpack ${item.path}: ${result.error?.message || 'tar exited with error'}`);
    const unpacked = JSON.parse(await fs.readFile(path.join(extracted, 'package.json'), 'utf8'));
    if (unpacked.version !== item.version) throw new Error(`Package version mismatch: ${item.path}`);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    hadPrevious = await fs.stat(dest).then(() => true).catch(() => false);
    if (hadPrevious) {
      await moveAcrossVolumes(dest, backup, options.moveOperations);
      oldSaved = true;
    }
    await moveAcrossVolumes(extracted, dest, options.moveOperations);
    const installedManifest = JSON.parse(await fs.readFile(path.join(dest, 'package.json'), 'utf8'));
    if (installedManifest.version !== item.version)
      throw new Error(`Installed package validation failed: ${item.path} (expected ${item.version})`);
    installed = true;
  } finally {
    let restoreFailed = false;
    if (!installed) {
      if (oldSaved) {
        await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
        try {
          await moveAcrossVolumes(backup, dest, options.moveOperations);
        } catch (error) {
          restoreFailed = true;
          console.error(`[Setup] Unable to restore previous package ${item.path}: ${error.message}. Recovery backup: ${backup}`);
        }
      } else if (!hadPrevious) {
        await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
      }
    }
    // Keep the backup for manual recovery if restoring the old package failed.
    if (!restoreFailed) {
      await fs.rm(staging, { recursive: true, force: true }).catch(error => {
        console.warn(`[Setup] Temporary package files remain locked and can be removed after closing Node/antivirus scans: ${staging} (${error.code || error.message})`);
      });
    }
  }
}

function browserInstallerEnvironment(projectRoot, tempRoot, browserRoot, relaxTLS) {
  const env = { ...process.env, TMP: tempRoot, TEMP: tempRoot, TMPDIR: tempRoot, PLAYWRIGHT_BROWSERS_PATH: browserRoot };
  // Do not inherit disabled certificate validation from the parent shell.
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (relaxTLS) env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  return env;
}

export async function installChromiumIfMissing(projectRoot = root, run = spawnSync, options = {}) {
  // Existing Chrome supports headed/headless automation and CDP. A default
  // Playwright 'bundled' workflow uses Chrome as a runtime fallback when the
  // bundled browser is absent (see resolveStudioBrowser).
  const chrome = await (options.detectChrome || findInstalledChrome)();
  if (chrome && !options.forceBundledBrowser) {
    console.log(`[Setup] Existing Chrome detected: ${chrome}`);
    console.log('[Setup] Skipping chromium, chromium_headless_shell, ffmpeg and winldd downloads.');
    console.log('[Setup] To install Playwright bundled Chromium explicitly, run setup-runtime.bat --install-bundled-browser');
    return { mode: 'system-chrome', executablePath: chrome };
  }
  const browserInfo = JSON.parse(await fs.readFile(path.join(projectRoot, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8'));
  const revision = browserInfo.browsers.find(item => item.name === 'chromium')?.revision;
  const shellRevision = browserInfo.browsers.find(item => item.name === 'chromium-headless-shell')?.revision;
  if (!revision || !shellRevision) throw new Error('Playwright Chromium revisions are missing');
  const browserRoot = path.join(projectRoot, 'runtime', 'browsers');
  const chromium = path.join(browserRoot, `chromium-${revision}`, 'chrome-win64', 'chrome.exe');
  const shell = path.join(browserRoot, `chromium_headless_shell-${shellRevision}`, 'chrome-win', 'headless_shell.exe');
  const exists = async file => fs.stat(file).then(stat => stat.isFile()).catch(() => false);
  if ((await exists(chromium)) && (await exists(shell))) {
    console.log('Playwright Chromium is ready.');
    return { mode: 'bundled' };
  }
  await fs.mkdir(browserRoot, { recursive: true });
  const tempRoot = sameVolumeStagingRoot(projectRoot);
  await fs.mkdir(tempRoot, { recursive: true });
  const args = [path.join(projectRoot, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'];
  const invoke = relaxTLS => {
    const result = run(process.execPath, args, {
      cwd: projectRoot,
      env: browserInstallerEnvironment(projectRoot, tempRoot, browserRoot, relaxTLS),
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    return result;
  };
  console.log('Installing missing Playwright Chromium browser with certificate validation...');
  let result = invoke(false);
  if (result.status !== 0 && CERTIFICATE_ERROR_TEXT.test(`${result.stderr || ''}\n${result.stdout || ''}`)) {
    console.warn('[Setup] Chromium download failed due to an untrusted TLS issuer. Retrying in a separate installer process with certificate verification disabled. Normal TLS remains enabled in the parent process.');
    result = invoke(true);
  }
  if (result.status !== 0 || !(await exists(chromium)) || !(await exists(shell)))
    throw new Error('Playwright Chromium installation did not complete; check the TLS/network and browser files above');
  console.log('Playwright Chromium is ready.');
  return { mode: 'bundled' };
}

export async function main() {
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  for (const item of manifest) await installPackage(item);
  console.log('Required runtime packages are ready.');
  if (!process.argv.includes('--packages-only')) await installChromiumIfMissing(root, spawnSync, { forceBundledBrowser: process.argv.includes('--install-bundled-browser') });
  console.log('[Setup] TLS certificate validation is enabled for subsequent operations.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

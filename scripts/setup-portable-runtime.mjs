import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'scripts', 'portable-runtime-packages.json'), 'utf8'));
const packagesOnly = process.argv.includes('--packages-only');

function get(url, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('Too many redirects'));
  if (new URL(url).protocol !== 'https:') return Promise.reject(new Error('Download must use HTTPS'));
  return new Promise((resolve, reject) => {
    https.get(url, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const next = new URL(response.headers.location, url).href;
        response.resume();
        get(next, redirects + 1).then(resolve, reject);
      } else if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed: HTTP ${response.statusCode}`));
      } else {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      }
    }).on('error', reject);
  });
}

async function installPackage(item) {
  const destination = path.join(root, ...item.path.split('/'));
  const pkg = await fs.readFile(path.join(destination, 'package.json'), 'utf8').then(JSON.parse).catch(() => null);
  if (pkg?.version === item.version) return;
  if (!item.url.startsWith('https://registry.npmjs.org/')) throw new Error(`Unexpected registry URL for ${item.path}`);
  console.log(`Installing ${item.path} ${item.version}...`);
  const bytes = await get(item.url);
  const [algorithm, expected] = item.integrity.split('-', 2);
  if (algorithm !== 'sha512' || createHash('sha512').update(bytes).digest('base64') !== expected)
    throw new Error(`Integrity check failed: ${item.path}`);
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'automation-studio-package-'));
  try {
    const archive = path.join(staging, 'package.tgz');
    const extracted = path.join(staging, 'extracted');
    await fs.mkdir(extracted);
    await fs.writeFile(archive, bytes);
    const result = spawnSync('tar.exe', ['-xzf', archive, '-C', extracted, '--strip-components=1'], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`Could not unpack ${item.path}; Windows tar.exe is required`);
    const unpacked = JSON.parse(await fs.readFile(path.join(extracted, 'package.json'), 'utf8'));
    if (unpacked.version !== item.version) throw new Error(`Version mismatch: ${item.path}`);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rm(destination, { recursive: true, force: true });
    await fs.rename(extracted, destination);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

for (const item of manifest) await installPackage(item);
console.log('Required runtime packages are ready.');
if (!packagesOnly) {
  const browserInfo = JSON.parse(await fs.readFile(path.join(root, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8'));
  const revision = browserInfo.browsers.find(item => item.name === 'chromium')?.revision;
  const shellRevision = browserInfo.browsers.find(item => item.name === 'chromium-headless-shell')?.revision;
  if (!revision || !shellRevision) throw new Error('Playwright Chromium revisions are missing');
  const browserRoot = path.join(root, 'runtime', 'browsers');
  const chromium = path.join(browserRoot, `chromium-${revision}`, 'chrome-win64', 'chrome.exe');
  const shell = path.join(browserRoot, `chromium_headless_shell-${shellRevision}`, 'chrome-win', 'headless_shell.exe');
  const exists = async file => fs.stat(file).then(stat => stat.isFile()).catch(() => false);
  if (!(await exists(chromium)) || !(await exists(shell))) {
    console.log('Installing missing Playwright Chromium browser...');
    await fs.mkdir(browserRoot, { recursive: true });
    const result = spawnSync(process.execPath, [path.join(root, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'], {
      cwd: root,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserRoot },
      stdio: 'inherit'
    });
    if (result.status !== 0 || !(await exists(chromium)) || !(await exists(shell)))
      throw new Error('Chromium installation did not complete');
  }
  console.log('Playwright Chromium is ready.');
}

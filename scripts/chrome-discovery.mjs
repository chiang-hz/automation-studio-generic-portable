import fs from 'node:fs/promises';
import path from 'node:path';

/** Find an existing Chrome binary without launching or downloading anything.
 * No Edge fallback: corporate Edge may have different enterprise policies.
 */
export function chromeCandidates(env = process.env) {
  const paths = [
    env.CHROME_PATH,
    env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    env.CHROMIUM_EXECUTABLE_PATH,
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.ProgramW6432 && path.join(env.ProgramW6432, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  if (process.platform === 'linux') {
    paths.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  } else if (process.platform === 'darwin') {
    paths.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  }
  return [...new Set(paths.filter(Boolean).map(item => path.resolve(item)))];
}

export async function findInstalledChrome(env = process.env) {
  for (const candidate of chromeCandidates(env)) {
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch { /* Missing or unreadable; inspect next candidate. */ }
  }
  return undefined;
}

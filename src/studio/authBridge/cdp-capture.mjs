import {canonicalOrigin, normalizeOrigins, saveEncryptedSession, VaultError} from './session-vault.mjs';

export function validateLocalCDPEndpoint(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { throw new VaultError('CDP 端點格式不正確。', 'INVALID_CDP'); }
  if (!['http:', 'ws:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase())) {
    throw new VaultError('只允許連接本機 CDP 端點，不接受對外開放的偵錯埠。', 'REMOTE_CDP_DENIED');
  }
  if (url.username || url.password) {
    throw new VaultError('CDP 端點不可包含認證憑證。', 'INVALID_CDP');
  }
  return url.toString();
}

export async function assertAuthenticated(page, {verifyUrl, authenticatedSelector, timeoutMs = 15000} = {}) {
  if (!authenticatedSelector || typeof authenticatedSelector !== 'string') {
    throw new VaultError('必須指定登入後才會出現的專屬元件定位規則。', 'MISSING_AUTH_SELECTOR');
  }
  const allowedOrigin = canonicalOrigin(verifyUrl);
  try {
    await page.goto(verifyUrl, {waitUntil: 'domcontentloaded', timeout: timeoutMs});
    if (canonicalOrigin(page.url()) !== allowedOrigin) throw new Error('驗證時被重新導向至其他網站');
    await page.locator(authenticatedSelector).first().waitFor({state: 'visible', timeout: timeoutMs});
  } catch {
    throw new VaultError('無法確認登入有效。請檢查登入狀態與驗證元件，不會保存或使用此狀態。', 'AUTH_INVALID');
  }
}

/** Captures only after an already-authenticated, same-user browser is explicitly selected. */
export async function captureFromCDP({chromium, endpoint = 'http://127.0.0.1:9222', verifyUrl, authenticatedSelector, allowedOrigins, profileId, passphrase, ttlMs, vaultRoot}) {
  if (!chromium?.connectOverCDP) throw new VaultError('需要應用程式既有 Playwright Chromium。', 'PLAYWRIGHT_REQUIRED');
  validateLocalCDPEndpoint(endpoint);
  const origins = normalizeOrigins(allowedOrigins || [verifyUrl]);
  if (!origins.includes(canonicalOrigin(verifyUrl))) {
    throw new VaultError('驗證網址必須列在允許的來源中。', 'ORIGIN_NOT_ALLOWED');
  }
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const context = browser.contexts()[0];
    if (!context) throw new VaultError('CDP 瀏覽器沒有可用的工作階段。', 'NO_CONTEXT');
    // Use a temporary CDP tab: never navigate or disturb the user's existing login tabs.
    const page = await context.newPage();
    try {
      await assertAuthenticated(page, {verifyUrl, authenticatedSelector});
      // indexedDB availability is product-version-dependent: do not silently omit it.
      const state = await context.storageState({indexedDB: true});
      const summary = await saveEncryptedSession({profileId, allowedOrigins: origins, state, passphrase, ttlMs, vaultRoot});
      return summary;
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    // Closing a CDP-connected Playwright handle disconnects that connection. The user's
    // remote-debugging Chrome profile and browser must be managed by the original launcher.
    await browser.close().catch(() => {});
  }
}

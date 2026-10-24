import {randomBytes, randomUUID, createCipheriv, createDecipheriv, scryptSync} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = 1;
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

export class VaultError extends Error {
  constructor(message, code = 'VAULT_ERROR') {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

export function defaultVaultRoot() {
  const appData = process.env.LOCALAPPDATA || path.join(os.homedir(), '.config');
  return path.join(appData, 'AutomationStudio', 'private-auth-vault');
}

export function validateProfileId(profileId) {
  if (typeof profileId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/.test(profileId)) {
    throw new VaultError('登入設定檔識別碼僅可使用英數、底線與連字號，長度 1–60。', 'INVALID_PROFILE');
  }
  return profileId;
}

export function canonicalOrigin(input) {
  let url;
  try { url = new URL(input); } catch { throw new VaultError('來源必須是有效的完整 HTTPS URL。', 'INVALID_ORIGIN'); }
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHost)) {
    throw new VaultError('來源網址必須使用 HTTPS（localhost 測試例外）。', 'INSECURE_ORIGIN');
  }
  if (url.username || url.password) throw new VaultError('來源網址不可包含帳號或密碼。', 'INVALID_ORIGIN');
  return url.origin;
}

export function normalizeOrigins(origins) {
  if (!Array.isArray(origins) || origins.length === 0 || origins.length > 10) {
    throw new VaultError('須指定 1–10 個允許的網站來源。', 'INVALID_ORIGINS');
  }
  return [...new Set(origins.map(canonicalOrigin))].sort();
}

function cookieMatchesOrigin(cookie, origin) {
  const host = new URL(origin).hostname.toLowerCase();
  const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
  if (!domain) return false;
  return host === domain || host.endsWith(`.${domain}`);
}

/** Minimise what is stored: only cookies useful to allowed origins and matching origin storage. */
export function scopeStorageState(state, allowedOrigins) {
  const origins = normalizeOrigins(allowedOrigins);
  if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) {
    throw new VaultError('Storage State 的資料格式不正確。', 'INVALID_STATE');
  }
  const filtered = {
    cookies: state.cookies.filter(c => origins.some(o => cookieMatchesOrigin(c, o))),
    origins: state.origins.filter(o => {
      try { return origins.includes(canonicalOrigin(o.origin)); } catch { return false; }
    })
  };
  if (filtered.cookies.length === 0 && filtered.origins.length === 0) {
    throw new VaultError('指定來源沒有可保存的登入狀態。', 'EMPTY_STATE');
  }
  return filtered;
}

function deriveKey(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length < 16) {
    throw new VaultError('加密密語至少 16 個字元，且不得以明文儲存於專案設定。', 'WEAK_PASSPHRASE');
  }
  return scryptSync(passphrase, salt, 32, {N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024});
}

async function ensurePrivateDirectory(dir) {
  await fs.mkdir(dir, {recursive: true, mode: 0o700});
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new VaultError('登入狀態保存位置不可是符號連結或非資料夾。', 'INVALID_VAULT_PATH');
  }
  if (process.platform !== 'win32') await fs.chmod(dir, 0o700);
}

export async function saveEncryptedSession({profileId, allowedOrigins, state, passphrase, ttlMs = DEFAULT_TTL_MS, vaultRoot = defaultVaultRoot(), now = Date.now()}) {
  validateProfileId(profileId);
  const origins = normalizeOrigins(allowedOrigins);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) {
    throw new VaultError('登入狀態有效時間最多 24 小時。', 'INVALID_TTL');
  }
  const scoped = scopeStorageState(state, origins);
  const payload = {version: VERSION, profileId, allowedOrigins: origins, capturedAt: now, expiresAt: now + ttlMs, storageState: scoped};
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`AutomationStudio/AuthVault/${VERSION}/${profileId}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const envelope = {format: 'automation-studio-encrypted-auth', version: VERSION, kdf: 'scrypt', cipher: 'aes-256-gcm', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64')};
  const destination = path.join(vaultRoot, `${profileId}.authvault`);
  await ensurePrivateDirectory(vaultRoot);
  const temp = path.join(vaultRoot, `.${profileId}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, JSON.stringify(envelope), {encoding: 'utf8', mode: 0o600, flag: 'wx'});
    await fs.rename(temp, destination);
    if (process.platform !== 'win32') await fs.chmod(destination, 0o600);
  } finally { await fs.rm(temp, {force: true}).catch(() => {}); key.fill(0); }
  return {profileId, originCount: origins.length, cookieCount: scoped.cookies.length, capturedAt: now, expiresAt: now + ttlMs};
}

export async function loadEncryptedSession({profileId, passphrase, vaultRoot = defaultVaultRoot(), now = Date.now()}) {
  validateProfileId(profileId);
  const filename = path.join(vaultRoot, `${profileId}.authvault`);
  let raw;
  try { raw = JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new VaultError('尚未保存此登入狀態，請先以 CDP 人工登入並擷取。', 'NOT_FOUND');
    throw new VaultError('無法讀取登入狀態檔。', 'READ_ERROR');
  }
  if (raw.format !== 'automation-studio-encrypted-auth' || raw.version !== VERSION || raw.kdf !== 'scrypt' || raw.cipher !== 'aes-256-gcm') {
    throw new VaultError('登入狀態格式或版本不支援。', 'UNSUPPORTED_FORMAT');
  }
  let key;
  let data;
  try {
    const salt = Buffer.from(raw.salt, 'base64');
    key = deriveKey(passphrase, salt);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(raw.iv, 'base64'));
    decipher.setAAD(Buffer.from(`AutomationStudio/AuthVault/${VERSION}/${profileId}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(raw.tag, 'base64'));
    data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(raw.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw new VaultError('密語錯誤或登入狀態已毀損。', 'DECRYPT_FAILED');
  } finally { key?.fill(0); }
  if (data.version !== VERSION || data.profileId !== profileId || !Array.isArray(data.storageState?.cookies) || !Array.isArray(data.storageState?.origins)) {
    throw new VaultError('登入狀態檔案內容不完整。', 'CORRUPT_STATE');
  }
  if (now >= data.expiresAt) throw new VaultError('本機保存的登入狀態已到期，請重新登入。', 'EXPIRED');
  const origins = normalizeOrigins(data.allowedOrigins);
  data.storageState = scopeStorageState(data.storageState, origins);
  return data;
}

export async function deleteEncryptedSession({profileId, vaultRoot = defaultVaultRoot()}) {
  validateProfileId(profileId);
  await fs.rm(path.join(vaultRoot, `${profileId}.authvault`), {force: true});
}

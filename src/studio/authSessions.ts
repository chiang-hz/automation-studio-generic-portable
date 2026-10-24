import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { WorkflowProject } from "./types.ts";
import { captureFromCDP, assertAuthenticated } from "./authBridge/cdp-capture.mjs";
import { canonicalOrigin, deleteEncryptedSession, loadEncryptedSession, defaultVaultRoot } from "./authBridge/session-vault.mjs";

export interface SavedAuthSession {
  storageState: { cookies: unknown[]; origins: unknown[] };
  verifyUrl: string;
  selector: string;
  allowedOrigins: string[];
  expiresAt: number;
}
const UNLOCK_MS = 60 * 60 * 1000;
function invalidAuthentication(message: string): Error & {code: string} {
  const error = new Error(message) as Error & {code: string};
  error.code = "AUTH_INVALID";
  return error;
}

export function authProfileId(projectId: string): string {
  return `project-${createHash("sha256").update(projectId).digest("hex").slice(0, 32)}`;
}

export function assertAuthConfiguration(project: WorkflowProject): { verifyUrl: string; selector: string; origin: string } {
  const verifyUrl = String(project.browser.authVerifyUrl || "").trim();
  const selector = String(project.browser.authSuccessSelector || "").trim();
  if (!selector || selector.length > 400) throw new Error("請設定登入後才會出現的專屬 CSS 元件定位規則（最多 400 字）。");
  const origin = canonicalOrigin(verifyUrl);
  if (![...project.allowedDomains].some((entry) => entry === new URL(verifyUrl).hostname)) {
    throw new Error("登入健康檢查網址的網域必須先加入此專案的允許網域清單（不接受萬用字元）。");
  }
  return {verifyUrl, selector, origin};
}

/** Server-process-only cache. Never serialize this map, secret state or passphrase to projects/runs/exports. */
export class AuthSessionManager {
  private readonly cache = new Map<string, SavedAuthSession>();
  private readonly vaultRoot = defaultVaultRoot();

  async capture(project: WorkflowProject, passphrase: string): Promise<Record<string, unknown>> {
    const {verifyUrl, selector, origin} = assertAuthConfiguration(project);
    const playwright = await import("playwright");
    const info = await captureFromCDP({
      chromium: playwright.chromium, endpoint: project.browser.cdpEndpoint,
      verifyUrl, authenticatedSelector: selector, allowedOrigins: [origin],
      profileId: authProfileId(project.id), passphrase, vaultRoot: this.vaultRoot
    });
    this.cache.delete(project.id);
    await this.unlock(project, passphrase);
    return {saved: true, capturedAt: info.capturedAt, expiresAt: info.expiresAt, cookieCount: info.cookieCount};
  }

  async unlock(project: WorkflowProject, passphrase: string): Promise<{ unlocked: boolean; expiresAt: number }> {
    const {origin, verifyUrl, selector} = assertAuthConfiguration(project);
    const data = await loadEncryptedSession({profileId: authProfileId(project.id), passphrase, vaultRoot: this.vaultRoot});
    if (!data.allowedOrigins.includes(origin)) throw new Error("保存的登入狀態與目前專案網址不一致，請重新以 CDP 擷取。");
    const expiresAt = Math.min(data.expiresAt, Date.now() + UNLOCK_MS);
    this.cache.set(project.id, { storageState: data.storageState, verifyUrl, selector, allowedOrigins: data.allowedOrigins, expiresAt });
    return {unlocked: true, expiresAt};
  }

  getForRun(project: WorkflowProject): SavedAuthSession {
    if (project.browser.connectionMode !== "managed" || project.browser.authStateEnabled !== true) {
      throw new Error("登入共用只可使用於已啟用此功能的管理瀏覽器。");
    }
    const {origin, verifyUrl, selector} = assertAuthConfiguration(project);
    const item = this.cache.get(project.id);
    if (!item || item.expiresAt <= Date.now()) {
      this.cache.delete(project.id);
      throw invalidAuthentication("登入狀態尚未解鎖或已到期。請於網站與瀏覽器工作站重新解鎖或 CDP 擷取。");
    }
    if (item.verifyUrl !== verifyUrl || item.selector !== selector || !item.allowedOrigins.includes(origin)) {
      throw invalidAuthentication("登入檢查設定已更動，請重新解鎖登入狀態。");
    }
    return item;
  }

  async verify(page: any, project: WorkflowProject): Promise<void> {
    const item = this.getForRun(project);
    await assertAuthenticated(page, {verifyUrl: item.verifyUrl, authenticatedSelector: item.selector, timeoutMs: 15_000});
  }

  async status(project: WorkflowProject): Promise<{saved: boolean; unlocked: boolean; expiresAt?: number}> {
    const profileId = authProfileId(project.id);
    const saved = await fs.stat(path.join(this.vaultRoot, `${profileId}.authvault`)).then(s=>s.isFile()).catch(()=>false);
    const item = this.cache.get(project.id);
    return {saved, unlocked: Boolean(item && item.expiresAt > Date.now()), ...(item && item.expiresAt > Date.now() ? {expiresAt:item.expiresAt} : {})};
  }

  async revoke(project: WorkflowProject): Promise<void> {
    this.cache.delete(project.id);
    await deleteEncryptedSession({profileId: authProfileId(project.id), vaultRoot: this.vaultRoot});
  }
  lock(projectId: string): void {this.cache.delete(projectId);}
}

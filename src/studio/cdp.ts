import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserSettings } from "./types.ts";
import { ensurePdfDownloadPreference } from "./profile.ts";

type PlaywrightModule = typeof import("playwright");

export interface CdpTabInfo {
  index: number;
  title: string;
  url: string;
}

export interface CdpConnectionResult {
  browser: any;
  context: any;
  page: any;
  endpoint: string;
  tabs: CdpTabInfo[];
  autoLaunched?: boolean;
}

export function validateLocalCdpEndpoint(raw: string): string {
  const value = String(raw ?? "").trim();
  if (!value) throw new Error("請輸入 CDP 位址，例如 http://127.0.0.1:9222。 ");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("CDP 位址格式錯誤，請使用 http://127.0.0.1:9222 之類的本機位址。");
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    throw new Error(`不支援的 CDP 協定：${url.protocol}`);
  }
  const hostname = url.hostname.toLowerCase();
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname)) {
    throw new Error("為避免遠端瀏覽器被誤接管，Automation Studio 的 CDP 模式只允許連線本機 localhost / 127.0.0.1 / ::1。");
  }
  return value;
}

export function defaultCdpProfileDir(): string {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "AutomationStudio", "ChromeCDPProfile");
  }
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "AutomationStudio", "ChromeCDPProfile");
  return path.join(os.homedir(), ".automation-studio", "ChromeCDPProfile");
}

export function findChromeExecutable(): string | undefined {
  const candidates: string[] = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  if (process.platform === "win32") {
    for (const root of [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]) {
      if (root) candidates.push(path.join(root, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  } else {
    candidates.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser");
  }
  return candidates.find((candidate) => fs.existsSync(candidate));
}

export function cdpLaunchArguments(endpointRaw: string, profileDir = defaultCdpProfileDir()): string[] {
  const endpoint = validateLocalCdpEndpoint(endpointRaw);
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("自動啟動 Chrome 時，CDP 位址請使用 http://127.0.0.1:9222 形式。");
  const port = url.port || "9222";
  return [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank"
  ];
}

export async function launchLocalChromeForCdp(settings: BrowserSettings): Promise<{ executable: string; profileDir: string }> {
  const executable = findChromeExecutable();
  if (!executable) {
    throw new Error("找不到 Google Chrome。請先安裝 Chrome，或設定環境變數 CHROME_PATH 指向 chrome.exe；也可關閉「執行時自動啟動 Chrome」並自行啟動 CDP Chrome。");
  }
  const profileDir = defaultCdpProfileDir();
  fs.mkdirSync(profileDir, { recursive: true });
  if (settings.downloadPdfInsteadOfPreview === true) await ensurePdfDownloadPreference(profileDir);
  const child = spawn(executable, cdpLaunchArguments(settings.cdpEndpoint, profileDir), {
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();
  return { executable, profileDir };
}

async function rawConnect(playwright: PlaywrightModule, settings: BrowserSettings, timeoutMs?: number): Promise<CdpConnectionResult> {
  const endpoint = validateLocalCdpEndpoint(settings.cdpEndpoint);
  const browser = await playwright.chromium.connectOverCDP(endpoint, { timeout: timeoutMs ?? Math.max(5_000, settings.defaultTimeoutMs) });
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => undefined);
    throw new Error("已連線 CDP，但找不到 Chrome 的預設瀏覽器工作階段。");
  }
  const pages = usablePages(context.pages());
  const page = selectCdpPage(pages, settings);
  const tabs = await describeCdpTabs(pages);
  return { browser, context, page, endpoint, tabs };
}

export async function connectToCdpBrowser(
  playwright: PlaywrightModule,
  settings: BrowserSettings
): Promise<CdpConnectionResult> {
  const endpoint = validateLocalCdpEndpoint(settings.cdpEndpoint);
  try {
    return await rawConnect(playwright, settings);
  } catch (firstError) {
    if (settings.cdpAutoLaunch === false) {
      const detail = firstError instanceof Error ? firstError.message : String(firstError);
      throw new Error(`無法連線本機 Chrome CDP（${endpoint}）。請確認 Chrome 已使用 --remote-debugging-port 啟動，而且連接埠一致。技術訊息：${detail}`, { cause: firstError });
    }

    await launchLocalChromeForCdp(settings);
    const deadline = Date.now() + Math.max(12_000, Math.min(30_000, settings.defaultTimeoutMs));
    let lastError: unknown = firstError;
    while (Date.now() < deadline) {
      await delay(500);
      try {
        const result = await rawConnect(playwright, settings, 2_000);
        result.autoLaunched = true;
        return result;
      } catch (error) {
        lastError = error;
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Automation Studio 已嘗試自動啟動 Chrome，但仍無法連線 CDP（${endpoint}）。請確認 Chrome 未被公司政策阻擋遠端除錯，或改用手動 CDP 啟動。技術訊息：${detail}`, { cause: lastError });
  }
}

export async function inspectCdpEndpoint(
  playwright: PlaywrightModule,
  settings: BrowserSettings
): Promise<{ endpoint: string; version: string; tabs: CdpTabInfo[]; selectedIndex: number; autoLaunched?: boolean }> {
  const result = await connectToCdpBrowser(playwright, settings);
  try {
    const version = await Promise.resolve(result.browser.version?.() ?? "Chromium");
    const selectedIndex = Math.max(1, usablePages(result.context.pages()).indexOf(result.page) + 1);
    return { endpoint: result.endpoint, version: String(version), tabs: result.tabs, selectedIndex, autoLaunched: result.autoLaunched };
  } finally {
    // For a browser obtained via connectOverCDP, browser.close() disconnects
    // this Playwright client. It does not close the user's pre-existing default
    // Chrome context/pages.
    await result.browser.close().catch(() => undefined);
  }
}

export function selectCdpPage(pagesInput: any[], settings: BrowserSettings): any {
  const pages = usablePages(pagesInput);
  if (!pages.length) throw new Error("CDP 已連線，但目前 Chrome 沒有可控制的分頁。請先在 Chrome 開啟至少一個網頁。");
  if (settings.cdpInitialPageMode === "url") {
    const target = String(settings.cdpInitialPageTarget ?? "").trim();
    if (!target) throw new Error("CDP 起始分頁選擇為「網址包含」時，請填入網址片段。");
    const found = pages.find((page) => String(page.url?.() ?? "").includes(target));
    if (!found) throw new Error(`找不到網址包含「${target}」的 Chrome 分頁。`);
    return found;
  }
  if (settings.cdpInitialPageMode === "index") {
    const index = Math.max(1, Math.trunc(Number(settings.cdpInitialPageIndex ?? 1)));
    if (index > pages.length) throw new Error(`Chrome 目前只有 ${pages.length} 個可控制分頁，無法選擇第 ${index} 個。`);
    return pages[index - 1];
  }
  return pages[0];
}

export async function describeCdpTabs(pagesInput: any[]): Promise<CdpTabInfo[]> {
  const pages = usablePages(pagesInput);
  return Promise.all(pages.map(async (page, index) => ({
    index: index + 1,
    title: String(await page.title().catch(() => "")),
    url: String(page.url?.() ?? "")
  })));
}

function usablePages(pages: any[]): any[] {
  const live = (pages ?? []).filter((page) => page && !page.isClosed?.());
  const normal = live.filter((page) => !/^(devtools|chrome-extension):/i.test(String(page.url?.() ?? "")));
  return normal.length ? normal : live;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

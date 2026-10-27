import fs from "node:fs/promises";
import path from "node:path";
import type { BrowserChannel } from "./types.ts";
import { findInstalledChrome } from "../../scripts/chrome-discovery.mjs";

export const DESKTOP_VIEWPORT = { width: 1440, height: 900 } as const;

export interface StudioBrowserResolution {
  executablePath?: string;
  channel?: "chrome";
  source: string;
  fallback: boolean;
  available?: boolean;
}

/**
 * Resolve a browser without assuming that Playwright's browser cache exists.
 * A portable package may carry the cache, while a normal Windows workstation
 * commonly already has Chrome installed.
 */
export async function resolveStudioBrowser(
  playwright: { chromium: { executablePath: () => string } },
  preferred: BrowserChannel,
  options: { detectChrome?: () => Promise<string | undefined> } = {}
): Promise<StudioBrowserResolution> {
  const configured = await existingFile(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_EXECUTABLE_PATH);
  if (configured) return { executablePath: configured, source: "環境變數指定瀏覽器", fallback: false };

  const bundled = await existingFile(safeExecutablePath(playwright));
  const cached = await firstExisting(await localPlaywrightCandidates());
  const chrome = await (options.detectChrome || findInstalledChrome)();

  if (preferred === "bundled") {
    if (bundled) return { executablePath: bundled, source: "Playwright 隨附 Chromium", fallback: false };
    if (cached) return { executablePath: cached, source: "本機 Playwright Chromium 快取", fallback: false };
    // Portable installs using system Chrome do not need a bundled Chromium.
    if (chrome) return { executablePath: chrome, source: "Google Chrome（未安裝隨附 Chromium，自動備援）", fallback: true };
    return { source: "找不到隨附 Chromium 或已安裝的 Google Chrome", fallback: false, available: false };
  }


  if (chrome) return { executablePath: chrome, source: "Google Chrome", fallback: false };
  return { source: "找不到 Google Chrome", fallback: false, available: false };
}

export function browserLaunchMessage(preferred: BrowserChannel, resolution: StudioBrowserResolution, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const selected = preferred === "bundled" ? "隨附 Chromium" : "系統 Google Chrome";
  if (/DevTools remote debugging is disallowed|remote debugging is disallowed/i.test(detail)) return `此電腦的系統原則禁止 ${resolution.fallback ? "備援 Google Chrome" : selected} 接受自動化控制。若公司政策允許，請執行 setup-runtime.bat --install-bundled-browser，並改用隨附 Chromium；或洽資訊單位確認可用的瀏覽器自動化方式。`;
  if (resolution.available === false) return `無法啟動瀏覽器：${resolution.source}。請先確認 Chrome 安裝位置（必要時設定 CHROME_PATH），或執行 setup-runtime.bat --install-bundled-browser 安裝可攜 Chromium。`;
  return `無法啟動瀏覽器（目前選擇：${selected}；${resolution.source}）。技術啟動參數已隱藏；請改用隨附 Chromium 或檢查本機瀏覽器設定。`;
}

async function localPlaywrightCandidates(): Promise<string[]> {
  const roots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "ms-playwright") : "",
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "AppData", "Local", "ms-playwright") : "",
    path.resolve("runtime", "browsers")
  ].filter(Boolean);
  const candidates: string[] = [];
  for (const root of roots) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const browserDirs = entries
      .filter((entry) => entry.isDirectory() && /^(chromium|chromium_headless_shell)-\d+$/i.test(entry.name))
      .sort((left, right) => readRevision(right.name) - readRevision(left.name));
    for (const entry of browserDirs) {
      candidates.push(
        path.join(root, entry.name, "chrome-win64", "chrome.exe"),
        path.join(root, entry.name, "chrome-linux", "chrome"),
        path.join(root, entry.name, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium")
      );
    }
  }
  return candidates;
}

function safeExecutablePath(playwright: { chromium: { executablePath: () => string } }): string | undefined {
  try {
    return playwright.chromium.executablePath();
  } catch {
    return undefined;
  }
}

async function firstExisting(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    const found = await existingFile(candidate);
    if (found) return found;
  }
  return undefined;
}

async function existingFile(filePath: string | undefined): Promise<string | undefined> {
  if (!filePath) return undefined;
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? filePath : undefined;
  } catch {
    return undefined;
  }
}

function readRevision(value: string): number {
  return Number(value.match(/\d+/)?.[0] ?? "0");
}

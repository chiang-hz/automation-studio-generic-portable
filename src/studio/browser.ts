import fs from "node:fs/promises";
import path from "node:path";
import type { BrowserChannel } from "./types.ts";

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
  preferred: BrowserChannel
): Promise<StudioBrowserResolution> {
  const configured = await existingFile(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_EXECUTABLE_PATH);
  if (configured) return { executablePath: configured, source: "環境變數指定瀏覽器", fallback: false };

  const bundled = await existingFile(safeExecutablePath(playwright));
  const cached = await firstExisting(await localPlaywrightCandidates());
  const chrome = await firstExisting(installedBrowserCandidates("chrome"));

  if (preferred === "bundled") {
    if (bundled) return { executablePath: bundled, source: "Playwright 隨附 Chromium", fallback: false };
    if (cached) return { executablePath: cached, source: "本機 Playwright Chromium 快取", fallback: false };
    return { source: "找不到專案內可攜 Chromium runtime", fallback: false, available: false };
  }


  if (chrome) return { executablePath: chrome, source: "Google Chrome", fallback: false };
  return { source: "找不到 Google Chrome", fallback: false, available: false };
}

export function browserLaunchMessage(preferred: BrowserChannel, resolution: StudioBrowserResolution, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const selected = preferred === "bundled" ? "隨附 Chromium" : "系統 Google Chrome";
  if (/DevTools remote debugging is disallowed|remote debugging is disallowed/i.test(detail)) return `此電腦的系統原則禁止 ${selected} 接受自動化控制，因此無法錄製或導向目標網址。請選擇「隨附 Chromium」並先執行 setup-runtime.bat 建立專案內的可攜 Chromium runtime；或請資訊單位依規定開放瀏覽器自動化。`;
  if (resolution.available === false) return `無法啟動瀏覽器：${resolution.source}。請先執行 setup-runtime.bat 下載專案內的可攜 Chromium，再選擇「隨附 Chromium」。`;
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

function installedBrowserCandidates(_kind: "chrome"): string[] {
  const candidates: string[] = [];
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramW6432 || process.env.ProgramFiles;
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  if (localAppData) candidates.push(path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"));
  if (programFiles) candidates.push(path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"));
  if (programFilesX86) candidates.push(path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"));
  candidates.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
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

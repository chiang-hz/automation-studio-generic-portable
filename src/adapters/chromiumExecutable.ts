import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.ts";

export async function resolveChromiumExecutablePath(
  config: AppConfig
): Promise<string | undefined> {
  const configured = normalizePath(config.chromiumExecutablePath);
  if (configured && await fileExists(configured)) {
    return configured;
  }

  for (const candidate of await findLocalPlaywrightChromiumCandidates()) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  // A Playwright package can be present while its browser cache is not.
  // Use Google Chrome as the only system-browser fallback. Microsoft Edge is
  // intentionally excluded because enterprise policy / IE mode can make
  // Playwright recording unreliable on managed intranet sites.
  for (const candidate of installedChromiumCandidates()) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function installedChromiumCandidates(): string[] {
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramW6432 || process.env.ProgramFiles;
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  return [
    localAppData ? path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe") : "",
    programFiles ? path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe") : "",
    programFilesX86 ? path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe") : "",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ].filter(Boolean);
}

async function findLocalPlaywrightChromiumCandidates(): Promise<string[]> {
  const roots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "ms-playwright") : "",
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "AppData", "Local", "ms-playwright") : ""
  ].filter(Boolean);

  const candidates: string[] = [];
  for (const root of roots) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const chromiumDirs = entries
      .filter((entry) => entry.isDirectory() && /^chromium-\d+$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => readChromiumRevision(right) - readChromiumRevision(left));

    for (const dir of chromiumDirs) {
      candidates.push(path.join(root, dir, "chrome-win64", "chrome.exe"));
    }
  }

  return [...new Set(candidates)];
}

function normalizePath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function readChromiumRevision(value: string): number {
  return Number(value.match(/\d+/)?.[0] ?? "0");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

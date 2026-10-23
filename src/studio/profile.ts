import fs from "node:fs/promises";
import path from "node:path";

export interface BrowserProfileStatus {
  enabled: boolean;
  hasData: boolean;
  relativePath: string;
}

export function resolveProjectProfileDir(projectId: string): string {
  const safe = safeProjectId(projectId);
  return path.resolve("./data/profiles", safe);
}

export function resolveBatchWorkerProfileDir(projectId: string, worker: number): string {
  if (!Number.isInteger(worker) || worker < 1 || worker > 3) throw new Error("批次工作站編號必須為 1–3。");
  return path.join(resolveProjectProfileDir(projectId), "batch-workers", String(worker));
}

export async function getBrowserProfileStatus(projectId: string, enabled: boolean): Promise<BrowserProfileStatus> {
  const profileDir = resolveProjectProfileDir(projectId);
  let hasData = false;
  try {
    const entries = await fs.readdir(profileDir);
    hasData = entries.length > 0;
  } catch {
    hasData = false;
  }
  return { enabled, hasData, relativePath: `data/profiles/${safeProjectId(projectId)}` };
}

export async function clearBrowserProfile(projectId: string): Promise<void> {
  await fs.rm(resolveProjectProfileDir(projectId), { recursive: true, force: true });
}

export async function ensurePdfDownloadPreference(userDataDir: string): Promise<void> {
  const profileDir = path.join(userDataDir, "Default");
  const preferencesPath = path.join(profileDir, "Preferences");
  await fs.mkdir(profileDir, { recursive: true });

  let preferences: Record<string, any> = {};
  try {
    const text = await fs.readFile(preferencesPath, "utf8");
    if (text.trim()) preferences = JSON.parse(text);
  } catch {
    preferences = {};
  }

  const plugins = preferences.plugins && typeof preferences.plugins === "object" ? preferences.plugins : {};
  const download = preferences.download && typeof preferences.download === "object" ? preferences.download : {};
  preferences.plugins = { ...plugins, always_open_pdf_externally: true };
  preferences.download = { ...download, prompt_for_download: false, open_pdf_in_system_reader: false };

  const temporary = `${preferencesPath}.automation-studio.tmp`;
  await fs.writeFile(temporary, JSON.stringify(preferences), "utf8");
  await fs.rename(temporary, preferencesPath).catch(async () => {
    await fs.copyFile(temporary, preferencesPath);
    await fs.rm(temporary, { force: true });
  });
}

function safeProjectId(value: string): string {
  const id = String(value).trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(id)) {
    throw new Error("識別碼只能包含英數字、句點、底線與連字號。");
  }
  return id;
}

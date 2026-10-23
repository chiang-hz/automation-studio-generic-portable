import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkflowParameter, WorkflowProject, WorkflowRun, WorkflowSettings, WorkflowStep } from "./types.ts";
import { isDebugCleanupDue, nextDebugCleanupEligibleAt, removeRunDebugDirectory, sweepExpiredDebug } from "./debugRetention.ts";
import {
  calculateRunHistoryUsage,
  findExpiredRunHistory,
  isRunHistoryCleanupDue,
  isRunHistoryDeletable,
  nextRunHistoryCleanupEligibleAt,
  safeRunRecordPath
} from "./runHistoryRetention.ts";
import { DEFAULT_AI_SETTINGS } from "./ai/config.ts";
import { normalizeBatchConcurrency } from "./concurrency.ts";
import type { AIProviderConfig, AISettings } from "./ai/types.ts";

const rootDir = path.resolve(process.env.STUDIO_DATA_DIR ?? "./data/studio");
const projectsDir = path.join(rootDir, "projects");
const runsDir = path.join(rootDir, "runs");
const settingsPath = path.join(rootDir, "settings.json");
const debugRoot = path.resolve("./debug");
const debugCleanupStatusPath = path.join(rootDir, "debug-cleanup-status.json");
const runHistoryCleanupStatusPath = path.join(rootDir, "run-history-cleanup-status.json");
const jsonWriteQueues = new Map<string, Promise<void>>();
let atomicWriteSequence = 0;
const WINDOWS_RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export interface DebugCleanupStatus {
  lastAttemptAt?: string;
  lastCompletedAt?: string;
  nextEligibleAt?: string;
  lastReason?: string;
  deletedRuns: number;
  reclaimedBytes: number;
  retentionDays?: number;
  debugRetention?: "failures" | "all";
  lastError?: string;
  running: boolean;
}

export interface DebugCleanupResult extends DebugCleanupStatus {
  skipped?: "not-due" | "already-running";
}

export interface RunHistoryCleanupStatus {
  lastAttemptAt?: string;
  lastCompletedAt?: string;
  nextEligibleAt?: string;
  lastReason?: string;
  deletedRuns: number;
  reclaimedBytes: number;
  retentionDays?: number;
  lastError?: string;
  running: boolean;
}

export interface RunHistoryCleanupResult extends RunHistoryCleanupStatus {
  skipped?: "not-due" | "already-running";
}

export interface DeleteRunsResult {
  requestedRuns: number;
  deletedRuns: number;
  protectedRuns: number;
  missingRuns: number;
  reclaimedBytes: number;
}

export class StudioStore {
  private debugCleanupPromise: Promise<DebugCleanupResult> | undefined;
  private runHistoryCleanupPromise: Promise<RunHistoryCleanupResult> | undefined;
  async initialize(): Promise<void> {
    await Promise.all([
      fs.mkdir(projectsDir, { recursive: true }),
      fs.mkdir(runsDir, { recursive: true }),
      fs.mkdir(path.resolve("./downloads"), { recursive: true }),
      fs.mkdir(debugRoot, { recursive: true }),
      fs.mkdir(path.resolve("./exports"), { recursive: true }),
      fs.mkdir(path.resolve("./data/profiles"), { recursive: true })
    ]);
  }

  async listProjects(): Promise<WorkflowProject[]> {
    await this.initialize();
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    const projects: WorkflowProject[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        projects.push(await this.getProject(entry.name));
      } catch {
        // Ignore incomplete project folders and keep the rest usable.
      }
    }
    return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getProject(id: string): Promise<WorkflowProject> {
    const project = await readJson<WorkflowProject>(path.join(projectsDir, safeId(id), "project.json"));
    // Apply compatibility upgrades when a stored project is read as well as
    // when it is saved/imported. This lets existing recordings immediately
    // benefit from newly recognised download routes.
    return {
      ...project,
      settings: normalizeSettings(project.settings),
      parameters: normalizeParameters(project.parameters),
      steps: upgradeRecordedSteps(Array.isArray(project.steps) ? project.steps : [])
    };
  }

  async saveProject(project: WorkflowProject): Promise<WorkflowProject> {
    await this.initialize();
    const normalized = normalizeProject(project);
    const folder = path.join(projectsDir, normalized.id);
    await fs.mkdir(folder, { recursive: true });
    await writeJsonAtomic(path.join(folder, "project.json"), normalized);
    return normalized;
  }

  async deleteProject(id: string): Promise<void> {
    await fs.rm(path.join(projectsDir, safeId(id)), { recursive: true, force: true });
  }

  async listRuns(projectId?: string): Promise<WorkflowRun[]> {
    await this.initialize();
    const files = (await fs.readdir(runsDir)).filter((name) => name.endsWith(".json"));
    const runs: WorkflowRun[] = [];
    for (const file of files) {
      try {
        const run = await readJson<WorkflowRun>(path.join(runsDir, file));
        if (!projectId || run.projectId === projectId) runs.push(run);
      } catch {
        // A partial run record must not block the history page.
      }
    }
    return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async getRun(id: string): Promise<WorkflowRun> {
    return readJson<WorkflowRun>(path.join(runsDir, `${safeId(id)}.json`));
  }

  async deleteRuns(ids: string[]): Promise<DeleteRunsResult> {
    await this.initialize();
    const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).map((id) => safeId(id)))];
    const result: DeleteRunsResult = { requestedRuns: uniqueIds.length, deletedRuns: 0, protectedRuns: 0, missingRuns: 0, reclaimedBytes: 0 };
    for (const id of uniqueIds) {
      const recordPath = safeRunRecordPath(runsDir, id);
      let outcome: "deleted" | "protected" | "missing" = "missing";
      let reclaimedBytes = 0;
      await enqueueJsonWrite(recordPath, async () => {
        let current: WorkflowRun;
        try {
          current = await readJson<WorkflowRun>(recordPath);
        } catch (error) {
          if (fileErrorCode(error) === "ENOENT") return;
          throw error;
        }
        if (!isRunHistoryDeletable(current.status)) {
          outcome = "protected";
          return;
        }
        const debugResult = await removeRunDebugDirectory(debugRoot, current.debugDir);
        const recordSize = await fs.stat(recordPath).then((stat) => stat.size).catch(() => 0);
        await fs.rm(recordPath, { force: true });
        reclaimedBytes = debugResult.reclaimedBytes + recordSize;
        outcome = "deleted";
      });
      if (outcome === "deleted") {
        result.deletedRuns += 1;
        result.reclaimedBytes += reclaimedBytes;
      } else if (outcome === "protected") result.protectedRuns += 1;
      else result.missingRuns += 1;
    }
    return result;
  }

  async getRunHistoryUsage() {
    const runs = await this.listRuns();
    return calculateRunHistoryUsage({ runsDir, debugRoot, runs });
  }

  async saveRun(run: WorkflowRun): Promise<WorkflowRun> {
    await this.initialize();
    run.updatedAt = new Date().toISOString();
    try {
      await writeJsonAtomic(path.join(runsDir, `${safeId(run.id)}.json`), run);
    } catch (error) {
      // Persisting run history is secondary to the browser workflow itself.
      // On Windows, endpoint protection/indexers can keep a JSON file locked
      // even after bounded retries. Do not turn an otherwise successful run
      // into a workflow failure solely because its history record could not be
      // replaced at this instant; a later saveRun call can still persist it.
      console.warn(`[run-store] 執行紀錄暫時無法保存 (${run.id})：${formatFileError(error)}`);
    }
    return run;
  }


  async getSettings(): Promise<Record<string, unknown>> {
    await this.initialize();
    try {
      const stored = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
      return normalizeSystemSettings(stored);
    } catch {
      return normalizeSystemSettings({});
    }
  }

  async saveSettings(settings: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.initialize();
    const previous = await this.getSettings();
    const normalized = normalizeSystemSettings(settings, previous);
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await writeJsonAtomic(settingsPath, normalized);
    return normalized;
  }

  async getDebugCleanupStatus(): Promise<DebugCleanupStatus> {
    await this.initialize();
    let stored: Partial<DebugCleanupStatus> = {};
    try {
      stored = await readJson<Partial<DebugCleanupStatus>>(debugCleanupStatusPath);
    } catch {
      stored = {};
    }
    return {
      lastAttemptAt: stored.lastAttemptAt,
      lastCompletedAt: stored.lastCompletedAt,
      nextEligibleAt: nextDebugCleanupEligibleAt(stored.lastCompletedAt),
      lastReason: stored.lastReason,
      deletedRuns: Number(stored.deletedRuns ?? 0) || 0,
      reclaimedBytes: Number(stored.reclaimedBytes ?? 0) || 0,
      retentionDays: stored.retentionDays,
      debugRetention: stored.debugRetention === "all" ? "all" : stored.debugRetention === "failures" ? "failures" : undefined,
      lastError: stored.lastError,
      running: Boolean(this.debugCleanupPromise)
    };
  }

  async getRunHistoryCleanupStatus(): Promise<RunHistoryCleanupStatus> {
    await this.initialize();
    let stored: Partial<RunHistoryCleanupStatus> = {};
    try {
      stored = await readJson<Partial<RunHistoryCleanupStatus>>(runHistoryCleanupStatusPath);
    } catch {
      stored = {};
    }
    return {
      lastAttemptAt: stored.lastAttemptAt,
      lastCompletedAt: stored.lastCompletedAt,
      nextEligibleAt: nextRunHistoryCleanupEligibleAt(stored.lastCompletedAt),
      lastReason: stored.lastReason,
      deletedRuns: Number(stored.deletedRuns ?? 0) || 0,
      reclaimedBytes: Number(stored.reclaimedBytes ?? 0) || 0,
      retentionDays: stored.retentionDays,
      lastError: stored.lastError,
      running: Boolean(this.runHistoryCleanupPromise)
    };
  }

  async maybeCleanupExpiredRunHistory(reason: "startup" | "run-finished" | "manual", force = false): Promise<RunHistoryCleanupResult> {
    if (this.runHistoryCleanupPromise) return this.runHistoryCleanupPromise;
    const task = this.checkAndPerformRunHistoryCleanup(reason, force);
    this.runHistoryCleanupPromise = task;
    try {
      return await task;
    } finally {
      if (this.runHistoryCleanupPromise === task) this.runHistoryCleanupPromise = undefined;
    }
  }

  private async checkAndPerformRunHistoryCleanup(reason: "startup" | "run-finished" | "manual", force: boolean): Promise<RunHistoryCleanupResult> {
    const current = await this.getRunHistoryCleanupStatus();
    if (!force && !isRunHistoryCleanupDue(current.lastCompletedAt)) return { ...current, skipped: "not-due", running: false };
    return this.performRunHistoryCleanup(reason);
  }

  private async performRunHistoryCleanup(reason: "startup" | "run-finished" | "manual"): Promise<RunHistoryCleanupResult> {
    const attemptAt = new Date().toISOString();
    const settings = await this.getSettings();
    const retentionDays = clampSystemInteger(settings.runHistoryRetentionDays, 1, 365, 30);
    try {
      const candidates = findExpiredRunHistory({ runs: await this.listRuns(), retentionDays });
      const deleted = await this.deleteRuns(candidates.runIds);
      const completedAt = new Date().toISOString();
      const stored: RunHistoryCleanupStatus = {
        lastAttemptAt: attemptAt,
        lastCompletedAt: completedAt,
        nextEligibleAt: nextRunHistoryCleanupEligibleAt(completedAt),
        lastReason: reason,
        deletedRuns: deleted.deletedRuns,
        reclaimedBytes: deleted.reclaimedBytes,
        retentionDays,
        running: false
      };
      await writeJsonAtomic(runHistoryCleanupStatusPath, stored);
      return stored;
    } catch (error) {
      const previous = await this.getRunHistoryCleanupStatus();
      const failed: RunHistoryCleanupStatus = {
        ...previous,
        lastAttemptAt: attemptAt,
        lastReason: reason,
        retentionDays,
        lastError: formatFileError(error),
        running: false
      };
      await writeJsonAtomic(runHistoryCleanupStatusPath, failed).catch(() => undefined);
      throw error;
    }
  }

  async cleanupCompletedRunDebug(run: WorkflowRun): Promise<{ deleted: boolean; reclaimedBytes: number }> {
    if (run.status !== "completed") return { deleted: false, reclaimedBytes: 0 };
    const settings = await this.getSettings();
    if (settings.debugRetention !== "failures") return { deleted: false, reclaimedBytes: 0 };
    return removeRunDebugDirectory(debugRoot, run.debugDir);
  }

  async maybeCleanupExpiredDebug(reason: "startup" | "run-finished" | "manual", force = false): Promise<DebugCleanupResult> {
    if (this.debugCleanupPromise) return this.debugCleanupPromise;
    // Assign the single-flight promise before the first await. This prevents two
    // batch completions in the same tick from both passing the due check and
    // starting duplicate directory scans.
    const task = this.checkAndPerformDebugCleanup(reason, force);
    this.debugCleanupPromise = task;
    try {
      return await task;
    } finally {
      if (this.debugCleanupPromise === task) this.debugCleanupPromise = undefined;
    }
  }

  private async checkAndPerformDebugCleanup(reason: "startup" | "run-finished" | "manual", force: boolean): Promise<DebugCleanupResult> {
    const current = await this.getDebugCleanupStatus();
    if (!force && !isDebugCleanupDue(current.lastCompletedAt)) {
      return { ...current, skipped: "not-due", running: false };
    }
    return this.performDebugCleanup(reason);
  }

  private async performDebugCleanup(reason: "startup" | "run-finished" | "manual"): Promise<DebugCleanupResult> {
    const attemptAt = new Date().toISOString();
    const settings = await this.getSettings();
    const retentionDays = clampSystemInteger(settings.retentionDays, 1, 365, 30);
    const debugRetention = settings.debugRetention === "all" ? "all" : "failures";
    try {
      const sweep = await sweepExpiredDebug({
        debugRoot,
        runs: await this.listRuns(),
        retentionDays
      });
      const completedAt = new Date().toISOString();
      const stored: DebugCleanupStatus = {
        lastAttemptAt: attemptAt,
        lastCompletedAt: completedAt,
        nextEligibleAt: nextDebugCleanupEligibleAt(completedAt),
        lastReason: reason,
        deletedRuns: sweep.deletedRuns,
        reclaimedBytes: sweep.reclaimedBytes,
        retentionDays,
        debugRetention,
        running: false
      };
      await writeJsonAtomic(debugCleanupStatusPath, stored);
      return stored;
    } catch (error) {
      const previous = await this.getDebugCleanupStatus();
      const failed: DebugCleanupStatus = {
        ...previous,
        lastAttemptAt: attemptAt,
        lastReason: reason,
        retentionDays,
        debugRetention,
        lastError: formatFileError(error),
        running: false
      };
      await writeJsonAtomic(debugCleanupStatusPath, failed).catch(() => undefined);
      throw error;
    }
  }

  getRootDir(): string {
    return rootDir;
  }
}


function normalizeSystemSettings(value: Record<string, unknown>, previous?: Record<string, unknown>): Record<string, unknown> {
  const previousAI = isSettingsRecord(previous?.ai) ? previous?.ai as unknown as AISettings : undefined;
  return {
    ...(previous ?? {}),
    ...value,
    theme: ["system", "light", "dark"].includes(String(value.theme ?? previous?.theme ?? "system")) ? String(value.theme ?? previous?.theme ?? "system") : "system",
    retentionDays: clampSystemInteger(value.retentionDays ?? previous?.retentionDays, 1, 365, 30),
    defaultDownloadDir: String(value.defaultDownloadDir ?? previous?.defaultDownloadDir ?? "./downloads").trim() || "./downloads",
    // Retain the old response field for compatibility; it is no longer configurable.
    autoOpenBrowser: true,
    debugRetention: String(value.debugRetention ?? previous?.debugRetention ?? "failures") === "all" ? "all" : "failures",
    runHistoryRetentionDays: clampSystemInteger(value.runHistoryRetentionDays ?? previous?.runHistoryRetentionDays, 1, 365, 30),
    issueReportEmail: String(value.issueReportEmail ?? previous?.issueReportEmail ?? process.env.AUTOMATION_STUDIO_SUPPORT_EMAIL ?? "").trim(),
    ai: normalizeAISettings(value.ai, previousAI)
  };
}

function normalizeAISettings(value: unknown, previous?: AISettings): AISettings {
  const raw = isSettingsRecord(value) ? value : {};
  const incomingProviders = Array.isArray(raw.providers) ? raw.providers.filter(isSettingsRecord) : [];
  const previousProviders = previous?.providers ?? [];
  const providers: AIProviderConfig[] = DEFAULT_AI_SETTINGS.providers.map((fallback) => {
    const incoming = incomingProviders.find((provider) => String(provider.id ?? "") === fallback.id) ?? {};
    const prior = previousProviders.find((provider) => provider.id === fallback.id);
    const authModeRaw = String(incoming.authMode ?? prior?.authMode ?? fallback.authMode ?? "none");
    const authMode = ["none", "api_key", "bearer_token", "custom_header"].includes(authModeRaw) ? authModeRaw as AIProviderConfig["authMode"] : fallback.authMode;
    const secretRaw = isSettingsRecord(incoming.secret) ? incoming.secret : {};
    const source = String(secretRaw.source ?? prior?.secret?.source ?? fallback.secret?.source ?? "env") === "inline" ? "inline" : "env";
    const incomingInline = source === "inline" ? String(secretRaw.value ?? "").trim() : "";
    const preservedInline = source === "inline" && prior?.secret?.source === "inline" ? prior.secret.value : undefined;
    const secret = source === "inline"
      ? { source: "inline" as const, value: incomingInline || preservedInline }
      : { source: "env" as const, envName: String(secretRaw.envName ?? prior?.secret?.envName ?? fallback.secret?.envName ?? "").trim() };
    const apiKeyHeader = fallback.kind === "gemini"
      ? "x-goog-api-key"
      : String(incoming.apiKeyHeader ?? prior?.apiKeyHeader ?? fallback.apiKeyHeader ?? "x-api-key").trim() || "x-api-key";
    return {
      ...fallback,
      ...prior,
      id: fallback.id,
      kind: fallback.kind,
      name: String(incoming.name ?? prior?.name ?? fallback.name),
      enabled: incoming.enabled === true,
      endpoint: String(incoming.endpoint ?? prior?.endpoint ?? fallback.endpoint).trim(),
      model: String(incoming.model ?? prior?.model ?? fallback.model ?? "").trim() || undefined,
      timeoutMs: clampSystemInteger(incoming.timeoutMs ?? prior?.timeoutMs ?? fallback.timeoutMs, 1000, 300000, fallback.timeoutMs ?? 60000),
      authMode,
      secret,
      apiKeyHeader,
      customHeaderName: String(incoming.customHeaderName ?? prior?.customHeaderName ?? fallback.customHeaderName ?? "").trim() || undefined,
      extraHeaders: isSettingsRecord(incoming.extraHeaders) ? Object.fromEntries(Object.entries(incoming.extraHeaders).map(([key,val]) => [key, String(val)])) : prior?.extraHeaders
    };
  });
  const requestedActive = String(raw.activeProviderId ?? previous?.activeProviderId ?? "").trim();
  return {
    enabled: raw.enabled === true,
    activeProviderId: providers.some((provider) => provider.id === requestedActive) ? requestedActive : (providers.find((provider) => provider.enabled)?.id ?? providers[0]?.id),
    providers
  };
}

function isSettingsRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clampSystemInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

export function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Imports are independent copies: never grow or trust the source project's ID. */
export function createImportedProject(input: Partial<WorkflowProject> = {}): WorkflowProject {
  return createDefaultProject({
    ...input,
    id: `workflow-import-${randomUUID()}`,
    name: `${input.name ?? "匯入專案"}（匯入）`
  });
}

export function createDefaultProject(input: Partial<WorkflowProject> = {}): WorkflowProject {
  const now = new Date().toISOString();
  const name = String(input.name ?? "未命名自動化專案").trim() || "未命名自動化專案";
  return normalizeProject({
    id: input.id ?? slugify(name),
    name,
    description: input.description ?? "",
    releaseNotes: input.releaseNotes ?? input.description ?? "",
    version: input.version ?? "1.0.0",
    status: input.status ?? "draft",
    targetUrl: input.targetUrl ?? "https://example.com",
    allowedDomains: input.allowedDomains ?? domainList(input.targetUrl ?? "https://example.com"),
    adapter: input.adapter ?? "generic",
    browser: input.browser ?? {
      connectionMode: "managed",
      channel: "bundled",
      headless: false,
      stealth: false,
      slowMoMs: 100,
      defaultTimeoutMs: 30_000,
      downloadTimeoutMs: 60_000,
      viewportWidth: 1440,
      viewportHeight: 900,
      reuseProfile: true,
      downloadPdfInsteadOfPreview: false,
      cdpEndpoint: "http://127.0.0.1:9222",
      cdpAutoLaunch: true,
      cdpInitialPageMode: "first",
      cdpInitialPageTarget: "",
      cdpInitialPageIndex: 1
    },
    settings: input.settings ?? {
      maxRetries: 1,
      safePlayback: true,
      humanizedPlayback: false,
      minStepDelayMs: 2_000,
      screenshotMode: "failure",
      saveHtmlOnFailure: true,
      captureConsole: true,
      captureNetwork: true,
      defaultConcurrency: 1
    },
    parameters: normalizeParameters(input.parameters),
    steps: input.steps ?? [],
    tags: input.tags ?? [],
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    lastRunAt: input.lastRunAt,
    lastRunStatus: input.lastRunStatus
  });
}

function normalizeProject(project: WorkflowProject): WorkflowProject {
  const id = safeId(project.id || slugify(project.name));
  return {
    ...project,
    id,
    name: String(project.name || "未命名自動化專案"),
    releaseNotes: typeof project.releaseNotes === "string" ? project.releaseNotes : String(project.description ?? ""),
    version: String(project.version || "1.0.0"),
    allowedDomains: Array.from(new Set((project.allowedDomains ?? []).map(String).filter(Boolean))),
    browser: normalizeBrowserSettings(project.browser),
    settings: normalizeSettings(project.settings),
    parameters: normalizeParameters(project.parameters),
    steps: upgradeRecordedSteps(Array.isArray(project.steps) ? project.steps : []),
    tags: Array.isArray(project.tags) ? project.tags : [],
    updatedAt: new Date().toISOString()
  };
}

function normalizeParameters(parameters: WorkflowParameter[] | undefined): WorkflowParameter[] {
  if (!Array.isArray(parameters)) return [];
  const used = new Set<string>();
  return parameters.map((raw, index) => {
    const parameter = (raw ?? {}) as WorkflowParameter;
    const name = String(parameter.name || `parameter_${index + 1}`).trim() || `parameter_${index + 1}`;
    const explicitId = String(parameter.id || "").trim();
    const base = safeId(explicitId || `p-${name}`) || `p-parameter-${index + 1}`;
    let id = base;
    let suffix = 2;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id);
    return {
      ...parameter,
      id,
      name,
      label: String(parameter.label || name),
      type: ["text", "number", "date", "boolean", "select", "secret"].includes(String(parameter.type)) ? parameter.type : "text",
      required: parameter.required === true,
      sensitive: parameter.sensitive === true || parameter.type === "secret",
      options: Array.isArray(parameter.options) ? parameter.options.map(String) : [],
      dependsOn: typeof parameter.dependsOn === "string" ? parameter.dependsOn.trim() : undefined,
      dependentOptions: parameter.dependentOptions && typeof parameter.dependentOptions === "object"
        ? Object.fromEntries(Object.entries(parameter.dependentOptions).map(([key, values]) => [String(key), Array.isArray(values) ? values.map(String) : []]))
        : undefined
    } as WorkflowParameter;
  });
}

function normalizeBrowserSettings(browser: WorkflowProject["browser"] | undefined): WorkflowProject["browser"] {
  const raw = browser ?? ({} as WorkflowProject["browser"]);
  const mode = raw.connectionMode === "cdp" ? "cdp" : "managed";
  const pageMode = raw.cdpInitialPageMode === "url" || raw.cdpInitialPageMode === "index" ? raw.cdpInitialPageMode : "first";
  return {
    connectionMode: mode,
    channel: raw.channel === "chrome" ? "chrome" : "bundled",
    headless: raw.headless === true,
    slowMoMs: Number.isFinite(Number(raw.slowMoMs)) ? Math.max(0, Number(raw.slowMoMs)) : 100,
    defaultTimeoutMs: Number.isFinite(Number(raw.defaultTimeoutMs)) ? Math.max(1000, Number(raw.defaultTimeoutMs)) : 30_000,
    downloadTimeoutMs: Number.isFinite(Number(raw.downloadTimeoutMs)) ? Math.max(1000, Number(raw.downloadTimeoutMs)) : 60_000,
    viewportWidth: Number.isFinite(Number(raw.viewportWidth)) ? Math.max(320, Number(raw.viewportWidth)) : 1440,
    viewportHeight: Number.isFinite(Number(raw.viewportHeight)) ? Math.max(240, Number(raw.viewportHeight)) : 900,
    stealth: raw.stealth === true,
    reuseProfile: raw.reuseProfile !== false,
    downloadPdfInsteadOfPreview: raw.downloadPdfInsteadOfPreview === true,
    cdpEndpoint: String(raw.cdpEndpoint || "http://127.0.0.1:9222").trim(),
    cdpAutoLaunch: raw.cdpAutoLaunch !== false,
    cdpInitialPageMode: pageMode,
    cdpInitialPageTarget: String(raw.cdpInitialPageTarget || ""),
    cdpInitialPageIndex: Number.isFinite(Number(raw.cdpInitialPageIndex)) ? Math.max(1, Math.trunc(Number(raw.cdpInitialPageIndex))) : 1
  };
}

// Upgrade older recordings that used a fixed 500 ms post-click wait. The next
// recorded CSS selector is a safer ready condition for search-result and
// article-navigation flows, including projects created before this release.
function upgradeRecordedSteps(steps: WorkflowStep[]): WorkflowStep[] {
  const meaningfulSteps = steps.filter((step, index, list) => {
    if (isRecordedStep(step) && step.kind === "hover" && !isRelatedRecordedHover(step, list[index + 1])) return false;
    // V1.1.3 could record SmartKMS hidden backing fields as a fill after a
    // visible filter interaction. These fields are not user-operable and the
    // executor intentionally ignores hidden controls, so drop the known legacy
    // backing-field artifact when it has no usable selector.
    const recordedLabel = step.name.replace(/^\d+\.\s*/, "").trim();
    if (isRecordedStep(step) && step.kind === "fill" && !(step.selectors?.length) && recordedLabel === "form.allText") return false;
    return true;
  });
  return meaningfulSteps.map((step, index, list) => {
    const recoveredSelectors = recoverRecordedStepSelectors(step);
    const nextCss = preferredRecordedCss(list[index + 1]);
    const downloadUpgrade = isRecordedDownloadClick(step);
    const articleDownloadCorrection = isRecordedArticleNavigationDownload(step);
    const shouldUpgrade = step.kind === "click"
      && step.waitAfter?.kind === "timeout"
      && (step.waitAfter.timeoutMs ?? 0) <= 500
      && Boolean(nextCss);
    const waitsForOwnClickTarget = isRecordedStep(step)
      && step.kind === "click"
      && step.waitAfter?.kind === "visible"
      && Boolean(nextCss)
      && step.selectors?.some((rule) => rule.strategy === "css" && rule.value === step.waitAfter?.value);
    return {
      ...step,
      ...(recoveredSelectors ? { selectors: recoveredSelectors } : {}),
      ...(downloadUpgrade
        ? { kind: "download" as const, waitAfter: undefined }
        : articleDownloadCorrection
          ? { kind: "click" as const, waitAfter: nextCss ? { kind: "visible" as const, value: nextCss, timeoutMs: 10_000 } : undefined }
          : shouldUpgrade || waitsForOwnClickTarget
            ? { waitAfter: { kind: "visible" as const, value: nextCss, timeoutMs: 10_000 } }
            : {}),
      thenSteps: step.thenSteps ? upgradeRecordedSteps(step.thenSteps) : undefined,
      elseSteps: step.elseSteps ? upgradeRecordedSteps(step.elseSteps) : undefined,
      steps: step.steps ? upgradeRecordedSteps(step.steps) : undefined
    };
  });
}

function recoverRecordedStepSelectors(step: WorkflowStep): WorkflowStep["selectors"] | undefined {
  if ((step.selectors?.length ?? 0) > 0 || !/^\d+\.\s/.test(step.name)) return step.selectors;
  if (!["click", "dblclick", "download", "fill", "select", "check", "uncheck", "hover"].includes(step.kind)) return step.selectors;
  const label = step.name.replace(/^\d+\.\s*/, "").replace(/\s+/g, " ").trim();
  if (!label) return step.selectors;
  const selectors: NonNullable<WorkflowStep["selectors"]> = [];
  if (/^[A-Za-z_][A-Za-z0-9_.:-]{1,120}$/.test(label)) {
    selectors.push({ strategy: "name", value: label, description: "由舊錄製步驟名稱復原 name selector" });
    if (!label.includes(".")) selectors.push({ strategy: "css", value: `[id="${label.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]:visible`, description: "由舊錄製步驟名稱復原 id selector" });
  }
  if (label.length <= 600 && !/^(?:a|div|span|td|tr|button|input)$/i.test(label)) {
    selectors.push({ strategy: "text", value: label, exact: true, description: "由舊錄製步驟文字復原 selector" });
  }
  return selectors.length ? selectors : step.selectors;
}

function isRecordedStep(step: WorkflowStep): boolean {
  return /^\d+\.\s/.test(step.name) || Boolean(step.selectors?.some((rule) => /錄製|Google (?:站內)?搜尋/.test(rule.description ?? "")));
}

function preferredRecordedCss(step: WorkflowStep | undefined): string | undefined {
  const css = step?.selectors?.filter((rule) => rule.strategy === "css") ?? [];
  return css.find((rule) => /\[title=/.test(rule.value) && !/google\.[a-z.]+\/url\?/i.test(rule.value))?.value
    ?? css.find((rule) => !/Google 站內搜尋/.test(rule.description ?? ""))?.value
    ?? css[0]?.value;
}

function isRelatedRecordedHover(step: WorkflowStep, next: WorkflowStep | undefined): boolean {
  if (!next || next.kind === "hover") return false;
  const currentCss = step.selectors?.filter((rule) => rule.strategy === "css").map((rule) => rule.value) ?? [];
  const nextCss = next.selectors?.filter((rule) => rule.strategy === "css").map((rule) => rule.value) ?? [];
  if (currentCss.some((value) => nextCss.includes(value))) return true;
  const current = currentCss.join(" ");
  const target = nextCss.join(" ");
  if (/aria-haspopup\s*=|\[aria-haspopup/i.test(current)) return true;
  if (/\[data-groupsn=/.test(current) && /\[data-groupsn=/.test(target)) return true;
  return /href=["'][^"']*cl\.aspx/i.test(current) && /href=["'][^"']*cl\.aspx/i.test(target);
}

function isRecordedArticleNavigationDownload(step: WorkflowStep): boolean {
  if (step.kind !== "download" || !isRecordedStep(step)) return false;
  const values = step.selectors?.map((rule) => rule.value).join(" ") ?? "";
  const strongDownloadSignal = /\.pdf(?:["'\]?#]|$)|\/Download\.ashx|\/File\/Doc|\[download(?:[\]=])/i.test(values)
    || /(?:^|\s)\[?pdf\]?(?:\s|$)/i.test(step.name.replace(/^\d+\.\s*/, ""));
  return !strongDownloadSignal && /News_Content\.aspx|News_Content\.aspx%3F/i.test(values);
}

function isRecordedDownloadClick(step: WorkflowStep): boolean {
  if (step.kind !== "click") return false;
  if (/^\s*\[?pdf\]?\s*$/i.test(step.name.replace(/^\d+\.\s*/, ""))) return true;
  return Boolean(step.selectors?.some((rule) =>
    rule.strategy === "css" && (
      /\.pdf(?:["'\]?#]|$)/i.test(rule.value)
      || /\/(?:File\/Doc|download|attachment)(?:\/|\?|["'])/i.test(rule.value)
      || /\[download(?:[\]=])/i.test(rule.value)
    )
  ));
}

function normalizeSettings(settings: Partial<WorkflowSettings> | undefined): WorkflowSettings {
  return {
    maxRetries: 1,
    safePlayback: true,
    humanizedPlayback: false,
    minStepDelayMs: 2_000,
    screenshotMode: "failure",
    saveHtmlOnFailure: true,
    captureConsole: true,
    captureNetwork: true,
    ...settings,
    defaultConcurrency: normalizeBatchConcurrency(settings?.defaultConcurrency)
  };
}

function safeId(value: string): string {
  const id = String(value).trim();
  if (!id) throw new Error("識別碼不可為空白。");
  if (id.length > 120) throw new Error(`識別碼長度不可超過 120 個字元（目前 ${id.length} 個字元）。`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
    throw new Error("識別碼必須以英數字開頭，且只能包含英數字、句點、底線與連字號。");
  }
  return id;
}

function slugify(value: string): string {
  const ascii = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${ascii || "workflow"}-${Date.now().toString(36)}`;
}

function domainList(url: string): string[] {
  try {
    return [new URL(url).hostname];
  } catch {
    return [];
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  // Snapshot before waiting in the per-file queue. WorkflowRun is mutable and
  // can continue changing while an earlier disk write is still in progress.
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await enqueueJsonWrite(filePath, async () => {
    const sequence = ++atomicWriteSequence;
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${sequence}.tmp`;
    try {
      await fs.writeFile(tempPath, body, "utf8");
      await renameWithRetry(tempPath, filePath);
    } finally {
      // If rename succeeds the temp path no longer exists. If it fails, clean
      // up best-effort so stale *.tmp files do not accumulate indefinitely.
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
  });
}

async function enqueueJsonWrite(filePath: string, task: () => Promise<void>): Promise<void> {
  const previous = jsonWriteQueues.get(filePath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  jsonWriteQueues.set(filePath, current);
  void current.finally(() => {
    if (jsonWriteQueues.get(filePath) === current) jsonWriteQueues.delete(filePath);
  }).catch(() => undefined);
  await current;
}

async function renameWithRetry(source: string, target: string, retries = 8): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await fs.rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      const code = fileErrorCode(error);
      if (!WINDOWS_RENAME_RETRY_CODES.has(code) || attempt >= retries) throw error;
      const delayMs = Math.min(50 * (2 ** attempt), 1_000);
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

function fileErrorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "";
  return String((error as { code?: unknown }).code ?? "");
}

function formatFileError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

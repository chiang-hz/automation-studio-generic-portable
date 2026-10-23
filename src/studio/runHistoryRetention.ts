import fs from "node:fs/promises";
import path from "node:path";
import type { WorkflowRun } from "./types.ts";

export const RUN_HISTORY_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DELETABLE_STATUSES = new Set(["completed", "failed", "cancelled"]);

export interface RunHistoryUsage {
  runCount: number;
  statusCounts: Record<string, number>;
  runRecordBytes: number;
  debugBytes: number;
  totalBytes: number;
}

export interface RunHistorySweepCandidates {
  runIds: string[];
  protectedRuns: number;
}

export function isRunHistoryCleanupDue(lastCompletedAt: string | undefined, nowMs = Date.now()): boolean {
  if (!lastCompletedAt) return true;
  const last = Date.parse(lastCompletedAt);
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= RUN_HISTORY_CLEANUP_INTERVAL_MS;
}

export function nextRunHistoryCleanupEligibleAt(lastCompletedAt: string | undefined): string | undefined {
  if (!lastCompletedAt) return undefined;
  const last = Date.parse(lastCompletedAt);
  if (!Number.isFinite(last)) return undefined;
  return new Date(last + RUN_HISTORY_CLEANUP_INTERVAL_MS).toISOString();
}

export function isRunHistoryDeletable(status: unknown): boolean {
  return DELETABLE_STATUSES.has(String(status ?? ""));
}

export function findExpiredRunHistory(input: {
  runs: WorkflowRun[];
  retentionDays: number;
  nowMs?: number;
}): RunHistorySweepCandidates {
  const nowMs = input.nowMs ?? Date.now();
  const retentionDays = Math.max(1, Math.trunc(Number(input.retentionDays) || 30));
  const thresholdMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const runIds: string[] = [];
  let protectedRuns = 0;
  for (const run of input.runs) {
    if (!isRunHistoryDeletable(run.status)) {
      protectedRuns += 1;
      continue;
    }
    const timestamp = Date.parse(run.endedAt ?? run.updatedAt ?? run.startedAt);
    if (Number.isFinite(timestamp) && timestamp < thresholdMs) runIds.push(run.id);
  }
  return { runIds, protectedRuns };
}

export async function calculateRunHistoryUsage(input: {
  runsDir: string;
  debugRoot: string;
  runs: WorkflowRun[];
}): Promise<RunHistoryUsage> {
  const statusCounts: Record<string, number> = {};
  const debugPaths = new Set<string>();
  let runRecordBytes = 0;
  const debugRoot = path.resolve(input.debugRoot);
  for (const run of input.runs) {
    statusCounts[run.status] = (statusCounts[run.status] ?? 0) + 1;
    let id: string;
    try {
      id = safeRunId(run.id);
    } catch {
      // A malformed legacy record should not make the whole history summary unavailable.
      continue;
    }
    try {
      runRecordBytes += (await fs.stat(path.join(input.runsDir, `${id}.json`))).size;
    } catch {
      // The history list may race a concurrent cleanup; missing records count as zero.
    }
    const debugPath = safeDebugPath(debugRoot, run.debugDir);
    if (debugPath) debugPaths.add(debugPath);
  }
  let debugBytes = 0;
  for (const debugPath of debugPaths) debugBytes += await directorySize(debugPath);
  return {
    runCount: input.runs.length,
    statusCounts,
    runRecordBytes,
    debugBytes,
    totalBytes: runRecordBytes + debugBytes
  };
}

export async function hasRunDiagnosticData(run: WorkflowRun, debugRoot: string): Promise<boolean> {
  const safe = safeDebugPath(path.resolve(debugRoot), run.debugDir);
  if (!safe || run.status !== "failed") return false;
  try {
    const entries = await fs.readdir(safe, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() || entry.isDirectory());
  } catch {
    return false;
  }
}

export function safeRunRecordPath(runsDir: string, runId: string): string {
  return path.join(runsDir, `${safeRunId(runId)}.json`);
}

export function safeDebugDirectory(debugRoot: string, debugDir: string): string | undefined {
  return safeDebugPath(path.resolve(debugRoot), debugDir);
}

function safeRunId(value: string): string {
  const id = String(value ?? "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(id)) throw new Error("執行紀錄識別碼無效。");
  return id;
}

function safeDebugPath(root: string, raw: string): string | undefined {
  const resolved = path.resolve(String(raw ?? ""));
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) return undefined;
  return resolved;
}

async function directorySize(directory: string): Promise<number> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    try {
      if (entry.isDirectory()) total += await directorySize(target);
      else if (entry.isFile()) total += (await fs.stat(target)).size;
    } catch {
      // Best effort: concurrently removed files contribute zero bytes.
    }
  }
  return total;
}

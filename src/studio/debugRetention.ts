import fs from "node:fs/promises";
import path from "node:path";
import type { WorkflowRun } from "./types.ts";

export const DEBUG_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export interface DebugCleanupSweepResult {
  deletedRuns: number;
  reclaimedBytes: number;
  deletedPaths: string[];
}

export function isDebugCleanupDue(lastCompletedAt: string | undefined, nowMs = Date.now()): boolean {
  if (!lastCompletedAt) return true;
  const last = Date.parse(lastCompletedAt);
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= DEBUG_CLEANUP_INTERVAL_MS;
}

export function nextDebugCleanupEligibleAt(lastCompletedAt: string | undefined): string | undefined {
  if (!lastCompletedAt) return undefined;
  const last = Date.parse(lastCompletedAt);
  if (!Number.isFinite(last)) return undefined;
  return new Date(last + DEBUG_CLEANUP_INTERVAL_MS).toISOString();
}

export async function removeRunDebugDirectory(debugRoot: string, debugDir: string): Promise<{ deleted: boolean; reclaimedBytes: number }> {
  const safe = resolveSafeDebugPath(debugRoot, debugDir);
  if (!safe) return { deleted: false, reclaimedBytes: 0 };
  try {
    const stat = await fs.stat(safe);
    if (!stat.isDirectory()) return { deleted: false, reclaimedBytes: 0 };
  } catch {
    return { deleted: false, reclaimedBytes: 0 };
  }
  const reclaimedBytes = await directorySize(safe);
  await fs.rm(safe, { recursive: true, force: true });
  await removeEmptyParents(path.resolve(debugRoot), path.dirname(safe));
  return { deleted: true, reclaimedBytes };
}

export async function sweepExpiredDebug(input: {
  debugRoot: string;
  runs: WorkflowRun[];
  retentionDays: number;
  nowMs?: number;
}): Promise<DebugCleanupSweepResult> {
  const root = path.resolve(input.debugRoot);
  const nowMs = input.nowMs ?? Date.now();
  const thresholdMs = nowMs - Math.max(1, Math.trunc(input.retentionDays)) * 24 * 60 * 60 * 1000;
  const knownPaths = new Set<string>();
  const protectedPaths = new Set<string>();
  const candidates = new Set<string>();

  for (const run of input.runs) {
    const safe = resolveSafeDebugPath(root, run.debugDir);
    if (!safe) continue;
    knownPaths.add(safe);
    if (!TERMINAL_STATUSES.has(run.status)) {
      protectedPaths.add(safe);
      continue;
    }
    if (!run.endedAt) continue;
    const ended = Date.parse(run.endedAt);
    if (Number.isFinite(ended) && ended < thresholdMs) candidates.add(safe);
  }

  // Also clear orphaned run folders from older releases or interrupted run-history writes.
  // Only folders named run-* and older than the retention threshold qualify.
  for (const orphan of await listOrphanRunDirectories(root, knownPaths, thresholdMs)) {
    if (!protectedPaths.has(orphan)) candidates.add(orphan);
  }

  let deletedRuns = 0;
  let reclaimedBytes = 0;
  const deletedPaths: string[] = [];
  for (const candidate of candidates) {
    if (protectedPaths.has(candidate)) continue;
    const result = await removeRunDebugDirectory(root, candidate);
    if (!result.deleted) continue;
    deletedRuns += 1;
    reclaimedBytes += result.reclaimedBytes;
    deletedPaths.push(candidate);
  }
  return { deletedRuns, reclaimedBytes, deletedPaths };
}

function resolveSafeDebugPath(debugRoot: string, debugDir: string): string | undefined {
  const root = path.resolve(debugRoot);
  const resolved = path.resolve(debugDir);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) return undefined;
  return resolved;
}

async function listOrphanRunDirectories(root: string, knownPaths: Set<string>, thresholdMs: number): Promise<string[]> {
  const result: string[] = [];
  let projectEntries: import("node:fs").Dirent[];
  try {
    projectEntries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;
    const projectDir = path.join(root, projectEntry.name);
    let runEntries: import("node:fs").Dirent[];
    try {
      runEntries = await fs.readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const runEntry of runEntries) {
      if (!runEntry.isDirectory() || !runEntry.name.startsWith("run-")) continue;
      const runDir = path.resolve(projectDir, runEntry.name);
      if (knownPaths.has(runDir)) continue;
      try {
        const stat = await fs.stat(runDir);
        if (stat.mtimeMs < thresholdMs) result.push(runDir);
      } catch {
        // Ignore folders disappearing during cleanup.
      }
    }
  }
  return result;
}

async function directorySize(directory: string): Promise<number> {
  let total = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    try {
      if (entry.isDirectory()) total += await directorySize(target);
      else if (entry.isFile()) total += (await fs.stat(target)).size;
    } catch {
      // Best effort only. A concurrently removed file contributes zero bytes.
    }
  }
  return total;
}

async function removeEmptyParents(root: string, start: string): Promise<void> {
  let current = path.resolve(start);
  while (current !== root && current.startsWith(`${root}${path.sep}`)) {
    try {
      const entries = await fs.readdir(current);
      if (entries.length) break;
      await fs.rmdir(current);
      current = path.dirname(current);
    } catch {
      break;
    }
  }
}

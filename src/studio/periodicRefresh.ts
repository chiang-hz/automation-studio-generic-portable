import type { WorkflowStep } from "./types.ts";

export const MIN_REFRESH_INTERVAL_SECONDS = 5;
export const MAX_REFRESH_INTERVAL_SECONDS = 600;

export function refreshIntervalMs(step: Pick<WorkflowStep, "periodicRefresh" | "refreshIntervalSeconds">): number {
  if (step.periodicRefresh !== true) return 0;
  const seconds = Number(step.refreshIntervalSeconds ?? 10);
  if (!Number.isInteger(seconds) || seconds < MIN_REFRESH_INTERVAL_SECONDS || seconds > MAX_REFRESH_INTERVAL_SECONDS) {
    throw new Error(`定期重新整理間隔必須為 ${MIN_REFRESH_INTERVAL_SECONDS}～${MAX_REFRESH_INTERVAL_SECONDS} 秒的整數。`);
  }
  return seconds * 1_000;
}

/** Reload at most once per interval, preserving the original workflow snapshot and active tab. */
export function createPeriodicPageRefresher(
  page: { reload: (options: { waitUntil: "domcontentloaded"; timeout: number }) => Promise<unknown> },
  step: Pick<WorkflowStep, "periodicRefresh" | "refreshIntervalSeconds">,
  deadline: number,
  now: () => number = Date.now
): { refreshIfDue: () => Promise<boolean>; count: () => number } {
  const interval = refreshIntervalMs(step);
  let nextReloadAt = interval ? now() + interval : Number.POSITIVE_INFINITY;
  let reloadCount = 0;
  return {
    count: () => reloadCount,
    async refreshIfDue() {
      if (!interval || now() < nextReloadAt || now() >= deadline) return false;
      const remaining = deadline - now();
      if (remaining <= 0) return false;
      try {
        await page.reload({ waitUntil: "domcontentloaded", timeout: Math.min(15_000, Math.max(1, remaining)) });
        reloadCount += 1;
      } finally {
        // A slow reload must not cause an immediate second reload.
        nextReloadAt = now() + interval;
      }
      return true;
    }
  };
}

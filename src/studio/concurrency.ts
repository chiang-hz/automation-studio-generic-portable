export const MAX_BATCH_CONCURRENCY = 3;

export function normalizeBatchConcurrency(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.min(MAX_BATCH_CONCURRENCY, Math.floor(number))) : 1;
}

export function effectiveBatchConcurrency(project: {
  browser: { connectionMode?: string };
  settings: { defaultConcurrency?: number };
}): number {
  return project.browser.connectionMode === "cdp" ? 1 : normalizeBatchConcurrency(project.settings.defaultConcurrency);
}

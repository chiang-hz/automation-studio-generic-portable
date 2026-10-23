import fs from "node:fs/promises";
import crypto from "node:crypto";
import { ErrorCodes, FlowError } from "../domain/errors.ts";
import { TaskStore } from "../domain/taskStore.ts";
import type {
  BatchDownloadItem,
  BatchDownloadItemInput,
  BatchDownloadResult,
  BatchDownloadTask,
  BatchDownloadTaskStatus,
  DownloadTask,
  ParsedReport,
  ReportId,
  ReportParameterDefinition,
  ReportParameters
} from "../domain/types.ts";
import type { ReportAdapter } from "../adapters/reportAdapter.ts";
import { parseDownloadedReport } from "../parsers/reportParser.ts";

import { normalizeBrowserMode, type BrowserMode } from "../domain/browserMode.ts";

export interface CreateDownloadTaskOptions {
  browserMode?: BrowserMode;
  debugEnabled?: boolean;
}

export interface CreateBatchDownloadTaskOptions extends CreateDownloadTaskOptions {
  continueOnError?: boolean;
  parallelism?: number;
  retryEnabled?: boolean;
  maxRetries?: number;
  retryDelaySeconds?: number;
  workerStorageStatePaths?: Record<string, string>;
}

export class ReportService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly adapter: ReportAdapter;
  private readonly taskStore: TaskStore;
  private readonly batchTasks = new Map<string, BatchDownloadTask>();
  private readonly parsedReportCache = new Map<string, CachedParsedReport>();

  constructor(
    adapter: ReportAdapter,
    taskStore: TaskStore
  ) {
    this.adapter = adapter;
    this.taskStore = taskStore;
  }

  listReports() {
    return this.adapter.listReports();
  }

  async getReportParameters(reportId: string): Promise<ReportParameterDefinition[]> {
    return this.adapter.getReportParameters(reportId);
  }

  async createDownloadTask(
    reportId: string,
    parameters: ReportParameters,
    options: CreateDownloadTaskOptions = {}
  ): Promise<DownloadTask> {
    const browserMode = normalizeBrowserMode(options.browserMode);
    const definitions = await this.adapter.getReportParameters(reportId);
    const normalizedParameters = this.applyParameterDefaults(definitions, parameters);
    this.validateParameters(definitions, normalizedParameters);

    const now = new Date().toISOString();
    const task = this.taskStore.create({
      id: crypto.randomUUID(),
      reportId,
      parameters: normalizedParameters,
      debugEnabled: Boolean(options.debugEnabled),
      browserMode,
      status: "queued",
      createdAt: now,
      updatedAt: now
    });

    this.controllers.set(task.id, new AbortController());
    void this.runDownload(task.id, reportId, normalizedParameters, Boolean(options.debugEnabled), browserMode);
    return task;
  }

  async createBatchDownloadTask(
    items: BatchDownloadItemInput[],
    options: CreateBatchDownloadTaskOptions = {}
  ): Promise<BatchDownloadTask> {
    const browserMode = normalizeBrowserMode(options.browserMode);
    if (!Array.isArray(items) || items.length === 0) {
      throw new FlowError(ErrorCodes.INVALID_PARAMETERS, "Batch download requires at least one item.");
    }

    const normalizedItems: BatchDownloadItemInput[] = [];
    for (const item of items) {
      if (!item.reportId) {
        throw new FlowError(ErrorCodes.INVALID_PARAMETERS, "Each batch item requires reportId.");
      }

      const definitions = await this.adapter.getReportParameters(item.reportId);
      const normalizedParameters = this.applyParameterDefaults(definitions, item.parameters);
      this.validateParameters(definitions, normalizedParameters);
      normalizedItems.push({
        reportId: item.reportId,
        parameters: normalizedParameters
      });
    }

    const now = new Date().toISOString();
    const task: BatchDownloadTask = {
      id: crypto.randomUUID(),
      items: normalizedItems.map((item) => ({
        id: crypto.randomUUID(),
        reportId: item.reportId,
        parameters: item.parameters,
        status: "queued",
        browserMode
      })),
      debugEnabled: Boolean(options.debugEnabled),
      browserMode,
      continueOnError: options.continueOnError !== false,
      parallelism: normalizeParallelism(options.parallelism),
      retryEnabled: options.retryEnabled !== false,
      maxRetries: normalizeRetryCount(options.maxRetries),
      retryDelaySeconds: normalizeRetryDelaySeconds(options.retryDelaySeconds),
      status: "queued",
      createdAt: now,
      updatedAt: now,
      completedCount: 0,
      failedCount: 0,
      skippedCount: 0
    };

    this.controllers.set(task.id, new AbortController());
    this.batchTasks.set(task.id, task);
    void this.runBatchDownload(task.id, options.workerStorageStatePaths ?? {});
    return task;
  }

  cancelDownloadTask(taskId: string): DownloadTask {
    const task = this.getDownloadTask(taskId);
    if (!["queued", "running"].includes(task.status)) return task;
    const next = this.taskStore.update(taskId, { status: "cancelling" })!;
    this.controllers.get(taskId)?.abort();
    return next;
  }

  cancelBatchDownloadTask(taskId: string): BatchDownloadTask {
    const task = this.getBatchDownloadTask(taskId);
    if (!["queued", "running"].includes(task.status)) return task;
    const items = task.items.map(item => ({
      ...item,
      status: item.status === "queued" ? "cancelled" as const
        : ["running", "retrying"].includes(item.status) ? "cancelling" as const : item.status,
      nextRetryAt: undefined
    }));
    const next = this.updateBatchTask(taskId, { status: "cancelling", items, cancelledCount: countItems(items, "cancelled") });
    this.controllers.get(taskId)?.abort();
    return next;
  }

  getDownloadTask(taskId: string): DownloadTask {
    const task = this.taskStore.get(taskId);
    if (!task) {
      throw new FlowError(ErrorCodes.TASK_NOT_FOUND, `Unknown task: ${taskId}`);
    }
    return task;
  }

  getBatchDownloadTask(taskId: string): BatchDownloadTask {
    const task = this.batchTasks.get(taskId);
    if (!task) {
      throw new FlowError(ErrorCodes.TASK_NOT_FOUND, `Unknown batch task: ${taskId}`);
    }
    return task;
  }

  async getDownloadResult(taskId: string): Promise<ParsedReport> {
    const task = this.getDownloadTask(taskId);
    if (task.status !== "completed" || !task.filePath) {
      throw new FlowError(
        ErrorCodes.DOWNLOAD_FAILED,
        `Task ${taskId} is not completed. Current status: ${task.status}`
      );
    }
    return this.getParsedReport(task.filePath);
  }

  getBatchDownloadResult(taskId: string): BatchDownloadResult {
    const task = this.getBatchDownloadTask(taskId);
    if (!["completed", "partial_failed", "failed", "cancelled"].includes(task.status)) {
      throw new FlowError(
        ErrorCodes.DOWNLOAD_FAILED,
        `Batch task ${taskId} is not finished. Current status: ${task.status}`
      );
    }

    return {
      taskId: task.id,
      status: task.status,
      completedCount: task.completedCount,
      failedCount: task.failedCount,
      skippedCount: task.skippedCount,
      cancelledCount: task.cancelledCount ?? 0,
      files: task.items
        .filter((item) => item.status === "completed" && item.filePath)
        .map((item) => ({
          itemId: item.id,
          reportId: item.reportId,
          filePath: item.filePath as string,
          workerId: item.workerId,
          rowCount: item.rowCount,
          debugDir: item.debugDir
        })),
      failedItems: task.items
        .filter((item) => item.status === "failed")
        .map((item) => ({
          itemId: item.id,
          reportId: item.reportId,
          workerId: item.workerId,
          errorCode: item.errorCode,
          errorMessage: item.errorMessage,
          debugDir: item.debugDir
        }))
    };
  }

  parseDownloadFile(filePath: string): Promise<ParsedReport> {
    return this.getParsedReport(filePath);
  }

  private async runBatchDownload(
    taskId: string,
    workerStorageStatePaths: Record<string, string>
  ): Promise<void> {
    const signal = this.controllers.get(taskId)!.signal;
    try {
      this.updateBatchTask(taskId, { status: signal.aborted ? "cancelling" : "running" });
      const initialTask = this.getBatchDownloadTask(taskId);
      const parallelism = normalizeParallelism(initialTask.parallelism);
      const workerIds = parallelism > 1 ? ["A", "B"].slice(0, parallelism) : ["A"];

      if (parallelism <= 1) {
        let stoppedAfterFailure = false;
        for (const item of this.getBatchDownloadTask(taskId).items) {
          if (signal.aborted) { this.updateBatchItem(taskId, item.id, { status: "cancelled", nextRetryAt: undefined }); continue; }
          if (stoppedAfterFailure) {
            this.updateBatchItem(taskId, item.id, { status: "skipped" });
            continue;
          }

          const task = this.getBatchDownloadTask(taskId);
          const workerId = "A";
          const failed = await this.runBatchItem(taskId, item.id, workerId, workerStorageStatePaths[workerId], Boolean(task.debugEnabled));
          if (failed && !task.continueOnError) {
            stoppedAfterFailure = true;
          }
        }
      } else {
        const queue = [...this.getBatchDownloadTask(taskId).items];
        let stopRequested = false;

        const runWorker = async (workerId: string): Promise<void> => {
          while (queue.length > 0) {
            const item = queue.shift();
            if (!item) return;
            const task = this.getBatchDownloadTask(taskId);

            if (signal.aborted) { this.updateBatchItem(taskId, item.id, { status: "cancelled", nextRetryAt: undefined }); continue; }
            if (stopRequested) {
              this.updateBatchItem(taskId, item.id, { status: "skipped" });
              continue;
            }

            const failed = await this.runBatchItem(taskId, item.id, workerId, workerStorageStatePaths[workerId], Boolean(task.debugEnabled));
            if (failed && !task.continueOnError) {
              stopRequested = true;
            }
          }
        };

        await Promise.all(workerIds.map((workerId) => runWorker(workerId)));
      }

      const finalTask = this.getBatchDownloadTask(taskId);
      this.updateBatchTask(taskId, {
        status: signal.aborted ? "cancelled" : finalBatchStatus(finalTask),
        completedCount: countItems(finalTask.items, "completed"),
        failedCount: countItems(finalTask.items, "failed"),
        skippedCount: countItems(finalTask.items, "skipped"),
        cancelledCount: countItems(finalTask.items, "cancelled"),
        errorCode: firstFailedItem(finalTask)?.errorCode,
        errorMessage: firstFailedItem(finalTask)?.errorMessage
      });
    } finally { this.controllers.delete(taskId); }
  }

  private async runBatchItem(
    taskId: string,
    itemId: string,
    workerId: string,
    storageStatePath: string | undefined,
    debugEnabled: boolean
  ): Promise<boolean> {
    const signal = this.controllers.get(taskId)!.signal;
    const taskOptions = this.getBatchDownloadTask(taskId);
    const maxRetries = taskOptions.retryEnabled === false ? 0 : normalizeRetryCount(taskOptions.maxRetries);
    const retryDelaySeconds = normalizeRetryDelaySeconds(taskOptions.retryDelaySeconds);
    let attempt = 0;
    let lastFlowError: FlowError | undefined;

    while (attempt <= maxRetries) {
      if (signal.aborted) { this.updateBatchItem(taskId, itemId, { status: "cancelled", nextRetryAt: undefined }); return false; }
      const item = this.getBatchDownloadTask(taskId).items.find((candidate) => candidate.id === itemId);
      if (!item) return true;

      const status = attempt === 0 ? "running" : "retrying";
      this.updateBatchItem(taskId, itemId, {
        status,
        workerId,
        attempt: attempt + 1,
        retryCount: attempt,
        maxRetries,
        nextRetryAt: undefined,
        errorCode: undefined,
        errorMessage: undefined
      });

      try {
        const reportName = await this.resolveReportName(item.reportId);
        signal.throwIfAborted();
        const output = await this.adapter.downloadReport({
          reportId: item.reportId,
          reportName,
          parameters: item.parameters,
          debugEnabled,
          browserMode: taskOptions.browserMode,
          signal,
          workerId,
          storageStatePath
        });
        const parsed = await this.getParsedReport(output.filePath);

        this.updateBatchItem(taskId, itemId, {
          status: "completed",
          filePath: output.filePath,
          debugDir: output.debugDir,
          rowCount: parsed.rowCount,
          workerId,
          attempt: attempt + 1,
          retryCount: attempt,
          nextRetryAt: undefined,
          errorCode: undefined,
          errorMessage: undefined,
          lastErrorMessage: lastFlowError?.message
        });
        return false;
      } catch (error) {
        if (signal.aborted) {
          this.updateBatchItem(taskId, itemId, { status: "cancelled", nextRetryAt: undefined, errorCode: undefined, errorMessage: undefined });
          return false;
        }
        const flowError = error instanceof FlowError
          ? error
          : new FlowError(ErrorCodes.DOWNLOAD_FAILED, "Unexpected download failure.", error);
        lastFlowError = flowError;

        const canRetry = attempt < maxRetries && isRetryableDownloadError(flowError);
        if (!canRetry) {
          const retrySuffix = maxRetries > 0
            ? ` Attempts: ${attempt + 1}/${maxRetries + 1}.`
            : "";
          this.updateBatchItem(taskId, itemId, {
            status: "failed",
            debugDir: readDebugDir(flowError.details),
            errorCode: flowError.code,
            errorMessage: `${flowError.message}${retrySuffix}`,
            lastErrorMessage: flowError.message,
            workerId,
            attempt: attempt + 1,
            retryCount: attempt,
            maxRetries,
            nextRetryAt: undefined
          });
          return true;
        }

        const nextRetryAt = new Date(Date.now() + retryDelaySeconds * 1000).toISOString();
        this.updateBatchItem(taskId, itemId, {
          status: "retrying",
          debugDir: readDebugDir(flowError.details),
          errorCode: flowError.code,
          errorMessage: `第 ${attempt + 1} 次執行失敗，${retryDelaySeconds} 秒後自動重試。${flowError.message}`,
          lastErrorMessage: flowError.message,
          workerId,
          attempt: attempt + 1,
          retryCount: attempt + 1,
          maxRetries,
          nextRetryAt
        });
        await sleep(retryDelaySeconds * 1000, signal);
        attempt += 1;
      }
    }

    return true;
  }

  private async runDownload(
    taskId: string,
    reportId: ReportId,
    parameters: ReportParameters,
    debugEnabled: boolean,
    browserMode: BrowserMode
  ): Promise<void> {
    const signal = this.controllers.get(taskId)!.signal;
    this.taskStore.update(taskId, { status: signal.aborted ? "cancelling" : "running" });
    let downloaded: { filePath: string; debugDir?: string } | undefined;
    try {
      signal.throwIfAborted();
      const reportName = await this.resolveReportName(reportId);
      signal.throwIfAborted();
      const output = await this.adapter.downloadReport({
        reportId,
        reportName,
        parameters,
        debugEnabled,
        signal,
        browserMode
      });
      downloaded = output;
      const parsed = await this.getParsedReport(output.filePath);

      this.taskStore.update(taskId, {
        status: signal.aborted ? "cancelled" : "completed",
        filePath: output.filePath,
        debugDir: output.debugDir,
        rowCount: parsed.rowCount
      });
    } catch (error) {
      if (signal.aborted) {
        this.taskStore.update(taskId, { status: "cancelled", filePath: downloaded?.filePath, debugDir: downloaded?.debugDir });
        return;
      }
      const flowError = error instanceof FlowError
        ? error
        : new FlowError(ErrorCodes.DOWNLOAD_FAILED, "Unexpected download failure.", error);

      this.taskStore.update(taskId, {
        status: "failed",
        debugDir: readDebugDir(flowError.details),
        errorCode: flowError.code,
        errorMessage: flowError.message
      });
    } finally { this.controllers.delete(taskId); }
  }

  private validateParameters(
    definitions: ReportParameterDefinition[],
    parameters: ReportParameters
  ): void {
    const missing = definitions
      .filter((definition) => definition.required && !parameters[definition.name])
      .map((definition) => definition.name);

    if (missing.length > 0) {
      throw new FlowError(
        ErrorCodes.INVALID_PARAMETERS,
        `Missing required parameters: ${missing.join(", ")}`
      );
    }

    for (const definition of definitions) {
      const value = parameters[definition.name];
      if (!value) continue;

      if (definition.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new FlowError(
          ErrorCodes.INVALID_PARAMETERS,
          `${definition.name} must use YYYY-MM-DD format.`
        );
      }

      if (definition.type === "enum" && definition.options && !definition.options.includes(value)) {
        throw new FlowError(
          ErrorCodes.INVALID_PARAMETERS,
          `${definition.name} must be one of: ${definition.options.join(", ")}`
        );
      }
    }
  }

  private applyParameterDefaults(
    definitions: ReportParameterDefinition[],
    parameters: ReportParameters
  ): ReportParameters {
    const normalized = { ...parameters };
    for (const definition of definitions) {
      if (!normalized[definition.name] && definition.defaultValue !== undefined) {
        normalized[definition.name] = definition.defaultValue;
      }
    }
    return normalized;
  }

  private async resolveReportName(reportId: ReportId): Promise<string> {
    const reports = await this.adapter.listReports();
    return reports.find((report) => report.id === reportId)?.name ?? reportId;
  }

  private async getParsedReport(filePath: string): Promise<ParsedReport> {
    const stat = await fs.stat(filePath);
    const cacheKey = buildParsedReportCacheKey(filePath, stat.size, stat.mtimeMs);
    const cached = this.parsedReportCache.get(cacheKey);
    if (cached) {
      return cached.report;
    }

    this.deleteStaleParsedReportCacheEntries(filePath, cacheKey);
    const report = await parseDownloadedReport(filePath);
    this.parsedReportCache.set(cacheKey, { report });
    return report;
  }

  private deleteStaleParsedReportCacheEntries(filePath: string, keepKey: string): void {
    for (const key of this.parsedReportCache.keys()) {
      if (key !== keepKey && key.startsWith(`${filePath}::`)) {
        this.parsedReportCache.delete(key);
      }
    }
  }

  private updateBatchTask(taskId: string, patch: Partial<BatchDownloadTask>): BatchDownloadTask {
    const current = this.getBatchDownloadTask(taskId);
    const next: BatchDownloadTask = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    this.batchTasks.set(taskId, next);
    return next;
  }

  private updateBatchItem(
    taskId: string,
    itemId: string,
    patch: Partial<BatchDownloadItem>
  ): BatchDownloadTask {
    const current = this.getBatchDownloadTask(taskId);
    const items = current.items.map((item) => item.id === itemId ? { ...item, ...patch } : item);
    const next: BatchDownloadTask = {
      ...current,
      items,
      completedCount: countItems(items, "completed"),
      failedCount: countItems(items, "failed"),
      skippedCount: countItems(items, "skipped"),
      cancelledCount: countItems(items, "cancelled"),
      updatedAt: new Date().toISOString()
    };
    this.batchTasks.set(taskId, next);
    return next;
  }
}

interface CachedParsedReport {
  report: ParsedReport;
}

function normalizeRetryCount(value: unknown): number {
  const numeric = Math.floor(Number(value ?? 3));
  if (!Number.isFinite(numeric)) return 3;
  return Math.min(Math.max(numeric, 0), 10);
}

function normalizeRetryDelaySeconds(value: unknown): number {
  const numeric = Math.floor(Number(value ?? 5));
  if (!Number.isFinite(numeric)) return 5;
  return Math.min(Math.max(numeric, 1), 300);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
}

function isRetryableDownloadError(error: FlowError): boolean {
  if ([ErrorCodes.INVALID_PARAMETERS, ErrorCodes.REPORT_NOT_FOUND, ErrorCodes.TASK_NOT_FOUND].includes(error.code)) {
    return false;
  }

  const message = `${error.message} ${error.details instanceof Error ? error.details.message : ""}`;
  const nonRetryablePatterns = [
    /Unable to choose EBAS dropdown value/i,
    /Unable to find input field for EBAS label/i,
    /Unable to click EBAS text/i,
    /Unknown EBAS report/i,
    /Missing required parameters/i,
    /must be one of/i,
    /does not match expected/i,
    /expected .* actual/i
  ];
  if (nonRetryablePatterns.some((pattern) => pattern.test(message))) {
    return false;
  }

  const retryablePatterns = [
    /Timeout/i,
    /timed out/i,
    /Target page, context or browser has been closed/i,
    /download/i,
    /ext-el-mask/i,
    /intercepts pointer events/i,
    /Execution context was destroyed/i,
    /Navigation failed/i,
    /net::/i,
    /Unexpected download failure/i
  ];
  return retryablePatterns.some((pattern) => pattern.test(message)) || error.code === ErrorCodes.DOWNLOAD_FAILED;
}

function normalizeParallelism(value: unknown): number {
  const numeric = Number(value ?? 1);
  return numeric >= 2 ? 2 : 1;
}

function readDebugDir(details: unknown): string | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const value = (details as Record<string, unknown>).debugDir;
  return typeof value === "string" ? value : undefined;
}

function countItems(items: BatchDownloadItem[], status: BatchDownloadItem["status"]): number {
  return items.filter((item) => item.status === status).length;
}

function firstFailedItem(task: BatchDownloadTask): BatchDownloadItem | undefined {
  return task.items.find((item) => item.status === "failed");
}

function finalBatchStatus(task: BatchDownloadTask): BatchDownloadTaskStatus {
  const failedCount = countItems(task.items, "failed");
  const completedCount = countItems(task.items, "completed");
  if (failedCount === 0) return "completed";
  if (completedCount > 0) return "partial_failed";
  return "failed";
}

function buildParsedReportCacheKey(filePath: string, size: number, mtimeMs: number): string {
  return `${filePath}::${size}::${mtimeMs}`;
}

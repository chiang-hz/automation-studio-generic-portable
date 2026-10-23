import type { BrowserMode } from "./browserMode.ts";

export type ReportId = string;

export type ParameterType = "string" | "date" | "enum";

export type DownloadTaskStatus = "queued" | "running" | "cancelling" | "cancelled" | "completed" | "failed";

export type BatchDownloadTaskStatus = "queued" | "running" | "cancelling" | "cancelled" | "completed" | "partial_failed" | "failed";

export type BatchDownloadItemStatus = "queued" | "running" | "retrying" | "cancelling" | "cancelled" | "completed" | "failed" | "skipped";

export interface ReportDefinition {
  id: ReportId;
  name: string;
  description: string;
  outputFormat: "csv" | "xlsx";
}

export interface ReportParameterDefinition {
  name: string;
  label?: string;
  type: ParameterType;
  required: boolean;
  description: string;
  options?: string[];
  defaultValue?: string;
}

export type ReportParameters = Record<string, string>;

export interface DownloadTask {
  id: string;
  reportId: ReportId;
  parameters: ReportParameters;
  debugEnabled?: boolean;
  browserMode?: BrowserMode;
  status: DownloadTaskStatus;
  createdAt: string;
  updatedAt: string;
  filePath?: string;
  debugDir?: string;
  rowCount?: number;
  errorCode?: string;
  errorMessage?: string;
  attempt?: number;
  maxRetries?: number;
  retryCount?: number;
  nextRetryAt?: string;
  lastErrorMessage?: string;
}

export interface BatchDownloadItemInput {
  reportId: ReportId;
  parameters: ReportParameters;
}

export interface BatchDownloadItem extends BatchDownloadItemInput {
  browserMode?: BrowserMode;
  id: string;
  workerId?: string;
  status: BatchDownloadItemStatus;
  filePath?: string;
  debugDir?: string;
  rowCount?: number;
  errorCode?: string;
  errorMessage?: string;
  attempt?: number;
  maxRetries?: number;
  retryCount?: number;
  nextRetryAt?: string;
  lastErrorMessage?: string;
}

export interface BatchDownloadTask {
  id: string;
  items: BatchDownloadItem[];
  debugEnabled?: boolean;
  browserMode?: BrowserMode;
  continueOnError: boolean;
  parallelism?: number;
  retryEnabled?: boolean;
  maxRetries?: number;
  retryDelaySeconds?: number;
  status: BatchDownloadTaskStatus;
  createdAt: string;
  updatedAt: string;
  completedCount: number;
  failedCount: number;
  skippedCount: number;
  cancelledCount?: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface BatchDownloadResult {
  taskId: string;
  status: BatchDownloadTaskStatus;
  completedCount: number;
  failedCount: number;
  skippedCount: number;
  cancelledCount?: number;
  files: Array<{
    itemId: string;
    reportId: ReportId;
    workerId?: string;
    filePath: string;
    rowCount?: number;
    debugDir?: string;
  }>;
  failedItems: Array<{
    itemId: string;
    reportId: ReportId;
    workerId?: string;
    errorCode?: string;
    errorMessage?: string;
    debugDir?: string;
  }>;
}

export interface ParsedReport {
  filePath: string;
  rowCount: number;
  columns: string[];
  rows: Record<string, string>[];
}

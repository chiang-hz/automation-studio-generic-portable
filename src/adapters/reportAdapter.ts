import type {
  ReportDefinition,
  ReportId,
  ReportParameterDefinition,
  ReportParameters
} from "../domain/types.ts";

import type { BrowserMode } from "../domain/browserMode.ts";

export interface DownloadReportInput {
  browserMode?: BrowserMode;
  signal?: AbortSignal;
  reportId: ReportId;
  reportName?: string;
  parameters: ReportParameters;
  debugEnabled?: boolean;
  storageStatePath?: string;
  workerId?: string;
}

export interface DownloadReportOutput {
  filePath: string;
  debugDir?: string;
}

export interface ReportAdapter {
  listReports(): Promise<ReportDefinition[]>;
  getReportParameters(reportId: ReportId): Promise<ReportParameterDefinition[]>;
  downloadReport(input: DownloadReportInput): Promise<DownloadReportOutput>;
}

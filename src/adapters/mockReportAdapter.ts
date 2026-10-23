import { localFilenameTimestamp } from "../domain/localTimestamp.ts";
import fs from "node:fs/promises";
import path from "node:path";
import type { ReportAdapter, DownloadReportInput, DownloadReportOutput } from "./reportAdapter.ts";
import { assertReportExists, reportParameters, reports } from "./reportCatalog.ts";
import type { ReportDefinition, ReportId, ReportParameterDefinition } from "../domain/types.ts";

export class MockReportAdapter implements ReportAdapter {
  private readonly downloadDir: string;

  constructor(downloadDir: string) {
    this.downloadDir = downloadDir;
  }

  async listReports(): Promise<ReportDefinition[]> {
    return reports.filter((report) => report.id !== "ebas-1103-income-statement");
  }

  async getReportParameters(reportId: ReportId): Promise<ReportParameterDefinition[]> {
    assertReportExists(reportId);
    return reportParameters[reportId];
  }

  async downloadReport(input: DownloadReportInput): Promise<DownloadReportOutput> {
    input.signal?.throwIfAborted();
    assertReportExists(input.reportId);
    if (input.reportId === "ebas-1103-income-statement") {
      throw new Error("Mock adapter does not support EBAS reports. Set REPORT_ADAPTER=ebas.");
    }
    await fs.mkdir(this.downloadDir, { recursive: true });

    const filePath = path.join(this.downloadDir, withTimestamp(input.reportName ?? input.reportId, ".csv"));
    const csv = this.createCsv(input);

    input.signal?.throwIfAborted();
    await fs.writeFile(filePath, csv, "utf8");
    return { filePath };
  }

  private createCsv(input: DownloadReportInput): string {
    if (input.reportId === "sales-summary") {
      const channel = input.parameters.channel || "all";
      return [
        "date,channel,totalOrders,totalAmount",
        `${input.parameters.startDate},${channel},18,42150`,
        `${input.parameters.endDate},${channel},24,58800`
      ].join("\n");
    }

    return [
      "asOfDate,warehouse,sku,quantity,agingBucket",
      `${input.parameters.asOfDate},${input.parameters.warehouse || "ALL"},SKU-001,120,0-30`,
      `${input.parameters.asOfDate},${input.parameters.warehouse || "ALL"},SKU-048,32,31-60`
    ].join("\n");
  }
}

function withTimestamp(name: string, extension: string): string {
  const baseName = sanitizeFileName(path.basename(name, path.extname(name)));
  const stamp = localFilenameTimestamp();
  return `${baseName}-${stamp}${extension}`;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

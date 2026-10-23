import { bindContextCancellation } from "./cancellation.ts";
import { localFilenameTimestamp } from "../domain/localTimestamp.ts";
import path from "node:path";
import type { AppConfig } from "../config.ts";
import { ErrorCodes, FlowError } from "../domain/errors.ts";
import type { ReportDefinition, ReportId, ReportParameterDefinition } from "../domain/types.ts";
import { resolveChromiumExecutablePath } from "./chromiumExecutable.ts";
import type { DownloadReportInput, DownloadReportOutput, ReportAdapter } from "./reportAdapter.ts";
import { assertReportExists, reportParameters, reports } from "./reportCatalog.ts";

export class PlaywrightReportAdapter implements ReportAdapter {
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
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
    this.assertConfigured();

    const { chromium } = await import("playwright");
    const executablePath = await resolveChromiumExecutablePath(this.config);
    const browser = await chromium.launch({
      headless: input.browserMode ? input.browserMode === "headless" : this.config.headless,
      ...(executablePath ? { executablePath } : {})
    });
    const context = await browser.newContext({ acceptDownloads: true });
    const releaseContext = bindContextCancellation(context, input.signal);
    try {
      input.signal?.throwIfAborted();
      const page = await context.newPage();
      await page.goto(this.config.targetBaseUrl!, { waitUntil: "domcontentloaded" });

      // Replace these selectors with the target site's stable locators.
      await page.getByLabel("Username").fill(this.config.targetUsername!);
      await page.getByLabel("Password").fill(this.config.targetPassword!);
      await page.getByRole("button", { name: /sign in|log in/i }).click();

      await page.getByRole("navigation").waitFor({ timeout: 30_000 });
      await page.getByRole("link", { name: /reports/i }).click();
      await page.getByRole("link", { name: new RegExp(input.reportId, "i") }).click();

      for (const [name, value] of Object.entries(input.parameters)) {
        await page.getByLabel(new RegExp(name, "i")).fill(value);
      }

      const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
      void downloadPromise.catch(() => undefined);
      await page.getByRole("button", { name: /download|export/i }).click();
      const download = await downloadPromise;

      const suggested = download.suggestedFilename();
      const filePath = path.join(
        this.config.downloadDir,
        withTimestamp(input.reportName ?? input.reportId, path.extname(suggested))
      );
      await download.saveAs(filePath);
      return { filePath };
    } catch (error) {
      throw new FlowError(
        ErrorCodes.DOWNLOAD_FAILED,
        "Playwright download flow failed. Check selectors, login state, MFA, and report parameters.",
        error
      );
    } finally {
      await releaseContext();
      await browser.close();
    }
  }

  private assertConfigured(): void {
    if (!this.config.targetBaseUrl || !this.config.targetUsername || !this.config.targetPassword) {
      throw new FlowError(
        ErrorCodes.PLAYWRIGHT_NOT_CONFIGURED,
        "TARGET_BASE_URL, TARGET_USERNAME, and TARGET_PASSWORD are required for the Playwright adapter."
      );
    }
  }
}

function withTimestamp(name: string, extension = path.extname(name)): string {
  const baseName = sanitizeFileName(path.basename(name, path.extname(name)));
  const safeExtension = extension || path.extname(name) || ".xlsx";
  const stamp = localFilenameTimestamp();
  return `${baseName}-${stamp}${safeExtension}`;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

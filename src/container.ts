import fs from "node:fs/promises";
import { loadConfig } from "./config.ts";
import { EbasReportAdapter } from "./adapters/ebasReportAdapter.ts";
import { MockReportAdapter } from "./adapters/mockReportAdapter.ts";
import { PlaywrightReportAdapter } from "./adapters/playwrightReportAdapter.ts";
import type { ReportAdapter } from "./adapters/reportAdapter.ts";
import { TaskStore } from "./domain/taskStore.ts";
import { ReportService } from "./services/reportService.ts";

export async function createReportService(): Promise<ReportService> {
  const config = loadConfig();
  await fs.mkdir(config.downloadDir, { recursive: true });

  let adapter: ReportAdapter;
  if (config.adapter === "playwright") {
    adapter = new PlaywrightReportAdapter(config);
  } else if (config.adapter === "ebas") {
    adapter = new EbasReportAdapter(config);
  } else {
    adapter = new MockReportAdapter(config.downloadDir);
  }

  return new ReportService(adapter, new TaskStore());
}

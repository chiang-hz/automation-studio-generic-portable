import fs from "node:fs/promises";
import path from "node:path";
import type { ParsedReport } from "../domain/types.ts";
import { parseCsvReport } from "./csvParser.ts";

export async function parseDownloadedReport(filePath: string): Promise<ParsedReport> {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".csv") {
    return parseCsvReport(filePath);
  }

  const stat = await fs.stat(filePath);
  return {
    filePath,
    rowCount: 0,
    columns: ["filePath", "fileSizeBytes", "format"],
    rows: [
      {
        filePath,
        fileSizeBytes: String(stat.size),
        format: extension.replace(".", "") || "unknown"
      }
    ]
  };
}

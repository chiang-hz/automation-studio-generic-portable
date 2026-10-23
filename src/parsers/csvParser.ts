import fs from "node:fs/promises";
import { ErrorCodes, FlowError } from "../domain/errors.ts";
import type { ParsedReport } from "../domain/types.ts";

export async function parseCsvReport(filePath: string): Promise<ParsedReport> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.trim().split(/\r?\n/);
    const columns = splitCsvLine(lines[0] ?? "");
    const rows = lines.slice(1).map((line) => {
      const values = splitCsvLine(line);
      return Object.fromEntries(columns.map((column, index) => [column, values[index] ?? ""]));
    });

    return {
      filePath,
      columns,
      rows,
      rowCount: rows.length
    };
  } catch (error) {
    throw new FlowError(ErrorCodes.FILE_PARSE_FAILED, `Unable to parse CSV file: ${filePath}`, error);
  }
}

function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === "\"" && quoted && next === "\"") {
      current += "\"";
      index += 1;
      continue;
    }

    if (char === "\"") {
      quoted = !quoted;
      continue;
    }

    if (char === "," && !quoted) {
      result.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  result.push(current);
  return result;
}

import fs from "node:fs/promises";
import path from "node:path";
import type { ReportDefinition, ReportParameterDefinition } from "../domain/types.ts";

export interface EbasReportDefinition {
  id: string;
  name: string;
  description: string;
  menuPath: string[];
  businessType: string;
  fundType: string;
  year: string;
  stage: string;
  outputFormat: string;
  kind: string;
  kindOptions: string[];
  printLevel: string;
  usagePrintStopLevel: string;
  accountLevel: string;
  accountCode: string;
  accountPrintLevel: string;
}

const definitionsCache = new Map<string, EbasReportDefinition[]>();

export const EBAS_BUSINESS_TYPE_OPTIONS = ["單位", "彙編"];
export const EBAS_STAGE_OPTIONS = ["預算案", "法定預算", "自編決算", "院編決算", "審定決算"];
export const EBAS_OUTPUT_FORMAT_OPTIONS = ["pdf", "excel", "xml"];
export const EBAS_LEVEL_OPTIONS = ["不適用", "1", "2", "3", "4", "5"];

export const DEFAULT_EBAS_REPORT: EbasReportDefinition = {
  id: "ebas-1103-income-statement",
  name: "EBAS 1103 損益表",
  description: "營業基金決(結)算編製，決算主要表中的損益表 Excel 下載。",
  menuPath: ["營業基金", "決(結)算", "決算書表", "書表列印", "決算主要表", "損益表"],
  businessType: "單位",
  fundType: "決(結)算編製",
  year: "114",
  stage: "院編決算",
  outputFormat: "excel",
  kind: "",
  kindOptions: [],
  printLevel: "不適用",
  usagePrintStopLevel: "不適用",
  accountLevel: "不適用",
  accountCode: "不適用",
  accountPrintLevel: "不適用"
};

export async function listEbasReportDefinitions(filePath: string): Promise<EbasReportDefinition[]> {
  const cached = definitionsCache.get(filePath);
  if (cached) {
    return cached.map((definition) => ({ ...definition, menuPath: [...definition.menuPath] }));
  }

  const definitions = mergeDefinitions(await readCustomDefinitions(filePath));
  definitionsCache.set(filePath, definitions);
  return definitions.map((definition) => ({ ...definition, menuPath: [...definition.menuPath] }));
}

export async function listDownloadableEbasReportDefinitions(filePath: string): Promise<EbasReportDefinition[]> {
  return (await listEbasReportDefinitions(filePath)).filter(
    (definition) => definition.id !== DEFAULT_EBAS_REPORT.id
  );
}

export async function loadSampleEbasReportDefinition(filePath: string): Promise<EbasReportDefinition> {
  return saveEbasReportDefinition(filePath, DEFAULT_EBAS_REPORT);
}

export async function getEbasReportDefinition(
  filePath: string,
  reportId: string
): Promise<EbasReportDefinition | undefined> {
  return (await listEbasReportDefinitions(filePath)).find((definition) => definition.id === reportId);
}

export async function saveEbasReportDefinition(
  filePath: string,
  definition: EbasReportDefinition
): Promise<EbasReportDefinition> {
  const normalized = normalizeDefinition(definition);
  const existing = await readCustomDefinitions(filePath);
  const next = [
    ...existing.filter((item) => item.id !== normalized.id),
    normalized
  ].sort((left, right) => left.id.localeCompare(right.id));

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  definitionsCache.delete(filePath);
  return normalized;
}

export async function deleteEbasReportDefinition(
  filePath: string,
  reportId: string
): Promise<EbasReportDefinition[]> {
  const existing = await readCustomDefinitions(filePath);
  const next = existing.filter((item) => item.id !== reportId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  definitionsCache.delete(filePath);
  return listEbasReportDefinitions(filePath);
}

export async function importEbasReportDefinitions(
  filePath: string,
  definitions: unknown[]
): Promise<EbasReportDefinition[]> {
  const existing = await readCustomDefinitions(filePath);
  const imported = definitions.map((definition) => normalizeDefinition(definition));
  const byId = new Map(existing.map((definition) => [definition.id, definition]));
  for (const definition of imported) {
    byId.set(definition.id, definition);
  }
  const next = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  definitionsCache.delete(filePath);
  return listEbasReportDefinitions(filePath);
}

export function normalizeEbasReportDefinitions(value: unknown): EbasReportDefinition[] {
  if (!Array.isArray(value)) return [];
  return value.map((definition) => normalizeDefinition(definition));
}

export function toReportDefinition(definition: EbasReportDefinition): ReportDefinition {
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    outputFormat: "xlsx"
  };
}

export function toEbasParameterDefinitions(
  definition: EbasReportDefinition
): ReportParameterDefinition[] {
  return [
    {
      name: "businessType",
      type: "enum",
      required: true,
      description: "上側業務別。",
      options: withDefaultOption(EBAS_BUSINESS_TYPE_OPTIONS, definition.businessType),
      defaultValue: definition.businessType
    },
    {
      name: "fundType",
      type: "enum",
      required: true,
      description: "上側營業基金。",
      options: [definition.fundType],
      defaultValue: definition.fundType
    },
    {
      name: "year",
      type: "string",
      required: true,
      description: "右側年度，例如 114。",
      defaultValue: definition.year
    },
    {
      name: "stage",
      type: "enum",
      required: true,
      description: "右側階段。",
      options: withDefaultOption(EBAS_STAGE_OPTIONS, definition.stage),
      defaultValue: definition.stage
    },
    {
      name: "outputFormat",
      type: "enum",
      required: true,
      description: "右側輸出格式。",
      options: withDefaultOption(EBAS_OUTPUT_FORMAT_OPTIONS, definition.outputFormat),
      defaultValue: definition.outputFormat
    },
    ...(definition.kind || definition.kindOptions[0]
      ? [{
          name: "kind",
          label: "\u5831\u8868\u7a2e\u985e",
          type: "enum",
          required: true,
          description: "EBAS report kind.",
          options: withDefaultOption(definition.kindOptions, definition.kind || definition.kindOptions[0] || ""),
          defaultValue: definition.kind || definition.kindOptions[0] || ""
        }]
      : []),
    {
      name: "printLevel",
      type: "enum",
      required: true,
      description: "右側列印層級。",
      options: EBAS_LEVEL_OPTIONS,
      defaultValue: definition.printLevel
    },
    {
      name: "usagePrintStopLevel",
      type: "enum",
      required: true,
      description: "右側用途別列印截止層級。",
      options: EBAS_LEVEL_OPTIONS,
      defaultValue: definition.usagePrintStopLevel
    },
    {
      name: "accountLevel",
      type: "enum",
      required: true,
      description: "右側科目層級。",
      options: EBAS_LEVEL_OPTIONS,
      defaultValue: definition.accountLevel
    },
    {
      name: "accountCode",
      type: "string",
      required: true,
      description: "右側會計科目；可填會計科目代碼，或使用不適用。",
      defaultValue: definition.accountCode
    },
    {
      name: "accountPrintLevel",
      type: "enum",
      required: true,
      description: "右側會計科目列印層級。",
      options: EBAS_LEVEL_OPTIONS,
      defaultValue: definition.accountPrintLevel
    }
  ];
}

function mergeDefinitions(definitions: EbasReportDefinition[]): EbasReportDefinition[] {
  const byId = new Map<string, EbasReportDefinition>();
  for (const definition of definitions) {
    byId.set(definition.id, normalizeDefinition(definition));
  }
  return [...byId.values()];
}

async function readCustomDefinitions(filePath: string): Promise<EbasReportDefinition[]> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const value = JSON.parse(text);
    if (!Array.isArray(value)) return [];
    return value.map((entry) => normalizeDefinition(entry));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function normalizeDefinition(value: unknown): EbasReportDefinition {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const menuPath = Array.isArray(input.menuPath)
    ? input.menuPath.map((item) => String(item).trim()).filter(Boolean)
    : String(input.menuPath ?? "").split(/\r?\n|>/).map((item) => item.trim()).filter(Boolean);

  const id = String(input.id ?? "").trim();
  const name = String(input.name ?? "").trim();
  const description = String(input.description ?? "").trim();
  const businessType = String(input.businessType ?? DEFAULT_EBAS_REPORT.businessType).trim();
  const fundType = String(input.fundType ?? DEFAULT_EBAS_REPORT.fundType).trim();
  const year = String(input.year ?? DEFAULT_EBAS_REPORT.year).trim();
  const stage = String(input.stage ?? DEFAULT_EBAS_REPORT.stage).trim();
  const outputFormat = normalizeOutputFormat(input.outputFormat, DEFAULT_EBAS_REPORT.outputFormat);
  const kindOptions = normalizeStringOptions(input.kindOptions);
  const kind = String(input.kind ?? kindOptions[0] ?? "").trim();
  const printLevel = normalizeLevel(input.printLevel, DEFAULT_EBAS_REPORT.printLevel);
  const usagePrintStopLevel = normalizeLevel(
    input.usagePrintStopLevel,
    DEFAULT_EBAS_REPORT.usagePrintStopLevel
  );
  const accountLevel = normalizeLevel(input.accountLevel, DEFAULT_EBAS_REPORT.accountLevel);
  const accountCode = String(input.accountCode ?? DEFAULT_EBAS_REPORT.accountCode).trim();
  const accountPrintLevel = normalizeLevel(input.accountPrintLevel, DEFAULT_EBAS_REPORT.accountPrintLevel);

  if (!/^[a-z0-9][a-z0-9-]{2,80}$/i.test(id)) {
    throw new Error("報表 ID 只能使用英數字與連字號，長度至少 3。");
  }
  if (!name) throw new Error("報表名稱不可空白。");
  if (menuPath.length < 2) throw new Error("左側選單路徑至少需要 2 層。");
  if (!businessType || !fundType || !year || !stage || !outputFormat) {
    throw new Error("業務別、營業基金、年度、階段、輸出格式皆不可空白。");
  }

  return {
    id,
    name,
    description: description || name,
    menuPath,
    businessType,
    fundType,
    year,
    stage,
    outputFormat,
    kind,
    kindOptions: withDefaultOption(kindOptions, kind),
    printLevel,
    usagePrintStopLevel,
    accountLevel,
    accountCode: accountCode || DEFAULT_EBAS_REPORT.accountCode,
    accountPrintLevel
  };
}

function normalizeStringOptions(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value.map((item) => String(item).trim())
    : String(value ?? "").split(/\r?\n/).map((item) => item.trim());
  return [...new Set(items.filter(Boolean))];
}

function normalizeLevel(value: unknown, fallback: string): string {
  const level = String(value ?? fallback).trim();
  return EBAS_LEVEL_OPTIONS.includes(level) ? level : fallback;
}

function normalizeOutputFormat(value: unknown, fallback: string): string {
  const format = String(value ?? fallback).trim().toLowerCase();
  return EBAS_OUTPUT_FORMAT_OPTIONS.includes(format) ? format : fallback;
}

function withDefaultOption(options: string[], defaultValue: string): string[] {
  const normalized = [...new Set(options.map((option) => String(option).trim()).filter(Boolean))];
  if (!defaultValue) return normalized;
  return normalized.includes(defaultValue) ? normalized : [defaultValue, ...normalized];
}

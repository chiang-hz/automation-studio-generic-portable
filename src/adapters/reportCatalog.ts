import type { ReportDefinition, ReportId, ReportParameterDefinition } from "../domain/types.ts";
import { ErrorCodes, FlowError } from "../domain/errors.ts";

export const reports: ReportDefinition[] = [
  {
    id: "sales-summary",
    name: "Sales Summary",
    description: "Daily sales totals grouped by channel.",
    outputFormat: "csv"
  },
  {
    id: "inventory-aging",
    name: "Inventory Aging",
    description: "Inventory quantity and aging bucket by warehouse.",
    outputFormat: "csv"
  },
  {
    id: "ebas-1103-income-statement",
    name: "EBAS 1103 損益表",
    description: "營業基金決(結)算編製，決算主要表中的損益表 Excel 下載。",
    outputFormat: "xlsx"
  }
];

export const reportParameters: Record<ReportId, ReportParameterDefinition[]> = {
  "sales-summary": [
    {
      name: "startDate",
      type: "date",
      required: true,
      description: "Inclusive report start date in YYYY-MM-DD format."
    },
    {
      name: "endDate",
      type: "date",
      required: true,
      description: "Inclusive report end date in YYYY-MM-DD format."
    },
    {
      name: "channel",
      type: "enum",
      required: false,
      description: "Optional sales channel filter.",
      options: ["all", "online", "retail", "partner"]
    }
  ],
  "inventory-aging": [
    {
      name: "asOfDate",
      type: "date",
      required: true,
      description: "Inventory snapshot date in YYYY-MM-DD format."
    },
    {
      name: "warehouse",
      type: "string",
      required: false,
      description: "Optional warehouse code."
    }
  ],
  "ebas-1103-income-statement": [
    {
      name: "businessType",
      type: "enum",
      required: true,
      description: "上側業務別。",
      options: ["單位"]
    },
    {
      name: "fundType",
      type: "enum",
      required: true,
      description: "上側營業基金。",
      options: ["決(結)算編製"]
    },
    {
      name: "year",
      type: "string",
      required: true,
      description: "右側年度，例如 114。"
    },
    {
      name: "stage",
      type: "enum",
      required: true,
      description: "右側階段。",
      options: ["預算案", "法定預算", "自編決算", "院編決算", "審定決算"]
    },
    {
      name: "outputFormat",
      type: "enum",
      required: true,
      description: "右側輸出格式。",
      options: ["excel"]
    }
  ]
};

export function assertReportExists(reportId: string): asserts reportId is ReportId {
  if (!reports.some((report) => report.id === reportId)) {
    throw new FlowError(ErrorCodes.REPORT_NOT_FOUND, `Unknown report: ${reportId}`);
  }
}

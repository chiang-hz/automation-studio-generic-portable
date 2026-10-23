import { ErrorCodes, FlowError } from "./errors.ts";
export type BrowserMode = "headed" | "headless";

export function normalizeBrowserMode(value: unknown): BrowserMode {
  if (value === undefined) return "headed";
  if (value === "headed" || value === "headless") return value;
  throw new FlowError(ErrorCodes.INVALID_PARAMETERS, "browserMode 必須為 headed 或 headless。");
}

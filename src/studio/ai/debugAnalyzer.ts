import type { AIGenerateRequest, AIGenerateResponse } from "./types.ts";
import type { SelectorRule, WaitRule, VerificationRule, WorkflowProject, WorkflowRun, WorkflowStep } from "../types.ts";
import type { FailurePageSummary } from "../debugDiagnostics.ts";
import { redactExternalText, sanitizeExternalValue, sanitizeWorkflowStepForExternal } from "../debugDiagnostics.ts";

export interface AIDebugAnalysisInput {
  project: WorkflowProject;
  run: WorkflowRun;
  failedStep?: WorkflowStep;
  events: Record<string, unknown>[];
  pageSummary?: FailurePageSummary;
}

export interface AIDebugAnalysisResult {
  summary: string;
  rootCause: string;
  confidence: "low" | "medium" | "high";
  evidence: string[];
  suggestions: string[];
  patchSummary: string[];
  proposedPatch: Partial<WorkflowStep>;
  warnings: string[];
  failedStepId?: string;
  ai: { providerId: string; providerKind: string; model?: string; usage?: AIGenerateResponse["usage"] };
}

const SELECTOR_STRATEGIES = new Set(["role", "label", "placeholder", "text", "name", "testId", "css", "xpath", "component"]);
const MATCH_MODES = new Set(["unique", "first", "last", "nth"]);
const DOWNLOAD_MODES = new Set(["auto", "direct", "click"]);
const TAB_TARGET_MODES = new Set(["name", "url", "title", "index"]);
const MANUAL_COMPLETION_MODES = new Set(["button", "element", "url"]);

export function buildAIDebugAnalysisRequest(input: AIDebugAnalysisInput): AIGenerateRequest {
  const failedAttempt = [...(input.run.steps ?? [])].reverse().find((step) => step.status === "failed");
  const relevantEvents = input.events.slice(-120).map((event) => sanitizeExternalValue(event));
  const pageContext = input.pageSummary ? {
    url: input.pageSummary.url,
    title: input.pageSummary.title,
    bodyText: input.pageSummary.bodyText.slice(0, 20000),
    frames: input.pageSummary.frames.map((frame) => ({
      index: frame.index,
      name: frame.name,
      parentIndex: frame.parentIndex,
      path: frame.path,
      url: frame.url,
      title: frame.title,
      bodyText: frame.bodyText.slice(0, 12000),
      elements: frame.elements.slice(0, 180),
      selectorCandidates: frame.selectorCandidates.slice(0, 260)
    }))
  } : undefined;
  const payload = {
    failure: {
      errorCode: input.run.errorCode,
      errorMessage: redactExternalText(input.run.errorMessage ?? failedAttempt?.message ?? ""),
      failedStepId: input.failedStep?.id ?? failedAttempt?.stepId,
      failedAttempt: sanitizeExternalValue(failedAttempt)
    },
    step: input.failedStep ? sanitizeWorkflowStepForExternal(input.failedStep) : undefined,
    projectContext: {
      targetUrl: input.project.targetUrl,
      adapter: input.project.adapter,
      browser: {
        connectionMode: input.project.browser.connectionMode,
        channel: input.project.browser.channel,
        defaultTimeoutMs: input.project.browser.defaultTimeoutMs,
        downloadTimeoutMs: input.project.browser.downloadTimeoutMs,
        downloadPdfInsteadOfPreview: input.project.browser.downloadPdfInsteadOfPreview
      },
      settings: {
        maxRetries: input.project.settings.maxRetries,
        safePlayback: input.project.settings.safePlayback,
        humanizedPlayback: input.project.settings.humanizedPlayback,
        minStepDelayMs: input.project.settings.minStepDelayMs
      }
    },
    recentEvents: relevantEvents,
    pageContext
  };
  return {
    temperature: 0.05,
    maxTokens: 6000,
    responseFormat: "json",
    metadata: { feature: "automation-studio-debug-analysis", schemaVersion: "1.0.12" },
    messages: [
      { role: "system", content: DEBUG_ANALYSIS_PROMPT },
      { role: "user", content: JSON.stringify(payload, null, 2) }
    ]
  };
}

export function createAIDebugAnalysis(response: AIGenerateResponse, input: AIDebugAnalysisInput): AIDebugAnalysisResult {
  const parsed = parseJson(response.text);
  const warnings: string[] = [];
  const proposedPatch = normalizePatch(parsed.proposedPatch, input, warnings);
  return {
    summary: limit(parsed.summary, 1400) || "AI 已完成失敗原因分析。",
    rootCause: limit(parsed.rootCause, 1800) || "未能判定單一根因，請參考證據與建議。",
    confidence: parsed.confidence === "high" || parsed.confidence === "low" ? parsed.confidence : "medium",
    evidence: stringList(parsed.evidence, 12, 700),
    suggestions: stringList(parsed.suggestions, 12, 700),
    patchSummary: stringList(parsed.patchSummary, 12, 500),
    proposedPatch,
    warnings: [...stringList(parsed.warnings, 12, 700), ...warnings],
    failedStepId: input.failedStep?.id,
    ai: { providerId: response.providerId, providerKind: response.providerKind, model: response.model, usage: response.usage }
  };
}

function normalizePatch(raw: unknown, input: AIDebugAnalysisInput, warnings: string[]): Partial<WorkflowStep> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !input.failedStep) return {};
  const source = raw as Record<string, unknown>;
  const patch: Partial<WorkflowStep> = {};
  const copyString = (key: keyof WorkflowStep, max = 2000) => {
    if (typeof source[key] === "string" && String(source[key]).trim()) (patch as any)[key] = String(source[key]).trim().slice(0, max);
  };
  copyString("name", 160);
  copyString("description", 1200);
  copyString("url", 2000);
  copyString("componentPath", 500);
  copyString("manualExpected", 1000);
  copyString("tabTarget", 1000);
  copyString("downloadFileName", 500);
  copyString("pdfFileName", 500);
  copyString("outputVariable", 160);
  copyString("extractAttribute", 160);
  copyString("sourceVariable", 160);
  copyString("regexPattern", 1000);
  copyString("regexFlags", 20);
  if (typeof source.value === "string" || typeof source.value === "boolean") patch.value = source.value as string | boolean;
  if (typeof source.autoFrameSearch === "boolean") patch.autoFrameSearch = source.autoFrameSearch;
  if (MATCH_MODES.has(String(source.matchMode))) patch.matchMode = source.matchMode as WorkflowStep["matchMode"];
  if (Number.isFinite(Number(source.matchIndex))) patch.matchIndex = clampInt(source.matchIndex, 1, 999);
  if (Number.isFinite(Number(source.timeoutMs))) patch.timeoutMs = clampInt(source.timeoutMs, 500, 300000);
  if (Number.isFinite(Number(source.retryCount))) patch.retryCount = clampInt(source.retryCount, 0, 5);
  if (Number.isFinite(Number(source.tabIndex))) patch.tabIndex = clampInt(source.tabIndex, 1, 99);
  if (Number.isFinite(Number(source.listLimit))) patch.listLimit = clampInt(source.listLimit, 1, 500);
  if (Number.isFinite(Number(source.regexGroup))) patch.regexGroup = clampInt(source.regexGroup, 0, 50);
  if (typeof source.clickOnMatch === "boolean") patch.clickOnMatch = source.clickOnMatch;
  if (source.pdfPageSize === "A4" || source.pdfPageSize === "Letter") patch.pdfPageSize = source.pdfPageSize;
  if (source.pdfOrientation === "portrait" || source.pdfOrientation === "landscape") patch.pdfOrientation = source.pdfOrientation;
  if (typeof source.pdfPrintBackground === "boolean") patch.pdfPrintBackground = source.pdfPrintBackground;
  if (typeof source.pdfDisplayHeaderFooter === "boolean") patch.pdfDisplayHeaderFooter = source.pdfDisplayHeaderFooter;
  if (typeof source.pdfHeaderTemplate === "string") patch.pdfHeaderTemplate = source.pdfHeaderTemplate.slice(0, 10_000);
  if (typeof source.pdfFooterTemplate === "string") patch.pdfFooterTemplate = source.pdfFooterTemplate.slice(0, 10_000);
  if (Number.isFinite(Number(source.pdfScale))) patch.pdfScale = Math.min(2, Math.max(0.1, Number(source.pdfScale)));
  if (typeof source.pdfFullPage === "boolean") patch.pdfFullPage = source.pdfFullPage;
  if (typeof source.pdfUseLocalTime === "boolean") patch.pdfUseLocalTime = source.pdfUseLocalTime;
  for (const key of ["pdfMarginTopMm", "pdfMarginRightMm", "pdfMarginBottomMm", "pdfMarginLeftMm"] as const) {
    if (Number.isFinite(Number(source[key]))) patch[key] = Math.min(50, Math.max(0, Number(source[key])));
  }
  if (DOWNLOAD_MODES.has(String(source.downloadMode))) patch.downloadMode = source.downloadMode as WorkflowStep["downloadMode"];
  if (source.downloadFileNameMode === "original" || source.downloadFileNameMode === "custom") patch.downloadFileNameMode = source.downloadFileNameMode;
  if (TAB_TARGET_MODES.has(String(source.tabTargetMode))) patch.tabTargetMode = source.tabTargetMode as WorkflowStep["tabTargetMode"];
  if (MANUAL_COMPLETION_MODES.has(String(source.manualCompletionMode))) patch.manualCompletionMode = source.manualCompletionMode as WorkflowStep["manualCompletionMode"];
  if (source.extractMode === "text" || source.extractMode === "html" || source.extractMode === "attribute") patch.extractMode = source.extractMode;
  if (source.frame && typeof source.frame === "object" && !Array.isArray(source.frame)) {
    const frame = source.frame as Record<string, unknown>;
    patch.frame = {
      name: typeof frame.name === "string" ? frame.name.slice(0, 200) : undefined,
      urlIncludes: typeof frame.urlIncludes === "string" ? frame.urlIncludes.slice(0, 500) : undefined,
      selector: typeof frame.selector === "string" ? frame.selector.slice(0, 500) : undefined
    };
  }
  const waitBefore = normalizeWait(source.waitBefore);
  const waitAfter = normalizeWait(source.waitAfter);
  const verification = normalizeVerification(source.verification, input, warnings);
  if (waitBefore) patch.waitBefore = waitBefore;
  if (waitAfter) patch.waitAfter = waitAfter;
  if (verification) patch.verification = verification;
  const selectors = normalizeSelectors(source.selectors, input, warnings);
  if (selectors.length) patch.selectors = selectors;
  if (Array.isArray(source.selectors) && !selectors.length) warnings.push("AI 建議的 selector 不在失敗頁面實際觀察證據或原步驟 selector 中，因此未套入候選修正。 ");
  return patch;
}

function normalizeSelectors(raw: unknown, input: AIDebugAnalysisInput, warnings: string[]): SelectorRule[] {
  if (!Array.isArray(raw)) return [];
  const allowed = selectorEvidenceKeys(input);
  const output: SelectorRule[] = [];
  for (const item of raw.slice(0, 8)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const strategy = String(row.strategy ?? "");
    const value = String(row.value ?? "").trim();
    if (!SELECTOR_STRATEGIES.has(strategy) || !value) continue;
    const candidate: SelectorRule = {
      strategy: strategy as SelectorRule["strategy"],
      value: value.slice(0, 1000),
      role: typeof row.role === "string" ? row.role.slice(0, 100) : undefined,
      exact: typeof row.exact === "boolean" ? row.exact : undefined,
      description: typeof row.description === "string" ? row.description.slice(0, 300) : "AI Debug 建議"
    };
    if (!allowed.has(selectorKey(candidate))) {
      warnings.push(`已忽略未經頁面證據驗證的 selector：${strategy}=${value.slice(0, 160)}`);
      continue;
    }
    output.push(candidate);
  }
  return output;
}

function selectorEvidenceKeys(input: AIDebugAnalysisInput): Set<string> {
  const keys = new Set<string>();
  for (const selector of input.failedStep?.selectors ?? []) keys.add(selectorKey(selector));
  for (const frame of input.pageSummary?.frames ?? []) {
    for (const candidate of frame.selectorCandidates ?? []) {
      if (!candidate || typeof candidate !== "object") continue;
      const row = candidate as Record<string, unknown>;
      const strategy = String(row.strategy ?? "");
      const value = String(row.value ?? "").trim();
      if (!SELECTOR_STRATEGIES.has(strategy) || !value) continue;
      keys.add(selectorKey({ strategy: strategy as SelectorRule["strategy"], value, role: typeof row.role === "string" ? row.role : undefined, exact: typeof row.exact === "boolean" ? row.exact : undefined }));
    }
  }
  return keys;
}

function selectorKey(selector: SelectorRule): string {
  return JSON.stringify({ strategy: selector.strategy, value: selector.value, role: selector.role ?? "" });
}

function normalizeWait(raw: unknown): WaitRule | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  if (!["timeout", "visible", "hidden", "attached", "networkIdle", "url"].includes(String(row.kind))) return undefined;
  return {
    kind: row.kind as WaitRule["kind"],
    value: typeof row.value === "string" ? row.value.slice(0, 1000) : undefined,
    timeoutMs: Number.isFinite(Number(row.timeoutMs)) ? clampInt(row.timeoutMs, 500, 300000) : undefined
  };
}

function normalizeVerification(raw: unknown, input: AIDebugAnalysisInput, warnings: string[]): VerificationRule | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  if (!["visible", "hidden", "exists", "value", "text", "url", "checked", "download"].includes(String(row.kind))) return undefined;
  const selectors = normalizeSelectors(row.selector, input, warnings);
  return {
    kind: row.kind as VerificationRule["kind"],
    expected: typeof row.expected === "boolean" || typeof row.expected === "string" ? row.expected : undefined,
    selector: selectors.length ? selectors : undefined,
    timeoutMs: Number.isFinite(Number(row.timeoutMs)) ? clampInt(row.timeoutMs, 500, 300000) : undefined
  };
}

function parseJson(text: string): Record<string, unknown> {
  const raw = String(text ?? "").trim();
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {}
  }
  throw new Error("AI Debug 分析回傳內容不是可解析的 JSON。請重試或更換模型。 ");
}

function stringList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => limit(item, maxLength)).filter(Boolean).slice(0, maxItems);
}

function limit(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function clampInt(value: unknown, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(Number(value))));
}

const DEBUG_ANALYSIS_PROMPT = `你是 Automation Studio V1.2.4 的 Test & Debug 失敗分析助理。你會收到失敗步驟、執行錯誤、最近事件、瀏覽器設定，以及失敗頁面的實際元素與 selectorCandidates。只輸出一個 JSON object，不要 Markdown。
輸出欄位：summary(string), rootCause(string), confidence(low|medium|high), evidence(string[]), suggestions(string[]), patchSummary(string[]), proposedPatch(object), warnings(string[])。
目標是找出失敗原因，並在可以安全判定時提出「失敗步驟設定」候選修正。
重要規則：
1. 不可修改 step.id、step.kind、enabled，也不可新增/刪除/移動流程步驟；這個功能只修正目前失敗步驟的設定。
2. proposedPatch 只能使用以下欄位：name, description, value, url, selectors, matchMode, matchIndex, frame, autoFrameSearch, manualCompletionMode, manualExpected, waitBefore, waitAfter, verification, timeoutMs, retryCount, componentPath, outputVariable, extractMode, extractAttribute, sourceVariable, listLimit, clickOnMatch, regexPattern, regexFlags, regexGroup, tabTargetMode, tabTarget, tabIndex, downloadMode, downloadFileNameMode, downloadFileName, pdfFileName, pdfPageSize, pdfOrientation, pdfPrintBackground, pdfMarginTopMm, pdfMarginRightMm, pdfMarginBottomMm, pdfMarginLeftMm, pdfDisplayHeaderFooter, pdfHeaderTemplate, pdfFooterTemplate, pdfScale, pdfFullPage, pdfUseLocalTime。
3. selector 不可自行發明。若要修改 selectors，只能逐字沿用 pageContext.frames[].selectorCandidates 或原失敗步驟已存在的 selector；找不到可信 selector 時，proposedPatch 不要放 selectors，改在 suggestions 說明需要人工錄製/重新探索。
4. 不得要求或輸出密碼、Cookie、Authorization、MFA、Token、API Key 等敏感值。
5. 優先區分：selector 不匹配/多重匹配、iframe、頁面尚未完成載入、等待條件不足、下載模式不對、驗證條件錯誤、網址/分頁狀態錯誤、網路 4xx/5xx、安全驗證、前置變數/狀態缺失。
6. 若證據不足，confidence=low，proposedPatch 可以是空物件，不要為了提供修正而猜測。
7. 所有文字使用繁體中文。`;

import type { AIGenerateRequest, AIGenerateResponse, AIWorkflowSiteEvidence } from "./types.ts";
import type { AdapterKind, SelectorRule, WorkflowParameter, WorkflowProject, WorkflowStep } from "../types.ts";

const SAFE_KINDS = new Set(["navigate","manual","click","dblclick","fill","select","upload","press","hover","check","uncheck","wait","assert","download","savePagePdf","screenshot","condition","loop","extractText","extractPattern","clipboard","newTab","switchTab","waitNewFirst","captureListSnapshot","waitNewListItem"]);
const SELECTOR_STRATEGIES = new Set(["role","label","placeholder","text","name","testId","css","xpath","component"]);
const ADAPTERS = new Set<AdapterKind>(["generic","extjs","ksi","ebas"]);

export interface AIWorkflowConversationTurn { role: "user" | "assistant"; content: string; }
export interface AIWorkflowDraftInput {
  instruction: string;
  targetUrl?: string;
  currentProject?: WorkflowProject;
  currentDraft?: AIWorkflowDraftProject;
  siteEvidence?: AIWorkflowSiteEvidence;
  conversation?: AIWorkflowConversationTurn[];
}
export interface AIWorkflowDraftProject {
  name: string;
  description: string;
  targetUrl: string;
  allowedDomains: string[];
  adapter: AdapterKind;
  parameters: WorkflowParameter[];
  steps: WorkflowStep[];
  summary: string;
  assumptions: string[];
}
export interface AIWorkflowDraftResult {
  draft: AIWorkflowDraftProject;
  validation: { valid: boolean; errors: string[]; warnings: string[] };
  ai: { providerId: string; providerKind: string; model?: string; usage?: AIGenerateResponse["usage"] };
}
export interface AIWorkflowDraftDiffItem {
  type: "added" | "removed" | "modified" | "moved";
  id: string;
  beforeName?: string;
  afterName?: string;
  beforePath?: string;
  afterPath?: string;
}
export interface AIWorkflowDraftDiff {
  changed: boolean;
  summary: string[];
  steps: AIWorkflowDraftDiffItem[];
  parameters: { added: string[]; removed: string[]; modified: string[] };
}
export interface AIWorkflowRevisionResult extends AIWorkflowDraftResult {
  revision: { requiresExploration: boolean; reason?: string; changeSummary: string[] };
  diff: AIWorkflowDraftDiff;
}

type StepCounter = { value: number; ids: Set<string> };

export function buildAIWorkflowRequest(input: AIWorkflowDraftInput): AIGenerateRequest {
  const currentProject = input.currentProject ? sanitizeProjectContext(input.currentProject) : undefined;
  return {
    temperature: 0.1,
    maxTokens: 10000,
    responseFormat: "json",
    metadata: { feature: "automation-studio-workflow-draft", schemaVersion: "1.0.12" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify({ instruction: input.instruction, targetUrl: input.targetUrl || undefined, currentProject, siteEvidence: input.siteEvidence ? sanitizeSiteEvidence(input.siteEvidence) : undefined }, null, 2) }
    ]
  };
}

export function buildAIWorkflowRevisionRequest(input: AIWorkflowDraftInput & { currentDraft: AIWorkflowDraftProject }): AIGenerateRequest {
  const currentProject = input.currentProject ? sanitizeProjectContext(input.currentProject) : undefined;
  const conversation = (input.conversation ?? []).slice(-16).map((turn) => ({ role: turn.role, content: limit(turn.content, 4000) }));
  return {
    temperature: 0.05,
    maxTokens: 12000,
    responseFormat: "json",
    metadata: { feature: "automation-studio-workflow-revision", schemaVersion: "1.0.12" },
    messages: [
      { role: "system", content: REVISION_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify({ modification: input.instruction, conversation, currentDraft: sanitizeDraftContext(input.currentDraft), currentProject, siteEvidence: input.siteEvidence ? sanitizeSiteEvidence(input.siteEvidence) : undefined }, null, 2) }
    ]
  };
}

export function createAIWorkflowDraft(response: AIGenerateResponse, input: AIWorkflowDraftInput): AIWorkflowDraftResult {
  const parsed = parseAIWorkflowJson(response.text);
  const normalized = normalizeAIWorkflowDraft(parsed, input);
  return { ...normalized, ai: { providerId: response.providerId, providerKind: response.providerKind, model: response.model, usage: response.usage } };
}

export function createAIWorkflowRevision(response: AIGenerateResponse, input: AIWorkflowDraftInput & { currentDraft: AIWorkflowDraftProject }): AIWorkflowRevisionResult {
  const parsed = parseAIWorkflowJson(response.text);
  const requiresExploration = parsed.requiresExploration === true;
  const reason = limit(parsed.explorationReason, 1200) || undefined;
  const rawDraft = Array.isArray(parsed.steps) ? parsed : draftToRaw(input.currentDraft);
  const normalized = normalizeAIWorkflowDraft(rawDraft, { ...input, currentDraft: input.currentDraft });
  const changeSummary = Array.isArray(parsed.changeSummary) ? parsed.changeSummary.map((x) => limit(x, 300)).filter(Boolean).slice(0, 12) : [];
  return {
    ...normalized,
    ai: { providerId: response.providerId, providerKind: response.providerKind, model: response.model, usage: response.usage },
    revision: { requiresExploration, reason, changeSummary },
    diff: diffAIWorkflowDraft(input.currentDraft, normalized.draft)
  };
}

export function parseAIWorkflowJson(text: string): Record<string, unknown> {
  const raw = String(text ?? "").trim();
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fenced?.[1]) candidates.push(fenced[1].trim());
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}"); if (a >= 0 && b > a) candidates.push(raw.slice(a, b + 1));
  for (const candidate of candidates) { try { const parsed = JSON.parse(candidate); if (isRecord(parsed)) return parsed; } catch {} }
  throw new Error("AI 回傳內容不是可解析的 Workflow JSON。請重試或更換模型。 ");
}

export function normalizeAIWorkflowDraft(raw: Record<string, unknown>, input: AIWorkflowDraftInput): Omit<AIWorkflowDraftResult, "ai"> {
  const warnings: string[] = [], errors: string[] = [];
  const parameters = normalizeParameters(raw.parameters, warnings);
  const counter: StepCounter = { value: 0, ids: new Set<string>() };
  const steps = normalizeSteps(raw.steps, warnings, counter, 0);
  const targetUrl = normalizeHttpUrl(input.targetUrl || raw.targetUrl || firstNavigationUrl(steps));
  if (!targetUrl) errors.push("缺少有效的 HTTP(S) 目標網址。 ");
  else repairNavigateUrls(steps, targetUrl, warnings);
  if (!steps.length) errors.push("AI 草稿沒有可用流程步驟。 ");
  const adapterRaw = String(raw.adapter ?? "generic");
  const adapter = ADAPTERS.has(adapterRaw as AdapterKind) ? adapterRaw as AdapterKind : "generic";
  const domains = deriveDomains(targetUrl, steps);
  validateSteps(steps, warnings, errors, input);
  return {
    draft: {
      name: limit(raw.name ?? "AI 產生的自動化流程", 100) || "AI 產生的自動化流程",
      description: limit(raw.description ?? input.instruction, 2000),
      summary: limit(raw.summary ?? raw.description ?? "AI 已依需求產生 Workflow 草稿。", 1200),
      assumptions: Array.isArray(raw.assumptions) ? raw.assumptions.map((x) => limit(x, 400)).filter(Boolean).slice(0, 12) : [],
      targetUrl: targetUrl || "",
      allowedDomains: domains,
      adapter,
      parameters,
      steps
    },
    validation: { valid: errors.length === 0, errors, warnings: [...new Set(warnings)] }
  };
}

export function diffAIWorkflowDraft(previous: AIWorkflowDraftProject, next: AIWorkflowDraftProject): AIWorkflowDraftDiff {
  const summary: string[] = [];
  if (previous.targetUrl !== next.targetUrl) summary.push(`目標網址：${previous.targetUrl || "—"} → ${next.targetUrl || "—"}`);
  if (previous.adapter !== next.adapter) summary.push(`Adapter：${previous.adapter} → ${next.adapter}`);
  if (JSON.stringify(previous.allowedDomains ?? []) !== JSON.stringify(next.allowedDomains ?? [])) summary.push("允許網域已調整");

  const beforeSteps = flattenSteps(previous.steps);
  const afterSteps = flattenSteps(next.steps);
  const beforeById = new Map(beforeSteps.map((item) => [item.step.id, item]));
  const afterById = new Map(afterSteps.map((item) => [item.step.id, item]));
  const steps: AIWorkflowDraftDiffItem[] = [];
  for (const item of beforeSteps) {
    const after = afterById.get(item.step.id);
    if (!after) { steps.push({ type:"removed", id:item.step.id, beforeName:item.step.name, beforePath:item.path }); continue; }
    if (item.path !== after.path) steps.push({ type:"moved", id:item.step.id, beforeName:item.step.name, afterName:after.step.name, beforePath:item.path, afterPath:after.path });
    if (stableStepJson(item.step) !== stableStepJson(after.step)) steps.push({ type:"modified", id:item.step.id, beforeName:item.step.name, afterName:after.step.name, beforePath:item.path, afterPath:after.path });
  }
  for (const item of afterSteps) if (!beforeById.has(item.step.id)) steps.push({ type:"added", id:item.step.id, afterName:item.step.name, afterPath:item.path });

  const beforeParams = new Map((previous.parameters ?? []).map((p) => [p.name, p]));
  const afterParams = new Map((next.parameters ?? []).map((p) => [p.name, p]));
  const parameters = { added: [] as string[], removed: [] as string[], modified: [] as string[] };
  for (const [name, p] of beforeParams) {
    const after = afterParams.get(name);
    if (!after) parameters.removed.push(name);
    else if (JSON.stringify(p) !== JSON.stringify(after)) parameters.modified.push(name);
  }
  for (const name of afterParams.keys()) if (!beforeParams.has(name)) parameters.added.push(name);
  if (steps.length) summary.push(`流程步驟變更 ${steps.length} 項`);
  const paramCount = parameters.added.length + parameters.removed.length + parameters.modified.length;
  if (paramCount) summary.push(`參數變更 ${paramCount} 項`);
  return { changed: summary.length > 0 || steps.length > 0 || paramCount > 0, summary, steps, parameters };
}

function normalizeParameters(value: unknown, warnings: string[]): WorkflowParameter[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 40).map((item, index) => {
    const raw = isRecord(item) ? item : {};
    const name = safeName(raw.name, index + 1);
    const requested = String(raw.type ?? "text");
    const allowed = new Set(["text","number","date","boolean","select","secret"]);
    const sensitive = raw.sensitive === true || requested === "secret" || /password|token|api.?key|secret|密碼|驗證碼|金鑰/i.test(`${name} ${String(raw.label ?? "")}`);
    const type = sensitive ? "secret" : (allowed.has(requested) ? requested : "text");
    const explicitId = safeIdentifier(raw.id);
    const p: WorkflowParameter = { id: explicitId || `p-ai-${index + 1}-${name}`, name, label: limit(raw.label ?? name, 120) || name, type: type as WorkflowParameter["type"], required: raw.required === true, description: limit(raw.description, 500) || undefined, options: Array.isArray(raw.options) ? raw.options.map((x) => limit(x, 200)).filter(Boolean).slice(0, 100) : [], sensitive };
    if (!sensitive && raw.defaultValue !== undefined) p.defaultValue = p.type === "boolean" ? raw.defaultValue === true : limit(raw.defaultValue, 500);
    else if (sensitive && raw.defaultValue !== undefined) warnings.push(`敏感參數「${p.label}」的預設值已移除。`);
    if (typeof raw.dependsOn === "string" && raw.dependsOn.trim()) p.dependsOn = raw.dependsOn.trim();
    if (isRecord(raw.dependentOptions)) p.dependentOptions = Object.fromEntries(Object.entries(raw.dependentOptions).map(([k,v]) => [k, Array.isArray(v) ? v.map((x) => limit(x, 200)).filter(Boolean) : []]));
    return p;
  });
}

function normalizeSteps(value: unknown, warnings: string[], counter: StepCounter, depth: number): WorkflowStep[] {
  if (!Array.isArray(value) || depth > 4) return [];
  const out: WorkflowStep[] = [];
  for (const item of value) {
    if (counter.value >= 120) break;
    const raw = isRecord(item) ? item : {};
    const kind = String(raw.kind ?? "");
    if (kind === "script") { warnings.push(`步驟「${limit(raw.name ?? "script", 100)}」要求執行 script；基於安全性已移除。`); continue; }
    if (!SAFE_KINDS.has(kind)) { warnings.push(`不支援的 AI 步驟類型「${kind || "未指定"}」已略過。`); continue; }
    counter.value += 1;
    const preferredId = safeIdentifier(raw.id) || `ai-step-${counter.value}`;
    let stepId = preferredId;
    let suffix = 2;
    while (counter.ids.has(stepId)) stepId = `${preferredId}-${suffix++}`;
    counter.ids.add(stepId);
    const step: WorkflowStep = { id: stepId, name: limit(raw.name ?? `${kind} ${counter.value}`, 160), kind: kind as WorkflowStep["kind"], enabled: raw.enabled !== false };
    if (raw.description !== undefined) step.description = limit(raw.description, 1000);
    if (raw.url !== undefined) { const url = normalizeHttpUrl(raw.url); if (url) step.url = url; else warnings.push(`步驟「${step.name}」的非 HTTP(S) 網址已移除。`); }
    if (typeof raw.value === "boolean") step.value = raw.value; else if (raw.value !== undefined) step.value = limit(raw.value, 2000);
    if (Array.isArray(raw.selectors)) step.selectors = raw.selectors.map(normalizeSelector).filter(Boolean).slice(0, 8) as SelectorRule[];
    if (["unique","first","last","nth"].includes(String(raw.matchMode))) step.matchMode = String(raw.matchMode) as WorkflowStep["matchMode"];
    if (step.matchMode === "nth") step.matchIndex = clamp(raw.matchIndex, 1, 1000, 1);
    if (raw.autoFrameSearch === true) step.autoFrameSearch = true;
    if (["button","element","url"].includes(String(raw.manualCompletionMode))) step.manualCompletionMode = String(raw.manualCompletionMode) as WorkflowStep["manualCompletionMode"];
    if (raw.manualExpected !== undefined) step.manualExpected = limit(raw.manualExpected, 1000);
    if (raw.timeoutMs !== undefined) step.timeoutMs = clamp(raw.timeoutMs, 100, 300000, 30000);
    if (raw.retryCount !== undefined) step.retryCount = clamp(raw.retryCount, 0, 5, 1);
    if (["auto","direct","click"].includes(String(raw.downloadMode))) step.downloadMode = String(raw.downloadMode) as WorkflowStep["downloadMode"];
    if (["original","custom"].includes(String(raw.downloadFileNameMode))) step.downloadFileNameMode = String(raw.downloadFileNameMode) as WorkflowStep["downloadFileNameMode"];
    if (raw.downloadFileName !== undefined) step.downloadFileName = limit(raw.downloadFileName, 260);
    if (raw.pdfFileName !== undefined) step.pdfFileName = limit(raw.pdfFileName, 260);
    if (raw.pdfPageSize === "A4" || raw.pdfPageSize === "Letter") step.pdfPageSize = raw.pdfPageSize;
    if (raw.pdfOrientation === "portrait" || raw.pdfOrientation === "landscape") step.pdfOrientation = raw.pdfOrientation;
    if (typeof raw.pdfPrintBackground === "boolean") step.pdfPrintBackground = raw.pdfPrintBackground;
    if (typeof raw.pdfDisplayHeaderFooter === "boolean") step.pdfDisplayHeaderFooter = raw.pdfDisplayHeaderFooter;
    if (raw.pdfHeaderTemplate !== undefined) step.pdfHeaderTemplate = limit(raw.pdfHeaderTemplate, 10_000);
    if (raw.pdfFooterTemplate !== undefined) step.pdfFooterTemplate = limit(raw.pdfFooterTemplate, 10_000);
    if (raw.pdfScale !== undefined) {
      const scale = Number(raw.pdfScale);
      step.pdfScale = Number.isFinite(scale) ? Math.min(2, Math.max(0.1, scale)) : 1;
    }
    if (typeof raw.pdfFullPage === "boolean") step.pdfFullPage = raw.pdfFullPage;
    if (typeof raw.pdfUseLocalTime === "boolean") step.pdfUseLocalTime = raw.pdfUseLocalTime;
    for (const key of ["pdfMarginTopMm", "pdfMarginRightMm", "pdfMarginBottomMm", "pdfMarginLeftMm"] as const) {
      if (raw[key] !== undefined) step[key] = clamp(raw[key], 0, 50, 10);
    }
    if (raw.outputVariable !== undefined) step.outputVariable = safeName(raw.outputVariable, counter.value);
    if (["text","html","attribute"].includes(String(raw.extractMode))) step.extractMode = String(raw.extractMode) as WorkflowStep["extractMode"];
    if (raw.extractAttribute !== undefined) step.extractAttribute = limit(raw.extractAttribute, 200);
    if (raw.sourceVariable !== undefined) step.sourceVariable = safeName(raw.sourceVariable, counter.value);
    if (["waitNewFirst", "waitNewListItem"].includes(kind) && raw.periodicRefresh === true) {
      step.periodicRefresh = true;
      const seconds = Number(raw.refreshIntervalSeconds ?? 10);
      step.refreshIntervalSeconds = Number.isInteger(seconds) ? Math.max(5, Math.min(600, seconds)) : 10;
    }
    if (raw.regexPattern !== undefined) step.regexPattern = limit(raw.regexPattern, 2000);
    if (raw.regexFlags !== undefined) step.regexFlags = limit(raw.regexFlags, 20);
    if (raw.regexGroup !== undefined) step.regexGroup = clamp(raw.regexGroup, 0, 20, 0);
    if (raw.tabName !== undefined) step.tabName = limit(raw.tabName, 120);
    if (["name","url","title","index"].includes(String(raw.tabTargetMode))) step.tabTargetMode = String(raw.tabTargetMode) as WorkflowStep["tabTargetMode"];
    if (raw.tabTarget !== undefined) step.tabTarget = limit(raw.tabTarget, 1000);
    if (raw.tabIndex !== undefined) step.tabIndex = clamp(raw.tabIndex, 1, 100, 1);
    if (kind === "condition") { step.condition = isRecord(raw.condition) ? raw.condition as any : undefined; step.thenSteps = normalizeSteps(raw.thenSteps, warnings, counter, depth + 1); step.elseSteps = normalizeSteps(raw.elseSteps, warnings, counter, depth + 1); }
    if (kind === "loop") { if (raw.loopVariable !== undefined) step.loopVariable = safeName(raw.loopVariable, counter.value); if (Array.isArray(raw.loopValues)) step.loopValues = raw.loopValues.map((x) => limit(x, 500)).filter(Boolean).slice(0, 100); if (raw.loopParameter !== undefined) step.loopParameter = safeName(raw.loopParameter, counter.value); step.steps = normalizeSteps(raw.steps, warnings, counter, depth + 1); }
    if (kind === "manual" && !step.manualCompletionMode) step.manualCompletionMode = "button";
    if (kind === "download" && !step.downloadMode) step.downloadMode = "auto";
    if (/password|token|secret|api.?key|密碼|驗證碼|金鑰/i.test(`${step.name} ${step.description ?? ""}`) && typeof step.value === "string" && step.value && !/\{\{[^}]+\}\}/.test(step.value)) { warnings.push(`步驟「${step.name}」疑似含敏感固定值，該值已移除。`); step.value = ""; }
    out.push(step);
  }
  return out;
}

function normalizeSelector(value: unknown): SelectorRule | undefined { if (!isRecord(value)) return undefined; const strategy = String(value.strategy ?? ""); const selectorValue = limit(value.value, 2000); if (!SELECTOR_STRATEGIES.has(strategy) || !selectorValue) return undefined; return { strategy: strategy as SelectorRule["strategy"], value: selectorValue, role: value.role ? limit(value.role, 100) : undefined, exact: value.exact === true, description: value.description ? limit(value.description, 500) : undefined }; }
function validateSteps(steps: WorkflowStep[], warnings: string[], errors: string[], input: AIWorkflowDraftInput): void {
  const selectorRequired = new Set(["click","dblclick","fill","select","upload","hover","check","uncheck","download","extractText","captureListSnapshot","waitNewListItem"]);
  const trusted = trustedSelectorKeys(input);
  // Initial draft generation requires a completed exploration pass. Revisions are different:
  // an existing draft already carries trusted selectors, so an unrelated/incomplete inspection
  // session must not block simple logic/name/order/timeout changes. New or changed interactive
  // selectors are still rejected below unless they are present in currentDraft/currentProject or
  // verified by siteEvidence.
  if (!input.currentDraft && input.siteEvidence && !input.siteEvidence.readyForDraft) errors.push("AI 網站探索尚未完成，請先完成實際網站檢視或人工操作後再產生流程。");
  visit(steps, (s) => {
    if (s.kind === "navigate" && !s.url) {
      const fallback = normalizeHttpUrl(input.targetUrl || input.currentDraft?.targetUrl || input.currentProject?.targetUrl);
      if (!fallback) errors.push(`步驟「${s.name}」缺少網址，且流程沒有可用的目標網址。`);
    }
    if (s.kind === "newTab" && !s.url && !s.value) warnings.push(`步驟「${s.name}」未指定網址，執行時會開啟空白分頁。`);
    if (selectorRequired.has(s.kind) && !(s.selectors?.length)) { errors.push(`步驟「${s.name}」沒有經網站檢視取得 selector，已阻止建立流程。`); return; }
    if ((input.siteEvidence || input.currentDraft || input.currentProject) && s.selectors?.length && selectorRequired.has(s.kind)) {
      const matched = s.selectors.some((selector) => trusted.has(selectorKey(selector)));
      if (!matched) errors.push(`步驟「${s.name}」的 selector 未出現在本次實際網站探索或既有流程中，請重新探索。`);
    }
  });
  if (input.siteEvidence && !input.siteEvidence.trace.some((step) => (step.selectors?.length ?? 0) > 0)) warnings.push("本次網站探索尚未錄得互動 selector；若需求只有開啟網址可忽略，否則建議繼續探索。");
}

function trustedSelectorKeys(input: AIWorkflowDraftInput): Set<string> {
  const keys = new Set<string>();
  for (const selector of input.siteEvidence?.verifiedSelectors ?? []) keys.add(selectorKey(selector));
  if (input.currentProject) visit(input.currentProject.steps, (step) => { for (const selector of step.selectors ?? []) keys.add(selectorKey(selector)); });
  if (input.currentDraft) visit(input.currentDraft.steps, (step) => { for (const selector of step.selectors ?? []) keys.add(selectorKey(selector)); });
  return keys;
}

function selectorKey(selector: SelectorRule): string { return `${selector.strategy}|${selector.role ?? ""}|${selector.exact === true ? "1" : "0"}|${selector.value}`; }

function sanitizeSiteEvidence(evidence: AIWorkflowSiteEvidence): Record<string, unknown> {
  return {
    startedAt: evidence.startedAt, targetUrl: evidence.targetUrl, currentUrl: evidence.currentUrl, readyForDraft: evidence.readyForDraft, requiresManual: evidence.requiresManual, manualReason: evidence.manualReason,
    trace: evidence.trace.slice(-30).map((step) => ({ index:step.index, action:step.action, label:step.label, pageUrl:step.pageUrl, frameUrl:step.frameUrl, selectors:safeSelectorsForAI(step.selectors ?? []), workflowValue:step.workflowValue, result:step.result })),
    pages: evidence.pages.slice(-12).map((page) => ({ url:page.url, title:page.title, elements:page.elements.slice(0,80).map((element) => ({ ref:element.ref, tag:element.tag, role:element.role, type:element.type, text:element.text, ariaLabel:element.ariaLabel, placeholder:element.placeholder, name:element.name, href:element.href ? sanitizeEvidenceUrl(element.href) : undefined, download:element.download, options:element.options })) }))
  };
}

function safeSelectorsForAI(selectors: SelectorRule[]): SelectorRule[] { return selectors.filter((selector) => !/[?&](?:token|key|secret|password|auth|code)=[^&"']+/i.test(selector.value)); }
function sanitizeEvidenceUrl(value: string): string { try { const url = new URL(value); for (const key of [...url.searchParams.keys()]) if (/token|key|secret|password|auth|code/i.test(key)) url.searchParams.set(key, "***"); return url.href; } catch { return String(value).slice(0, 500); } }
function deriveDomains(targetUrl: string, steps: WorkflowStep[]): string[] { const set = new Set<string>(); const add = (url?: string) => { if (!url || /\{\{/.test(url)) return; try { const u = new URL(url); if (["http:","https:"].includes(u.protocol)) set.add(u.hostname.toLowerCase()); } catch {} }; add(targetUrl); visit(steps, (s) => { if (s.kind === "navigate" || s.kind === "newTab") add(s.url); }); return [...set]; }
function sanitizeProjectContext(project: WorkflowProject): Record<string, unknown> { return { name:project.name, description:project.description, targetUrl:project.targetUrl, allowedDomains:project.allowedDomains, adapter:project.adapter, parameters:sanitizeParameters(project.parameters), steps:sanitizeSteps(project.steps) }; }
function sanitizeDraftContext(draft: AIWorkflowDraftProject): Record<string, unknown> { return { name:draft.name, description:draft.description, summary:draft.summary, assumptions:draft.assumptions, targetUrl:draft.targetUrl, allowedDomains:draft.allowedDomains, adapter:draft.adapter, parameters:sanitizeParameters(draft.parameters), steps:sanitizeSteps(draft.steps) }; }
function sanitizeParameters(parameters: WorkflowParameter[]): Record<string, unknown>[] { return parameters.map((p) => ({ id:p.id, name:p.name, label:p.label, type:p.type, required:p.required, options:p.options, dependsOn:p.dependsOn, dependentOptions:p.dependentOptions, sensitive:p.sensitive === true || p.type === "secret", ...((p.sensitive === true || p.type === "secret") ? {} : { defaultValue:p.defaultValue }) })); }
function sanitizeSteps(steps: WorkflowStep[]): Record<string, unknown>[] { return steps.map((s) => ({ id:s.id, name:s.name, kind:s.kind, enabled:s.enabled, description:s.description, url:s.url, selectors:safeSelectorsForAI(s.selectors ?? []), matchMode:s.matchMode, matchIndex:s.matchIndex, autoFrameSearch:s.autoFrameSearch, manualCompletionMode:s.manualCompletionMode, manualExpected:s.manualExpected, downloadMode:s.downloadMode, downloadFileNameMode:s.downloadFileNameMode, downloadFileName:s.downloadFileName, pdfFileName:s.pdfFileName, pdfPageSize:s.pdfPageSize, pdfOrientation:s.pdfOrientation, pdfPrintBackground:s.pdfPrintBackground, pdfMarginTopMm:s.pdfMarginTopMm, pdfMarginRightMm:s.pdfMarginRightMm, pdfMarginBottomMm:s.pdfMarginBottomMm, pdfMarginLeftMm:s.pdfMarginLeftMm, pdfDisplayHeaderFooter:s.pdfDisplayHeaderFooter, pdfHeaderTemplate:s.pdfHeaderTemplate, pdfFooterTemplate:s.pdfFooterTemplate, pdfScale:s.pdfScale, pdfFullPage:s.pdfFullPage, pdfUseLocalTime:s.pdfUseLocalTime, timeoutMs:s.timeoutMs, retryCount:s.retryCount, condition:s.condition, loopVariable:s.loopVariable, loopValues:s.loopValues, loopParameter:s.loopParameter, outputVariable:s.outputVariable, extractMode:s.extractMode, extractAttribute:s.extractAttribute, sourceVariable:s.sourceVariable, listLimit:s.listLimit, clickOnMatch:s.clickOnMatch, periodicRefresh:s.periodicRefresh, refreshIntervalSeconds:s.refreshIntervalSeconds, regexPattern:s.regexPattern, regexFlags:s.regexFlags, regexGroup:s.regexGroup, tabName:s.tabName, tabTargetMode:s.tabTargetMode, tabTarget:s.tabTarget, tabIndex:s.tabIndex, ...((s.kind === "script" || /password|token|secret|密碼|驗證碼/i.test(`${s.name} ${s.description ?? ""}`)) ? {} : { value:s.value }), thenSteps:s.thenSteps ? sanitizeSteps(s.thenSteps) : undefined, elseSteps:s.elseSteps ? sanitizeSteps(s.elseSteps) : undefined, steps:s.steps ? sanitizeSteps(s.steps) : undefined })); }
function draftToRaw(draft: AIWorkflowDraftProject): Record<string, unknown> { return JSON.parse(JSON.stringify(draft)) as Record<string, unknown>; }
function flattenSteps(steps: WorkflowStep[], prefix = ""): { step: WorkflowStep; path: string }[] { const out: { step: WorkflowStep; path: string }[] = []; steps.forEach((step, index) => { const path = prefix ? `${prefix}.${index + 1}` : `${index + 1}`; out.push({ step, path }); if (step.thenSteps) out.push(...flattenSteps(step.thenSteps, `${path}.then`)); if (step.elseSteps) out.push(...flattenSteps(step.elseSteps, `${path}.else`)); if (step.steps) out.push(...flattenSteps(step.steps, `${path}.loop`)); }); return out; }
function stableStepJson(step: WorkflowStep): string { const { thenSteps, elseSteps, steps, ...rest } = step; return JSON.stringify(rest); }
function repairNavigateUrls(steps: WorkflowStep[], targetUrl: string, warnings: string[]): void {
  visit(steps, (step) => {
    if (step.kind !== "navigate" || step.url) return;
    const valueUrl = normalizeHttpUrl(typeof step.value === "string" ? step.value : "");
    step.url = valueUrl || targetUrl;
    warnings.push(`步驟「${step.name}」未提供網址，已自動使用流程目標網址 ${step.url}。`);
  });
}
function firstNavigationUrl(steps: WorkflowStep[]): string { let result = ""; visit(steps, (s) => { if (!result && (s.kind === "navigate" || s.kind === "newTab") && s.url) result = s.url; }); return result; }
function visit(steps: WorkflowStep[], fn: (s: WorkflowStep) => void): void { for (const s of steps) { fn(s); if (s.thenSteps) visit(s.thenSteps, fn); if (s.elseSteps) visit(s.elseSteps, fn); if (s.steps) visit(s.steps, fn); } }
function normalizeHttpUrl(value: unknown): string { const text = String(value ?? "").trim(); if (!text || /\{\{/.test(text)) return ""; try { const u = new URL(text); return ["http:","https:"].includes(u.protocol) ? u.toString() : ""; } catch { return ""; } }
function safeName(value: unknown, n: number): string { let name = String(value ?? "").trim().replace(/[^A-Za-z0-9_]/g, "_"); if (!name || !/^[A-Za-z_]/.test(name)) name = `parameter_${n}${name ? `_${name}` : ""}`; return name.slice(0, 80); }
function safeIdentifier(value: unknown): string { const text = String(value ?? "").trim(); return /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(text) ? text : ""; }
function limit(value: unknown, max: number): string { return String(value ?? "").trim().slice(0, max); }
function clamp(value: unknown, min: number, max: number, fallback: number): number { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

const SYSTEM_PROMPT = `你是 Automation Studio V2.1.0 的 Workflow 設計器。把使用者自然語言需求轉成單一 JSON object，不要 Markdown。輸出欄位：name, description, summary, assumptions, targetUrl, adapter, parameters, steps。\n可用 step kind：navigate, manual, click, dblclick, fill, select, upload, press, hover, check, uncheck, wait, assert, download, savePagePdf, screenshot, condition, loop, extractText, extractPattern, clipboard, newTab, switchTab, waitNewFirst, captureListSnapshot, waitNewListItem。禁止 script。\nSelector strategy：role, label, placeholder, text, name, testId, css, xpath, component。\n若提供 siteEvidence：互動步驟的 selectors 必須直接沿用 siteEvidence.trace[].selectors 或 currentProject 已存在的 selectors；不可猜測、不可自行發明 selector。siteEvidence.pages 只用於理解實際頁面結構。若需求中的某個互動尚未被實際探索到，改成 manual 步驟並在 assumptions 說明，不得輸出沒有 selector 的 click/fill/select/download。\n若 trace 已顯示實際操作順序，優先以該順序建立步驟；workflowValue 含 {{參數}} 時保留為參數值。\n安全：不得硬編碼帳密、Cookie、MFA、Token、API Key；需要敏感輸入時建立 type=secret、sensitive=true 且不要 defaultValue；不穩定登入優先 manual。navigate 需明確輸出 url；若是開啟初始目標頁，url 必須使用 targetUrl。newTab 若要開啟網址只能使用 HTTP(S)。下載預設 downloadMode=auto。動態清單優先 captureListSnapshot -> waitNewListItem。waitNewListItem 或 waitNewFirst 如需定期重新整理頁面，設定 periodicRefresh=true、refreshIntervalSeconds=10（秒，可設 5～600）；預設為關閉。保存目前網頁為 PDF 時使用 savePagePdf，不需要 selector；紙張預設 A4、直向、邊界 10 mm、縮放 100%、不輸出頁首與頁尾、完整頁面，並使用本機時間命名。需要頁首或頁尾時可設定 pdfDisplayHeaderFooter=true，使用 pdfHeaderTemplate／pdfFooterTemplate HTML 範本；縮放 pdfScale 範圍為 0.1 至 2。所有步驟名稱使用繁體中文。若提供 currentProject，輸出完整 replacement draft 而非 patch。\nDOWNLOAD TRACE RULE: when siteEvidence.trace[].action is download, emit a Workflow step with kind=download and downloadMode=auto, not click/manual. Local or multiple file downloads are read-only operations and do not require a manual step unless the same action changes remote data.`;

const REVISION_SYSTEM_PROMPT = `你是 Automation Studio V1.2.4 的對話式 Workflow 修改助理。你會收到 currentDraft、使用者本輪 modification、最近對話 conversation，以及可選的 siteEvidence/currentProject。請輸出單一 JSON object，不要 Markdown。\n輸出必須包含：requiresExploration(boolean)、explorationReason(string，可空)、changeSummary(string array)、以及完整 replacement draft 欄位 name, description, summary, assumptions, targetUrl, adapter, parameters, steps。\n重要原則：\n1. 只修改使用者本輪明確要求的部分；未提及的步驟、參數、順序、selector、名稱及設定保持不變。\n2. currentDraft 中既有 step.id 與 parameter.id 必須保留；只有新增項目才能建立新 id，且 id 僅使用英數字、句點、底線、連字號並以英數字開頭。\n3. 若修改只涉及等待時間、名稱、說明、參數、條件、啟用狀態、既有步驟順序等，不需要重新探索網站，requiresExploration=false。\n4. 若修改需要點擊／填入／選擇／下載／擷取一個 currentDraft 與 siteEvidence 都沒有可信 selector 的新網站元素，requiresExploration=true，explorationReason 說明需要查找什麼。此時不要猜 selector，不要硬新增 manual 來假裝完成；完整 draft 請維持 currentDraft 原狀，等待探索後再修改。\n5. 若 siteEvidence 已含本輪需要的新元素 selector，直接沿用它並 requiresExploration=false。任何互動 selector 只能沿用 currentDraft、currentProject 或 siteEvidence 中已存在的 selector，不可發明 CSS/XPath。\n6. 禁止 script；不得硬編碼帳密、Cookie、MFA、Token、API Key。既有 navigate 步驟必須保留 url；新增 navigate 若是回到入口頁，使用 currentDraft.targetUrl。\n7. changeSummary 用繁體中文列出本輪實際打算變更的重點，最多 12 項。\n8. 必須輸出完整 replacement draft，不要輸出 JSON Patch。\n9. DOWNLOAD TRACE RULE: siteEvidence trace action=download is trusted download evidence. Use kind=download with downloadMode=auto. Multiple/local downloads do not require manual confirmation unless the action also changes remote data.`;

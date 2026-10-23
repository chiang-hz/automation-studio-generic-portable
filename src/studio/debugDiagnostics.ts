import fs from "node:fs/promises";
import path from "node:path";
import { createZip } from "./zip.ts";
import type { WorkflowProject, WorkflowRun, WorkflowStep } from "./types.ts";
import { redactSecrets, redactText } from "./ai/sanitize.ts";

export interface FailurePageSummary {
  capturedAt: string;
  url: string;
  title: string;
  bodyText: string;
  frames: Array<{
    index: number;
    name?: string;
    parentIndex?: number;
    path: string[];
    url: string;
    title?: string;
    bodyText: string;
    elements: Array<Record<string, unknown>>;
    selectorCandidates: Array<Record<string, unknown>>;
  }>;
}

const MAX_BODY_TEXT = 50_000;
const MAX_ELEMENTS = 260;

export async function captureFailureDiagnostics(debugDir: string, page: any): Promise<void> {
  await fs.mkdir(debugDir, { recursive: true });
  const frames: FailurePageSummary["frames"] = [];
  const runtimeFrames = page.frames?.() ?? [];
  for (let index = 0; index < runtimeFrames.length; index += 1) {
    const frame = runtimeFrames[index];
    const snapshot = await captureFrameSummary(frame).catch(() => undefined);
    if (!snapshot) continue;
    const parent = frame.parentFrame?.() ?? undefined;
    const parentIndex = parent ? runtimeFrames.indexOf(parent) : -1;
    frames.push({
      index,
      name: redactExternalText(String(frame.name?.() ?? "")) || undefined,
      parentIndex: parentIndex >= 0 ? parentIndex : undefined,
      path: buildFramePath(frame).map((item) => redactExternalText(item)),
      ...snapshot
    });
  }
  const summary: FailurePageSummary = {
    capturedAt: new Date().toISOString(),
    url: sanitizeExternalUrl(String(page.url?.() ?? "")),
    title: redactExternalText(await page.title?.().catch?.(() => "") ?? ""),
    bodyText: aggregateFrameText(frames),
    frames
  };
  await fs.writeFile(path.join(debugDir, "page-summary.json"), JSON.stringify(summary, null, 2), "utf8");
  await fs.writeFile(path.join(debugDir, "page-text.txt"), summary.bodyText, "utf8");
  await captureRedactedFailureScreenshot(page, path.join(debugDir, "failure-redacted.png")).catch(() => undefined);
}

async function captureFrameSummary(frame: any): Promise<Omit<FailurePageSummary["frames"][number], "index" | "name" | "parentIndex" | "path">> {
  const raw = await frame.evaluate(({ maxBodyText, maxElements }: { maxBodyText: number; maxElements: number }) => {
    const text = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, maxBodyText);
    const nodes = Array.from(document.querySelectorAll("a,button,input,textarea,select,[role],[contenteditable='true'],[onclick],[ondblclick],[tabindex]"))
      .slice(0, maxElements)
      .map((element: Element) => {
        const html = element as HTMLElement;
        const input = element as HTMLInputElement;
        const anchor = element as HTMLAnchorElement;
        const textContent = (html.innerText || element.getAttribute("aria-label") || input.placeholder || "").replace(/\s+/g, " ").trim().slice(0, 180);
        return {
          tag: element.tagName.toLowerCase(),
          id: html.id || undefined,
          role: element.getAttribute("role") || undefined,
          name: input.name || undefined,
          type: input.type || undefined,
          ariaLabel: element.getAttribute("aria-label") || undefined,
          placeholder: input.placeholder || undefined,
          testId: element.getAttribute("data-testid") || undefined,
          title: element.getAttribute("title") || undefined,
          text: textContent || undefined,
          href: anchor.href || undefined,
          visible: Boolean((html.offsetWidth || html.offsetHeight || html.getClientRects().length) && getComputedStyle(html).visibility !== "hidden")
        };
      });
    return { url: location.href, title: document.title, bodyText: text, elements: nodes };
  }, { maxBodyText: MAX_BODY_TEXT, maxElements: MAX_ELEMENTS });
  const elements = Array.isArray(raw.elements) ? raw.elements.map((item: any) => ({
    ...item,
    text: item.text ? redactExternalText(String(item.text)) : undefined,
    href: item.href ? sanitizeExternalUrl(String(item.href)) : undefined
  })) : [];
  return {
    url: sanitizeExternalUrl(String(raw.url ?? "")),
    title: redactExternalText(String(raw.title ?? "")),
    bodyText: redactExternalText(String(raw.bodyText ?? "")).slice(0, MAX_BODY_TEXT),
    elements,
    selectorCandidates: buildSelectorCandidates(elements)
  };
}

function buildSelectorCandidates(elements: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const candidates: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const push = (candidate: Record<string, unknown>) => {
    const key = JSON.stringify(candidate);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };
  for (const item of elements) {
    const tag = String(item.tag ?? "").trim();
    const id = String(item.id ?? "").trim();
    const label = String(item.ariaLabel ?? "").trim();
    const name = String(item.name ?? "").trim();
    const placeholder = String(item.placeholder ?? "").trim();
    const testId = String(item.testId ?? "").trim();
    const text = String(item.text ?? "").trim();
    const title = String(item.title ?? "").trim();
    if (testId) push({ strategy: "testId", value: testId });
    if (label) push({ strategy: "label", value: label });
    if (name) push({ strategy: "name", value: name });
    if (placeholder) push({ strategy: "placeholder", value: placeholder });
    if (id && /^[A-Za-z][A-Za-z0-9_:.\-]*$/.test(id)) push({ strategy: "css", value: `#${cssEscape(id)}:visible` });
    if (title && tag) push({ strategy: "css", value: `${tag}[title="${cssAttributeEscape(title)}"]:visible` });
    if (text && text.length <= 80) push({ strategy: "text", value: text, exact: true });
  }
  return candidates.slice(0, 360);
}

async function captureRedactedFailureScreenshot(page: any, filePath: string): Promise<void> {
  const marker = `automation-studio-redaction-${Date.now()}`;
  const frames = page.frames?.() ?? [page];
  for (const frame of frames) {
    await frame.evaluate((id: string) => {
      if (document.getElementById(id)) return;
      const style = document.createElement("style");
      style.id = id;
      style.textContent = `
        input, textarea, select, [contenteditable="true"], [autocomplete="one-time-code"], [autocomplete="current-password"], [autocomplete="new-password"] {
          color: transparent !important;
          text-shadow: 0 0 8px rgba(0,0,0,.95) !important;
          caret-color: transparent !important;
        }
        input::placeholder, textarea::placeholder { color: transparent !important; }
      `;
      document.documentElement.appendChild(style);
    }, marker).catch(() => undefined);
  }
  try {
    await page.screenshot({ path: filePath, fullPage: true });
  } finally {
    for (const frame of frames) {
      await frame.evaluate((id: string) => document.getElementById(id)?.remove(), marker).catch(() => undefined);
    }
  }
}

function buildFramePath(frame: any): string[] {
  const path: string[] = [];
  let current: any = frame;
  while (current) {
    const name = String(current.name?.() ?? "").trim();
    const url = sanitizeExternalUrl(String(current.url?.() ?? ""));
    path.unshift(name ? `${name} :: ${url}` : url);
    current = current.parentFrame?.() ?? null;
  }
  return path.filter(Boolean);
}

function aggregateFrameText(frames: FailurePageSummary["frames"]): string {
  const sections = frames.map((frame) => {
    const header = `[Frame ${frame.index}${frame.name ? ` · ${frame.name}` : ""}] ${frame.url}`;
    const hierarchy = frame.path.length > 1 ? `Path: ${frame.path.join(" -> ")}` : "";
    return [header, hierarchy, frame.bodyText].filter(Boolean).join("\n");
  });
  return sections.join("\n\n").slice(0, MAX_BODY_TEXT * 4);
}

export async function readFailurePageSummary(debugDir: string): Promise<FailurePageSummary | undefined> {
  try {
    const raw = await fs.readFile(path.join(debugDir, "page-summary.json"), "utf8");
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value as FailurePageSummary : undefined;
  } catch {
    return undefined;
  }
}

export async function buildFailureDiagnosticZip(input: {
  project: WorkflowProject;
  run: WorkflowRun;
  failedStep?: WorkflowStep;
  events: Record<string, unknown>[];
  pageSummary?: FailurePageSummary;
}): Promise<{ fileName: string; buffer: Buffer }> {
  const { project, run, failedStep, events, pageSummary } = input;
  const sensitiveNames = new Set(project.parameters.filter((parameter) => parameter.sensitive || parameter.type === "secret").map((parameter) => parameter.name));
  const safeParameters = Object.fromEntries(Object.entries(run.parameters ?? {}).map(([key, value]) => [key, sensitiveNames.has(key) ? "***" : sanitizeExternalValue(value)]));
  const safeVariables = Object.fromEntries(Object.keys(run.variables ?? {}).map((key) => [key, "[value redacted for external sharing]"]));
  const safeEvents = events.slice(-300).map((event) => sanitizeExternalValue(event));
  const manifest = {
    schemaVersion: "1.0.12",
    generatedAt: new Date().toISOString(),
    note: "This package is sanitized for external troubleshooting. Form field values, secrets, authorization material, query values and workflow variable values are redacted. Review the redacted screenshot before sharing externally.",
    run: {
      id: run.id,
      projectId: run.projectId,
      projectName: run.projectName,
      status: run.status,
      mode: run.mode,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      errorCode: run.errorCode,
      errorMessage: redactExternalText(run.errorMessage ?? ""),
      currentStepId: run.currentStepId,
      completedSteps: run.completedSteps,
      totalSteps: run.totalSteps
    }
  };
  const projectSummary = {
    id: project.id,
    name: project.name,
    version: project.version,
    targetUrl: sanitizeExternalUrl(project.targetUrl),
    adapter: project.adapter,
    browser: {
      connectionMode: project.browser.connectionMode,
      channel: project.browser.channel,
      headless: project.browser.headless,
      defaultTimeoutMs: project.browser.defaultTimeoutMs,
      downloadTimeoutMs: project.browser.downloadTimeoutMs,
      downloadPdfInsteadOfPreview: project.browser.downloadPdfInsteadOfPreview
    },
    settings: {
      maxRetries: project.settings.maxRetries,
      safePlayback: project.settings.safePlayback,
      humanizedPlayback: project.settings.humanizedPlayback,
      minStepDelayMs: project.settings.minStepDelayMs,
      captureConsole: project.settings.captureConsole,
      captureNetwork: project.settings.captureNetwork
    },
    parameters: project.parameters.map((parameter) => ({ id: parameter.id, name: parameter.name, label: parameter.label, type: parameter.type, required: parameter.required, sensitive: Boolean(parameter.sensitive || parameter.type === "secret") })),
    stepOutline: flattenStepOutline(project.steps)
  };
  const entries: Array<{ name: string; data: Buffer | string }> = [
    { name: "README.txt", data: buildDiagnosticReadme() },
    { name: "manifest.json", data: JSON.stringify(manifest, null, 2) },
    { name: "project-summary.json", data: JSON.stringify(projectSummary, null, 2) },
    { name: "failed-step.json", data: JSON.stringify(failedStep ? sanitizeWorkflowStepForExternal(failedStep) : null, null, 2) },
    { name: "run-summary.json", data: JSON.stringify({ parameters: safeParameters, variables: safeVariables, steps: sanitizeExternalValue(run.steps), downloads: (run.downloads ?? []).map((file) => path.basename(file)) }, null, 2) },
    { name: "debug/events.json", data: JSON.stringify(safeEvents, null, 2) }
  ];
  if (pageSummary) {
    entries.push({ name: "page/page-summary.json", data: JSON.stringify(pageSummary, null, 2) });
    entries.push({ name: "page/page-text.txt", data: pageSummary.bodyText ?? "" });
  }
  const screenshotPath = path.join(run.debugDir, "failure-redacted.png");
  try {
    entries.push({ name: "page/failure-redacted.png", data: await fs.readFile(screenshotPath) });
  } catch {
    entries.push({ name: "page/screenshot-not-available.txt", data: "A redacted failure screenshot was not available. The page may have closed before capture or the runtime could not take a screenshot." });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return { fileName: `automation-studio-debug-${safeFileName(project.id)}-${safeFileName(run.id)}-${stamp}.zip`, buffer: createZip(entries) };
}


export function sanitizeWorkflowStepForExternal(step: WorkflowStep): unknown {
  const clone = structuredClone(step) as Record<string, unknown>;
  if (step.kind === "fill" || step.kind === "upload" || step.kind === "clipboard") {
    if (typeof clone.value === "string" && !/^\{\{[^{}]+\}\}$/.test(clone.value.trim())) clone.value = "[redacted step value]";
  }
  const sensitiveHint = `${step.name ?? ""} ${step.description ?? ""} ${JSON.stringify(step.selectors ?? [])}`;
  if (/password|passwd|pwd|otp|驗證碼|密碼|token|secret|api.?key/i.test(sensitiveHint) && "value" in clone) clone.value = "[redacted sensitive step value]";
  return sanitizeExternalValue(clone);
}

export function sanitizeExternalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const keys = [...url.searchParams.keys()];
    url.search = "";
    for (const key of keys.slice(0, 40)) url.searchParams.append(key, "***");
    url.hash = "";
    return url.toString();
  } catch {
    return redactExternalText(raw);
  }
}

export function redactExternalText(input: string): string {
  return redactText(String(input ?? ""))
    .replace(/([?&](?:code|otp|password|passwd|token|access_token|auth|key)=)[^&\s]+/gi, "$1***")
    .replace(/\b[A-Za-z0-9_-]{28,}\b/g, "***")
    .replace(/\b\d{6,}\b/g, (value) => /^20\d{6,}$/.test(value) ? value : "***");
}

export function sanitizeExternalValue(value: unknown): unknown {
  const redacted = redactSecrets(value);
  if (typeof redacted === "string") {
    if (/^[A-Za-z]:\\|^\//.test(redacted)) return `<local-path>/${path.basename(redacted)}`;
    if (/^https?:\/\//i.test(redacted)) return sanitizeExternalUrl(redacted);
    return redactExternalText(redacted);
  }
  if (Array.isArray(redacted)) return redacted.map(sanitizeExternalValue);
  if (redacted && typeof redacted === "object") {
    return Object.fromEntries(Object.entries(redacted as Record<string, unknown>).map(([key, item]) => [key, sanitizeExternalValue(item)]));
  }
  return redacted;
}

function flattenStepOutline(steps: WorkflowStep[], prefix = ""): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  steps.forEach((step, index) => {
    const position = prefix ? `${prefix}.${index + 1}` : String(index + 1);
    out.push({ position, id: step.id, name: step.name, kind: step.kind, enabled: step.enabled });
    if (step.thenSteps?.length) out.push(...flattenStepOutline(step.thenSteps, `${position}.then`));
    if (step.elseSteps?.length) out.push(...flattenStepOutline(step.elseSteps, `${position}.else`));
    if (step.steps?.length) out.push(...flattenStepOutline(step.steps, `${position}.loop`));
  });
  return out;
}

function buildDiagnosticReadme(): string {
  return [
    "Automation Studio failure diagnostic package",
    "",
    "Purpose: share enough context with a support engineer or external AI to understand a failed Test & Debug run.",
    "Sanitization: obvious secrets, authorization material, form-field values, query values and workflow variable values are redacted. The included screenshot also masks form fields.",
    "Important: visible page text or business data may still appear in the screenshot/page summary. Review the files before sharing outside your organization.",
    "",
    "Suggested files for an external AI:",
    "1. manifest.json",
    "2. failed-step.json",
    "3. run-summary.json",
    "4. debug/events.json",
    "5. page/page-summary.json",
    "6. page/page-text.txt (aggregated text from main document and child frames)",
    "7. page/failure-redacted.png"
  ].join("\r\n");
}

function cssEscape(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, (char) => `\\${char.codePointAt(0)?.toString(16)} `);
}

function cssAttributeEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function safeFileName(value: string): string {
  return String(value ?? "debug").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "debug";
}

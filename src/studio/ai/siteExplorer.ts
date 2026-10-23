import { createDefaultProject, createId } from "../store.ts";
import type { RecorderManager } from "../recorder.ts";
import type { WorkflowProject, RecorderEvent, SelectorRule } from "../types.ts";
import type { AIService } from "./service.ts";
import type { AIExplorationTraceStep, AIObservedElement, AIObservedPage, AIWorkflowMonitorState, AIWorkflowSiteEvidence } from "./types.ts";

interface ExplorationSession {
  id: string;
  recorderProjectId: string;
  targetUrl: string;
  startedAt: string;
  pages: AIObservedPage[];
  trace: AIExplorationTraceStep[];
  browserSource?: string;
  readyForDraft: boolean;
  requiresManual: boolean;
  manualReason?: string;
  lastRecorderEventCount: number;
  monitor: AIWorkflowMonitorState;
  lastActionKey?: string;
}

interface PlannerDecision {
  status: "act" | "done" | "manual";
  action?: "click" | "fill" | "select" | "check" | "uncheck" | "press";
  elementRef?: string;
  value?: string;
  workflowValue?: string;
  label?: string;
  reason?: string;
}


export function createAIRecorderProjectId(sessionId: string): string {
  const safeSession = String(sessionId ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .slice(0, 96);
  return `ai-recorder-${safeSession || createId("session")}`.slice(0, 120);
}

const MAX_PAGES = 14;
const MAX_TRACE = 20;
const MAX_ACTIONS_PER_PASS = 8;
const SENSITIVE_ELEMENT = /password|passwd|pwd|otp|one.?time|驗證碼|密碼|token|secret|api.?key/i;
const DOWNLOAD_MANUAL_REASON = /(?:download|pdf|excel|xml|attachment|file|\u4e0b\u8f09|\u9644\u4ef6|\u6a94\u6848|\u6587\u4ef6|\u5132\u5b58.*\u672c\u6a5f)/i;
const DOWNLOAD_ELEMENT = /(?:download|pdf|excel|xml|attachment|\.(?:pdf|xlsx?|csv|xml|zip|docx?)(?:$|[?#])|\u4e0b\u8f09|\u9644\u4ef6|\u6a94\u6848|\u6587\u4ef6)/i;
const UNSAFE_ACTION = /(?:\u522a\u9664|\u5220\u9664|delete|remove|\u9001\u51fa|submit|\u767c\u9001|send|\u4ed8\u6b3e|pay|purchase|\u8cfc\u8cb7|approve|\u6838\u51c6|publish|\u767c\u5e03|\u5132\u5b58\u8b8a\u66f4|save changes|confirm (?:order|purchase|delete|submit|approval)|\u78ba\u8a8d(?:\u9001\u51fa|\u522a\u9664|\u4ed8\u6b3e|\u6838\u51c6|\u767c\u5e03))/i;

export class AIWebsiteExplorer {
  private readonly sessions = new Map<string, ExplorationSession>();
  private readonly recorder: RecorderManager;

  constructor(recorder: RecorderManager) {
    this.recorder = recorder;
  }

  async start(targetUrl: string, browserProject?: WorkflowProject): Promise<AIWorkflowSiteEvidence> {
    const normalizedUrl = normalizeHttpUrl(targetUrl);
    if (!normalizedUrl) throw new Error("AI 網站檢視需要有效的 HTTP(S) 目標網址。");
    const sessionId = createId("ai-explore");
    const recorderProjectId = createAIRecorderProjectId(sessionId);
    const base = browserProject ?? createDefaultProject({ name: "AI 網站檢視", targetUrl: normalizedUrl });
    const project: WorkflowProject = {
      ...base,
      id: recorderProjectId,
      name: "AI 網站檢視",
      targetUrl: normalizedUrl,
      allowedDomains: [...new Set([...(base.allowedDomains ?? []), new URL(normalizedUrl).hostname])],
      steps: []
    };
    const started = await this.recorder.start(project);
    const session: ExplorationSession = {
      id: sessionId,
      recorderProjectId,
      targetUrl: normalizedUrl,
      startedAt: new Date().toISOString(),
      pages: [],
      trace: [],
      browserSource: started.browserSource,
      readyForDraft: false,
      requiresManual: false,
      lastRecorderEventCount: this.recorder.status(recorderProjectId).events.length,
      monitor: createMonitor("page_scan", "running", "掃描起始頁面", "正在讀取目前頁面的可操作元素")
    };
    this.sessions.set(sessionId, session);
    await this.capture(session);
    return this.evidence(session);
  }

  get(sessionId: string): AIWorkflowSiteEvidence {
    const session = this.requireSession(sessionId);
    const status = this.recorder.status(session.recorderProjectId);
    if (!status.active) throw new Error("AI 網站檢視瀏覽器已關閉，請重新啟動網站檢視。");
    return this.evidence(session, status.url);
  }

  async focus(sessionId: string): Promise<AIWorkflowSiteEvidence> {
    const session = this.requireSession(sessionId);
    await this.recorder.focus(session.recorderProjectId);
    return this.get(sessionId);
  }

  async explore(sessionId: string, instruction: string, ai: AIService, projectContext?: WorkflowProject): Promise<AIWorkflowSiteEvidence> {
    const session = this.requireSession(sessionId);
    session.requiresManual = false;
    session.manualReason = undefined;
    session.readyForDraft = false;
    session.lastRecorderEventCount = this.recorder.status(session.recorderProjectId).events.length;

    try {
      for (let attempt = 0; attempt < MAX_ACTIONS_PER_PASS; attempt += 1) {
        this.updateMonitor(session, {
          phase: "page_scan", status: "running", label: `掃描頁面（${attempt + 1}/${MAX_ACTIONS_PER_PASS}）`,
          detail: "正在讀取目前頁面的可操作元素與 iframe", waitingFor: "頁面 DOM 掃描", attempt: attempt + 1, maxAttempts: MAX_ACTIONS_PER_PASS
        });
        const observed = await this.capture(session);
        this.updateMonitor(session, { currentUrl: observed.url, detail: `已讀取 ${observed.elements.length} 個可操作元素；準備交由 AI 判斷下一步` });

        this.updateMonitor(session, {
          phase: "ai_planning", status: "waiting", label: `等待 AI 決定下一步（${attempt + 1}/${MAX_ACTIONS_PER_PASS}）`,
          detail: "正在將目前頁面結構與已完成操作交給 AI Provider", waitingFor: "AI Provider 回覆", currentAction: undefined, currentElementRef: undefined, currentSelector: undefined
        });
        const decision = await this.plan(ai, instruction, observed, session, projectContext);
        if (decision.status === "done") {
          session.readyForDraft = true;
          session.requiresManual = false;
          session.manualReason = undefined;
          this.updateMonitor(session, { phase: "complete", status: "completed", label: "網站探索完成", detail: "AI 已確認網站證據足以產生流程草稿", waitingFor: undefined, lastSuccess: "網站探索完成", lastSuccessAt: new Date().toISOString() });
          break;
        }
        if (decision.status === "manual") {
          session.readyForDraft = false;
          session.requiresManual = true;
          session.manualReason = decision.reason || "目前步驟需要人工在已開啟的瀏覽器完成後再繼續。";
          session.trace.push({
            index: session.trace.length + 1,
            action: "manual",
            label: decision.label || "人工操作",
            pageUrl: observed.url,
            result: session.manualReason
          });
          this.updateMonitor(session, { phase: "manual", status: "manual", label: "等待人工操作", detail: session.manualReason, waitingFor: "使用者完成瀏覽器中的人工步驟", currentAction: decision.label || "人工操作" });
          break;
        }
        this.updateMonitor(session, {
          phase: "browser_action", status: "running", label: "執行 AI 指定操作",
          detail: decision.reason || decision.label || decision.action || "執行網站操作", waitingFor: "瀏覽器操作完成",
          currentAction: `${decision.action || "action"}${decision.label ? ` · ${decision.label}` : ""}`, currentElementRef: decision.elementRef
        });
        await this.executeDecision(session, observed, decision);
        if (session.requiresManual) break;
        if (session.trace.length >= MAX_TRACE) {
          session.readyForDraft = true;
          this.updateMonitor(session, { phase: "complete", status: "completed", label: "網站探索完成", detail: "已達網站操作證據上限，可產生流程草稿", waitingFor: undefined, lastSuccess: "已收集足夠網站證據", lastSuccessAt: new Date().toISOString() });
          break;
        }
      }
      if (!session.requiresManual && !session.readyForDraft) {
        session.readyForDraft = true;
        this.updateMonitor(session, { phase: "complete", status: "completed", label: "網站探索完成", detail: "本輪探索已完成，可產生流程草稿", waitingFor: undefined, lastSuccess: "網站探索完成", lastSuccessAt: new Date().toISOString() });
      }
      await this.capture(session).catch(() => undefined);
      return this.evidence(session);
    } catch (error) {
      this.updateMonitor(session, { phase: "failed", status: "failed", label: "網站探索失敗", detail: error instanceof Error ? error.message : String(error), waitingFor: undefined });
      throw error;
    }
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    await this.recorder.stop(session.recorderProjectId).catch(() => undefined);
  }

  private async capture(session: ExplorationSession): Promise<AIObservedPage> {
    const active = this.recorder.peekActiveSession(session.recorderProjectId);
    if (!active) throw new Error("AI 網站檢視瀏覽器目前不可用，請重新啟動。");
    const page = active.page;
    const frames = page.frames().slice(0, 8);
    const elements: AIObservedElement[] = [];
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
      const frame = frames[frameIndex];
      const frameElements = await frame.evaluate(({ frameIndex, limit }) => {
        const attr = "data-automation-studio-ai-ref";
        const nodes = Array.from(document.querySelectorAll<HTMLElement>([
          "button", "a", "input", "textarea", "select", "[role=button]", "[role=link]", "[role=option]", "[role=row]", "[role=menuitem]", "[contenteditable=true]", "[tabindex]:not([tabindex='-1'])"
        ].join(",")));
        const visible = (el: HTMLElement) => {
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && rect.width > 1 && rect.height > 1;
        };
        const compact = (value: string | null | undefined, max = 140) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max) || undefined;
        const result: any[] = [];
        for (const el of nodes) {
          if (result.length >= limit || !visible(el)) continue;
          const ref = `f${frameIndex}-e${result.length + 1}`;
          el.setAttribute(attr, ref);
          const input = el as HTMLInputElement;
          const select = el as HTMLSelectElement;
          const type = compact(input.type, 40);
          const isSensitive = /password|hidden/i.test(type || "") || /password|passwd|pwd|otp|one.?time|token|secret/i.test(`${el.getAttribute("name") || ""} ${el.getAttribute("autocomplete") || ""} ${el.getAttribute("aria-label") || ""}`);
          result.push({
            ref,
            frameIndex,
            frameUrl: location.href,
            tag: el.tagName.toLowerCase(),
            role: compact(el.getAttribute("role"), 60),
            type,
            text: isSensitive ? undefined : compact(el.innerText || el.textContent, 160),
            ariaLabel: isSensitive ? undefined : compact(el.getAttribute("aria-label"), 120),
            placeholder: isSensitive ? undefined : compact(input.placeholder, 120),
            name: isSensitive ? undefined : compact(input.name, 100),
            href: el instanceof HTMLAnchorElement ? compact(el.href.split("#")[0], 240) : undefined,
            download: el instanceof HTMLAnchorElement ? el.hasAttribute("download") : undefined,
            options: el instanceof HTMLSelectElement ? Array.from(select.options).slice(0, 40).map((o) => compact(o.textContent || o.value, 100)).filter(Boolean) : undefined
          });
        }
        return result;
      }, { frameIndex, limit: Math.max(12, Math.floor(90 / Math.max(1, frames.length))) }).catch(() => [] as AIObservedElement[]);
      elements.push(...frameElements);
    }
    const observed: AIObservedPage = {
      observedAt: new Date().toISOString(),
      url: sanitizeUrl(page.url()),
      title: String(await page.title().catch(() => "")).slice(0, 200),
      elements: elements.slice(0, 100)
    };
    const previous = session.pages[session.pages.length - 1];
    if (!previous || previous.url !== observed.url || signature(previous.elements) !== signature(observed.elements)) {
      session.pages.push(observed);
      if (session.pages.length > MAX_PAGES) session.pages.splice(0, session.pages.length - MAX_PAGES);
    } else {
      session.pages[session.pages.length - 1] = observed;
    }
    return observed;
  }

  private async plan(ai: AIService, instruction: string, observed: AIObservedPage, session: ExplorationSession, projectContext?: WorkflowProject): Promise<PlannerDecision> {
    const safeParameters = projectContext?.parameters.map((p) => ({
      name: p.name,
      label: p.label,
      type: p.type,
      required: p.required,
      options: p.options,
      defaultValue: p.sensitive || p.type === "secret" ? undefined : p.defaultValue
    })) ?? [];
    const response = await ai.generate({
      temperature: 0,
      maxTokens: 1200,
      responseFormat: "json",
      metadata: { feature: "automation-studio-site-explorer", schemaVersion: "1.0.12" },
      messages: [
        { role: "system", content: EXPLORER_PROMPT },
        { role: "user", content: JSON.stringify({ instruction, currentPage: observed, trace: session.trace.slice(-10), parameters: safeParameters }, null, 2) }
      ]
    });
    const raw = parseJsonObject(response.text);
    const status = ["act", "done", "manual"].includes(String(raw.status)) ? String(raw.status) as PlannerDecision["status"] : "manual";
    const action = ["click", "fill", "select", "check", "uncheck", "press"].includes(String(raw.action)) ? String(raw.action) as PlannerDecision["action"] : undefined;
    const decision: PlannerDecision = {
      status,
      action,
      elementRef: stringOrUndefined(raw.elementRef, 80),
      value: stringOrUndefined(raw.value, 500),
      workflowValue: stringOrUndefined(raw.workflowValue, 500),
      label: stringOrUndefined(raw.label, 160),
      reason: stringOrUndefined(raw.reason, 500)
    };
    return normalizePlannerDecisionForSafeDownloads(decision, observed, session.trace);
  }

  private async executeDecision(session: ExplorationSession, observed: AIObservedPage, decision: PlannerDecision): Promise<void> {
    if (!decision.action || !decision.elementRef) {
      session.requiresManual = true;
      session.manualReason = "AI 未能對目前頁面選出可驗證的操作元素。請人工操作到下一個頁面後再繼續探索。";
      return;
    }
    const element = observed.elements.find((item) => item.ref === decision.elementRef);
    if (!element) throw new Error(`AI 選擇的頁面元素 ${decision.elementRef} 已不存在，請重新探索。`);
    const descriptor = `${element.text ?? ""} ${element.ariaLabel ?? ""} ${element.placeholder ?? ""} ${element.name ?? ""}`;
    const active = this.recorder.peekActiveSession(session.recorderProjectId);
    if (!active) throw new Error("AI 網站檢視瀏覽器目前不可用。");
    const page = active.page;
    const frame = page.frames()[element.frameIndex];
    if (!frame) throw new Error("目標 iframe 已變更，請重新探索目前頁面。");
    this.updateMonitor(session, { phase: "selector_probe", status: "running", label: "驗證目標元素 selector", detail: `正在確認 ${decision.label || describeElement(element)} 可被穩定重播`, waitingFor: "selector 探測", currentAction: `${decision.action} · ${decision.label || describeElement(element)}`, currentElementRef: decision.elementRef });
    const probedSelectors = await frame.evaluate((ref) => {
      const el = document.querySelector(`[data-automation-studio-ai-ref="${ref.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`) as HTMLElement | null;
      const probe = (window as any).__automationStudioSelectorsOf;
      return el && typeof probe === "function" ? probe(el) : [];
    }, decision.elementRef).catch(() => [] as SelectorRule[]);

    this.updateMonitor(session, { currentSelector: selectorSummary(probedSelectors), detail: probedSelectors.length ? `已取得 ${probedSelectors.length} 個候選 selector` : "尚未取得 selector，將依錄製事件再次確認" });

    const requireManual = (reason: string) => {
      session.requiresManual = true;
      session.readyForDraft = false;
      session.manualReason = reason;
      session.trace.push({
        index: session.trace.length + 1,
        action: "manual",
        label: decision.label || describeElement(element),
        pageUrl: observed.url,
        frameUrl: element.frameUrl,
        elementRef: decision.elementRef,
        selectors: probedSelectors,
        workflowValue: decision.workflowValue,
        result: reason
      });
      this.updateMonitor(session, { phase: "manual", status: "manual", label: "等待人工操作", detail: reason, waitingFor: "使用者完成瀏覽器中的人工步驟" });
    };

    if (SENSITIVE_ELEMENT.test(descriptor) || /password/i.test(element.type ?? "")) {
      requireManual("登入、MFA、驗證碼或其他敏感欄位必須由使用者人工完成。");
      return;
    }
    if (decision.action === "click" && UNSAFE_ACTION.test(descriptor)) {
      requireManual(`「${descriptor.trim().slice(0, 80) || "此按鈕"}」可能造成送出、刪除或核准等實際變更，AI 探索不會自動點擊。請人工確認後再繼續。`);
      return;
    }
    if ((decision.action === "fill" || decision.action === "select") && !decision.value) {
      requireManual("此步驟需要測試值才能繼續探索，但需求中沒有可安全使用的非敏感值。請人工填入後完成該操作，再按繼續探索。");
      return;
    }


    this.updateMonitor(session, { phase: "browser_action", status: "running", label: "執行網站操作", detail: decision.label || describeElement(element), waitingFor: "Playwright 操作完成", currentAction: `${decision.action} · ${decision.label || describeElement(element)}`, currentElementRef: decision.elementRef, currentSelector: selectorSummary(probedSelectors) });
    const locator = frame.locator(`[data-automation-studio-ai-ref="${cssEscape(decision.elementRef)}"]`).first();
    const beforePages = active.context.pages?.().length ?? 1;
    const beforeCount = this.recorder.status(session.recorderProjectId).events.length;
    if (decision.action === "click") await locator.click({ timeout: 10_000 });
    else if (decision.action === "fill") {
      await locator.fill(decision.value!, { timeout: 10_000 });
      await locator.dispatchEvent("change").catch(() => undefined);
    } else if (decision.action === "select") await locator.selectOption({ label: decision.value! }).catch(() => locator.selectOption(decision.value!));
    else if (decision.action === "check") await locator.check({ timeout: 10_000 });
    else if (decision.action === "uncheck") await locator.uncheck({ timeout: 10_000 });
    else if (decision.action === "press") await locator.press(decision.value || "Enter", { timeout: 10_000 });
    this.updateMonitor(session, { phase: "page_wait", status: "waiting", label: "等待頁面反應", detail: "操作已送出，正在等待頁面載入、Popup 或下載事件", waitingFor: "頁面／下載事件" });
    await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(450).catch(() => undefined);
    if ((active.context.pages?.().length ?? beforePages) > beforePages) await this.recorder.adoptNewestPage(session.recorderProjectId);

    const events = this.recorder.status(session.recorderProjectId).events;
    const newEvents = events.slice(beforeCount);
    const recorded = pickRecordedEvent(newEvents, decision.action);
    const trace: AIExplorationTraceStep = {
      index: session.trace.length + 1,
      action: recorded?.type === "download" ? "download" : decision.action,
      label: decision.label || recorded?.label || describeElement(element),
      pageUrl: observed.url,
      frameUrl: recorded?.frameUrl || element.frameUrl,
      elementRef: decision.elementRef,
      selectors: recorded?.selector?.length ? recorded.selector : probedSelectors,
      workflowValue: decision.workflowValue || (decision.action === "fill" || decision.action === "select" ? decision.value : undefined),
      result: (recorded?.selector?.length || probedSelectors.length) ? "已由真實瀏覽器操作並驗證 selector" : "已執行操作，但未取得可重播 selector"
    };
    session.trace.push(trace);
    session.lastRecorderEventCount = events.length;
    const actionKey = `${trace.action}|${trace.label}|${trace.pageUrl}`;
    const repeatCount = session.lastActionKey === actionKey ? (session.monitor.repeatCount ?? 1) + 1 : 1;
    session.lastActionKey = actionKey;
    this.updateMonitor(session, {
      phase: "page_scan", status: "running", label: "操作完成，準備重新掃描", detail: trace.result, waitingFor: "下一輪頁面掃描",
      currentAction: `${trace.action} · ${trace.label}`, currentSelector: selectorSummary(trace.selectors ?? []), currentUrl: this.recorder.status(session.recorderProjectId).url,
      lastSuccess: `${trace.action} · ${trace.label}`, lastSuccessAt: new Date().toISOString(), repeatCount,
      warning: repeatCount >= 3 ? "相同網站操作已連續出現 3 次以上，可能進入重複探索。" : undefined
    });
  }

  private updateMonitor(session: ExplorationSession, patch: Partial<AIWorkflowMonitorState>): void {
    const now = new Date().toISOString();
    const phaseChanged = patch.phase !== undefined && patch.phase !== session.monitor.phase;
    session.monitor = {
      ...session.monitor,
      ...patch,
      phaseStartedAt: phaseChanged ? now : session.monitor.phaseStartedAt,
      updatedAt: now
    };
  }

  private evidence(session: ExplorationSession, currentUrl?: string): AIWorkflowSiteEvidence {
    const verifiedSelectors = uniqueSelectors(session.trace.flatMap((step) => step.selectors ?? []));
    const status = this.recorder.status(session.recorderProjectId);
    return {
      sessionId: session.id,
      startedAt: session.startedAt,
      targetUrl: session.targetUrl,
      currentUrl: sanitizeUrl(currentUrl || status.url || session.pages.at(-1)?.url || session.targetUrl),
      pages: session.pages,
      trace: session.trace,
      verifiedSelectors,
      readyForDraft: session.readyForDraft,
      requiresManual: session.requiresManual,
      manualReason: session.manualReason,
      browserSource: session.browserSource,
      monitor: { ...session.monitor, currentUrl: sanitizeUrl(currentUrl || status.url || session.monitor.currentUrl || session.targetUrl) }
    };
  }

  private requireSession(sessionId: string): ExplorationSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("找不到 AI 網站檢視工作階段，請重新開啟網站檢視。");
    return session;
  }
}

function createMonitor(phase: AIWorkflowMonitorState["phase"], status: AIWorkflowMonitorState["status"], label: string, detail?: string): AIWorkflowMonitorState {
  const now = new Date().toISOString();
  return { phase, status, label, detail, phaseStartedAt: now, updatedAt: now, repeatCount: 0 };
}

function selectorSummary(selectors: SelectorRule[]): string | undefined {
  const first = selectors[0];
  if (!first) return undefined;
  const value = String(first.value ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
  return `${first.strategy}${first.role ? `:${first.role}` : ""}=${value}`;
}

export function normalizePlannerDecisionForSafeDownloads(
  decision: PlannerDecision,
  observed: AIObservedPage,
  trace: AIExplorationTraceStep[] = []
): PlannerDecision {
  if (decision.status !== "manual" || !isDownloadOnlyManualReason(decision.reason)) return decision;
  const used = new Set(trace.filter((step) => step.pageUrl === observed.url).map((step) => step.elementRef).filter(Boolean));
  const candidate = observed.elements.find((element) => isDownloadElement(element) && !used.has(element.ref));
  if (!candidate) return decision;
  return {
    status: "act",
    action: "click",
    elementRef: candidate.ref,
    label: describeElement(candidate),
    reason: "Local file download is a permitted read-only exploration action."
  };
}

export function isDownloadOnlyManualReason(reason?: string): boolean {
  const text = String(reason ?? "").trim();
  return Boolean(text) && DOWNLOAD_MANUAL_REASON.test(text) && !UNSAFE_ACTION.test(text) && !SENSITIVE_ELEMENT.test(text);
}

function isDownloadElement(element: AIObservedElement): boolean {
  if (element.download) return true;
  const descriptor = `${element.text ?? ""} ${element.ariaLabel ?? ""} ${element.placeholder ?? ""} ${element.name ?? ""} ${element.href ?? ""}`;
  return DOWNLOAD_ELEMENT.test(descriptor);
}

function pickRecordedEvent(events: RecorderEvent[], action: PlannerDecision["action"]): RecorderEvent | undefined {
  const preferred = action === "fill" ? "fill" : action === "select" ? "select" : action === "check" || action === "uncheck" ? "check" : action === "click" ? "click" : undefined;
  return [...events].reverse().find((event) => event.type === preferred) ?? [...events].reverse().find((event) => event.selector?.length);
}

function describeElement(element: AIObservedElement): string {
  return element.text || element.ariaLabel || element.placeholder || element.name || `${element.tag} ${element.ref}`;
}

function uniqueSelectors(selectors: SelectorRule[]): SelectorRule[] {
  const seen = new Set<string>();
  return selectors.filter((selector) => {
    const key = selectorKey(selector);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function selectorKey(selector: SelectorRule): string {
  return `${selector.strategy}|${selector.role ?? ""}|${selector.exact === true ? "1" : "0"}|${selector.value}`;
}

function signature(elements: AIObservedElement[]): string {
  return elements.slice(0, 30).map((el) => `${el.tag}:${el.role ?? ""}:${el.text ?? el.ariaLabel ?? el.placeholder ?? el.name ?? ""}`).join("|");
}

function parseJsonObject(text: string): Record<string, unknown> {
  const raw = String(text ?? "").trim();
  for (const candidate of [raw, raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? "", raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* try next candidate */ }
  }
  return { status: "manual", reason: "AI 探索回傳內容無法解析，請人工操作後再重試。" };
}

function stringOrUndefined(value: unknown, max: number): string | undefined {
  const result = String(value ?? "").trim().slice(0, max);
  return result || undefined;
}

function normalizeHttpUrl(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch { return ""; }
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) if (/token|key|secret|password|auth|code/i.test(key)) url.searchParams.set(key, "***");
    return url.href;
  } catch { return value.slice(0, 500); }
}

function cssEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const EXPLORER_PROMPT = `你是 Automation Studio V1.2.4 的網站探索代理。你正在控制一個真實、可見的瀏覽器，目標是先觀察並安全操作網站，取得之後產生可重播 Workflow 所需的實際元素證據。\n只回傳一個 JSON object。欄位：status(act|done|manual), action(click|fill|select|check|uncheck|press), elementRef, value, workflowValue, label, reason。\n規則：\n1. action 只能選 currentPage.elements 中存在的 elementRef，絕對不可自行發明 selector。\n2. 需要登入、密碼、MFA、驗證碼、CAPTCHA、API Key 或任何敏感值時，status=manual。\n3. 可能造成刪除、送出、付款、核准、發信、發布、儲存正式資料等副作用時，status=manual。\n3a. IMPORTANT DOWNLOAD EXCEPTION: downloading PDF/Excel/XML/ZIP/documents or attachments is a permitted read-only action, even when files are saved locally and even when multiple files are requested. Do NOT return status=manual only because a download writes files to the local machine. Use action=click on the real observed download element and continue exploration. Only use manual when the same action also performs a remote destructive or submission side effect. \n4. 搜尋、切換頁籤、開啟第一筆結果、展開選單等低風險導覽可自動操作。\n5. fill/select 的 value 必須是使用者需求或非敏感參數中已明確提供、可安全拿來探索的值；沒有安全值就 manual。workflowValue 可使用 {{參數名}} 表示最後 Workflow 應填入參數。\n6. 不要太早 done。只有需求中每個需要操作的頁面與關鍵控制項都已實際觀察，尤其是點擊後的新頁、第一筆資料內頁、下載頁等，才 done。\n7. 若目前頁面已足以完成剩餘需求且不需再進一步探索，status=done。`;

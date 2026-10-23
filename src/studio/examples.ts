import { createDefaultProject, createId } from "./store.ts";
import type { RecorderEvent, WorkflowProject, WorkflowStep } from "./types.ts";

export function createGenericExample(): WorkflowProject {
  return createDefaultProject({
    id: "generic-example",
    name: "通用網站範例",
    description: "示範開啟網站、文字驗證與截圖；可複製後改成自己的流程。",
    targetUrl: "https://example.com",
    allowedDomains: ["example.com"],
    tags: ["範例", "通用"],
    status: "ready",
    parameters: [
      { id: "p-title", name: "expectedTitle", label: "預期標題", type: "text", required: true, defaultValue: "Example Domain", description: "用來驗證頁面內容。" }
    ],
    steps: [
      { id: "step-open", name: "開啟目標網站", kind: "navigate", enabled: true, url: "https://example.com", timeoutMs: 30_000, retryCount: 1 },
      { id: "step-check", name: "確認頁面標題", kind: "assert", enabled: true, selectors: [{ strategy: "text", value: "{{expectedTitle}}", exact: true }], verification: { kind: "visible" } },
      { id: "step-shot", name: "保存完成畫面", kind: "screenshot", enabled: true, value: "completed.png" }
    ]
  });
}

export function createEbasExample(): WorkflowProject {
  return createDefaultProject({
    id: "ebas-report-example",
    name: "EBAS 報表下載範例",
    description: "將既有 EBAS 經驗整理成可編輯範例。需先在網站與工作站頁面完成人工登入。",
    targetUrl: "https://ebasnew.ebas.gov.tw/SSO/ToLink/0/1103",
    allowedDomains: ["ebasnew.ebas.gov.tw", "sso.ebas.gov.tw"],
    adapter: "ebas",
    tags: ["範例", "EBAS", "ExtJS"],
    parameters: [
      { id: "p-year", name: "year", label: "年度", type: "text", required: true, defaultValue: "115" },
      { id: "p-stage", name: "stage", label: "階段", type: "text", required: true, defaultValue: "院編決算" },
      { id: "p-format", name: "format", label: "輸出格式", type: "select", required: true, defaultValue: "excel", options: ["excel", "pdf", "xml", "ods"] },
      { id: "p-level", name: "printLevel", label: "會計科目列印層級", type: "select", required: false, defaultValue: "5", options: ["1", "2", "3", "4", "5"] }
    ],
    steps: [
      { id: "ebas-open", name: "開啟 EBAS 入口", kind: "navigate", enabled: true, url: "https://ebasnew.ebas.gov.tw/SSO/ToLink/0/1103", waitAfter: { kind: "timeout", timeoutMs: 1_500 } },
      { id: "ebas-year", name: "設定年度", kind: "fill", enabled: true, adapter: "ebas", componentPath: "q.q_year", value: "{{year}}", frame: { urlIncludes: "/SFUND/" }, verification: { kind: "value", expected: "{{year}}", selector: [{ strategy: "css", value: "#q_year" }] } },
      { id: "ebas-level", name: "設定會計科目列印層級", kind: "select", enabled: true, adapter: "ebas", componentPath: "mst1.code_level", value: "{{printLevel}}", frame: { urlIncludes: "/SFUND/" } },
      { id: "ebas-format", name: "選擇 Excel 輸出", kind: "check", enabled: true, adapter: "ksi", componentPath: "mst1.excel", value: "excel", frame: { urlIncludes: "/SFUND/" } },
      { id: "ebas-ready", name: "等待 EBAS 狀態同步", kind: "wait", enabled: true, value: "1200" },
      { id: "ebas-download", name: "列印並等待下載", kind: "download", enabled: true, frame: { urlIncludes: "/SFUND/" }, selectors: [{ strategy: "text", value: "列印", exact: true }, { strategy: "css", value: "button[onclick*='executePrint']" }], timeoutMs: 60_000 }
    ]
  });
}

export function recordedEventsToSteps(events: RecorderEvent[]): WorkflowStep[] {
  // Pointer movement across a page can create incidental hover events. Keep a
  // hover only when the following action is the same control or a plausible
  // menu child; otherwise it must not impose an unrelated visibility wait.
  const meaningfulEvents = events.filter((event, index) =>
    event.type !== "hover" || isRelatedHoverEvent(event, events[index + 1])
  );
  return meaningfulEvents.map((event, index) => {
    const eventKind = recordedEventKind(event);
    const selectors = recordedSelectorsForStep(event);
    const currentCss = selectors.find((rule) => rule.strategy === "css");
    const nextSelectors = sanitizeRecordedSelectors(meaningfulEvents[index + 1]?.selector ?? []);
    const nextSelector = meaningfulEvents[index + 1]?.type === "upload" ? undefined : nextSelectors.find((rule) => rule.strategy === "css");
    const base: WorkflowStep = {
      id: createId("step"),
      name: `${index + 1}. ${event.label}`,
      kind: eventKind === "navigate" ? "navigate" : eventKind,
      enabled: true,
      selectors,
      frame: recordedEventFrameUrl(event) ? recordedFrameRule(recordedEventFrameUrl(event)!) : undefined,
      autoFrameSearch: Boolean(recordedEventFrameUrl(event)),
      retryCount: 1,
      waitBefore: currentCss && !["navigate", "upload", "assert"].includes(eventKind)
        ? { kind: "visible", value: currentCss.value, timeoutMs: 10000 } : undefined,
      waitAfter: eventKind === "hover" && nextSelector
        ? { kind: "visible", value: nextSelector.value, timeoutMs: 5_000, ...(recordedEventFrameUrl(meaningfulEvents[index + 1]) ? { autoFrameSearch: true } : {}) }
        // A fixed 500 ms delay is unreliable for a search result or article
        // navigation. The next recorded visible selector is stronger evidence
        // that the click has completed and avoids unnecessary retries.
        : (eventKind === "click" || eventKind === "dblclick") && nextSelector
          ? { kind: "visible", value: nextSelector.value, timeoutMs: 10_000, ...(recordedEventFrameUrl(meaningfulEvents[index + 1]) ? { autoFrameSearch: true } : {}) }
          : (eventKind === "click" || eventKind === "dblclick") ? { kind: "timeout", timeoutMs: 750 } : undefined
    };
    if (event.type === "navigate") base.url = event.url;
    if (["fill", "select", "press", "upload"].includes(event.type)) base.value = event.value ?? "";
    if (event.type === "assert") base.verification = event.verification;
    if (event.type === "upload") {
      base.enabled = false;
      base.description = `已選取：${(event.fileNames ?? []).join("、")}。網頁無法取得完整本機路徑；請將值改為完整路徑（多個檔案一行一個），再啟用此步驟。`;
    }
    if (event.sensitive) {
      base.enabled = false;
      base.value = "";
      base.description = "密碼值未錄製。請設定機敏參數或人工登入，再啟用此步驟。";
    }
    if (event.type === "check") base.kind = event.value === "false" ? "uncheck" : "check";
    return base;
  });
}


function recordedSelectorsForStep(event: RecorderEvent): NonNullable<WorkflowStep["selectors"]> {
  const primary = sanitizeRecordedSelectors(event.selector ?? []);
  if (primary.length) return primary;
  const fallback: NonNullable<WorkflowStep["selectors"]> = [];
  const label = String(event.label ?? "").replace(/^\d+\.\s*/, "").replace(/\s+/g, " ").trim();
  if (label && label.length <= 600 && !/^(?:a|div|span|td|tr|button|input)$/i.test(label)) {
    fallback.push({ strategy: "text", value: label, exact: true, description: "錄製 selector 遺失時以操作文字備援" });
  }
  if (event.targetUrl) {
    try {
      const parsed = new URL(event.targetUrl);
      const tail = `${parsed.pathname.split("/").pop() ?? ""}${parsed.search}`;
      if (tail) fallback.push({ strategy: "css", value: `a[href*=${cssQuotedSelector(tail)}]:visible`, description: "錄製 selector 遺失時以目標網址備援" });
    } catch { /* text fallback remains */ }
  }
  return sanitizeRecordedSelectors(fallback);
}

function recordedEventFrameUrl(event: RecorderEvent): string | undefined {
  const path = Array.isArray(event.framePath) ? event.framePath : [];
  const last = path.at(-1);
  if (last) {
    const separator = last.indexOf(" :: ");
    const candidate = (separator >= 0 ? last.slice(separator + 4) : last).trim();
    if (/^https?:\/\//i.test(candidate)) return candidate;
  }
  return event.frameUrl;
}

function cssQuotedSelector(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function recordedFrameRule(frameUrl: string): WorkflowStep["frame"] {
  try {
    const parsed = new URL(frameUrl);
    const pathname = parsed.pathname || "/";
    return { urlIncludes: pathname };
  } catch {
    return { urlIncludes: frameUrl };
  }
}

function isRelatedHoverEvent(event: RecorderEvent, next: RecorderEvent | undefined): boolean {
  if (!next || next.type === "hover") return false;
  const currentCss = sanitizeRecordedSelectors((event as any).selector).filter((rule) => rule.strategy === "css").map((rule) => rule.value);
  const nextCss = sanitizeRecordedSelectors((next as any).selector).filter((rule) => rule.strategy === "css").map((rule) => rule.value);
  if (currentCss.some((value) => nextCss.includes(value))) return true;
  const current = currentCss.join(" ");
  const target = nextCss.join(" ");
  if (/aria-haspopup\s*=|\[aria-haspopup/i.test(current)) return true;
  if (/\[data-groupsn=/.test(current) && /\[data-groupsn=/.test(target)) return true;
  return /href=["'][^"']*cl\.aspx/i.test(current) && /href=["'][^"']*cl\.aspx/i.test(target);
}

function recordedEventKind(event: RecorderEvent): RecorderEvent["type"] {
  if (event.type !== "click") return event.type;
  const label = String(event.label ?? "").replace(/^\d+\.\s*/, "");
  const looksLikeDownload = /^\s*\[?pdf\]?\s*$/i.test(label)
    || sanitizeRecordedSelectors((event as any).selector).some((rule) => rule.strategy === "css" && (
      /\.pdf(?:["'\]?#]|$)/i.test(rule.value)
      || /\/(?:File\/Doc|download|attachment)(?:\/|\?|["'])/i.test(rule.value)
      || /\[download(?:[\]=])/i.test(rule.value)
    ));
  return looksLikeDownload ? "download" : event.type;
}

export function sanitizeRecordedSelectors(selectors: unknown = []): NonNullable<WorkflowStep["selectors"]> {
  const safeSelectors = normalizeRecordedSelectorPayload(selectors);
  const normalized = safeSelectors.flatMap((rule) => {
    if (rule.strategy !== "css" || !isGoogleCseTemporarySelector(rule.value)) return [rule];
    const title = rule.value.match(/^([a-z][\w-]*).*?(\[title="(?:\\.|[^"])*"\])/i);
    return title
      ? [{ ...rule, value: `${title[1]}${title[2]}:visible`, description: "已移除 Google 站內搜尋暫時轉址參數" }]
      : [];
  });
  const seen = new Set<string>();
  const unique = normalized.filter((rule) => {
    const key = `${rule.strategy}|${rule.role ?? ""}|${rule.value}|${rule.exact ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // A title selector remains stable when Google changes the encoded redirect
  // href. Put it before the destination-fragment fallback so generated waits
  // never depend on a temporary/rewritten Google URL.
  if (unique.some((rule) => /Google 站內搜尋|Google 搜尋結果/.test(rule.description ?? ""))) {
    return [...unique].sort((a, b) => stableGoogleSelectorRank(a) - stableGoogleSelectorRank(b));
  }
  return unique;
}


function normalizeRecordedSelectorPayload(value: unknown): NonNullable<WorkflowStep["selectors"]> {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return []; }
  }
  const items: unknown[] = Array.isArray(parsed) ? parsed.flat(4) : parsed && typeof parsed === "object" ? [parsed] : [];
  return items.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const rule = item as Record<string, unknown>;
    const strategy = String(rule.strategy ?? "").trim();
    const valueText = rule.value == null ? "" : String(rule.value);
    if (!strategy || !valueText) return [];
    return [{
      ...rule,
      strategy,
      value: valueText,
      ...(rule.role == null ? {} : { role: String(rule.role) }),
      ...(typeof rule.exact === "boolean" ? { exact: rule.exact } : {}),
      ...(rule.description == null ? {} : { description: String(rule.description) })
    } as NonNullable<WorkflowStep["selectors"]>[number]];
  });
}

function stableGoogleSelectorRank(rule: NonNullable<WorkflowStep["selectors"]>[number]): number {
  if (rule.strategy === "css" && /\[title=/.test(rule.value) && !/google\.[a-z.]+\/url\?/i.test(rule.value)) return 0;
  if (/Google 站內搜尋/.test(rule.description ?? "")) return 2;
  return 1;
}

function isGoogleCseTemporarySelector(value: string): boolean {
  return /google\.[a-z.]+\/url\?/i.test(value) || /client=internal-element-cse|[?&](?:ved|usg|fexp)=/i.test(value);
}

export function applyRecordedEvents(steps: WorkflowStep[], events: RecorderEvent[]): WorkflowStep[] {
  const recorded = recordedEventsToSteps(events);
  const opening = recorded.find((step) => step.kind === "navigate");
  const remaining = recorded.filter((step) => step !== opening);
  if (!opening) return [...steps, ...remaining];
  const index = steps.findIndex((step) => step.kind === "navigate" && (/開啟目標網站|開啟.*入口|前往/i.test(step.name)));
  if (index >= 0) {
    const updated = [...steps];
    updated[index] = { ...updated[index], name: "開啟目標網站", url: opening.url, enabled: true };
    return [...updated, ...remaining];
  }
  return [opening, ...steps, ...remaining];
}

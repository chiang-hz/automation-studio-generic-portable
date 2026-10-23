import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import path from "node:path";
import fs from "node:fs/promises";
import { recorderScript, RecorderManager } from "../src/studio/recorder.ts";
import { recordedEventsToSteps } from "../src/studio/examples.ts";
import { WorkflowRunner } from "../src/studio/executor.ts";
import { createDefaultProject } from "../src/studio/store.ts";

function harness() {
  const events: any[] = [], diagnostics: any[] = [];
  const listeners = new Map<string, Function[]>();
  class Element {
    tagName = "INPUT"; type = "text"; value = ""; checked = false; id = "query"; name = "query";
    classList: string[] = []; innerText = ""; textContent = ""; isContentEditable = false;
    files: any[] = []; attrs: Record<string, string> = {}; parentElement = null;
    getAttribute(key: string) { return this.attrs[key] ?? (key === "name" ? this.name : null); }
    hasAttribute(key: string) { return key in this.attrs; }
    closest(selector: string) { return selector.includes("input,") ? this : null; }
  }
  class Input extends Element {}
  class Select extends Element {}
  class Textarea extends Element {}
  class Anchor extends Element {}
  const doc: any = { activeElement: null, body: new Element(), querySelector: () => null, querySelectorAll: () => [1], addEventListener: (name: string, fn: Function) => listeners.set(name, [...listeners.get(name) ?? [], fn]) };
  const win: any = { name: "", location: { href: "https://example.test/" }, __automationStudioRecord: (event: any) => events.push(JSON.parse(JSON.stringify(event))), __automationStudioDiagnostic: (event: any) => diagnostics.push(event) }; win.top = win;
  vm.runInNewContext(`(${recorderScript.toString()})()`, { window: win, document: doc, location: win.location, HTMLElement: Element, HTMLInputElement: Input, HTMLSelectElement: Select, HTMLTextAreaElement: Textarea, HTMLAnchorElement: Anchor, CSS: { escape: (s: string) => s }, URL, console: { debug() {} }, getComputedStyle: () => ({ cursor: "default" }) });
  function dispatch(type: string, target: any, data: any = {}) {
    const event: any = { target, button: 0, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...data };
    for (const fn of listeners.get(type) ?? []) fn(event);
    return event;
  }
  return { events, diagnostics, win, doc, dispatch, Input, Select, Textarea, Element };
}

test("錄製 Enter 前保存填值，Tab/focusout 不重複填值", () => {
  const h = harness(), input = new h.Input(); input.value = "年度決算";
  h.dispatch("keydown", input, { key: "Enter" });
  assert.deepEqual(h.events.map(e => [e.type, e.value]), [["fill", "年度決算"], ["press", "Enter"]]);
  h.dispatch("change", input); h.dispatch("keydown", input, { key: "Tab", shiftKey: true }); h.dispatch("focusout", input);
  assert.equal(h.events.filter(e => e.type === "fill").length, 1);
  assert.equal(h.events.at(-1).value, "Shift+Tab");
});

test("錄製快捷鍵，忽略 IME、重複按鍵與密碼值", () => {
  const h = harness(), input = new h.Input(); input.value = "搜尋";
  h.dispatch("keydown", input, { key: "Enter", isComposing: true });
  h.dispatch("keydown", input, { key: "Enter", repeat: true });
  assert.equal(h.events.length, 0);
  h.dispatch("keydown", input, { key: "a", ctrlKey: true });
  assert.equal(h.events.at(-1).value, "Control+a");
  const password = new h.Input(); password.type = "password"; password.value = "SECRET";
  h.dispatch("keydown", password, { key: "Enter" }); h.dispatch("change", password);
  assert.equal(JSON.stringify(h.events).includes("SECRET"), false);
  const steps = recordedEventsToSteps(h.events);
  assert.equal(steps.at(-1)?.enabled, false);
});

test("焦點離開及點擊前保存尚未觸發 change 的文字", () => {
  const h = harness(), input = new h.Input(); input.value = "一";
  h.dispatch("focusout", input); input.value = "二"; h.doc.activeElement = input;
  h.dispatch("pointerdown", new h.Element());
  assert.deepEqual(h.events.map(e => e.value), ["一", "二"]);
});

test("多檔上傳保存檔名，隱藏 input 定位不要求 visible，加入後停用待補路徑", () => {
  const h = harness(), input = new h.Input(); input.type = "file"; input.files = [{ name: "甲.pdf" }, { name: "乙.xlsx" }];
  h.dispatch("change", input);
  assert.equal(h.events[0].type, "upload");
  assert.deepEqual(h.events[0].fileNames, ["甲.pdf", "乙.xlsx"]);
  assert.equal(h.events[0].selector[0].value, "#query");
  const [step] = recordedEventsToSteps(h.events);
  assert.equal(step.enabled, false); assert.equal(step.value, "甲.pdf\n乙.xlsx"); assert.match(step.description!, /完整路徑/);
});

test("驗證選取攔截 pointerdown/mousedown/click，保留文字驗證並解除模式", () => {
  const h = harness(), element = new h.Element(); element.tagName = "BUTTON"; element.textContent = "查詢完成";
  h.win.__automationStudioAssertionMode = "text";
  for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
    const event = h.dispatch(type, element); assert.equal(event.prevented, true); assert.equal(event.stopped, true);
  }
  assert.equal(h.events.length, 1); assert.equal(h.events[0].type, "assert");
  assert.equal(h.events[0].verification.expected, "查詢完成"); assert.equal(h.win.__automationStudioAssertionMode, undefined);
  const [step] = recordedEventsToSteps(h.events); assert.equal(step.kind, "assert"); assert.equal(step.verification?.kind, "text");
});

test("值驗證阻止密碼選取，Esc 只送取消信號", () => {
  const h = harness(), input = new h.Input(); input.type = "password"; input.value = "SECRET";
  h.win.__automationStudioAssertionMode = "value"; h.dispatch("click", input);
  assert.equal(h.events.length, 0); assert.equal(h.diagnostics.at(-1).result, "ignored");
  h.dispatch("keydown", input, { key: "Escape" }); assert.equal(h.events[0].cancelled, true); assert.equal(h.win.__automationStudioAssertionMode, undefined);
});

test("元素可見及欄位值驗證可加入既有流程格式", () => {
  for (const mode of ["visible", "value"]) {
    const h = harness(), input = new h.Input(); input.value = "115"; h.win.__automationStudioAssertionMode = mode;
    h.dispatch("click", input); const [step] = recordedEventsToSteps(h.events);
    assert.equal(step.verification?.kind, mode); if (mode === "value") assert.equal(step.verification?.expected, "115");
  }
});

test("唯一 test id 優先於廣泛舊式 CSS 備援", () => {
  const h = harness(), input = new h.Input(); input.attrs["data-testid"] = "search"; input.value = "報表";
  h.dispatch("change", input);
  assert.equal(h.events[0].selector[0].value, '[data-testid="search"]:visible');
  assert.ok(h.events[0].selector.length > 1);
});

test("上傳執行允許隱藏 input，支援多檔路徑且不執行 scroll/click", async () => {
  const files: string[][] = [];
  const locator: any = { count: async () => 1, nth: () => locator, setInputFiles: async (paths: string[]) => files.push(paths), filter: () => { throw new Error("上傳不應要求 visible"); } };
  const page: any = { locator: () => locator };
  const runner = new WorkflowRunner({} as any) as any;
  const project = createDefaultProject({ targetUrl: "https://example.test" });
  await runner.performStep(project, { parameters: {} }, {}, page, { id: "u", name: "上傳", kind: "upload", enabled: true, value: "a.pdf\nb.xlsx", selectors: [{ strategy: "css", value: "#file" }] }, {});
  assert.deepEqual(files, [[path.resolve("a.pdf"), path.resolve("b.xlsx")]]);
  await assert.rejects(runner.performStep(project, { parameters: {} }, {}, page, { id: "u", name: "上傳", kind: "upload", enabled: true, value: "", selectors: [{ strategy: "css", value: "#file" }] }, {}), /缺少檔案路徑/);
});

test("驗證模式套用所有 frame，後端取消信號不加入事件", async () => {
  const manager: any = new RecorderManager();
  const frames = [0, 1].map(() => ({ mode: undefined, isDetached: () => false, evaluate: async function(fn: Function, arg: any) { if (typeof arg === "string" && arg.startsWith("1.2.2")) return true; if (fn.toString().includes("__automationStudioAssertionMode")) this.mode = arg; return undefined; } }));
  const session: any = { recordingEnabled: true, revision: 1, events: [], waiters: new Set(), seenTransportIds: new Map(), watchedPages: new WeakSet(), context: { pages: () => [{ frames: () => frames }] }, frameHealth: { repairedFrames: 0 }, transportHealth: {} };
  session.context.pages = () => [page]; const page = { isClosed: () => false, frames: () => frames }; session.watchedPages.add(page);
  manager.sessions.set("p", session);
  await manager.setAssertionMode("p", "text"); assert.ok(frames.every(f => f.mode === "text"));
  manager.ingestRecorderEvent("p", { type: "assert", cancelled: true }, {}, "binding");
  await manager.refreshRecorderHealth("p", true);
  assert.ok(frames.every(f => f.mode === undefined)); assert.equal(session.events.length, 0);
  await assert.rejects(manager.setAssertionMode("p", "invalid"), /不支援/);
});


test("手動加入或停止前 flush 保留仍聚焦欄位的最後內容", () => {
  const h = harness(), input = new h.Input(); input.value = "尚未離開欄位"; h.doc.activeElement = input;
  h.win.__automationStudioRecorderFlush(); h.win.__automationStudioRecorderFlush();
  assert.equal(h.events.length, 1); assert.equal(h.events[0].value, "尚未離開欄位");
});


test("錄製步驟在操作前等待自身元素，主頁點擊後可等待子 Frame 元素", () => {
  const steps = recordedEventsToSteps([
    { id: "a", type: "click", label: "開啟", url: "https://example.test", selector: [{ strategy: "css", value: "#open:visible" }], createdAt: "" },
    { id: "b", type: "press", value: "Enter", label: "查詢", url: "https://example.test/frame", frameUrl: "https://example.test/frame", selector: [{ strategy: "css", value: "#query:visible" }], createdAt: "" }
  ]);
  assert.equal(steps[0].waitBefore?.value, "#open:visible");
  assert.equal(steps[0].waitAfter?.autoFrameSearch, true);
  assert.equal(steps[1].waitBefore?.value, "#query:visible");
});

test("文字和值驗證等待非同步更新，逾時仍回報失敗", async () => {
  for (const kind of ["text", "value"]) {
    let reads = 0;
    const locator: any = { filter: () => locator, evaluateAll: async () => [0], nth: () => locator, inputValue: async () => ++reads > 1 ? "完成" : "載入中", textContent: async () => ++reads > 1 ? "完成" : "載入中" };
    const page: any = { locator: () => locator, waitForTimeout: async () => {} };
    const runner = new WorkflowRunner({} as any) as any;
    const step = { id: "verify", name: "驗證", kind: "assert", enabled: true, selectors: [{ strategy: "css", value: "#status" }], verification: { kind, expected: "完成", timeoutMs: 100 } };
    await runner.performStep(createDefaultProject(), { parameters: {} }, {}, page, step, {});
    assert.equal(reads, 2);
    step.verification.expected = "不會出現"; step.verification.timeoutMs = 0;
    await assert.rejects(runner.performStep(createDefaultProject(), { parameters: {} }, {}, page, step, {}), /驗證失敗/);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { ReportService } from "../src/services/reportService.ts";
import { TaskStore } from "../src/domain/taskStore.ts";
import { bindContextCancellation } from "../src/adapters/cancellation.ts";
import { EbasReportAdapter, withTimestamp, waitForEbasDownload } from "../src/adapters/ebasReportAdapter.ts";
import { localFilenameTimestamp } from "../src/domain/localTimestamp.ts";
import { MinimalMcpServer } from "../src/mcp/server.ts";
import { FlowError, ErrorCodes } from "../src/domain/errors.ts";
import { loadConfig } from "../src/config.ts";

const immediate = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(read: () => boolean, timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (!read()) { if (Date.now() > deadline) throw new Error("condition timeout"); await new Promise(resolve => setTimeout(resolve, 3)); }
}
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ebas-cancel-"));
  const file = path.join(dir, "done.csv"); await fs.writeFile(file, "name,value\nreport,1\n");
  const calls: any[] = [];
  const adapter: any = {
    listReports: async () => [{ id: "r", name: "report", outputFormat: "csv" }],
    getReportParameters: async () => [],
    downloadReport: (input: any) => { calls.push(input); return new Promise((_, reject) => { const abort = () => reject(new Error("context closed")); input.signal.addEventListener("abort", abort, { once: true }); if (input.signal.aborted) abort(); }); }
  };
  return { dir, file, calls, adapter, service: new ReportService(adapter, new TaskStore()) };
}

test("檔名使用主機本機時區，正負時差與跨日皆正確", () => {
  const originalTimezone = process.env.TZ;
  try {
    for (const [zone, expected] of [["Asia/Taipei", "2026-10-05T13-44-12-345"], ["UTC", "2026-10-05T05-44-12-345"], ["America/Los_Angeles", "2026-10-04T22-44-12-345"]]) {
      process.env.TZ = zone;
      assert.equal(localFilenameTimestamp(new Date("2026-10-05T05:44:12.345Z")), expected);
    }
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});

test("EBAS 檔名保留中文、安全副檔名與毫秒，沒有 UTC Z", () => {
  const date = new Date(2026, 9, 5, 13, 44, 12, 345);
  assert.equal(localFilenameTimestamp(date), "2026-10-05T13-44-12-345");
  assert.equal(withTimestamp("損益表.xlsx", ".pdf", date), "損益表-2026-10-05T13-44-12-345.pdf");
});

test("單筆中斷先 cancelling 再 cancelled，其他任務不受影響", async () => {
  const h = await fixture();
  try {
    const a = await h.service.createDownloadTask("r", {}), b = await h.service.createDownloadTask("r", {});
    await waitFor(() => h.calls.length === 2);
    assert.equal(h.service.cancelDownloadTask(a.id).status, "cancelling");
    assert.equal(h.service.cancelDownloadTask(a.id).status, "cancelling");
    await waitFor(() => h.service.getDownloadTask(a.id).status === "cancelled");
    assert.equal(h.service.getDownloadTask(b.id).status, "running"); assert.equal(h.calls[1].signal.aborted, false);
    h.service.cancelDownloadTask(b.id); await waitFor(() => h.service.getDownloadTask(b.id).status === "cancelled");
    assert.equal((h.service as any).controllers.size, 0);
  } finally { await fs.rm(h.dir, { recursive: true, force: true }); }
});

test("排隊時中斷不啟動 adapter", async () => {
  const h = await fixture(); let unblock: Function;
  h.adapter.listReports = () => new Promise(resolve => { unblock = () => resolve([{ id: "r", name: "r" }]); });
  try {
    const task = await h.service.createDownloadTask("r", {}); await immediate();
    h.service.cancelDownloadTask(task.id); unblock!();
    await waitFor(() => h.service.getDownloadTask(task.id).status === "cancelled"); assert.equal(h.calls.length, 0);
  } finally { await fs.rm(h.dir, { recursive: true, force: true }); }
});

test("批次中斷保留完成檔案、取消目前與待執行項目", async () => {
  const h = await fixture(); const pending = h.adapter.downloadReport;
  h.adapter.downloadReport = (input: any) => h.calls.length === 0 ? (h.calls.push(input), Promise.resolve({ filePath: h.file })) : pending(input);
  try {
    const task = await h.service.createBatchDownloadTask(Array.from({ length: 4 }, () => ({ reportId: "r", parameters: {} })), { maxRetries: 3 });
    await waitFor(() => h.calls.length === 2);
    h.service.cancelBatchDownloadTask(task.id);
    await waitFor(() => h.service.getBatchDownloadTask(task.id).status === "cancelled");
    const result = h.service.getBatchDownloadTask(task.id);
    assert.equal(result.completedCount, 1); assert.equal(result.cancelledCount, 3); assert.equal(result.failedCount, 0); assert.equal(h.calls.length, 2);
    assert.equal(result.items[0].filePath, h.file); assert.equal((await fs.readFile(h.file, "utf8")).includes("report"), true);
    assert.equal(h.service.getBatchDownloadResult(task.id).files.length, 1);
  } finally { await fs.rm(h.dir, { recursive: true, force: true }); }
});

test("A/B 平行中斷取消兩個下載並停止後續佇列", async () => {
  const h = await fixture();
  try {
    const task = await h.service.createBatchDownloadTask(Array.from({ length: 5 }, () => ({ reportId: "r", parameters: {} })), { parallelism: 2 });
    await waitFor(() => h.calls.length === 2); h.service.cancelBatchDownloadTask(task.id);
    await waitFor(() => h.service.getBatchDownloadTask(task.id).status === "cancelled");
    assert.equal(h.service.getBatchDownloadTask(task.id).cancelledCount, 5); assert.ok(h.calls.every(c => c.signal.aborted)); assert.equal(h.calls.length, 2);
  } finally { await fs.rm(h.dir, { recursive: true, force: true }); }
});

test("重試倒數可立即中斷，不等待完整重試間隔", async () => {
  const h = await fixture();
  h.adapter.downloadReport = async (input: any) => { h.calls.push(input); throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, "timeout"); };
  try {
    const task = await h.service.createBatchDownloadTask([{ reportId: "r", parameters: {} }], { maxRetries: 3, retryDelaySeconds: 300 });
    await waitFor(() => h.service.getBatchDownloadTask(task.id).items[0].status === "retrying");
    h.service.cancelBatchDownloadTask(task.id);
    await waitFor(() => h.service.getBatchDownloadTask(task.id).status === "cancelled", 500);
    assert.equal(h.calls.length, 1); assert.equal(h.service.getBatchDownloadTask(task.id).items[0].nextRetryAt, undefined);
  } finally { await fs.rm(h.dir, { recursive: true, force: true }); }
});

test("完成後的中斷請求不改寫已完成任務", async () => {
  const h = await fixture(); h.adapter.downloadReport = async () => ({ filePath: h.file });
  try {
    const task = await h.service.createDownloadTask("r", {}); await waitFor(() => h.service.getDownloadTask(task.id).status === "completed");
    assert.equal(h.service.cancelDownloadTask(task.id).status, "completed");
    assert.throws(() => h.service.cancelDownloadTask("missing"), /Unknown task/);
  } finally { await fs.rm(h.dir, { recursive: true, force: true }); }
});

test("Context 中斷只關閉本任務一次，不關閉其他 context", async () => {
  let a = 0, b = 0; const first = new AbortController(), second = new AbortController();
  const releaseA = bindContextCancellation({ close: async () => { a++; } }, first.signal);
  const releaseB = bindContextCancellation({ close: async () => { b++; } }, second.signal);
  first.abort(); await releaseA(); assert.equal(a, 1); assert.equal(b, 0); await releaseB(); assert.equal(b, 1);
});

test("EBAS 下載在導航中可由 signal 關閉 context 中斷，共用 Browser 保留", async () => {
  const adapter: any = new EbasReportAdapter(loadConfig());
  let rejectNavigation: Function, closed = 0, browserClosed = 0;
  const context: any = { newPage: async () => ({ goto: () => new Promise((_, reject) => { rejectNavigation = reject; }) }), close: async () => { closed++; rejectNavigation?.(new Error("context closed")); } };
  const browser: any = { newContext: async () => context, close: async () => { browserClosed++; } };
  const controller = new AbortController();
  try {
    const task = adapter.runDownload(browser, { reportId: "r", parameters: {}, signal: controller.signal }, { name: "report" }, "auth.json");
    const rejects = assert.rejects(task, /context closed/);
    await waitFor(() => Boolean(rejectNavigation)); controller.abort(); await rejects;
    assert.equal(closed, 1); assert.equal(browserClosed, 0);
  } finally { for (const e of ["exit", "SIGINT", "SIGTERM"]) process.removeListener(e, adapter.closeBrowserOnExit); }
});

test("MCP 可中斷單筆與批次任務", async () => {
  const h = await fixture(), mcp = new MinimalMcpServer(h.service);
  try {
    for (const batch of [false, true]) {
      const task = batch ? await h.service.createBatchDownloadTask([{ reportId: "r", parameters: {} }]) : await h.service.createDownloadTask("r", {});
      const result = JSON.parse((await mcp.callTool(batch ? "cancel_batch_download_task" : "cancel_download_task", { taskId: task.id })).content[0].text);
      assert.equal(result.status, "cancelling");
      await waitFor(() => (batch ? h.service.getBatchDownloadTask(task.id) : h.service.getDownloadTask(task.id)).status === "cancelled");
    }
  } finally { await fs.rm(h.dir, { recursive: true, force: true }); }
});

test("UI 只在可中斷時顯示按鈕，正在中斷時停用", async () => {
  const source = await fs.readFile("public/legacy/app.js", "utf8");
  const start = source.indexOf("function renderCancelTaskButton"), end = source.indexOf("function renderTask()", start);
  const sandbox: any = { state: { cancelRequestedId: null } }; vm.createContext(sandbox); vm.runInContext(source.slice(start, end), sandbox);
  assert.match(sandbox.renderCancelTaskButton({ id: "t", status: "running" }), /中斷任務/);
  assert.match(sandbox.renderCancelTaskButton({ id: "t", status: "cancelling" }), /disabled/);
  assert.equal(sandbox.renderCancelTaskButton({ id: "t", status: "completed" }), "");
  sandbox.state.cancelRequestedId = "t"; assert.match(sandbox.renderCancelTaskButton({ id: "t", status: "running" }), /disabled/);
});


test("中斷取消 EBAS 自訂下載監聽與計時器，無需等下載 timeout", async () => {
  const context: any = new EventEmitter(), page: any = new EventEmitter();
  context.pages = () => [page]; page.context = () => context;
  for (const closeContext of [false, true]) {
    const controller = new AbortController();
    const waiter = waitForEbasDownload(page, 300000, undefined, controller.signal);
    const result = assert.rejects(waiter);
    if (closeContext) context.emit("close"); else controller.abort();
    await result;
    assert.equal(context.listenerCount("page"), 0); assert.equal(context.listenerCount("close"), 0);
    assert.equal(page.listenerCount("download"), 0); assert.equal(page.listenerCount("dialog"), 0);
  }
});


test("中斷與下載完成同時發生時不覆寫取消狀態，保留已保存檔案", async () => {
  const h = await fixture(); let resolveDownload: Function;
  h.adapter.downloadReport = (input: any) => { h.calls.push(input); return new Promise(resolve => { resolveDownload = resolve; }); };
  try {
    const task = await h.service.createDownloadTask("r", {}); await waitFor(() => h.calls.length === 1);
    h.service.cancelDownloadTask(task.id); resolveDownload!({ filePath: h.file });
    await waitFor(() => h.service.getDownloadTask(task.id).status === "cancelled");
    assert.equal(h.service.getDownloadTask(task.id).filePath, h.file);
    assert.equal((await fs.stat(h.file)).isFile(), true);
  } finally { await fs.rm(h.dir, { recursive: true, force: true }); }
});

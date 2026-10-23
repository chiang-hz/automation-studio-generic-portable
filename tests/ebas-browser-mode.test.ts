import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { normalizeBrowserMode } from "../src/domain/browserMode.ts";
import { EbasReportAdapter } from "../src/adapters/ebasReportAdapter.ts";
import { ReportService } from "../src/services/reportService.ts";
import { TaskStore } from "../src/domain/taskStore.ts";
import { MinimalMcpServer } from "../src/mcp/server.ts";
import { loadConfig } from "../src/config.ts";
import { FlowError, ErrorCodes } from "../src/domain/errors.ts";

function fakeBrowser() {
  const handlers = new Map<string, Function>();
  let closes = 0;
  return { once: (event: string, fn: Function) => handlers.set(event, fn), close: async () => { closes++; handlers.get("disconnected")?.(); }, disconnect: () => handlers.get("disconnected")?.(), get closes() { return closes; } };
}
async function cleanup(adapter: any) {
  await adapter.disposeBrowser();
  for (const event of ["exit", "SIGINT", "SIGTERM"]) process.removeListener(event, adapter.closeBrowserOnExit);
}

test("下載模式預設 headed，拒絕未知參數", () => {
  assert.equal(normalizeBrowserMode(undefined), "headed");
  assert.equal(normalizeBrowserMode("headless"), "headless");
  for (const value of [null, "auto", "false", true, 0]) assert.throws(() => normalizeBrowserMode(value), /browserMode/);
});

test("有頭與無頭使用獨立 browser，相同模式並行只啟動一次", async () => {
  const launches: any[] = [];
  const adapter: any = new EbasReportAdapter({ ...loadConfig(), headless: true }, async (options) => { launches.push(options); return fakeBrowser() as any; });
  try {
    const [a, b, c] = await Promise.all([adapter.getBrowser("headed"), adapter.getBrowser("headless"), adapter.getBrowser("headed")]);
    assert.equal(a, c); assert.notEqual(a, b); assert.equal(launches.length, 2);
    assert.deepEqual(launches.map(x => x.headless).sort(), [false, true]);
    a.disconnect(); const replacement = await adapter.getBrowser("headed");
    assert.notEqual(a, replacement); assert.equal(await adapter.getBrowser("headless"), b);
    a.disconnect(); assert.equal(await adapter.getBrowser("headed"), replacement);
    await adapter.disposeBrowser(); assert.equal(b.closes, 1); assert.equal(replacement.closes, 1);
  } finally { await cleanup(adapter); }
});

test("單一模式啟動失敗不影響另一模式，後續可重新啟動", async () => {
  let fail = true;
  const adapter: any = new EbasReportAdapter(loadConfig(), async options => {
    if (options.headless && fail) { fail = false; throw new Error("launch failed"); }
    return fakeBrowser() as any;
  });
  try {
    const headed = await adapter.getBrowser("headed");
    await assert.rejects(adapter.getBrowser("headless"), /launch failed/);
    assert.equal(await adapter.getBrowser("headed"), headed);
    assert.notEqual(await adapter.getBrowser("headless"), headed);
  } finally { await cleanup(adapter); }
});

async function createService() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ebas-mode-"));
  const file = path.join(dir, "report.csv"); await fs.writeFile(file, "name,amount\ntest,1\n");
  const calls: any[] = [];
  const adapter: any = { listReports: async () => [{ id: "r", name: "Report", outputFormat: "csv" }], getReportParameters: async () => [], downloadReport: async (input: any) => { calls.push(input); return { filePath: file }; } };
  return { dir, calls, adapter, service: new ReportService(adapter, new TaskStore()) };
}
async function finish(read: () => any) {
  const deadline = Date.now() + 5000;
  while (["queued", "running"].includes(read().status)) {
    if (Date.now() > deadline) throw new Error("task did not finish");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return read();
}

test("單筆任務保存預設模式，Debug 無頭照原選擇傳入 adapter", async () => {
  const h = await createService();
  try {
    const first = await h.service.createDownloadTask("r", {});
    assert.equal(first.browserMode, "headed");
    assert.equal((await finish(() => h.service.getDownloadTask(first.id))).browserMode, "headed");
    const second = await h.service.createDownloadTask("r", {}, { browserMode: "headless", debugEnabled: true });
    await finish(() => h.service.getDownloadTask(second.id));
    assert.deepEqual(h.calls.map(x => [x.browserMode, x.debugEnabled]), [["headed", false], ["headless", true]]);
  } finally { await fs.rm(h.dir, { recursive: true, force: true }); }
});

test("批次 A/B 與重試沿用相同模式，子任務狀態保存模式", async () => {
  const h = await createService(); let first = true;
  h.adapter.downloadReport = async (input: any) => {
    h.calls.push(input);
    if (first) { first = false; throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, "temporary network failure"); }
    return { filePath: path.join(h.dir, "report.csv") };
  };
  try {
    const task = await h.service.createBatchDownloadTask([{ reportId: "r", parameters: {} }, { reportId: "r", parameters: {} }], { browserMode: "headless", debugEnabled: true, parallelism: 2, maxRetries: 1, retryDelaySeconds: 1, workerStorageStatePaths: { A: "a.json", B: "b.json" } });
    const result = await finish(() => h.service.getBatchDownloadTask(task.id));
    assert.equal(result.status, "completed"); assert.equal(result.browserMode, "headless");
    assert.ok(result.items.every((item: any) => item.browserMode === "headless"));
    assert.equal(h.calls.length, 3); assert.ok(h.calls.every(input => input.browserMode === "headless" && input.debugEnabled));
    assert.deepEqual([...new Set(h.calls.map(input => input.workerId))].sort(), ["A", "B"]);
    assert.ok(h.calls.every(input => input.storageStatePath === `${input.workerId.toLowerCase()}.json`));
  } finally { await fs.rm(h.dir, { recursive: true, force: true }); }
});

test("MCP 單筆與批次 schema 宣告 browserMode 並傳遞至任務", async () => {
  const h = await createService(), mcp = new MinimalMcpServer(h.service);
  try {
    const list: any = await mcp.listTools();
    for (const name of ["create_download_task", "create_batch_download_task"]) {
      const schema = list.tools.find((t: any) => t.name === name).inputSchema.properties.browserMode;
      assert.deepEqual(schema.enum, ["headed", "headless"]); assert.equal(schema.default, "headed");
    }
    const single = JSON.parse((await mcp.callTool("create_download_task", { reportId: "r", browserMode: "headless", debug: true })).content[0].text);
    assert.equal(single.browserMode, "headless"); await finish(() => h.service.getDownloadTask(single.id));
    const batch = JSON.parse((await mcp.callTool("create_batch_download_task", { items: [{ reportId: "r" }], retryEnabled: false })).content[0].text);
    assert.equal(batch.browserMode, "headed"); await finish(() => h.service.getBatchDownloadTask(batch.id));
    await assert.rejects(mcp.callTool("create_download_task", { reportId: "r", browserMode: "auto" }), /browserMode/);
  } finally { await fs.rm(h.dir, { recursive: true, force: true }); }
});

test("UI 提醒只在 Debug 加無頭出現，不改變選擇", async () => {
  const source = await fs.readFile("public/legacy/app.js", "utf8");
  const start = source.indexOf("function updateBrowserModeWarning()");
  const end = source.indexOf("function formatTaskStatus", start);
  const elements: any = { debugToggle: { checked: false }, browserModeSelect: { value: "headless" }, browserModeWarning: { hidden: true } };
  const sandbox: any = { elements }; vm.createContext(sandbox); vm.runInContext(source.slice(start, end), sandbox);
  sandbox.updateBrowserModeWarning(); assert.equal(elements.browserModeWarning.hidden, true);
  elements.debugToggle.checked = true; sandbox.updateBrowserModeWarning(); assert.equal(elements.browserModeWarning.hidden, false); assert.equal(elements.browserModeSelect.value, "headless");
  elements.browserModeSelect.value = "headed"; sandbox.updateBrowserModeWarning(); assert.equal(elements.browserModeWarning.hidden, true);
  assert.equal(sandbox.formatBrowserMode("headless"), "無頭模式");
  const html = await fs.readFile("public/legacy/index.html", "utf8"); assert.match(html, /value="headed" selected/);
});

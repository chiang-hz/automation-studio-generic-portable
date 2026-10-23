import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkflowRunner, uniquePath } from "../src/studio/executor.ts";
import { createDefaultProject } from "../src/studio/store.ts";
import { normalizeBatchConcurrency, effectiveBatchConcurrency } from "../src/studio/concurrency.ts";
import { resolveBatchWorkerProfileDir, resolveProjectProfileDir } from "../src/studio/profile.ts";

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

function harness(concurrency: number) {
  const project = createDefaultProject({ name: "批次並行測試", targetUrl: "https://example.com" });
  project.settings.defaultConcurrency = concurrency;
  const records = new Map<string, any>();
  const store = {
    saveRun: async (run: any) => { records.set(run.id, run); },
    getRun: async (id: string) => records.get(id),
    cleanupCompletedRunDebug: async () => {},
    maybeCleanupExpiredDebug: async () => {},
    maybeCleanupExpiredRunHistory: async () => {}
  };
  const runner = new WorkflowRunner(store as any) as any;
  const started: Array<{ run: any; options: any; finish: (failed?: boolean) => void }> = [];
  let active = 0, peak = 0;
  runner.execute = async (_project: any, run: any, _steps: any, options: any) => {
    active++; peak = Math.max(peak, active);
    run.status = "running";
    await new Promise<void>(resolve => started.push({ run, options, finish: (failed = false) => {
      if (options.batchSessionId) {
        if (options.batchSessionLast || failed) runner.batchSessions.delete(options.batchSessionId);
        else runner.batchSessions.set(options.batchSessionId, {});
      }
      active--; run.status = failed ? "failed" : "completed"; resolve();
    } }));
  };
  const clean = async () => {
    while (runner.activeCount || runner.queue.length) {
      for (const entry of started) if (entry.run.status === "running") entry.finish();
      await flush();
    }
    await fs.rm(path.resolve("debug", project.id), { recursive: true, force: true });
  };
  return { project, runner, started, clean, peak: () => peak };
}

test("批次上限 3：前三筆並行，同一工作站後續資料等待並沿用該工作階段", async () => {
  const h = harness(3);
  try {
    const runs = await h.runner.startBatch(h.project, Array.from({ length: 7 }, (_, i) => ({ row: String(i) })));
    await flush();
    assert.equal(h.started.length, 3);
    assert.deepEqual(h.started.map(x => x.run.batchWorker), [1, 2, 3]);
    assert.equal(runs[3].status, "queued");
    h.started[1].finish(); await flush();
    assert.equal(h.started.length, 4);
    assert.equal(h.started[3].run.parameters.row, "4");
    assert.equal(h.started[3].options.batchSessionId, h.started[1].options.batchSessionId);
    assert.equal(h.started[3].options.batchWorker, 2);
    assert.equal(h.peak(), 3);
  } finally { await h.clean(); }
  assert.equal(h.runner.batchSessions.size, 0);
  assert.equal(h.runner.resourceOwners.size, 0);
});

test("同時執行數 1／2 與 CDP 接管均遵守實際上限", async () => {
  for (const [configured, cdp, expected] of [[1, false, 1], [2, false, 2], [3, true, 1]] as const) {
    const h = harness(configured);
    if (cdp) h.project.browser.connectionMode = "cdp";
    try {
      const runs = await h.runner.startBatch(h.project, Array.from({ length: 5 }, () => ({})));
      await flush();
      assert.equal(h.started.length, expected);
      assert.ok(runs.every((r: any) => r.batchConcurrency === expected));
      if (expected === 1) assert.ok(runs.every((r: any) => !r.batchWorker));
    } finally { await h.clean(); }
    assert.equal(h.peak(), expected);
  }
});

test("同專案重複啟動批次不會共用正在使用或保留的工作站", async () => {
  const h = harness(3);
  try {
    await h.runner.startBatch(h.project, Array.from({ length: 6 }, (_, i) => ({ group: "first", row: String(i) })));
    await flush();
    await h.runner.startBatch(h.project, Array.from({ length: 3 }, () => ({ group: "second" })));
    await flush();
    assert.equal(h.started.length, 3);
    h.started[0].finish(); await flush();
    assert.equal(h.started[3].run.parameters.group, "first");
    assert.equal(h.started[3].run.batchWorker, 1);
    h.started[3].finish(); await flush();
    assert.equal(h.started[4].run.parameters.group, "second");
    assert.equal(h.started[4].run.batchWorker, 1);
    assert.equal(h.peak(), 3);
  } finally { await h.clean(); }
});

test("失敗釋放工作站，後續批次資料仍可繼續排程", async () => {
  const h = harness(3);
  try {
    await h.runner.startBatch(h.project, Array.from({ length: 6 }, () => ({})));
    await flush();
    h.started[0].finish(true); await flush();
    assert.equal(h.started[3].run.batchWorker, 1);
    assert.equal(h.started[0].run.status, "failed");
    assert.equal(h.peak(), 3);
  } finally { await h.clean(); }
});

test("取消等待中的末筆資料會關閉保留工作階段並釋放工作站", async () => {
  const h = harness(1);
  try {
    // Use the real executor cancellation path; no browser runtime is needed.
    delete h.runner.execute;
    const run: any = { id: "cancelled", projectId: h.project.id, status: "cancelled", parameters: {}, debugDir: path.resolve("debug", h.project.id) };
    await fs.mkdir(run.debugDir, { recursive: true });
    let closes = 0;
    h.runner.batchSessions.set("session", { context: { close: async () => { closes++; } }, page: {}, externalBrowser: false });
    h.runner.activeRuns.set(run.id, { cancelled: true });
    h.runner.queue.push({ project: h.project, run, steps: [], batchSessionId: "session", batchSessionLast: true, concurrency: 1 });
    h.runner.resourceOwners.set(resolveProjectProfileDir(h.project.id), "session");
    h.runner.pumpQueue(); await flush();
    assert.equal(closes, 1);
    assert.equal(h.runner.activeCount, 0);
    assert.equal(h.runner.batchSessions.size, 0);
    assert.equal(h.runner.resourceOwners.size, 0);
  } finally { await h.clean(); }
});

test("設定正規化、工作站路徑隔離與並行下載同名檔案", async () => {
  assert.deepEqual([undefined, 0, -1, 2.9, 99, NaN].map(normalizeBatchConcurrency), [1, 1, 1, 2, 3, 1]);
  const project = createDefaultProject({ name: "獨立設定" });
  project.settings.defaultConcurrency = 3;
  assert.equal(effectiveBatchConcurrency(project), 3);
  const profiles = [1, 2, 3].map(worker => resolveBatchWorkerProfileDir(project.id, worker));
  assert.equal(new Set(profiles).size, 3);
  assert.ok(profiles.every(p => p !== resolveProjectProfileDir(project.id)));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "studio-parallel-files-"));
  try {
    const paths = await Promise.all(Array.from({ length: 3 }, () => uniquePath(directory, "報表.pdf")));
    assert.equal(new Set(paths).size, 3);
    await Promise.all(paths.map((p, i) => fs.writeFile(p, String(i))));
    assert.deepEqual(await Promise.all(paths.map(p => fs.readFile(p, "utf8"))), ["0", "1", "2"]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

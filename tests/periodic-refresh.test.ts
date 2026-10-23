import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createPeriodicPageRefresher, refreshIntervalMs } from "../src/studio/periodicRefresh.ts";

test("定期重新整理預設關閉，啟用時預設 10 秒", () => {
  assert.equal(refreshIntervalMs({}), 0);
  assert.equal(refreshIntervalMs({ periodicRefresh: false, refreshIntervalSeconds: 5 }), 0);
  assert.equal(refreshIntervalMs({ periodicRefresh: true }), 10_000);
  assert.equal(refreshIntervalMs({ periodicRefresh: true, refreshIntervalSeconds: 60 }), 60_000);
  for (const invalid of [0, 4, 601, 2.5, Number.NaN]) {
    assert.throws(() => refreshIntervalMs({ periodicRefresh: true, refreshIntervalSeconds: invalid }), /5～600 秒/);
  }
});

test("在等待期限內每隔 10 秒重新整理同一分頁，並避免重複觸發", async () => {
  let clock = 1000;
  const calls: Array<{ waitUntil: string; timeout: number }> = [];
  const page = { async reload(options: { waitUntil: "domcontentloaded"; timeout: number }) {
    calls.push(options);
    clock += 100;
  } };
  const refresh = createPeriodicPageRefresher(page, { periodicRefresh: true, refreshIntervalSeconds: 10 }, 31_000, () => clock);
  assert.equal(await refresh.refreshIfDue(), false);
  clock = 11_000;
  assert.equal(await refresh.refreshIfDue(), true);
  assert.equal(await refresh.refreshIfDue(), false);
  clock = 21_100;
  assert.equal(await refresh.refreshIfDue(), true);
  assert.equal(refresh.count(), 2);
  assert.deepEqual(calls, [{ waitUntil: "domcontentloaded", timeout: 15_000 }, { waitUntil: "domcontentloaded", timeout: 9_900 }]);
  clock = 31_000;
  assert.equal(await refresh.refreshIfDue(), false);
  assert.equal(refresh.count(), 2);
});

test("原本不開啟定期重新整理的流程不會自動重新載入", async () => {
  let clock = 0;
  let calls = 0;
  const refresh = createPeriodicPageRefresher({ reload: async () => { calls++; } }, { periodicRefresh: false, refreshIntervalSeconds: 10 }, 120_000, () => clock);
  clock = 60_000;
  assert.equal(await refresh.refreshIfDue(), false);
  assert.equal(calls, 0);
});

test("重新整理失敗時不會立即無限重試", async () => {
  let clock = 0;
  let calls = 0;
  const refresh = createPeriodicPageRefresher({ reload: async () => { calls++; throw new Error("network aborted"); } }, { periodicRefresh: true, refreshIntervalSeconds: 5 }, 50_000, () => clock);
  clock = 5000;
  await assert.rejects(() => refresh.refreshIfDue(), /network aborted/);
  assert.equal(await refresh.refreshIfDue(), false);
  assert.equal(calls, 1);
});

test("設定欄位同時存在於步驟表單、核心執行器及獨立 TypeScript 匯出範本", async () => {
  const [form, executor, standalone, type] = await Promise.all([
    fs.readFile("public/app.js", "utf8"),
    fs.readFile("src/studio/executor.ts", "utf8"),
    fs.readFile("src/studio/templates/generated-runner.ts.txt", "utf8"),
    fs.readFile("src/studio/types.ts", "utf8")
  ]);
  assert.match(form, /id="periodicRefresh"/);
  assert.match(form, /id="refreshIntervalSeconds"/);
  assert.match(form, /readPeriodicRefreshSettings\(step\)/);
  assert.match(executor, /createPeriodicPageRefresher/);
  assert.match(standalone, /makePeriodicRefresher/);
  assert.match(type, /refreshIntervalSeconds\?: number/);
});

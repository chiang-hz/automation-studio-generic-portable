import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { prepareStudioChromium } from "../src/studio/stealth.ts";
import { createDefaultProject, StudioStore } from "../src/studio/store.ts";
import { ExportService } from "../src/studio/exporter.ts";

test("Stealth off and CDP do not import or modify plugin state", async () => {
  const chromium = {};
  const fail = async () => { throw new Error("must not load"); };
  for (const settings of [{}, { stealth: false }, { stealth: true, connectionMode: "cdp" }]) {
    assert.equal(await prepareStudioChromium({ chromium }, settings, fail as any), chromium);
  }
});

test("enabled projects receive independent plugin instances before launch", async () => {
  const base = {};
  const loaded: any[] = [];
  const loader = async () => ({
    addExtra: (original: any) => {
      assert.equal(original, base);
      return { use(plugin: any) { loaded.push(plugin); } };
    },
    StealthPlugin: () => ({})
  });
  const a = await prepareStudioChromium({ chromium: base }, { stealth: true }, loader as any);
  const b = await prepareStudioChromium({ chromium: base }, { stealth: true }, loader as any);
  assert.notEqual(a, b);
  assert.notEqual(loaded[0], loaded[1]);
  assert.equal(loaded.length, 2);
});

test("missing plugin fails explicitly rather than running without Stealth", async () => {
  await assert.rejects(prepareStudioChromium({ chromium: {} }, { stealth: true }, async () => {
    throw new Error("missing");
  }), /npm install/);
});

test("per-project setting survives storage and TypeScript export; legacy defaults off", async () => {
  const store = new StudioStore();
  const exporter = new ExportService();
  const project = createDefaultProject({ id: `stealth-test-${Date.now()}`, targetUrl: "https://example.com" });
  assert.equal(project.browser.stealth, false);
  try {
    for (const [mode, enabled] of [["managed", true], ["managed", false], ["cdp", true]] as const) {
      project.browser.connectionMode = mode;
      project.browser.stealth = enabled;
      const saved = await store.saveProject(project);
      assert.equal(saved.browser.stealth, enabled);
      assert.equal((await store.getProject(project.id)).browser.stealth, enabled);
      const result = await exporter.create(saved, { portableWorkflow: true, typescript: true, skill: false, includeTests: false, includeExamples: false });
      try {
        const zip = await fs.readFile(result.filePath);
        assert.ok(zip.includes(Buffer.from('"stealth": ' + enabled)));
        assert.ok(zip.includes(Buffer.from("typescript-project/src/stealth.ts")));
        assert.ok(zip.includes(Buffer.from("const chromium = await prepareStudioChromium")));
        // Dependencies occur only in enabled managed exports (helper imports are lazy).
        assert.equal(zip.includes(Buffer.from('"playwright-extra": "^4.3.6"')), enabled && mode === "managed");
      } finally { await fs.rm(result.filePath, { force: true }); }
    }
    delete project.browser.stealth;
    assert.equal((await store.saveProject(project)).browser.stealth, false);
  } finally { await store.deleteProject(project.id); }
});

test("persistent initial pages receive Stealth hooks before the caller navigates", async () => {
  const page = {};
  const context = { pages: () => [page] };
  let patched = false;
  const loader = async () => ({
    addExtra: () => ({
      use() {},
      launchPersistentContext: async () => context,
      plugins: { dispatchBlocking: async (hook: string, target: any) => {
        assert.equal(hook, "onPageCreated");
        assert.equal(target, page);
        patched = true;
      } }
    }),
    StealthPlugin: () => ({})
  });
  const chromium = await prepareStudioChromium({ chromium: {} }, { stealth: true }, loader as any);
  assert.equal(await chromium.launchPersistentContext("profile", {}), context);
  assert.equal(patched, true);
});

test("installed Stealth plugins attach independently to actual playwright-extra wrappers", async () => {
  const playwright = await import("playwright");
  const a = await prepareStudioChromium(playwright, { stealth: true });
  const b = await prepareStudioChromium(playwright, { stealth: true });
  assert.notEqual(a, b);
  assert.ok(a.plugins.list.some((plugin: any) => plugin.name === "stealth"));
  assert.notEqual(a.plugins.list[0], b.plugins.list[0]);
  assert.equal(await prepareStudioChromium(playwright, { stealth: false }), playwright.chromium);
});

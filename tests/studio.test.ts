import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveStudioBrowser } from "../src/studio/browser.ts";
import { cdpLaunchArguments, inspectCdpEndpoint, validateLocalCdpEndpoint } from "../src/studio/cdp.ts";
import { createGenericExample, recordedEventsToSteps } from "../src/studio/examples.ts";
import { ExportService } from "../src/studio/exporter.ts";
import { WorkflowRunner, extractPatternValue, isAllowedHostname, normalizeAllowedDomain, playbackStepDelay, preflightWorkflowDomains, appendDownloadTimestamp, resolveDownloadFileName, stabilizeRecordedCssSelector, decodedDownloadNameFromUrl, findWorkflowStepById, workflowStepsFromStepId, selectWorkflowRunSteps } from "../src/studio/executor.ts";
import { resolveStudioDownloadArtifact } from "../src/studio/downloadArtifacts.ts";
import { RecorderManager } from "../src/studio/recorder.ts";
import { clearBrowserProfile, ensurePdfDownloadPreference, getBrowserProfileStatus, resolveProjectProfileDir } from "../src/studio/profile.ts";
import { createDefaultProject, StudioStore } from "../src/studio/store.ts";
import { createZip } from "../src/studio/zip.ts";
import { GeminiProvider } from "../src/studio/ai/providers/gemini.ts";
import { fetchJson } from "../src/studio/ai/http.ts";
import { buildAIWorkflowRequest, buildAIWorkflowRevisionRequest, createAIWorkflowRevision, diffAIWorkflowDraft, normalizeAIWorkflowDraft } from "../src/studio/ai/workflowGenerator.ts";
import { createAIRecorderProjectId, isDownloadOnlyManualReason, normalizePlannerDecisionForSafeDownloads } from "../src/studio/ai/siteExplorer.ts";
import { buildAIDebugAnalysisRequest, createAIDebugAnalysis } from "../src/studio/ai/debugAnalyzer.ts";
import { buildFailureDiagnosticZip, captureFailureDiagnostics } from "../src/studio/debugDiagnostics.ts";
import { isDebugCleanupDue, removeRunDebugDirectory, sweepExpiredDebug } from "../src/studio/debugRetention.ts";
import { calculateRunHistoryUsage, findExpiredRunHistory, hasRunDiagnosticData, isRunHistoryCleanupDue, nextRunHistoryCleanupEligibleAt } from "../src/studio/runHistoryRetention.ts";

test("ZIP 產生器建立可辨識的 UTF-8 ZIP", () => {
  const zip = createZip([
    { name: "workflow/流程.json", data: "{\"ok\":true}" },
    { name: "workflow/README.md", data: "# 測試" }
  ]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.ok(zip.includes(Buffer.from("workflow/流程.json")));
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
});


test("DGBAS Download.ashx 可由 base64 查詢參數辨識 PDF 檔名", () => {
  const url = "https://ws.dgbas.gov.tw/Download.ashx?u=LzAwMS9VcGxvYWQvNDYxL3JlbGZpbGUvMTA4MzMvMjM1NDU3L%2bS4reiPr%2bawkeWci%2bS4gOeZvuWNgeWbm%2bW5tOW6pue4veaxuueul%2be3qOijveS9nOalreaJi%2bWGiijlhagpLnBkZg%3d%3d&n=5Lit6I%2bv5rCR5ZyL5LiA55m%2b5Y2B5Zub5bm05bqm57i95rG6566X57eo6KO95L2c5qWt5omL5YaKKOWFqCkucGRm";
  assert.equal(decodedDownloadNameFromUrl(url), "中華民國一百十四年度總決算編製作業手冊(全).pdf");
});


test("PDF 直接下載設定會寫入專案 Chrome Profile 並保留既有偏好", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "automation-studio-pdf-pref-"));
  try {
    const defaultDir = path.join(temporary, "Default");
    await fs.mkdir(defaultDir, { recursive: true });
    await fs.writeFile(path.join(defaultDir, "Preferences"), JSON.stringify({ profile: { name: "測試" }, download: { directory_upgrade: true } }), "utf8");
    await ensurePdfDownloadPreference(temporary);
    const prefs = JSON.parse(await fs.readFile(path.join(defaultDir, "Preferences"), "utf8"));
    assert.equal(prefs.plugins.always_open_pdf_externally, true);
    assert.equal(prefs.download.prompt_for_download, false);
    assert.equal(prefs.download.open_pdf_in_system_reader, false);
    assert.equal(prefs.download.directory_upgrade, true);
    assert.equal(prefs.profile.name, "測試");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("新專案包含通用安全預設值", () => {
  const project = createDefaultProject({ name: "測試專案", targetUrl: "https://example.com" });
  assert.equal(project.browser.reuseProfile, true);
  assert.equal(project.browser.downloadPdfInsteadOfPreview, false);
  assert.equal(project.browser.connectionMode, "managed");
  assert.equal(project.browser.cdpEndpoint, "http://127.0.0.1:9222");
  assert.equal(project.browser.cdpAutoLaunch, true);
  assert.equal(project.browser.channel, "bundled");
  assert.equal(project.browser.headless, false);
  assert.equal(project.settings.defaultConcurrency, 1);
  assert.equal(project.settings.safePlayback, true);
  assert.equal(project.settings.humanizedPlayback, false);
  assert.equal(project.settings.minStepDelayMs, 2_000);
  assert.deepEqual(project.allowedDomains, ["example.com"]);
});



test("匯入舊流程時會自動補齊穩定的參數 ID", () => {
  const project = createDefaultProject({
    name: "舊流程",
    targetUrl: "https://example.com",
    parameters: [
      { name: "year", label: "年度", type: "text", required: true, defaultValue: "114" },
      { name: "stage", label: "階段", type: "text", required: true, defaultValue: "院編決算" },
      { id: "p-stage", name: "stage2", label: "階段2", type: "text", required: false }
    ] as any
  });
  assert.equal(project.parameters[0].id, "p-year");
  assert.equal(project.parameters[1].id, "p-stage");
  assert.equal(project.parameters[2].id, "p-stage-2");
});

test("CDP 自動啟動參數使用指定本機埠與獨立 Profile", () => {
  const args = cdpLaunchArguments("http://127.0.0.1:9333", "C:/AutomationStudio/TestProfile");
  assert.ok(args.includes("--remote-debugging-address=127.0.0.1"));
  assert.ok(args.includes("--remote-debugging-port=9333"));
  assert.ok(args.includes("--user-data-dir=C:/AutomationStudio/TestProfile"));
});
test("模擬人工操作模式會使用自然變化的安全步驟間隔", () => {
  for (let index = 0; index < 20; index += 1) {
    const delay = playbackStepDelay({ safePlayback: true, humanizedPlayback: true, minStepDelayMs: 2_000 });
    assert.ok(delay >= 2_150 && delay <= 2_850);
  }
  assert.equal(playbackStepDelay({ safePlayback: false, humanizedPlayback: false, minStepDelayMs: 2_000 }), 800);
});

test("舊專案缺少保守重播欄位時會補上安全預設值", () => {
  const project = createDefaultProject({
    name: "舊版專案",
    targetUrl: "https://example.com",
    settings: {
      maxRetries: 1,
      screenshotMode: "failure",
      saveHtmlOnFailure: true,
      captureConsole: true,
      captureNetwork: true,
      defaultConcurrency: 1
    } as any
  });
  assert.equal(project.settings.safePlayback, true);
  assert.equal(project.settings.minStepDelayMs, 2_000);
});

test("隨附 Chromium 不存在時可使用指定的本機瀏覽器", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "automation-studio-browser-"));
  const executable = path.join(temporary, "chrome.exe");
  await fs.writeFile(executable, "test-browser");
  const previous = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = executable;
  try {
    const resolution = await resolveStudioBrowser({ chromium: { executablePath: () => path.join(temporary, "missing", "chrome.exe") } }, "bundled");
    assert.equal(resolution.executablePath, executable);
    assert.equal(resolution.source, "環境變數指定瀏覽器");
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    else process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = previous;
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("未下載隨附 Chromium 時不自動改用受管理的 Edge", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "automation-studio-edge-"));
  const edgePath = path.join(temporary, "Microsoft", "Edge", "Application", "msedge.exe");
  await fs.mkdir(path.dirname(edgePath), { recursive: true });
  await fs.writeFile(edgePath, "test-edge");
  const previous = {
    executable: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    localAppData: process.env.LOCALAPPDATA,
    programFiles: process.env.ProgramFiles,
    programFilesX86: process.env["ProgramFiles(x86)"],
    programW6432: process.env.ProgramW6432
  };
  delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  process.env.LOCALAPPDATA = temporary;
  delete process.env.ProgramFiles;
  delete process.env["ProgramFiles(x86)"];
  delete process.env.ProgramW6432;
  try {
    const resolution = await resolveStudioBrowser({ chromium: { executablePath: () => path.join(temporary, "missing", "chrome.exe") } }, "bundled");
    assert.equal(resolution.executablePath, undefined);
    assert.equal(resolution.source, "找不到專案內可攜 Chromium runtime");
    assert.equal(resolution.available, false);
  } finally {
    if (previous.executable === undefined) delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    else process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = previous.executable;
    for (const [key, value] of Object.entries({ LOCALAPPDATA: previous.localAppData, ProgramFiles: previous.programFiles, "ProgramFiles(x86)": previous.programFilesX86, ProgramW6432: previous.programW6432 })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("錄製器建立獨立視窗、帶到前景並立即導向目標網址", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "automation-studio-recorder-"));
  const executable = path.join(temporary, "chrome.exe");
  await fs.writeFile(executable, "test-browser");
  const previous = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = executable;
  let foregroundCalls = 0;
  let launchOptions: Record<string, unknown> | undefined;
  let gotoOptions: Record<string, unknown> | undefined;
  let recordBinding: ((source: unknown, event: any) => void) | undefined;
  let responseListener: ((response: any) => void) | undefined;
  let currentUrl = "about:blank";
  const page = {
    isClosed: () => false,
    bringToFront: async () => { foregroundCalls += 1; },
    goto: async (url: string, options: Record<string, unknown>) => { currentUrl = url; gotoOptions = options; },
    url: () => currentUrl
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    exposeBinding: async (_name: string, callback: (source: unknown, event: any) => void) => { recordBinding = callback; },
    addInitScript: async () => undefined,
    on: (event: string, callback: (response: any) => void) => { if (event === "response") responseListener = callback; },
    once: () => undefined,
    close: async () => undefined
  };
  const manager = new RecorderManager(async () => ({
    chromium: {
      executablePath: () => path.join(temporary, "missing", "chrome.exe"),
      launchPersistentContext: async (_profile: string, options: Record<string, unknown>) => {
        launchOptions = options;
        return context;
      }
    }
  }) as never);
  try {
    const project = createDefaultProject({ id: "recorder-window-test", targetUrl: "https://example.com" });
    project.browser.channel = "bundled";
    const started = await manager.start(project);
    assert.equal(started.url, "https://example.com");
    assert.equal(gotoOptions?.waitUntil, "commit");
    assert.deepEqual(launchOptions?.args, ["--new-window"]);
    assert.deepEqual(launchOptions?.viewport, { width: 1440, height: 900 });
    assert.ok(foregroundCalls >= 2);
    await manager.focus(project.id);
    assert.ok(foregroundCalls >= 3);
    recordBinding?.({}, { type: "click", label: "錄製動作", url: currentUrl, targetUrl: "https://example.com/article", selector: [] });
    responseListener?.({
      status: () => 200,
      headers: () => ({ "content-type": "application/pdf" }),
      url: () => "https://example.com/files/report.pdf",
      request: () => undefined
    });
    assert.equal(manager.status(project.id).events.length, 2);
    assert.equal(manager.status(project.id).events.at(-1)?.type, "click", "文章載入的 PDF 資源不可把文章點擊誤判為下載");
    const active = manager.acquireActiveSession(project.id);
    assert.ok(active);
    recordBinding?.({}, { type: "click", label: "測試執行動作", url: currentUrl, selector: [] });
    assert.equal(manager.status(project.id).events.length, 2, "沿用工作階段測試時不應污染錄製事件");
    active.release();
    recordBinding?.({}, { type: "click", label: "繼續錄製", url: currentUrl, targetUrl: "https://example.com/report?id=1", selector: [] });
    responseListener?.({
      status: () => 200,
      headers: () => ({ "content-type": "application/pdf" }),
      url: () => "https://example.com/report?id=1",
      request: () => undefined
    });
    assert.equal(manager.status(project.id).events.length, 3);
    assert.equal(manager.status(project.id).events.at(-1)?.type, "download", "相同目標的 PDF 回應應升級為下載");
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    else process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = previous;
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("PDF 錄製事件會轉為下載步驟並保留精準 selector", () => {
  const selectors = [{ strategy: "css" as const, value: 'a[title="手冊.pdf"][href*="Download.ashx"]:visible' }];
  const [step] = recordedEventsToSteps([{ id: "record-pdf", createdAt: new Date().toISOString(), type: "download", label: "手冊.pdf", url: "https://www.dgbas.gov.tw/", selector: selectors }]);
  assert.equal(step.kind, "download");
  assert.deepEqual(step.selectors, selectors);
});

test("無副檔名 File/Doc 點擊事件會轉為下載步驟", () => {
  const selectors = [{ strategy: "css" as const, value: 'a[href="/File/Doc/9cd6c3a5-82d8-4dac-b960-a5b5713f1736"]:visible' }];
  const [step] = recordedEventsToSteps([{ id: "record-opaque-pdf", createdAt: new Date().toISOString(), type: "click", label: "[pdf]", url: "https://www.president.gov.tw/Page/294/50043", selector: selectors }]);
  assert.equal(step.kind, "download");
  assert.equal(step.waitAfter, undefined);
});

test("舊流程的無副檔名 File/Doc 點擊會自動升級為下載步驟", () => {
  const project = createDefaultProject({
    name: "舊 PDF 流程",
    steps: [{
      id: "legacy-pdf",
      name: "6. [pdf]",
      kind: "click",
      enabled: true,
      selectors: [{ strategy: "css", value: 'a[href="/File/Doc/9cd6c3a5-82d8-4dac-b960-a5b5713f1736"]:visible' }],
      waitAfter: { kind: "timeout", timeoutMs: 750 }
    }]
  });
  assert.equal(project.steps[0].kind, "download");
  assert.equal(project.steps[0].waitAfter, undefined);
});

test("錄製的搜尋點擊會等待下一個可見元件，不再固定只等 500ms", () => {
  const steps = recordedEventsToSteps([
    { id: "search", createdAt: new Date().toISOString(), type: "click", label: "搜尋", url: "https://example.com", selector: [{ strategy: "css", value: "button[title='搜尋']:visible" }] },
    { id: "result", createdAt: new Date().toISOString(), type: "click", label: "搜尋結果", url: "https://example.com", selector: [{ strategy: "css", value: "a[title='結果']:visible" }] }
  ]);
  assert.deepEqual(steps[0].waitAfter, { kind: "visible", value: "a[title='結果']:visible", timeoutMs: 10_000 });
});

test("舊錄製流程的 500ms 點擊等待會在載入時升級為可見等待", () => {
  const project = createDefaultProject({
    name: "舊流程",
    steps: [
      { id: "click", name: "搜尋", kind: "click", enabled: true, waitAfter: { kind: "timeout", timeoutMs: 500 }, selectors: [{ strategy: "css", value: "button:visible" }] },
      { id: "result", name: "結果", kind: "click", enabled: true, selectors: [{ strategy: "css", value: "a.result:visible" }] }
    ]
  });
  assert.deepEqual(project.steps[0].waitAfter, { kind: "visible", value: "a.result:visible", timeoutMs: 10_000 });
});

test("Google CSE 暫時轉址不會寫入步驟或 Hover 等待條件", () => {
  const temporaryHref = "https://www.google.com/url?client=internal-element-cse&cx=61e3449c720a04370&q=https://www.dgbas.gov.tw/News_Content.aspx%3Fn%3D1961%26s%3D235457&sa=U&ved=temporary&usg=temporary&fexp=temporary";
  const titleSelector = 'a[title="114年度總決算編製作業手冊 - 行政院主計總處"]:visible';
  const events = [
    { id: "hover-result", createdAt: new Date().toISOString(), type: "hover" as const, label: "搜尋結果", url: "https://www.dgbas.gov.tw/", selector: [{ strategy: "css" as const, value: "button[aria-haspopup=menu]:visible" }] },
    { id: "click-result", createdAt: new Date().toISOString(), type: "click" as const, label: "114年度總決算編製作業手冊", url: "https://www.dgbas.gov.tw/", selector: [
      { strategy: "css" as const, value: `a[title="114年度總決算編製作業手冊 - 行政院主計總處"][href="${temporaryHref}"]:visible` },
      { strategy: "css" as const, value: titleSelector },
      { strategy: "text" as const, value: "114年度總決算編製作業手冊 - 行政院主計總處", exact: true }
    ] }
  ];
  const [hover, click] = recordedEventsToSteps(events);
  assert.deepEqual(hover.waitAfter, { kind: "visible", value: titleSelector, timeoutMs: 5_000 });
  assert.ok(click.selectors?.every((rule) => !rule.value.includes("google.com/url?")));
  assert.equal(click.selectors?.filter((rule) => rule.value === titleSelector).length, 1);
  assert.equal(stabilizeRecordedCssSelector(`a[title="114年度總決算編製作業手冊 - 行政院主計總處"][href="${temporaryHref}"]:visible`), titleSelector);
});

test("無關的導覽列 Hover 不會綁定 Google 搜尋結果等待條件", () => {
  const events = [
    { id: "search", createdAt: new Date().toISOString(), type: "click" as const, label: "搜尋", url: "https://www.dgbas.gov.tw/Default.aspx", selector: [{ strategy: "css" as const, value: 'a[title="搜尋"][href="#"]:visible' }] },
    { id: "incidental-hover", createdAt: new Date().toISOString(), type: "hover" as const, label: "相關連結", url: "https://www.dgbas.gov.tw/Default.aspx", selector: [{ strategy: "css" as const, value: '[data-groupsn="491"] a[title="相關連結"][href="cl.aspx?n=1900"]:visible' }] },
    { id: "article", createdAt: new Date().toISOString(), type: "click" as const, label: "114年度總決算編製作業手冊 - 行政院主計總處", url: "https://www.dgbas.gov.tw/Default.aspx", selector: [
      { strategy: "css" as const, value: 'a[href*="News_Content.aspx%3Fn%3D1961%26s%3D235457"]:visible', description: "Google 站內搜尋的穩定目標網址" },
      { strategy: "css" as const, value: 'a[title="114年度總決算編製作業手冊 - 行政院主計總處"]:visible', description: "Google 搜尋結果的穩定標題" }
    ] },
    { id: "pdf", createdAt: new Date().toISOString(), type: "download" as const, label: "pdf(3.51 MB)", url: "https://www.dgbas.gov.tw/News_Content.aspx?n=1961&s=235457", selector: [{ strategy: "css" as const, value: 'a[href*="Download.ashx"]:visible' }] }
  ];
  const steps = recordedEventsToSteps(events);
  assert.equal(steps.some((step) => step.name.includes("相關連結")), false);
  assert.deepEqual(steps[0].waitAfter, { kind: "visible", value: 'a[title="114年度總決算編製作業手冊 - 行政院主計總處"]:visible', timeoutMs: 10_000 });
  assert.equal(steps[1].kind, "click");
  assert.deepEqual(steps[1].waitAfter, { kind: "visible", value: 'a[href*="Download.ashx"]:visible', timeoutMs: 10_000 });
});

test("舊流程會移除無關 Hover 並把文章誤判下載修正為點擊", () => {
  const project = createDefaultProject({
    name: "舊 Google 搜尋流程",
    steps: [
      { id: "hover", name: "6. 相關連結", kind: "hover", enabled: true, selectors: [{ strategy: "css", value: '[data-groupsn="491"] a[title="相關連結"][href="cl.aspx?n=1900"]:visible', description: "桌面版錄製路徑與穩定父選單" }], waitAfter: { kind: "visible", value: 'a[href*="News_Content.aspx%3Fn%3D1961%26s%3D235457"]:visible', timeoutMs: 5_000 } },
      { id: "article", name: "7. 114年度總決算編製作業手冊 - 行政院主計總處", kind: "download", enabled: true, selectors: [
        { strategy: "css", value: 'a[href*="News_Content.aspx%3Fn%3D1961%26s%3D235457"]:visible', description: "Google 站內搜尋的穩定目標網址" },
        { strategy: "css", value: 'a[title="114年度總決算編製作業手冊 - 行政院主計總處"]:visible', description: "錄製時實際可見且 title 相符的元件" }
      ] },
      { id: "pdf", name: "8. pdf(3.51 MB)", kind: "download", enabled: true, selectors: [{ strategy: "css", value: 'a[href*="Download.ashx"]:visible', description: "錄製時實際可見的連結與網址" }] }
    ]
  });
  assert.deepEqual(project.steps.map((step) => step.id), ["article", "pdf"]);
  assert.equal(project.steps[0].kind, "click");
  assert.deepEqual(project.steps[0].waitAfter, { kind: "visible", value: 'a[href*="Download.ashx"]:visible', timeoutMs: 10_000 });
});

test("只能開啟 downloads 目錄內且存在的下載檔案", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "automation-studio-download-"));
  const downloadRoot = path.join(temporary, "downloads");
  const filePath = path.join(downloadRoot, "project", "report.pdf");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "%PDF-test");
  try {
    const artifact = await resolveStudioDownloadArtifact(filePath, downloadRoot);
    assert.equal(artifact.filePath, filePath);
    assert.equal(artifact.directory, path.dirname(filePath));
    await assert.rejects(() => resolveStudioDownloadArtifact(path.join(temporary, "outside.pdf"), downloadRoot), /downloads/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("無副檔名的既有 PDF 下載結果會自動補上 .pdf", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "automation-studio-pdf-name-"));
  const downloadRoot = path.join(temporary, "downloads");
  const filePath = path.join(downloadRoot, "project", "long-pdf-name");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "%PDF-test");
  try {
    const artifact = await resolveStudioDownloadArtifact(filePath, downloadRoot);
    assert.equal(artifact.filePath, `${filePath}.pdf`);
    assert.equal(artifact.normalizedFrom, filePath);
    await fs.access(`${filePath}.pdf`);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("下載步驟可保留原檔名或套用自訂名稱且維持來源副檔名", () => {
  const original = "來源報表.pdf";
  const originalStep = { id: "download-1", name: "下載", kind: "download", enabled: true, downloadFileNameMode: "original" as const };
  const customStep = { ...originalStep, downloadFileNameMode: "custom" as const, downloadFileName: "{{year}}年度決算.txt" };
  assert.equal(resolveDownloadFileName(original, originalStep, (value) => String(value)), original);
  assert.equal(resolveDownloadFileName(original, customStep, (value) => String(value).replace("{{year}}", "114")), "114年度決算.pdf");
});

test("批次下載檔名可在副檔名前加入時間戳記", () => {
  const fixed = new Date(2026, 8, 14, 15, 45, 12);
  assert.equal(appendDownloadTimestamp("損益表-114.xlsx", fixed), "損益表-114-20260914-154512.xlsx");
  assert.equal(appendDownloadTimestamp("無副檔名", fixed), "無副檔名-20260914-154512");
});

test("選單 Hover 事件會等待下一個子選單顯示", () => {
  const events = [
    { id: "hover-menu", createdAt: new Date().toISOString(), type: "hover" as const, label: "主要業務", url: "https://www.dgbas.gov.tw/", selector: [{ strategy: "css" as const, value: '[data-groupsn="483"] a[role="button"]:visible' }] },
    { id: "click-child", createdAt: new Date().toISOString(), type: "click" as const, label: "預算執行及決算", url: "https://www.dgbas.gov.tw/", selector: [{ strategy: "css" as const, value: '[data-groupsn="484"] a[title="預算執行及決算"]:visible' }] }
  ];
  const [hover] = recordedEventsToSteps(events);
  assert.equal(hover.kind, "hover");
  assert.deepEqual(hover.waitAfter, { kind: "visible", value: '[data-groupsn="484"] a[title="預算執行及決算"]:visible', timeoutMs: 5_000 });
});

test("三種成果可以合併匯出，且敏感預設值會移除", async () => {
  const project = createGenericExample();
  project.id = `export-test-${Date.now()}`;
  project.parameters.push({
    id: "p-secret",
    name: "password",
    label: "密碼",
    type: "secret",
    required: false,
    defaultValue: "DO-NOT-EXPORT-THIS",
    sensitive: true
  });
  const result = await new ExportService().create(project, {
    portableWorkflow: true,
    typescript: true,
    skill: true,
    includeTests: true,
    includeExamples: true
  });
  const zip = await fs.readFile(result.filePath);
  assert.ok(zip.includes(Buffer.from("portable-workflow/workflow.json")));
  assert.ok(zip.includes(Buffer.from("typescript-project/src/run.ts")));
  assert.ok(zip.includes(Buffer.from("automation-skill/SKILL.md")));
  assert.equal(zip.includes(Buffer.from("DO-NOT-EXPORT-THIS")), false);
  await fs.unlink(result.filePath);
});

test("人工操作步驟會保留在流程與 TypeScript 匯出", async () => {
  const project = createGenericExample();
  project.id = `manual-step-export-${Date.now()}`;
  project.steps.splice(1, 0, {
    id: "manual-checkpoint",
    name: "人工完成受保護選單",
    kind: "manual",
    enabled: true,
    value: "請在瀏覽器中完成選單操作",
    verification: { kind: "url", expected: "/News_Content.aspx" },
    retryCount: 0
  });
  const result = await new ExportService().create(project, {
    portableWorkflow: true,
    typescript: true,
    skill: false,
    includeTests: false,
    includeExamples: false
  });
  const zip = await fs.readFile(result.filePath);
  assert.ok(zip.includes(Buffer.from("人工完成受保護選單")));
  assert.ok(zip.includes(Buffer.from("manualAction")));
  await fs.unlink(result.filePath);
});


test("流程步驟可保存多筆資料選取設定", () => {
  const project = createDefaultProject({
    name: "多筆選取",
    steps: [{
      id: "latest-mail",
      name: "點擊收件匣第一封郵件",
      kind: "click",
      enabled: true,
      selectors: [{ strategy: "css", value: ".mail-row" }],
      matchMode: "first",
      matchIndex: undefined
    }]
  });
  assert.equal(project.steps[0].matchMode, "first");
  assert.equal(project.steps[0].matchIndex, undefined);
});

test("第 N 筆選取設定使用 1-based 索引保存", () => {
  const project = createDefaultProject({
    name: "指定資料列",
    steps: [{
      id: "third-row",
      name: "點擊第三筆",
      kind: "click",
      enabled: true,
      selectors: [{ strategy: "css", value: ".result-row" }],
      matchMode: "nth",
      matchIndex: 3
    }]
  });
  assert.equal(project.steps[0].matchMode, "nth");
  assert.equal(project.steps[0].matchIndex, 3);
});


test("雙擊錄製事件會轉為 dblclick 流程步驟", () => {
  const steps = recordedEventsToSteps([{
    id: "record-dblclick",
    createdAt: new Date().toISOString(),
    type: "dblclick",
    label: "郵件列",
    url: "https://mail.example.test/owa/",
    selector: [{ strategy: "css", value: 'div[role="row"]:visible' }]
  }]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]?.kind, "dblclick");
  assert.equal(steps[0]?.waitAfter?.kind, "timeout");
});


test("人工操作步驟可保存手動繼續完成方式", () => {
  const project = createDefaultProject({
    name: "登入等待",
    steps: [{
      id: "manual-login",
      name: "人工登入",
      kind: "manual",
      enabled: true,
      value: "請完成登入",
      manualCompletionMode: "button",
      retryCount: 0
    }]
  });
  assert.equal(project.steps[0].manualCompletionMode, "button");
});

test("人工操作步驟可保存網址符合完成方式", () => {
  const project = createDefaultProject({
    name: "網址登入等待",
    steps: [{
      id: "manual-login-url",
      name: "登入後等待收件匣",
      kind: "manual",
      enabled: true,
      value: "請完成登入",
      manualCompletionMode: "url",
      manualExpected: "/owa/",
      verification: { kind: "url", expected: "/owa/" },
      retryCount: 0
    }]
  });
  assert.equal(project.steps[0].manualCompletionMode, "url");
  assert.equal(project.steps[0].manualExpected, "/owa/");
});


test("擷取樣式可從郵件本文取得第一個 6 位數字", () => {
  assert.equal(extractPatternValue("您的登入驗證碼為 497163，請勿告知他人。", "\\b\\d{6}\\b"), "497163");
});

test("擷取樣式支援指定 capture group", () => {
  assert.equal(extractPatternValue("案件代碼 ABC-123456", "ABC-(\\d{6})", "", 1), "123456");
});

test("擷取樣式找不到內容時會明確失敗", () => {
  assert.throws(() => extractPatternValue("此信件沒有數字", "\\b\\d{6}\\b"), /找不到符合樣式/);
});


test("允許網域預設採精確比對，萬用字元才允許子網域", () => {
  assert.equal(isAllowedHostname("auth.openai.com", ["auth.openai.com"]), true);
  assert.equal(isAllowedHostname("login.auth.openai.com", ["auth.openai.com"]), false);
  assert.equal(isAllowedHostname("login.openai.com", ["*.openai.com"]), true);
  assert.equal(isAllowedHostname("openai.com", ["*.openai.com"]), false);
  assert.equal(normalizeAllowedDomain("https://AUTH.OPENAI.COM/email-verification"), "auth.openai.com");
});

test("執行前會找出尚未允許的開啟網址網域", () => {
  const project = createDefaultProject({ name: "網域檢查", targetUrl: "https://mail.cbc.gov.tw/owa/", allowedDomains: ["mail.cbc.gov.tw"] });
  project.steps = [
    { id: "a", name: "mail", kind: "navigate", enabled: true, url: "https://mail.cbc.gov.tw/owa/" },
    { id: "b", name: "openai", kind: "navigate", enabled: true, url: "https://auth.openai.com/email-verification" }
  ];
  const result = preflightWorkflowDomains(project, {});
  assert.deepEqual(result.requiredDomains.sort(), ["auth.openai.com", "mail.cbc.gov.tw"]);
  assert.deepEqual(result.missingDomains, ["auth.openai.com"]);
});

test("執行前網域檢查會展開網址參數", () => {
  const project = createDefaultProject({ name: "參數網址", targetUrl: "https://example.com", allowedDomains: ["auth.openai.com"] });
  project.steps = [{ id: "a", name: "param", kind: "navigate", enabled: true, url: "https://{{host}}/email-verification" }];
  assert.deepEqual(preflightWorkflowDomains(project, { host: "auth.openai.com" }).missingDomains, []);
});


test("瀏覽器 Profile 狀態可建立與清除", async () => {
  const projectId = `profile-test-${Date.now()}`;
  const profileDir = resolveProjectProfileDir(projectId);
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(path.join(profileDir, "Cookies.mock"), "test");
  try {
    const before = await getBrowserProfileStatus(projectId, true);
    assert.equal(before.enabled, true);
    assert.equal(before.hasData, true);
    await clearBrowserProfile(projectId);
    const after = await getBrowserProfileStatus(projectId, true);
    assert.equal(after.hasData, false);
  } finally {
    await clearBrowserProfile(projectId);
  }
});

test("關閉保留登入狀態時錄製器使用暫時 Context", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "automation-studio-ephemeral-recorder-"));
  const executable = path.join(temporary, "chrome.exe");
  await fs.writeFile(executable, "test-browser");
  const previous = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = executable;
  let persistentCalls = 0;
  let launchCalls = 0;
  let browserCloseCalls = 0;
  const page = { isClosed: () => false, bringToFront: async () => undefined, goto: async () => undefined, url: () => "https://example.com" };
  const context = {
    pages: () => [page], newPage: async () => page, exposeBinding: async () => undefined, addInitScript: async () => undefined,
    on: () => undefined, once: () => undefined, close: async () => undefined
  };
  const browser = { newContext: async () => context, close: async () => { browserCloseCalls += 1; } };
  const manager = new RecorderManager(async () => ({
    chromium: {
      executablePath: () => path.join(temporary, "missing", "chrome.exe"),
      launchPersistentContext: async () => { persistentCalls += 1; return context; },
      launch: async () => { launchCalls += 1; return browser; }
    }
  }) as never);
  try {
    const project = createDefaultProject({ id: "ephemeral-recorder-test", targetUrl: "https://example.com" });
    project.browser.reuseProfile = false;
    await manager.start(project);
    assert.equal(persistentCalls, 0);
    assert.equal(launchCalls, 1);
    await manager.stop(project.id);
    assert.equal(browserCloseCalls, 1);
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    else process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = previous;
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("執行前網域檢查會納入開新分頁網址", () => {
  const project = createDefaultProject({ name: "分頁網域", targetUrl: "https://chatgpt.com/" });
  project.allowedDomains = ["chatgpt.com"];
  project.steps = [
    { id: "tab-a", name: "ChatGPT", kind: "newTab", enabled: true, url: "https://chatgpt.com/", tabName: "chatgpt-login" },
    { id: "tab-b", name: "Webmail", kind: "newTab", enabled: true, url: "https://mail.cbc.gov.tw/owa/", tabName: "webmail" }
  ];
  const result = preflightWorkflowDomains(project, {}, project.steps);
  assert.deepEqual(result.requiredDomains.sort(), ["chatgpt.com", "mail.cbc.gov.tw"].sort());
  assert.deepEqual(result.missingDomains, ["mail.cbc.gov.tw"]);
});

test("分頁控制設定會保留在可攜流程與 TypeScript runner", async () => {
  const project = createDefaultProject({ name: "分頁控制", targetUrl: "https://chatgpt.com/" });
  project.id = `tab-control-export-${Date.now()}`;
  project.version = "1.0.0";
  project.allowedDomains = ["chatgpt.com", "mail.cbc.gov.tw"];
  project.steps = [
    { id: "chatgpt", name: "開 ChatGPT", kind: "newTab", enabled: true, url: "https://chatgpt.com/", tabName: "chatgpt-login" },
    { id: "mail", name: "開 Webmail", kind: "newTab", enabled: true, url: "https://mail.cbc.gov.tw/owa/", tabName: "webmail" },
    { id: "back", name: "回 ChatGPT", kind: "switchTab", enabled: true, tabTargetMode: "name", tabTarget: "chatgpt-login" }
  ];
  const service = new ExportService();
  const exported = await service.create(project, { portableWorkflow: true, typescript: true, skill: false });
  const zip = await fs.readFile(exported.filePath);
  assert.ok(zip.includes(Buffer.from('"kind": "newTab"')));
  assert.ok(zip.includes(Buffer.from('"tabName": "chatgpt-login"')));
  assert.ok(zip.includes(Buffer.from('"kind": "switchTab"')));
  assert.ok(zip.includes(Buffer.from("const namedTabs = new Map")));
  assert.ok(zip.includes(Buffer.from("switchToTab")));
  await fs.rm(exported.filePath, { force: true });
});

test("執行器可建立命名分頁並依名稱切回原分頁", async () => {
  const pages: any[] = [];
  const makePage = (initialUrl = "about:blank") => {
    let currentUrl = initialUrl;
    let foreground = 0;
    return {
      isClosed: () => false,
      url: () => currentUrl,
      title: async () => currentUrl.includes("chatgpt") ? "ChatGPT" : currentUrl.includes("mail.cbc") ? "Webmail" : "",
      goto: async (url: string) => { currentUrl = url; },
      setDefaultTimeout: () => undefined,
      bringToFront: async () => { foreground += 1; },
      foregroundCount: () => foreground
    };
  };
  const initial = makePage();
  pages.push(initial);
  const context = {
    pages: () => pages,
    newPage: async () => { const created = makePage(); pages.push(created); return created; }
  };
  const project = createDefaultProject({ name: "分頁執行", targetUrl: "https://chatgpt.com/" });
  project.allowedDomains = ["chatgpt.com", "mail.cbc.gov.tw"];
  project.settings.safePlayback = false;
  const run: any = { parameters: {}, debugDir: ".", steps: [] };
  const runner = new WorkflowRunner({} as any) as any;
  await runner.performStep(project, run, context, initial, { id: "chat", name: "ChatGPT", kind: "newTab", enabled: true, url: "https://chatgpt.com/", tabName: "chatgpt-login" }, {});
  const chatPage = pages.at(-1);
  await runner.performStep(project, run, context, chatPage, { id: "mail", name: "Webmail", kind: "newTab", enabled: true, url: "https://mail.cbc.gov.tw/owa/", tabName: "webmail" }, {});
  const result = await runner.performStep(project, run, context, pages.at(-1), { id: "back", name: "回 ChatGPT", kind: "switchTab", enabled: true, tabTargetMode: "name", tabTarget: "chatgpt-login" }, {});
  assert.match(result.message, /ChatGPT/);
  assert.ok(chatPage.foregroundCount() >= 2);
});

test("保存頁面 PDF 使用系統預設下載資料夾與原生列印選項", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "automation-studio-page-pdf-"));
  try {
    const downloadDir = path.join(temporary, "預設下載");
    const store = { getSettings: async () => ({ defaultDownloadDir: downloadDir }) };
    const runner = new WorkflowRunner(store as any) as any;
    const project = createDefaultProject({ name: "PDF 輸出", targetUrl: "https://example.com" });
    const run: any = { id: "pdf-run", parameters: {}, debugDir: temporary, steps: [] };
    let pdfOptions: any;
    const page = {
      pdf: async (options: any) => {
        pdfOptions = options;
        await fs.writeFile(options.path, Buffer.from("%PDF-test"));
      }
    };

    const result = await runner.performStep(project, run, {}, page, {
      id: "save-pdf",
      name: "保存品質檢測結果",
      kind: "savePagePdf",
      enabled: true,
      pdfFileName: "台灣銀行決算_品質檢測結果.pdf",
      pdfPageSize: "Letter",
      pdfOrientation: "landscape",
      pdfPrintBackground: true,
      pdfMarginTopMm: 5,
      pdfMarginRightMm: 6,
      pdfMarginBottomMm: 7,
      pdfMarginLeftMm: 8,
      pdfDisplayHeaderFooter: true,
      pdfHeaderTemplate: '<div><span class="title"></span></div>',
      pdfFooterTemplate: '<div><span class="pageNumber"></span></div>',
      pdfScale: 0.8,
      pdfUseLocalTime: true
    }, {});

    assert.ok(result.downloadPath?.startsWith(downloadDir));
    assert.match(path.basename(result.downloadPath!), /^台灣銀行決算_品質檢測結果_\d{8}_\d{6}\.pdf$/);
    assert.equal(await fs.readFile(result.downloadPath!, "utf8"), "%PDF-test");
    assert.equal(pdfOptions.format, "Letter");
    assert.equal(pdfOptions.landscape, true);
    assert.equal(pdfOptions.printBackground, true);
    assert.equal(pdfOptions.displayHeaderFooter, true);
    assert.equal(pdfOptions.headerTemplate, '<div><span class="title"></span></div>');
    assert.equal(pdfOptions.footerTemplate, '<div><span class="pageNumber"></span></div>');
    assert.equal(pdfOptions.scale, 0.8);
    assert.deepEqual(pdfOptions.margin, { top: "5mm", right: "6mm", bottom: "7mm", left: "8mm" });
    assert.match(result.message, /Letter、橫向、縮放 80%、頁首／頁尾已啟用/);
    const generatedRunner = await fs.readFile(path.resolve("src/studio/templates/generated-runner.ts.txt"), "utf8");
    assert.match(generatedRunner, /displayHeaderFooter: step\.pdfDisplayHeaderFooter === true/);
    assert.match(generatedRunner, /headerTemplate: expand\(step\.pdfHeaderTemplate/);
    assert.match(generatedRunner, /scale: scale\(step\.pdfScale\)/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("PDF 頁首／頁尾與縮放設定會寫入可攜流程及 TypeScript 匯出", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "automation-studio-pdf-export-"));
  try {
    const project = createDefaultProject({ name: "PDF 匯出", targetUrl: "https://example.com" });
    project.id = `pdf-export-${Date.now()}`;
    project.steps = [{
      id: "save-pdf",
      name: "保存頁面 PDF",
      kind: "savePagePdf",
      enabled: true,
      pdfDisplayHeaderFooter: true,
      pdfHeaderTemplate: '<div><span class="title"></span></div>',
      pdfFooterTemplate: '<div><span class="pageNumber"></span>/<span class="totalPages"></span></div>',
      pdfScale: 1.35
    }];
    const service = new ExportService() as any;
    service.exportDir = temporary;
    const exported = await service.create(project, { portableWorkflow: true, typescript: true, skill: false });
    const zip = await fs.readFile(exported.filePath);
    assert.ok(zip.includes(Buffer.from('"pdfDisplayHeaderFooter": true')));
    assert.ok(zip.includes(Buffer.from('"pdfHeaderTemplate": "<div><span class=\\"title\\"></span></div>"')));
    assert.ok(zip.includes(Buffer.from('"pdfScale": 1.35')));
    assert.ok(zip.includes(Buffer.from("displayHeaderFooter: step.pdfDisplayHeaderFooter === true")));
    assert.ok(zip.includes(Buffer.from("scale: scale(step.pdfScale)")));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});


test("CDP 模式只允許本機除錯位址", () => {
  assert.equal(validateLocalCdpEndpoint("http://127.0.0.1:9222"), "http://127.0.0.1:9222");
  assert.equal(validateLocalCdpEndpoint("http://localhost:9333"), "http://localhost:9333");
  assert.throws(() => validateLocalCdpEndpoint("http://192.168.1.10:9222"), /只允許連線本機/);
});

test("CDP 測試連線會列出分頁、依網址選擇，並在結束時只斷開 Playwright 連線", async () => {
  let closeCalls = 0;
  const makePage = (url: string, title: string) => ({
    url: () => url,
    title: async () => title,
    isClosed: () => false
  });
  const pages = [makePage("https://example.com/", "Example"), makePage("https://chatgpt.com/", "ChatGPT")];
  const context = { pages: () => pages };
  const browser = {
    contexts: () => [context],
    version: () => "Chrome/140.0",
    close: async () => { closeCalls += 1; }
  };
  const playwright = { chromium: { connectOverCDP: async () => browser } } as any;
  const project = createDefaultProject({ name: "CDP", targetUrl: "https://chatgpt.com/" });
  project.browser.connectionMode = "cdp";
  project.browser.cdpInitialPageMode = "url";
  project.browser.cdpInitialPageTarget = "chatgpt.com";
  const result = await inspectCdpEndpoint(playwright, project.browser);
  assert.equal(result.tabs.length, 2);
  assert.equal(result.selectedIndex, 2);
  assert.match(result.version, /Chrome/);
  assert.equal(closeCalls, 1);
});

test("TypeScript 匯出 runner 支援 CDP 接管且不關閉外部預設 Context", async () => {
  const project = createDefaultProject({ name: "CDP 匯出", targetUrl: "https://chatgpt.com/" });
  project.browser.connectionMode = "cdp";
  project.browser.cdpEndpoint = "http://127.0.0.1:9222";
  const service = new ExportService();
  const result = await service.create(project, { portableWorkflow: false, typescript: true, skill: false } as any);
  const buffer = await fs.readFile(result.filePath);
  assert.ok(buffer.includes(Buffer.from("connectOverCDP")));
  assert.ok(buffer.includes(Buffer.from("if (cdpMode)")));
  await fs.rm(path.dirname(result.filePath), { recursive: true, force: true }).catch(() => undefined);
});

test("CDP 錄製器接管既有分頁且停止時不關閉外部 Context", async () => {
  let browserCloseCalls = 0;
  let contextCloseCalls = 0;
  let gotoCalls = 0;
  let evaluateCalls = 0;
  const page = {
    isClosed: () => false,
    bringToFront: async () => undefined,
    goto: async () => { gotoCalls += 1; },
    url: () => "https://chatgpt.com/",
    title: async () => "ChatGPT",
    evaluate: async () => { evaluateCalls += 1; }
  };
  const context = {
    pages: () => [page],
    exposeBinding: async () => undefined,
    addInitScript: async () => undefined,
    on: () => undefined,
    once: () => undefined,
    close: async () => { contextCloseCalls += 1; }
  };
  const browser = {
    contexts: () => [context],
    version: () => "Chrome/140.0",
    close: async () => { browserCloseCalls += 1; }
  };
  const manager = new RecorderManager(async () => ({ chromium: { connectOverCDP: async () => browser } }) as any);
  const project = createDefaultProject({ name: "CDP Recorder", targetUrl: "https://chatgpt.com/" });
  project.browser.connectionMode = "cdp";
  await manager.start(project);
  assert.equal(gotoCalls, 0);
  assert.ok(evaluateCalls >= 1, "frame-aware recorder may probe/reinstall the existing CDP document");
  await manager.stop(project.id);
  assert.equal(contextCloseCalls, 0);
  assert.equal(browserCloseCalls, 1);
});

test("等待第一筆新資料會保留在流程與 TypeScript 匯出", async () => {
  const project = createDefaultProject({ name: "新郵件等待", targetUrl: "https://mail.cbc.gov.tw/owa/" });
  project.allowedDomains = ["mail.cbc.gov.tw"];
  project.steps = [{
    id: "wait-new",
    name: "等待新驗證信",
    kind: "waitNewFirst",
    enabled: true,
    selectors: [{ strategy: "css", value: 'div[role="option"]' }],
    sourceVariable: "mailBaseline",
    outputVariable: "latestMailRow",
    regexPattern: "ChatGPT|OpenAI",
    regexFlags: "i",
    matchMode: "first",
    autoFrameSearch: true,
    timeoutMs: 180000
  } as any];
  const service = new ExportService();
  const result = await service.create(project, { portableWorkflow: true, typescript: true, skill: false } as any);
  const buffer = await fs.readFile(result.filePath);
  assert.ok(buffer.includes(Buffer.from('"kind": "waitNewFirst"')));
  assert.ok(buffer.includes(Buffer.from('waitForNewFirst')));
});

test("清單快照與等待新清單資料會保留在流程與 TypeScript 匯出", async () => {
  const project = createDefaultProject({ name: "新郵件集合等待", targetUrl: "https://mail.cbc.gov.tw/owa/" });
  project.allowedDomains = ["mail.cbc.gov.tw"];
  project.steps = [
    {
      id: "snapshot",
      name: "快照郵件清單",
      kind: "captureListSnapshot",
      enabled: true,
      selectors: [{ strategy: "css", value: 'div[role="option"]' }],
      outputVariable: "mailBaselineSet",
      listLimit: 50,
      autoFrameSearch: true
    },
    {
      id: "wait-new-set",
      name: "等待新驗證信",
      kind: "waitNewListItem",
      enabled: true,
      selectors: [{ strategy: "css", value: 'div[role="option"]' }],
      sourceVariable: "mailBaselineSet",
      outputVariable: "latestMailRow",
      listLimit: 50,
      clickOnMatch: true,
      regexPattern: "ChatGPT|OpenAI",
      regexFlags: "i",
      autoFrameSearch: true,
      timeoutMs: 180000
    }
  ] as any;
  const service = new ExportService();
  const result = await service.create(project, { portableWorkflow: true, typescript: true, skill: false } as any);
  const buffer = await fs.readFile(result.filePath);
  assert.ok(buffer.includes(Buffer.from('"kind": "captureListSnapshot"')));
  assert.ok(buffer.includes(Buffer.from('"kind": "waitNewListItem"')));
  assert.ok(buffer.includes(Buffer.from('captureListSnapshot')));
  assert.ok(buffer.includes(Buffer.from('waitForNewListItem')));
});

test("批次執行紀錄會提供等待人工操作的繼續按鈕並自動輪詢", async () => {
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  const html = await fs.readFile(path.resolve("public/index.html"), "utf8");
  assert.ok(app.includes('data-run-action="continue"'));
  assert.ok(app.includes('data-run-action="open-file"'));
  assert.ok(app.includes('data-run-action="open-folder"'));
  assert.ok(app.includes('/continue`'));
  assert.ok(app.includes("startRunsPolling"));
  assert.ok(html.includes('<option value="paused">等待人工操作</option>'));
  assert.ok(html.includes("<th>操作</th>"));
});

test("批次工作站會保留同一瀏覽器工作階段並沿用已完成的人工登入檢查點", async () => {
  const executor = await fs.readFile(path.resolve("src/studio/executor.ts"), "utf8");
  assert.ok(executor.includes("async startBatch"));
  assert.ok(executor.includes("reuse-batch-session"));
  assert.ok(executor.includes("manual_step_reused_from_batch_session"));
  assert.ok(executor.includes("completedManualStepIds"));
  assert.ok(executor.includes("nextRunWillReuseLogin: true"));
  assert.ok(executor.includes('run.mode === "batch" ? appendDownloadTimestamp'));
});


test("batch parameter editor mirrors workflow parameter controls and defaults", async () => {
  const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.ok(app.includes('parameter.type === "select"'));
  assert.ok(app.includes('renderBatchParameterControl'));
  assert.ok(app.includes('batchParameterDefault'));
  assert.ok(app.includes('syncBatchRowsWithParameters'));
  assert.ok(app.includes('input.value === "true" ? true : input.value === "false" ? false : input.value'));
});

test("相依下拉選單會在測試與批次參數依父參數動態篩選", async () => {
  const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const html = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const types = await fs.readFile(new URL("../src/studio/types.ts", import.meta.url), "utf8");
  assert.ok(app.includes("parameterAllowedOptions"));
  assert.ok(app.includes("handleTestParameterChange"));
  assert.ok(app.includes("handleBatchParameterChange"));
  assert.ok(app.includes("dependentOptions"));
  assert.ok(html.includes('id="parameterDependsOn"'));
  assert.ok(html.includes('id="parameterDependentOptions"'));
  assert.ok(types.includes("dependsOn?: string"));
  assert.ok(types.includes("dependentOptions?: Record<string, string[]>"));
});

test("Windows 啟動器會依專案設定停用 Node TLS 驗證，但 TypeScript 匯出仍維持驗證", async () => {
  const mainStart = await fs.readFile(path.resolve("./start.bat"), "utf8");
  const legacyStart = await fs.readFile(path.resolve("./start-ebas-ui.bat"), "utf8");
  assert.match(mainStart, /NODE_USE_SYSTEM_CA%"=="" set "NODE_USE_SYSTEM_CA=1"/);
  assert.match(legacyStart, /NODE_USE_SYSTEM_CA%"=="" set "NODE_USE_SYSTEM_CA=1"/);
  assert.match(mainStart, /(?:^|\r?\n)\s*set\s+"NODE_TLS_REJECT_UNAUTHORIZED=0"/i);
  assert.match(legacyStart, /(?:^|\r?\n)\s*set\s+"NODE_TLS_REJECT_UNAUTHORIZED=0"/i);

  const project = createGenericExample();
  project.id = `system-ca-export-${Date.now()}`;
  const result = await new ExportService().create(project, {
    portableWorkflow: false,
    typescript: true,
    skill: false,
    includeTests: false,
    includeExamples: false
  });
  try {
    const zip = await fs.readFile(result.filePath);
    assert.ok(zip.includes(Buffer.from('if "%NODE_USE_SYSTEM_CA%"=="" set "NODE_USE_SYSTEM_CA=1"')));
    assert.equal(zip.includes(Buffer.from("NODE_TLS_REJECT_UNAUTHORIZED=0")), false);
  } finally {
    await fs.unlink(result.filePath);
  }
});

test("自動下載遇到憑證錯誤會降級為瀏覽器下載，且保存失敗先使用既有下載串流", async () => {
  const runnerTemplate = await fs.readFile(path.resolve("./src/studio/templates/generated-runner.ts.txt"), "utf8");
  const executorSource = await fs.readFile(path.resolve("./src/studio/executor.ts"), "utf8");
  for (const source of [runnerTemplate, executorSource]) {
    assert.match(source, /unable to get local issuer certificate/);
    assert.match(source, /createReadStream/);
    assert.match(source, /downloadMode|const mode = step\.downloadMode/);
  }
  assert.match(runnerTemplate, /直接下載遇到 TLS 憑證信任問題，已自動改用瀏覽器下載/);
  assert.match(executorSource, /直接下載遇到 TLS 憑證信任問題，已自動改用瀏覽器下載/);
});

test("DGBAS 下載可在 Node 直接請求與點擊事件之外改走 Chrome 導覽網路層", async () => {
  const runnerTemplate = await fs.readFile(path.resolve("./src/studio/templates/generated-runner.ts.txt"), "utf8");
  const executorSource = await fs.readFile(path.resolve("./src/studio/executor.ts"), "utf8");
  for (const source of [runnerTemplate, executorSource]) {
    assert.match(source, /browserNavigation/);
    assert.match(source, /newPage\(\)/);
    assert.match(source, /goto\(url, \{ waitUntil: "commit"/);
    assert.match(source, /%PDF-/);
  }
  assert.match(executorSource, /Chrome 網路層直接取得檔案/);
  assert.match(runnerTemplate, /Chrome 網路層直接取得檔案/);
});

test("自動化設計器流程卡片提供刪除按鈕且三欄內容可獨立捲動", async () => {
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  const css = await fs.readFile(path.resolve("public/styles.css"), "utf8");
  assert.match(app, /data-step-action="delete"/);
  assert.match(app, /if \(action === "delete"\) deleteStep\(id\)/);
  assert.match(css, /\.palette, \.workflow-canvas, #stepProperties \{[^}]*overflow: auto/s);
  assert.match(css, /\.designer-pane \{[^}]*overflow: hidden/s);
  assert.match(css, /#stepProperties \{[^}]*flex: 1 1 auto/s);
});

test("workspace pages use view-specific widths and designer keeps content-oriented columns", async () => {
  const css = await fs.readFile(path.join(process.cwd(), "public", "styles.css"), "utf8");
  assert.ok(css.includes("#dashboardView { max-width: 1480px; }"));
  assert.ok(css.includes("#workstationView { max-width: 1360px; }"));
  assert.ok(css.includes("#designerView { max-width: 1760px; }"));
  assert.ok(css.includes("#settingsView { max-width: 1040px; }"));
  assert.ok(css.includes(".topbar { width: 100%; max-width: var(--active-view-width); }"));
  assert.ok(css.includes("grid-template-columns: clamp(190px, 15%, 235px) minmax(420px, 1fr) clamp(320px, 24%, 410px);"));
});

test("流程步驟畫布取消置中寬度限制並完整使用中間欄寬", async () => {
  const css = await fs.readFile(path.join(process.cwd(), "public", "styles.css"), "utf8");
  assert.match(css, /#designerView \.canvas-pane \{[\s\S]*?padding-left: 0;[\s\S]*?padding-right: 0;/);
  assert.match(css, /#designerView \.workflow-canvas \{[\s\S]*?width: 100%;[\s\S]*?max-width: none;[\s\S]*?margin: 0;/);
});

test("重複執行下載會在 download 事件當下先暫存檔案，避免來源頁關閉競態", async () => {
  const executorSource = await fs.readFile(path.resolve("src/studio/executor.ts"), "utf8");
  const templateSource = await fs.readFile(path.resolve("src/studio/templates/generated-runner.ts.txt"), "utf8");
  assert.match(executorSource, /stagedFilePromise:\s*stageNativeDownload\(download\)/);
  assert.match(executorSource, /await fs\.copyFile\(stagedPath, filePath\)/);
  assert.match(templateSource, /stagedFilePromise:\s*stageNativeDownload\(download\)/);
  assert.match(templateSource, /await fs\.copyFile\(stagedPath, filePath\)/);
});

test("下載來源頁或 BrowserContext 關閉時可改用 Windows 原生下載，不依賴 Playwright context.request", async () => {
  const executorSource = await fs.readFile(path.resolve("src/studio/executor.ts"), "utf8");
  const templateSource = await fs.readFile(path.resolve("src/studio/templates/generated-runner.ts.txt"), "utf8");
  for (const source of [executorSource, templateSource]) {
    assert.match(source, /download\.path\(\)/);
    assert.match(source, /downloadWithWindowsNative/);
    assert.match(source, /System32["', ]+,?\s*["']curl\.exe|System32.*curl\.exe/s);
    assert.match(source, /recoveryHeaders/);
  }
  assert.match(executorSource, /Windows certificate store|Windows 憑證|Windows 原生|OS curl/);
});

test("PDF 點擊下載可由 Chrome DevTools 直接寫入獨立暫存目錄，不依賴已關閉頁面的 Download 物件", async () => {
  const executorSource = await fs.readFile(path.resolve("src/studio/executor.ts"), "utf8");
  const templateSource = await fs.readFile(path.resolve("src/studio/templates/generated-runner.ts.txt"), "utf8");
  for (const source of [executorSource, templateSource]) {
    assert.match(source, /Page\.setDownloadBehavior/);
    assert.match(source, /Browser\.setDownloadBehavior/);
    assert.match(source, /automation-studio-chrome-download-/);
    assert.match(source, /kind:\s*"browser-file"/);
    assert.match(source, /%PDF-/);
  }
  assert.match(executorSource, /Chrome 原生下載完成/);
});

test("PDF direct download can use Chrome CDP Network.loadNetworkResource before click/download events", async () => {
  const executorSource = await fs.readFile(path.resolve("src/studio/executor.ts"), "utf8");
  const templateSource = await fs.readFile(path.resolve("src/studio/templates/generated-runner.ts.txt"), "utf8");
  for (const source of [executorSource, templateSource]) {
    assert.match(source, /Network\.loadNetworkResource/);
    assert.match(source, /includeCredentials:\s*true/);
    assert.match(source, /disableCache:\s*true/);
    assert.match(source, /IO\.read/);
    assert.match(source, /automation-studio-cdp-resource-/);
  }
  assert.match(executorSource, /browserCdpResourceDownload[\s\S]*clickAndWaitForDownload/);
  assert.match(templateSource, /cdpNetworkResourceDownload[\s\S]*locator\.click/);
});


test("v1.0.40 publish autosave, empty batch state, debug tabs and layout refinements are wired", async () => {
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  const html = await fs.readFile(path.resolve("public/index.html"), "utf8");
  const css = await fs.readFile(path.resolve("public/styles.css"), "utf8");
  assert.match(app, /state\.project\.releaseNotes \?\? state\.project\.description \?\? ""/);
  assert.match(app, /scheduleReleaseAutoSave/);
  assert.match(app, /state\.batchRows = \[\]/);
  assert.match(app, /batchEmptyState/);
  assert.match(app, /refreshRunDebug/);
  assert.match(app, /request_failed/);
  assert.match(app, /download_completed/);
  assert.match(html, /data-debug-tab="variables"/);
  assert.match(html, /batch-empty-state/);
  assert.doesNotMatch(html, /class="nav-item legacy-link"/);
  assert.match(html, /developer-link[^>]*href="\/legacy\/"/);
  assert.match(html, /settings-save-button/);
  assert.match(html, /runs-table-wrap/);
  assert.match(html, /batch-settings-grid/);
  assert.match(css, /\.settings-save-button \{[^}]*margin-top: 26px/s);
  assert.match(css, /\.runs-table \{[^}]*table-layout: fixed/s);
  assert.match(css, /\.run-error-message \{[^}]*overflow-wrap: anywhere/s);
  assert.match(css, /\.batch-settings-grid \{[^}]*grid-template-columns/s);
});


test("Automation Studio product metadata is v2.0.4 and the classic interface is removed", async () => {
  assert.equal((await fs.readFile(path.resolve("VERSION"), "utf8")).trim(), "2.0.4");
  const pkg = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8"));
  const router = await fs.readFile(path.resolve("src/studio/router.ts"), "utf8");
  const exporter = await fs.readFile(path.resolve("src/studio/exporter.ts"), "utf8");
  assert.equal(pkg.version, "2.0.4");
  assert.match(pkg.version, /^\d+\.[0-9]\.[0-9]$/);
  assert.match(router, /version: "2\.0\.4"/);
  assert.match(exporter, /productVersion: "2\.0\.4"/);
  const versioning = await fs.readFile(path.resolve("VERSIONING.md"), "utf8");
  assert.match(versioning, /MAJOR\.MINOR\.PATCH/);
  const modernUi = await fs.readFile(path.resolve("frontend/src/main.tsx"), "utf8");
  assert.doesNotMatch(modernUi, /classic-entry|\/classic\/|舊版介面/);
  await assert.rejects(fs.access(path.resolve("public/classic")));
});

test("V1.0.11 局部測試可遞迴找到巢狀子步驟並從選取位置接續後方流程", () => {
  const steps = [
    { id: "a", name: "A", kind: "navigate", enabled: true },
    {
      id: "cond", name: "條件", kind: "condition", enabled: true,
      thenSteps: [
        { id: "b", name: "B", kind: "click", enabled: true },
        { id: "c", name: "C", kind: "fill", enabled: true }
      ],
      elseSteps: [{ id: "x", name: "X", kind: "click", enabled: true }]
    },
    { id: "d", name: "D", kind: "download", enabled: true }
  ] as any;
  assert.equal(findWorkflowStepById(steps, "c")?.name, "C");
  assert.deepEqual(selectWorkflowRunSteps(steps, "c", "single-step").map((step) => step.id), ["c"]);
  assert.deepEqual(workflowStepsFromStepId(steps, "b")?.map((step) => step.id), ["b", "c", "d"]);
  assert.deepEqual(selectWorkflowRunSteps(steps, "b", "from-step").map((step) => step.id), ["b", "c", "d"]);
});

test("V1.0.11 測試與 Debug 提供完整、單步、從此步驟三種模式並在使用說明說明操作", async () => {
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  const html = await fs.readFile(path.resolve("public/index.html"), "utf8");
  assert.match(html, /id="runStepButton"[^>]*>只執行此步驟<\/button>/);
  assert.match(html, /id="runFromStepButton"[^>]*>從此步驟執行<\/button>/);
  assert.match(html, /id="testStepSelectionInfo"/);
  assert.match(app, /runWorkflow\("single-step"\)/);
  assert.match(app, /runWorkflow\("from-step"\)/);
  assert.match(app, /runModeLabel[\s\S]*"from-step": "從此步驟執行"/);
  assert.match(html, /<summary>步驟執行方式<\/summary>/);
  assert.match(html, /巢狀流程/);
  assert.match(html, /不會重新執行外層條件判斷或之前的迴圈次數/);
  assert.doesNotMatch(html, /id="stepDebugHelp"/);
});

test("建立專案對話框取消與關閉不會再送出建立表單", async () => {
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  const html = await fs.readFile(path.resolve("public/index.html"), "utf8");
  assert.match(html, /<button type="button" class="icon-button"[^>]*data-project-dialog-close/);
  assert.match(html, /<button type="button" class="button secondary" data-project-dialog-close>取消<\/button>/);
  assert.match(html, /id="createProjectConfirm" type="submit"/);
  assert.match(app, /function closeProjectDialog\(\)/);
  assert.match(app, /dialog\.close\("cancel"\)/);
  assert.match(app, /data-project-dialog-close/);
});

test("執行紀錄詳情會緊接在所選紀錄下方展開並可收合", async () => {
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  const html = await fs.readFile(path.resolve("public/index.html"), "utf8");
  const css = await fs.readFile(path.resolve("public/styles.css"), "utf8");
  assert.match(app, /data-run-row=/);
  assert.match(app, /data-run-detail-row=/);
  assert.match(app, /buildRunHistoryDetailsMarkup/);
  assert.match(app, /data-run-detail-close/);
  assert.match(app, /data-history-debug-tab=/);
  assert.match(app, /\["log", "執行日誌"\]/);
  assert.match(app, /\["console", "Console"\]/);
  assert.match(app, /\["network", "Network"\]/);
  assert.match(app, /\["popup", "Popup \/ Download"\]/);
  assert.match(app, /\["variables", "變數"\]/);
  assert.doesNotMatch(html, /id="runHistoryDetails"/);
  assert.match(css, /\.run-detail-row > td/);
  assert.match(css, /\.run-status-icon/);
  assert.match(css, /\.step-status-icon/);
  assert.match(app, /function runStatusIconMarkup\(status\)/);
  assert.match(app, /<svg viewBox="0 0 20 20"/);
  assert.match(css, /\.run-detail-item > span/);
  assert.match(css, /\.status-icon svg/);
});

test("專案總覽最近專案對可快速執行者提供執行流程按鈕", async () => {
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  const css = await fs.readFile(path.resolve("public/styles.css"), "utf8");
  assert.match(app, /function projectIsQuickRunnable/);
  assert.match(app, /data-dashboard-run=/);
  assert.match(app, /async function runDashboardProject/);
  assert.match(app, /必要參數|parameter.required/);
  assert.match(app, /domainEntryAllows/);
  assert.match(css, /\.dashboard-run-button/);
  assert.match(css, /\.project-row-actions/);
});

test("測試與 Debug 執行監控使用一致 SVG 狀態圖示與分區資訊", async () => {
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  const html = await fs.readFile(path.resolve("public/index.html"), "utf8");
  const css = await fs.readFile(path.resolve("public/styles.css"), "utf8");
  assert.match(html, /id="runProgressPercent"/);
  assert.match(html, /id="runCurrentStep"/);
  assert.match(html, /id="runMonitorError"/);
  assert.match(html, /monitor-step-results/);
  assert.match(html, /monitor-download-results/);
  assert.match(app, /statusBadge\.innerHTML = `\$\{runStatusIconMarkup\(run\.status\)\}/);
  assert.match(app, /<article class="step-result \$\{step\.status\}">\$\{runStatusIconMarkup\(step\.status\)\}/);
  assert.doesNotMatch(app, /<article class="step-result \$\{step\.status\}"><i><\/i>/);
  assert.match(css, /#testView \.run-monitor-overview/);
  assert.match(css, /#testView \.run-stat-grid/);
  assert.match(css, /#testView \.monitor-step-results \.status-icon/);
});

test("長錯誤訊息不會撐破測試監控版面且執行紀錄輪詢保留展開區捲動位置", async () => {
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  const css = await fs.readFile(path.resolve("public/styles.css"), "utf8");
  assert.match(app, /function captureRunHistoryScrollState\(\)/);
  assert.match(app, /function restoreRunHistoryScrollState\(snapshot\)/);
  assert.match(app, /read\("\.run-history-steps"\)/);
  assert.match(app, /read\("\.run-history-downloads"\)/);
  assert.match(app, /read\("\.run-history-debug pre"\)/);
  assert.match(app, /window\.scrollTo\(snapshot\.pageX, snapshot\.pageY\)/);
  assert.match(app, /const scrollState = captureRunHistoryScrollState\(\);\s*renderRuns\(\);\s*restoreRunHistoryScrollState\(scrollState\);/s);
  assert.match(css, /#testView \.run-monitor-error \{[^}]*min-width: 0;[^}]*max-width: 100%;[^}]*overflow: hidden;/s);
  assert.match(css, /#testView \.run-monitor-error span \{[^}]*max-height: 160px;[^}]*overflow: auto;[^}]*word-break: break-all;[^}]*white-space: pre-wrap;/s);
  assert.match(css, /#testView \.monitor-step-results \.step-result small \{[^}]*max-height: 72px;[^}]*overflow: auto;[^}]*word-break: break-all;/s);
  assert.match(css, /\.run-history-debug pre \{[^}]*overflow: auto;[^}]*word-break: break-all;[^}]*white-space: pre-wrap;/s);
});


test("左側提供使用說明與回報問題並支援預設收件信箱", async () => {
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  const html = await fs.readFile(path.resolve("public/index.html"), "utf8");
  const css = await fs.readFile(path.resolve("public/styles.css"), "utf8");
  const store = await fs.readFile(path.resolve("src/studio/store.ts"), "utf8");
  assert.match(html, /data-view="help"[^>]*>.*使用說明/s);
  assert.match(html, /data-view="report"[^>]*>.*回報問題/s);
  assert.match(html, /id="helpView"/);
  assert.match(html, /快速上手流程/);
  assert.match(html, /常見問題 FAQ/);
  assert.match(html, /系統架構圖/);
  assert.match(html, /id="reportView"/);
  assert.match(html, /id="sendIssueReportButton"/);
  assert.match(html, /id="issueReportEmail"/);
  assert.match(app, /function buildIssueReportText\(\)/);
  assert.match(app, /function sendIssueReport\(\)/);
  assert.match(app, /mailto:/);
  assert.match(app, /navigator\.clipboard\.writeText/);
  assert.match(app, /未由系統自動附帶密碼、Cookie、MFA、驗證碼或流程參數實際值/);
  assert.match(store, /AUTOMATION_STUDIO_SUPPORT_EMAIL/);
  assert.match(css, /\.quick-flow/);
  assert.match(css, /\.architecture-diagram/);
  assert.match(css, /\.support-grid/);
  assert.match(html, /TypeScript 專案獨立執行/);
  assert.match(html, /playwright/);
  assert.match(html, /Node\.js 22\.6/);
  assert.match(html, /npm install/);
  assert.match(html, /npx playwright install chromium/);
  assert.match(html, /不需要另外安裝.*typescript.*ts-node/s);
  assert.match(css, /\.faq-list summary \{[^}]*font-size: 13px;/s);
  assert.match(css, /\.faq-list p \{[^}]*font-size: 12px;/s);
  assert.match(css, /\.flow-node small \{[^}]*font-size: 11px;/s);
  assert.match(css, /\.arch-layer span \{[^}]*font-size: 11px;/s);
});


test("工作空間外頁面不顯示工作空間儲存與快速執行控制列", async () => {
  const html = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const css = await fs.readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.ok(html.includes('id="workspaceTopbarActions"'));
  assert.ok(app.includes('new Set(["dashboard", "workstation", "designer", "parameters", "test"])'));
  assert.match(app, /aiWorkflow: \["AI 流程助理", "開發者功能"\]/);
  assert.ok(app.includes('workspaceTopbarActions.hidden = !workspaceViews.has(view)'));
  assert.ok(css.includes('.topbar-actions[hidden] { display: none !important; }'));
});

test("Windows 執行紀錄原子寫入會序列化、使用唯一 tmp 並重試暫時性鎖檔", async () => {
  const source = await fs.readFile(new URL("../src/studio/store.ts", import.meta.url), "utf8");
  assert.match(source, /jsonWriteQueues = new Map<string, Promise<void>>/);
  assert.match(source, /WINDOWS_RENAME_RETRY_CODES = new Set\(\["EPERM", "EBUSY", "EACCES"\]\)/);
  assert.match(source, /const tempPath = `\$\{filePath\}\.\$\{process\.pid\}\.\$\{Date\.now\(\)\}\.\$\{sequence\}\.tmp`/);
  assert.match(source, /await renameWithRetry\(tempPath, filePath\)/);
  assert.match(source, /Math\.min\(50 \* \(2 \*\* attempt\), 1_000\)/);
  assert.match(source, /console\.warn\(`\[run-store\]/);
});

test("Gemini V1.0.7 使用 x-goog-api-key Header 而非 query key", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  globalThis.fetch = (async (input: any, init?: any) => {
    capturedUrl = String(input);
    capturedHeaders = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k,v]) => [String(k).toLowerCase(), String(v)]));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "OK" }] } }], modelVersion: "gemini-3.5-flash-lite" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const provider = new GeminiProvider({ id:"gemini-default", name:"Gemini", kind:"gemini", enabled:true, endpoint:"https://generativelanguage.googleapis.com/v1beta", model:"gemini-3.5-flash-lite", authMode:"api_key", apiKeyHeader:"x-goog-api-key", secret:{ source:"inline", value:"test-key" }, timeoutMs:1000 });
    const result = await provider.generate({ messages:[{ role:"user", content:"Reply only OK" }] });
    assert.equal(result.text, "OK");
    assert.equal(capturedHeaders["x-goog-api-key"], "test-key");
    assert.doesNotMatch(capturedUrl, /[?&]key=/);
  } finally { globalThis.fetch = originalFetch; }
});

test("AI HTTP 503 會依設定進行 retry 並在後續成功", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls < 3) return new Response(JSON.stringify({ error:{ code:503, message:"high demand", status:"UNAVAILABLE" } }), { status:503, headers:{ "content-type":"application/json" } });
    return new Response(JSON.stringify({ ok:true }), { status:200, headers:{ "content-type":"application/json" } });
  }) as typeof fetch;
  try {
    const result = await fetchJson<{ok:boolean}>({ id:"gemini-default", name:"Gemini", kind:"gemini", enabled:true, endpoint:"https://example.com", authMode:"none", timeoutMs:1000 }, "https://example.com/test", { method:"GET" }, { retryDelaysMs:[1,1,1] });
    assert.equal(result.ok, true);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = originalFetch; }
});

test("AI fetch failed 會顯示底層 TLS cause", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { const cause:any = new Error("unable to get local issuer certificate"); cause.code="UNABLE_TO_GET_ISSUER_CERT_LOCALLY"; throw new TypeError("fetch failed", { cause }); }) as typeof fetch;
  try {
    await assert.rejects(() => fetchJson({ id:"gemini-default", name:"Gemini", kind:"gemini", enabled:true, endpoint:"https://example.com", authMode:"none", timeoutMs:1000 }, "https://example.com", { method:"GET" }, { retryDelaysMs:[] }), /UNABLE_TO_GET_ISSUER_CERT_LOCALLY.*unable to get local issuer certificate/);
  } finally { globalThis.fetch = originalFetch; }
});

test("AI Workflow 正規化會移除 script 與敏感預設值", () => {
  const result = normalizeAIWorkflowDraft({ name:"AI流程", targetUrl:"https://example.com", parameters:[{ name:"password", label:"密碼", type:"text", defaultValue:"secret" }], steps:[{ name:"危險腳本", kind:"script", script:"alert(1)" },{ name:"開啟首頁", kind:"navigate", url:"https://example.com" }] }, { instruction:"開啟網站" });
  assert.equal(result.validation.valid, true);
  assert.equal(result.draft.steps.some((s) => s.kind === "script"), false);
  assert.equal(result.draft.parameters[0]?.type, "secret");
  assert.equal(result.draft.parameters[0]?.defaultValue, undefined);
  assert.deepEqual(result.draft.allowedDomains, ["example.com"]);
});

test("AI Workflow 正規化會保留頁面 PDF 頁首／頁尾與縮放設定", () => {
  const result = normalizeAIWorkflowDraft({
    name: "PDF 流程",
    targetUrl: "https://example.com",
    steps: [{
      name: "保存頁面 PDF",
      kind: "savePagePdf",
      pdfDisplayHeaderFooter: true,
      pdfHeaderTemplate: '<div><span class="title"></span></div>',
      pdfFooterTemplate: '<div><span class="pageNumber"></span>/<span class="totalPages"></span></div>',
      pdfScale: 1.35
    }]
  }, { instruction: "保存目前頁面為 PDF" });
  const step = result.draft.steps[0];
  assert.equal(result.validation.valid, true);
  assert.equal(step.pdfDisplayHeaderFooter, true);
  assert.equal(step.pdfHeaderTemplate, '<div><span class="title"></span></div>');
  assert.equal(step.pdfFooterTemplate, '<div><span class="pageNumber"></span>/<span class="totalPages"></span></div>');
  assert.equal(step.pdfScale, 1.35);
});

test("V1.0.7 UI 提供 Gemini Header、TLS 診斷與 AI 流程助理", async () => {
  const html = await fs.readFile(path.resolve("public/index.html"), "utf8");
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  assert.match(html, /data-view="aiWorkflow"/);
  assert.match(html, /id="diagnoseAIButton"/);
  assert.match(html, /x-goog-api-key/);
  assert.match(app, /diagnoseActiveAIProvider/);
  assert.match(app, /gemini-3\.5-flash-lite/);
});


test("AI Workflow 網站探索會阻止缺少或未觀察 selector 的互動步驟", () => {
  const siteEvidence = {
    sessionId:"ai-explore-test", startedAt:new Date().toISOString(), targetUrl:"https://example.com/", currentUrl:"https://example.com/",
    pages:[], trace:[{ index:1, action:"fill", label:"搜尋", pageUrl:"https://example.com/", selectors:[{ strategy:"css", value:"#search" }], workflowValue:"{{keyword}}" }],
    verifiedSelectors:[{ strategy:"css", value:"#search" }], readyForDraft:true, requiresManual:false
  } as any;
  const missing = normalizeAIWorkflowDraft({ name:"缺 selector", targetUrl:"https://example.com", steps:[{ name:"輸入搜尋關鍵字", kind:"fill", value:"{{keyword}}" }] }, { instruction:"搜尋", siteEvidence });
  assert.equal(missing.validation.valid, false);
  assert.match(missing.validation.errors.join("\n"), /沒有經網站檢視取得 selector/);

  const invented = normalizeAIWorkflowDraft({ name:"猜 selector", targetUrl:"https://example.com", steps:[{ name:"輸入搜尋關鍵字", kind:"fill", value:"{{keyword}}", selectors:[{ strategy:"css", value:"#invented" }] }] }, { instruction:"搜尋", siteEvidence });
  assert.equal(invented.validation.valid, false);
  assert.match(invented.validation.errors.join("\n"), /未出現在本次實際網站探索/);

  const verified = normalizeAIWorkflowDraft({ name:"已驗證", targetUrl:"https://example.com", steps:[{ name:"輸入搜尋關鍵字", kind:"fill", value:"{{keyword}}", selectors:[{ strategy:"css", value:"#search" }] }] }, { instruction:"搜尋", siteEvidence });
  assert.equal(verified.validation.valid, true);
});

test("AI Workflow request 會帶入網站探索證據並要求不可發明 selector", () => {
  const request = buildAIWorkflowRequest({ instruction:"輸入搜尋關鍵字後點擊搜尋", targetUrl:"https://example.com", siteEvidence:{ sessionId:"s", startedAt:"2026-09-23T00:00:00Z", targetUrl:"https://example.com/", currentUrl:"https://example.com/", pages:[], trace:[{ index:1, action:"fill", label:"搜尋", pageUrl:"https://example.com/", selectors:[{ strategy:"name", value:"q" }] }], verifiedSelectors:[{ strategy:"name", value:"q" }], readyForDraft:true, requiresManual:false } as any });
  assert.match(request.messages[0].content, /不可猜測、不可自行發明 selector/);
  assert.match(request.messages[1].content, /siteEvidence/);
  assert.match(request.messages[1].content, /\"value\": \"q\"/);
});

test("V1.0.8 AI 流程助理提供實際網站檢視與人工接手機制", async () => {
  const html = await fs.readFile(path.resolve("public/index.html"), "utf8");
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  const router = await fs.readFile(path.resolve("src/studio/router.ts"), "utf8");
  assert.match(html, /id="startAIWorkflowInspectionButton"/);
  assert.match(html, /網站探索模式/);
  assert.match(app, /AI 正在實際探索網站/);
  assert.match(router, /ai\/workflows\/exploration\/start/);
  assert.match(router, /explorationSessionId/);
});



test("AI 網站探索暫存專案 ID 符合既有識別碼安全規則", () => {
  const ids = [
    createAIRecorderProjectId("ai-explore-test"),
    createAIRecorderProjectId("__ai explore 中文 test"),
    createAIRecorderProjectId("../unsafe/path")
  ];
  for (const id of ids) {
    assert.match(id, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/);
    assert.match(id, /^ai-recorder-/);
  }
});

test("V1.0.8 AI 網站探索模組可由 Node strip-only TypeScript 直接載入", async () => {
  const source = await fs.readFile(path.resolve("src/studio/ai/siteExplorer.ts"), "utf8");
  assert.doesNotMatch(source, /constructor\([^)]*\b(?:public|private|protected|readonly)\b/);
  assert.match(source, /private readonly recorder: RecorderManager;/);
  assert.match(source, /constructor\(recorder: RecorderManager\)\s*\{\s*this\.recorder = recorder;/s);
});


test("V1.0.9 對話式修改 request 會帶入目前草稿與歷史，並要求只改指定內容", () => {
  const currentDraft:any = {
    name:"測試流程", description:"原流程", summary:"原流程", assumptions:[], targetUrl:"https://example.com/", allowedDomains:["example.com"], adapter:"generic", parameters:[],
    steps:[{ id:"step-search", name:"點擊搜尋", kind:"click", enabled:true, selectors:[{ strategy:"css", value:"#search" }] }]
  };
  const request = buildAIWorkflowRevisionRequest({ instruction:"把等待時間改成 3 秒，其他不要改", targetUrl:currentDraft.targetUrl, currentDraft, conversation:[{ role:"user", content:"先做搜尋流程" },{ role:"assistant", content:"已產生初版" }] });
  assert.equal(request.metadata?.schemaVersion, "1.0.12");
  assert.match(request.messages[0].content, /只修改使用者本輪明確要求的部分/);
  assert.match(request.messages[0].content, /既有 step\.id/);
  assert.match(request.messages[1].content, /"currentDraft"/);
  assert.match(request.messages[1].content, /step-search/);
  assert.match(request.messages[1].content, /把等待時間改成 3 秒/);
});

test("V1.0.9 對話式修改會保留既有步驟 ID 並以既有 selector 視為可信", () => {
  const currentDraft:any = {
    name:"測試流程", description:"原流程", summary:"原流程", assumptions:[], targetUrl:"https://example.com/", allowedDomains:["example.com"], adapter:"generic", parameters:[],
    steps:[{ id:"step-search", name:"點擊搜尋", kind:"click", enabled:true, selectors:[{ strategy:"css", value:"#search" }] }]
  };
  const result = normalizeAIWorkflowDraft({ ...currentDraft, description:"更新說明", steps:[{ ...currentDraft.steps[0], name:"執行搜尋" }] }, { instruction:"改步驟名稱", currentDraft, targetUrl:currentDraft.targetUrl });
  assert.equal(result.validation.valid, true);
  assert.equal(result.draft.steps[0]?.id, "step-search");
  assert.equal(result.draft.steps[0]?.selectors?.[0]?.value, "#search");
});

test("V1.0.9 對話修改不會被未完成但無關的網站探索 session 誤擋", () => {
  const currentDraft:any = {
    name:"測試流程", description:"原流程", summary:"原流程", assumptions:[], targetUrl:"https://example.com/", allowedDomains:["example.com"], adapter:"generic", parameters:[],
    steps:[
      { id:"step-search", name:"點擊搜尋", kind:"click", enabled:true, selectors:[{ strategy:"css", value:"#search" }] },
      { id:"step-wait", name:"等待", kind:"wait", enabled:true, timeoutMs:1000 }
    ]
  };
  const incompleteEvidence:any = {
    sessionId:"ai-explore-pending", startedAt:new Date().toISOString(), targetUrl:"https://example.com/", currentUrl:"https://example.com/",
    pages:[], trace:[], verifiedSelectors:[], readyForDraft:false, requiresManual:false
  };
  const result = normalizeAIWorkflowDraft({
    ...currentDraft,
    steps:[currentDraft.steps[0], { ...currentDraft.steps[1], timeoutMs:3000 }]
  }, { instruction:"等待改成 3 秒", currentDraft, targetUrl:currentDraft.targetUrl, siteEvidence:incompleteEvidence });
  assert.equal(result.validation.valid, true);
  assert.doesNotMatch(result.validation.errors.join("\n"), /AI 網站探索尚未完成/);
});

test("V1.0.9 初版流程仍會阻止未完成的網站探索", () => {
  const incompleteEvidence:any = {
    sessionId:"ai-explore-pending", startedAt:new Date().toISOString(), targetUrl:"https://example.com/", currentUrl:"https://example.com/",
    pages:[], trace:[], verifiedSelectors:[], readyForDraft:false, requiresManual:false
  };
  const result = normalizeAIWorkflowDraft({
    name:"初版", targetUrl:"https://example.com/",
    steps:[{ id:"step-open", name:"開啟首頁", kind:"navigate", enabled:true, url:"https://example.com/" }]
  }, { instruction:"開啟網站", targetUrl:"https://example.com/", siteEvidence:incompleteEvidence });
  assert.equal(result.validation.valid, false);
  assert.match(result.validation.errors.join("\n"), /AI 網站探索尚未完成/);
});

test("V1.0.9 對話修改仍會阻止 AI 發明新的未驗證 selector", () => {
  const currentDraft:any = {
    name:"測試流程", description:"原流程", summary:"原流程", assumptions:[], targetUrl:"https://example.com/", allowedDomains:["example.com"], adapter:"generic", parameters:[],
    steps:[{ id:"step-search", name:"點擊搜尋", kind:"click", enabled:true, selectors:[{ strategy:"css", value:"#search" }] }]
  };
  const incompleteEvidence:any = {
    sessionId:"ai-explore-pending", startedAt:new Date().toISOString(), targetUrl:"https://example.com/", currentUrl:"https://example.com/",
    pages:[], trace:[], verifiedSelectors:[], readyForDraft:false, requiresManual:false
  };
  const result = normalizeAIWorkflowDraft({
    ...currentDraft,
    steps:[...currentDraft.steps, { id:"step-download", name:"下載檔案", kind:"download", enabled:true, selectors:[{ strategy:"css", value:"#invented-download" }] }]
  }, { instruction:"新增下載", currentDraft, targetUrl:currentDraft.targetUrl, siteEvidence:incompleteEvidence });
  assert.equal(result.validation.valid, false);
  assert.match(result.validation.errors.join("\n"), /selector 未出現在本次實際網站探索或既有流程中/);
});

test("V1.0.9 revise API 不會因網站探索停在人工操作而阻止純流程修改", async () => {
  const router = await fs.readFile(path.resolve("src/studio/router.ts"), "utf8");
  const draftStart = router.indexOf('relativePath === "/ai/workflows/draft"');
  const reviseStart = router.indexOf('relativePath === "/ai/workflows/revise"');
  assert.ok(draftStart >= 0 && reviseStart > draftStart);
  const draftBlock = router.slice(draftStart, reviseStart);
  const reviseBlock = router.slice(reviseStart, router.indexOf('sendJson(response, 404', reviseStart));
  assert.match(draftBlock, /siteEvidence\?\.requiresManual/);
  assert.doesNotMatch(reviseBlock, /siteEvidence\?\.requiresManual\)\s*throw/);
});

test("V1.0.9 差異預覽只列出真正變更的步驟", () => {
  const before:any = {
    name:"測試", description:"", summary:"", assumptions:[], targetUrl:"https://example.com/", allowedDomains:["example.com"], adapter:"generic", parameters:[],
    steps:[
      { id:"step-1", name:"開啟首頁", kind:"navigate", enabled:true, url:"https://example.com/" },
      { id:"step-2", name:"等待", kind:"wait", enabled:true, timeoutMs:1000 }
    ]
  };
  const after:any = structuredClone(before);
  after.steps[1].timeoutMs = 3000;
  const diff = diffAIWorkflowDraft(before, after);
  assert.equal(diff.changed, true);
  assert.equal(diff.steps.length, 1);
  assert.equal(diff.steps[0]?.id, "step-2");
  assert.equal(diff.steps[0]?.type, "modified");
});

test("V1.0.9 revision 可要求重新探索網站而不猜測 selector", () => {
  const currentDraft:any = {
    name:"測試", description:"", summary:"", assumptions:[], targetUrl:"https://example.com/", allowedDomains:["example.com"], adapter:"generic", parameters:[],
    steps:[{ id:"step-1", name:"開啟首頁", kind:"navigate", enabled:true, url:"https://example.com/" }]
  };
  const response:any = { providerId:"test", providerKind:"gemini", text:JSON.stringify({ requiresExploration:true, explorationReason:"需要找到下載按鈕", changeSummary:["新增下載步驟"], ...currentDraft }) };
  const result = createAIWorkflowRevision(response, { instruction:"新增下載按鈕", currentDraft, targetUrl:currentDraft.targetUrl });
  assert.equal(result.revision.requiresExploration, true);
  assert.match(result.revision.reason ?? "", /下載按鈕/);
  assert.equal(result.diff.changed, false);
});

test("V1.0.9 UI 提供多輪對話、差異確認與不呼叫 AI 的復原上一版", async () => {
  const html = await fs.readFile(path.resolve("public/index.html"), "utf8");
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  const router = await fs.readFile(path.resolve("src/studio/router.ts"), "utf8");
  assert.match(html, /id="aiWorkflowConversation"/);
  assert.match(html, /id="sendAIWorkflowRevisionButton"/);
  assert.match(html, /id="undoAIWorkflowRevisionButton"/);
  assert.match(html, /id="acceptAIWorkflowRevisionButton"/);
  assert.match(html, /id="acceptAndApplyAIWorkflowRevisionButton"/);
  assert.match(html, /確認並套用至目前專案/);
  assert.match(html, /復原由本機程式執行，不呼叫 AI/);
  assert.match(app, /function undoAIWorkflowRevision\(\)/);
  assert.match(app, /state\.aiWorkflowHistory\.pop\(\)/);
  assert.doesNotMatch(app.match(/async function undoAIWorkflowRevision\(\)[\s\S]*?\n\}/)?.[0] ?? "", /\/api\/studio\/ai/);
  assert.match(app, /previous\.appliedToProject/);
  assert.match(app, /AI 草稿與目前專案已復原上一版/);
  assert.match(app, /renderAIWorkflowDiff/);
  assert.match(app, /function acceptAndApplyAIWorkflowRevision\(\)/);
  assert.match(app, /renderAIWorkflowDiffLegend/);
  assert.match(app, /renderAIWorkflowRemovedSteps/);
  assert.match(app, /change-added/);
  assert.match(app, /change-modified/);
  assert.match(app, /change-removed/);
  assert.match(app, /↔ 移動/);
  assert.match(router, /ai\/workflows\/revise/);
});


test("V1.0.9 download-only manual decisions are converted to safe browser actions", () => {
  const observed:any = {
    observedAt:new Date().toISOString(), url:"https://example.com/report", title:"Report",
    elements:[
      { ref:"f0-e1", frameIndex:0, frameUrl:"https://example.com/report", tag:"a", text:"PDF", href:"https://example.com/a.pdf" },
      { ref:"f0-e2", frameIndex:0, frameUrl:"https://example.com/report", tag:"a", text:"PDF", href:"https://example.com/b.pdf" }
    ]
  };
  const decision:any = { status:"manual", reason:"download PDF files saves multiple files to the local machine" };
  const first:any = normalizePlannerDecisionForSafeDownloads(decision, observed, []);
  assert.equal(first.status, "act");
  assert.equal(first.action, "click");
  assert.equal(first.elementRef, "f0-e1");
  const second:any = normalizePlannerDecisionForSafeDownloads(decision, observed, [{ index:1, action:"download", label:"PDF", pageUrl:observed.url, elementRef:"f0-e1" }] as any);
  assert.equal(second.elementRef, "f0-e2");
});

test("V1.0.9 download exception never overrides destructive or sensitive manual reasons", () => {
  assert.equal(isDownloadOnlyManualReason("download PDF files saves files locally"), true);
  assert.equal(isDownloadOnlyManualReason("delete the record and download PDF"), false);
  assert.equal(isDownloadOnlyManualReason("download file after entering password"), false);
});

test("V1.0.9 explorer prompt explicitly permits local and multiple downloads", async () => {
  const source = await fs.readFile(path.resolve("src/studio/ai/siteExplorer.ts"), "utf8");
  assert.match(source, /IMPORTANT DOWNLOAD EXCEPTION/);
  assert.match(source, /even when files are saved locally and even when multiple files are requested/);
  assert.match(source, /recorded\?\.type === "download" \? "download"/);
});


test("V1.0.9 AI 流程助理錯誤會持久保留而非只顯示短暫 toast", async () => {
  const html = await fs.readFile(path.resolve("public/index.html"), "utf8");
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  assert.match(html, /id="aiWorkflowErrorPanel"/);
  assert.match(app, /function recordAIWorkflowError\(/);
  assert.match(app, /function renderAIWorkflowErrors\(/);
  assert.match(app, /錯誤會保留，直到你手動清除/);
  assert.match(app, /errors:\(state\.aiWorkflowErrors \?\? \[\]\)\.slice\(0,20\)/);
  assert.match(app, /state\.aiWorkflowErrors = Array\.isArray\(saved\?\.errors\)/);
  assert.match(app, /recordAIWorkflowError\("generation", error\)/);
  assert.match(app, /recordAIWorkflowError\("revision", error\)/);
});


test("V1.0.10 AI 流程助理提供即時執行監控、停滯提示與診斷操作", async () => {
  const html = await fs.readFile(path.resolve("public/index.html"), "utf8");
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  const css = await fs.readFile(path.resolve("public/styles.css"), "utf8");
  const router = await fs.readFile(path.resolve("src/studio/router.ts"), "utf8");
  assert.match(html, /id="aiWorkflowMonitorPanel"/);
  assert.match(html, /id="retryAIWorkflowMonitorButton"/);
  assert.match(html, /id="stopAIWorkflowMonitorButton"/);
  assert.match(html, /id="copyAIWorkflowDiagnosticButton"/);
  assert.match(app, /AI_WORKFLOW_MONITOR_STAGES/);
  assert.match(app, /pollAIWorkflowExplorationMonitor/);
  assert.match(app, /deriveAIWorkflowMonitorWarning/);
  assert.match(app, /AI Provider 已等待/);
  assert.match(app, /selector 驗證已等待/);
  assert.match(app, /相同網站操作已連續出現 3 次以上/);
  assert.match(app, /copyAIWorkflowDiagnostic/);
  assert.match(app, /retryAIWorkflowMonitorStep/);
  assert.match(app, /stopAIWorkflowMonitoredOperation/);
  assert.match(router, /ai\/workflows\/exploration\/status/);
  assert.match(css, /V1\.0\.10 AI execution monitor/);
});

test("V1.0.10 網站探索後端會回報 AI、selector、瀏覽器與頁面等待階段", async () => {
  const source = await fs.readFile(path.resolve("src/studio/ai/siteExplorer.ts"), "utf8");
  const types = await fs.readFile(path.resolve("src/studio/ai/types.ts"), "utf8");
  assert.match(types, /interface AIWorkflowMonitorState/);
  assert.match(types, /monitor\?: AIWorkflowMonitorState/);
  assert.match(source, /phase: "ai_planning"/);
  assert.match(source, /phase: "selector_probe"/);
  assert.match(source, /phase: "browser_action"/);
  assert.match(source, /phase: "page_wait"/);
  assert.match(source, /repeatCount >= 3/);
  assert.match(source, /monitor: \{ \.\.\.session\.monitor/);
});

test("V1.0.10 AI Provider 預設等待 180 秒並把 Abort 明確標示為逾時", async () => {
  const config = await fs.readFile(path.resolve("src/studio/ai/config.ts"), "utf8");
  const http = await fs.readFile(path.resolve("src/studio/ai/http.ts"), "utf8");
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  assert.match(config, /openai-default[\s\S]*timeoutMs: 180000/);
  assert.match(config, /gemini-default[\s\S]*timeoutMs: 180000/);
  assert.match(http, /AI 回應逾時：等待超過/);
  assert.match(http, /code: "AI_TIMEOUT"/);
  assert.match(app, /Provider Timeout/);
  assert.match(app, /180000/);
});


test("V1.0.10 AI Workflow 會自動補上缺少的初始 navigate 網址，避免合法草稿無法建立或套用", () => {
  const result = normalizeAIWorkflowDraft({
    name:"總統府下載流程",
    targetUrl:"https://www.president.gov.tw/Page/129",
    steps:[
      { id:"step-open", name:"前往總統府公報查詢頁面", kind:"navigate", enabled:true },
      { id:"step-wait", name:"等待頁面", kind:"wait", enabled:true, timeoutMs:1000 }
    ]
  }, { instruction:"前往總統府公報查詢頁面", targetUrl:"https://www.president.gov.tw/Page/129" });
  assert.equal(result.validation.valid, true);
  assert.equal(result.draft.steps[0]?.url, "https://www.president.gov.tw/Page/129");
  assert.match(result.validation.warnings.join("\n"), /已自動使用流程目標網址/);
});

test("V1.0.10 AI 草稿操作按鈕會顯示停用原因而不是只有灰色按鈕", async () => {
  const html = await fs.readFile(path.resolve("public/index.html"), "utf8");
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  assert.match(html, /id="aiWorkflowActionHint"/);
  assert.match(app, /目前無法套用/);
  assert.match(app, /草稿已通過驗證，可建立為新專案/);
  assert.match(app, /createButton\.title = validationReason/);
});


test("V1.0.12 Debug AI 只提供失敗步驟候選設定，且 selector 必須來自實際頁面證據", () => {
  const project:any = createDefaultProject({
    id:"debug-ai-project", name:"Debug AI", targetUrl:"https://example.com/search",
    steps:[{ id:"step-search", name:"點擊搜尋", kind:"click", enabled:true, selectors:[{ strategy:"css", value:"#old-search:visible" }], timeoutMs:30000 }]
  });
  const run:any = {
    id:"run-debug", projectId:project.id, projectName:project.name, status:"failed", mode:"single-step", parameters:{},
    startedAt:new Date().toISOString(), endedAt:new Date().toISOString(), completedSteps:0, totalSteps:1, currentStepId:"step-search",
    steps:[{ stepId:"step-search", name:"點擊搜尋", kind:"click", status:"failed", startedAt:new Date().toISOString(), message:"locator timed out" }],
    downloads:[], variables:{}, debugDir:"./debug/test", errorCode:"TIMEOUT", errorMessage:"locator timed out"
  };
  const pageSummary:any = {
    capturedAt:new Date().toISOString(), url:"https://example.com/search", title:"Search", bodyText:"搜尋",
    frames:[{ url:"https://example.com/search", bodyText:"搜尋", elements:[{ tag:"button", id:"searchBtn", text:"搜尋" }], selectorCandidates:[{ strategy:"css", value:"#searchBtn:visible" }, { strategy:"text", value:"搜尋", exact:true }] }]
  };
  const input:any = { project, run, failedStep:project.steps[0], events:[], pageSummary };
  const request = buildAIDebugAnalysisRequest(input);
  assert.equal(request.metadata?.schemaVersion, "1.0.12");
  const response:any = { providerId:"test", providerKind:"gemini", text:JSON.stringify({
    summary:"selector 已變更", rootCause:"舊 selector 不存在", confidence:"high", evidence:["頁面存在 #searchBtn"], suggestions:["更新 selector"], patchSummary:["更新 selector 與 timeout"],
    proposedPatch:{ id:"evil", kind:"script", selectors:[{ strategy:"css", value:"#searchBtn:visible" }, { strategy:"css", value:"#invented:visible" }], timeoutMs:60000 }, warnings:[]
  }) };
  const analysis = createAIDebugAnalysis(response, input);
  assert.equal(analysis.proposedPatch.timeoutMs, 60000);
  assert.deepEqual(analysis.proposedPatch.selectors?.map((x:any) => x.value), ["#searchBtn:visible"]);
  assert.equal((analysis.proposedPatch as any).id, undefined);
  assert.equal((analysis.proposedPatch as any).kind, undefined);
  assert.match(analysis.warnings.join("\n"), /未經頁面證據驗證/);
});

test("V1.0.12 失敗診斷包會遮罩敏感參數、變數、URL query 與本機路徑", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "automation-studio-debug-bundle-"));
  try {
    const project:any = createDefaultProject({
      id:"diag-project", name:"診斷", targetUrl:"https://example.com/report?token=secret",
      parameters:[{ id:"p-secret", name:"password", label:"密碼", type:"secret", required:false, sensitive:true }],
      steps:[{ id:"step-1", name:"下載", kind:"download", enabled:true, selectors:[{ strategy:"text", value:"PDF", exact:true }] }]
    });
    const run:any = {
      id:"run-1", projectId:project.id, projectName:project.name, status:"failed", mode:"full", parameters:{ password:"super-secret" },
      startedAt:new Date().toISOString(), endedAt:new Date().toISOString(), completedSteps:0, totalSteps:1, currentStepId:"step-1",
      steps:[{ stepId:"step-1", name:"下載", kind:"download", status:"failed", startedAt:new Date().toISOString(), message:"GET https://example.com/file?token=abc failed" }],
      downloads:["C:\\Users\\name\\Downloads\\secret.pdf"], variables:{ otp:"123456" }, debugDir:temporary, errorCode:"ERROR", errorMessage:"token=abcdef"
    };
    await fs.writeFile(path.join(temporary, "failure-redacted.png"), Buffer.from([1,2,3]));
    const bundle = await buildFailureDiagnosticZip({
      project, run, failedStep:project.steps[0], events:[{ type:"request_failed", url:"https://example.com/file?token=abc", filePath:"C:\\Users\\name\\Downloads\\secret.pdf" }],
      pageSummary:{ capturedAt:new Date().toISOString(), url:"https://example.com/report?token=***", title:"Report", bodyText:"safe", frames:[] }
    });
    assert.ok(bundle.buffer.includes(Buffer.from("run-summary.json")));
    assert.ok(bundle.buffer.includes(Buffer.from("***")));
    assert.ok(!bundle.buffer.includes(Buffer.from("super-secret")));
    assert.ok(!bundle.buffer.includes(Buffer.from("123456")));
    assert.ok(!bundle.buffer.includes(Buffer.from("C:\\Users\\name")));
  } finally {
    await fs.rm(temporary, { recursive:true, force:true });
  }
});

test("V1.0.12 測試與 Debug 顯示 AI 失敗分析、候選修正與失敗診斷包下載", async () => {
  const html = await fs.readFile(path.resolve("public/index.html"), "utf8");
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  const router = await fs.readFile(path.resolve("src/studio/router.ts"), "utf8");
  const executor = await fs.readFile(path.resolve("src/studio/executor.ts"), "utf8");
  assert.match(html, /id="debugFailureTools"/);
  assert.match(html, /id="analyzeRunFailureButton"/);
  assert.match(html, /id="downloadFailureDiagnosticsButton"/);
  assert.match(html, /id="applyDebugAIPatchButton"/);
  assert.match(html, /<summary>執行失敗後：AI 分析與失敗診斷包<\/summary>/);
  assert.doesNotMatch(html, /id="debugAIHelp"/);
  assert.match(app, /analyzeCurrentRunFailure/);
  assert.match(app, /downloadCurrentRunDiagnostics/);
  assert.match(app, /applyDebugAIPatch/);
  assert.match(router, /parts\[2\] === "ai-analyze"/);
  assert.match(router, /parts\[2\] === "diagnostics"/);
  assert.match(executor, /captureFailureDiagnostics/);
});

test("V1.0.12 UI 資訊架構：AI 流程助理移入開發者功能，AI Provider 分層收折", async () => {
  const html = await fs.readFile(path.resolve("public/index.html"), "utf8");
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  const styles = await fs.readFile(path.resolve("public/styles.css"), "utf8");
  const workspaceNav = html.match(/<nav class="nav"[\s\S]*?<\/nav>/)?.[0] ?? "";
  const developerMenu = html.match(/<details class="developer-menu">[\s\S]*?<\/details>/)?.[0] ?? "";
  assert.doesNotMatch(workspaceNav, /data-view="aiWorkflow"/);
  assert.match(developerMenu, /data-view="aiWorkflow"[^>]*>[\s\S]*AI 流程助理/);
  assert.match(app, /aiWorkflow: \["AI 流程助理", "開發者功能"\]/);
  assert.match(app, /const workspaceViews = new Set\(\["dashboard", "workstation", "designer", "parameters", "test"\]\)/);
  assert.match(html, /<details class="card settings-card ai-settings-card settings-collapsible">/);
  assert.match(app, /<details class="ai-provider-card"/);
  assert.match(styles, /\.settings-collapsible-summary/);
  assert.match(styles, /\.ai-provider-summary/);
  assert.match(html, /guide-inline-details/);
});

test("V1.0.12 自動化設計器每個流程步驟可直接單步或從此步驟執行", async () => {
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  const html = await fs.readFile(path.resolve("public/index.html"), "utf8");
  const css = await fs.readFile(path.resolve("public/styles.css"), "utf8");
  assert.match(app, /data-step-action="run-single"[^>]*>只執行此步驟<\/button>/);
  assert.match(app, /data-step-action="run-from"[^>]*>從此步驟執行<\/button>/);
  assert.match(app, /action === "run-single" \|\| action === "run-from"/);
  assert.match(app, /runWorkflow\(action === "run-single" \? "single-step" : "from-step"\)/);
  assert.match(css, /\.step-quick-run-actions/);
  assert.match(html, /每個步驟可直接單步執行或從該步驟開始執行/);
});


test("V1.0.13 Debug 到期清理採 24 小時節流，且不刪除執行中的 run", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "automation-studio-debug-retention-"));
  const debugRoot = path.join(temporary, "debug");
  const oldDir = path.join(debugRoot, "project-a", "run-old");
  const recentDir = path.join(debugRoot, "project-a", "run-recent");
  const activeDir = path.join(debugRoot, "project-a", "run-active");
  const orphanDir = path.join(debugRoot, "project-a", "run-orphan");
  const now = Date.now();
  try {
    for (const dir of [oldDir, recentDir, activeDir, orphanDir]) await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(oldDir, "old.txt"), "12345", "utf8");
    await fs.writeFile(path.join(recentDir, "recent.txt"), "recent", "utf8");
    await fs.writeFile(path.join(activeDir, "active.txt"), "active", "utf8");
    await fs.writeFile(path.join(orphanDir, "orphan.txt"), "orphan", "utf8");
    const oldDate = new Date(now - 40 * 24 * 60 * 60 * 1000);
    await fs.utimes(orphanDir, oldDate, oldDate);
    const base = { projectId: "project-a", projectName: "A", mode: "full" as const, parameters: {}, updatedAt: "", completedSteps: 0, totalSteps: 0, steps: [], downloads: [] };
    const runs: any[] = [
      { ...base, id: "run-old", status: "failed", startedAt: oldDate.toISOString(), endedAt: oldDate.toISOString(), debugDir: oldDir },
      { ...base, id: "run-recent", status: "failed", startedAt: new Date(now - 2 * 86400000).toISOString(), endedAt: new Date(now - 2 * 86400000).toISOString(), debugDir: recentDir },
      { ...base, id: "run-active", status: "running", startedAt: oldDate.toISOString(), debugDir: activeDir }
    ];
    const result = await sweepExpiredDebug({ debugRoot, runs, retentionDays: 30, nowMs: now });
    assert.equal(result.deletedRuns, 2);
    assert.ok(result.reclaimedBytes >= 11);
    assert.equal(await fs.stat(oldDir).then(() => true).catch(() => false), false);
    assert.equal(await fs.stat(orphanDir).then(() => true).catch(() => false), false);
    assert.equal(await fs.stat(recentDir).then(() => true).catch(() => false), true);
    assert.equal(await fs.stat(activeDir).then(() => true).catch(() => false), true);
    assert.equal(isDebugCleanupDue(new Date(now - 60 * 60 * 1000).toISOString(), now), false);
    assert.equal(isDebugCleanupDue(new Date(now - 25 * 60 * 60 * 1000).toISOString(), now), true);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("V1.0.13 僅失敗任務模式可精準刪除單一成功 run 的 Debug 路徑", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "automation-studio-debug-single-"));
  const debugRoot = path.join(temporary, "debug");
  const first = path.join(debugRoot, "project", "run-first");
  const second = path.join(debugRoot, "project", "run-second");
  try {
    await fs.mkdir(first, { recursive: true });
    await fs.mkdir(second, { recursive: true });
    await fs.writeFile(path.join(first, "events.jsonl"), "first", "utf8");
    await fs.writeFile(path.join(second, "events.jsonl"), "second", "utf8");
    const result = await removeRunDebugDirectory(debugRoot, first);
    assert.equal(result.deleted, true);
    assert.equal(await fs.stat(first).then(() => true).catch(() => false), false);
    assert.equal(await fs.stat(second).then(() => true).catch(() => false), true);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("V1.0.13 系統設定顯示 Debug 清理狀態並提供立即清理功能", async () => {
  const html = await fs.readFile(path.resolve("public/index.html"), "utf8");
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  const router = await fs.readFile(path.resolve("src/studio/router.ts"), "utf8");
  const executor = await fs.readFile(path.resolve("src/studio/executor.ts"), "utf8");
  assert.match(html, /id="cleanupExpiredDebugButton"/);
  assert.match(html, /真正掃描最多 24 小時一次/);
  assert.match(app, /cleanupExpiredDebugNow/);
  assert.match(app, /debugCleanupStatus/);
  assert.match(app, /refreshDebugCleanupStatus/);
  assert.match(router, /\/settings\/debug-cleanup/);
  assert.match(router, /maybeCleanupExpiredDebug\("startup"\)/);
  assert.match(executor, /cleanupCompletedRunDebug\(run\)/);
  assert.match(executor, /maybeCleanupExpiredDebug\("run-finished"\)/);
});


test("V1.0.13 Debug 到期清理使用 single-flight，並行觸發只執行一次掃描", async () => {
  const store = new StudioStore() as any;
  let cleanupCalls = 0;
  store.getDebugCleanupStatus = async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { deletedRuns:0, reclaimedBytes:0, running:true };
  };
  store.performDebugCleanup = async () => {
    cleanupCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { deletedRuns:0, reclaimedBytes:0, running:false, lastCompletedAt:new Date().toISOString() };
  };
  const [a,b,c] = await Promise.all([
    store.maybeCleanupExpiredDebug("run-finished"),
    store.maybeCleanupExpiredDebug("run-finished"),
    store.maybeCleanupExpiredDebug("run-finished")
  ]);
  assert.equal(cleanupCalls, 1);
  assert.equal(a.lastCompletedAt, b.lastCompletedAt);
  assert.equal(b.lastCompletedAt, c.lastCompletedAt);
});


test("V1.1.0 移除 Edge 選項並把舊 msedge 專案遷移到隨附 Chromium", async () => {
  const legacy = createDefaultProject({
    name: "舊 Edge 專案",
    targetUrl: "http://cbc-km:8081/SmartKMS/cbc/bbs/Home.action",
    browser: {
      connectionMode: "managed",
      channel: "msedge",
      headless: false,
      slowMoMs: 100,
      defaultTimeoutMs: 30_000,
      downloadTimeoutMs: 60_000,
      viewportWidth: 1440,
      viewportHeight: 900,
      reuseProfile: true,
      downloadPdfInsteadOfPreview: false,
      cdpEndpoint: "http://127.0.0.1:9222",
      cdpAutoLaunch: true,
      cdpInitialPageMode: "first",
      cdpInitialPageTarget: "",
      cdpInitialPageIndex: 1
    } as any
  });
  assert.equal(legacy.browser.channel, "bundled");
  const html = await fs.readFile(path.resolve("public/index.html"), "utf8");
  const adapter = await fs.readFile(path.resolve("src/adapters/chromiumExecutable.ts"), "utf8");
  assert.doesNotMatch(html, /option value="msedge"/);
  assert.doesNotMatch(adapter, /msedge\.exe/);
  assert.match(html, /Microsoft Edge 選項已移除/);
});

test("V1.1.0 錄製器立即記錄舊式網站 click，dblclick 會合併前兩筆 click", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "automation-studio-recorder-v110-"));
  const executable = path.join(temporary, "chrome.exe");
  await fs.writeFile(executable, "test-browser");
  const previous = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = executable;
  let recordBinding: ((source: unknown, event: any) => void) | undefined;
  const page = { isClosed: () => false, bringToFront: async () => undefined, goto: async () => undefined, url: () => "http://cbc-km:8081/SmartKMS/cbc/bbs/Home.action" };
  const context = {
    pages: () => [page], newPage: async () => page,
    exposeBinding: async (name: string, callback: (source: unknown, event: any) => void) => { if (name === "__automationStudioRecord") recordBinding = callback; },
    addInitScript: async () => undefined, on: () => undefined, once: () => undefined, close: async () => undefined
  };
  const manager = new RecorderManager(async () => ({ chromium: { executablePath: () => executable, launchPersistentContext: async () => context } }) as never);
  try {
    const project = createDefaultProject({ id: "smartkms-recorder", targetUrl: "http://cbc-km:8081/SmartKMS/cbc/bbs/Home.action" });
    await manager.start(project);
    manager.clear(project.id);
    const raw = { label: "最新消息", url: page.url(), selector: [{ strategy: "css", value: "td.x-grid3-cell-inner:visible" }] };
    recordBinding?.({}, { type: "click", ...raw });
    assert.equal(manager.status(project.id).events.length, 1, "單擊必須立即抵達後端，不等待 browser timer");
    recordBinding?.({}, { type: "click", ...raw });
    recordBinding?.({}, { type: "dblclick", ...raw });
    assert.equal(manager.status(project.id).events.length, 1);
    assert.equal(manager.status(project.id).events[0]?.type, "dblclick");
    const recorderSource = await fs.readFile(path.resolve("src/studio/recorder.ts"), "utf8");
    assert.doesNotMatch(recorderSource, /pendingClickTimer|setTimeout\(\(\) => \{\s*if \(pendingClickEvent\)/s);
    assert.match(recorderSource, /x-grid\|x-tree\|x-menu/);
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    else process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = previous;
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("V1.1.1 frame-aware recorder 會在子 Frame 重新載入後自動補裝並保存 Frame 路徑", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "automation-studio-frame-aware-recorder-"));
  const executable = path.join(temporary, "chrome.exe");
  await fs.writeFile(executable, "test-browser");
  const previous = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = executable;
  let recordBinding: ((source: unknown, event: any) => void) | undefined;
  const pageHandlers = new Map<string, (...args: any[]) => void>();
  const mainFrame: any = {
    marker: false,
    installs: 0,
    url: () => "http://cbc-km:8081/SmartKMS/cbc/bbs/Home.action",
    name: () => "",
    parentFrame: () => null,
    isDetached: () => false,
    evaluate: async (fn: Function, arg?: unknown) => {
      if (arg === "1.2.2-recorder-keyboard-upload-assertion") return mainFrame.marker;
      mainFrame.marker = true;
      mainFrame.installs += 1;
      return undefined;
    }
  };
  const childFrame: any = {
    marker: false,
    installs: 0,
    url: () => "http://cbc-km:8081/SmartKMS/cbc/bbs/CategoryDocListEmbedded.action?cat=1",
    name: () => "docList",
    parentFrame: () => mainFrame,
    isDetached: () => false,
    evaluate: async (fn: Function, arg?: unknown) => {
      if (arg === "1.2.2-recorder-keyboard-upload-assertion") return childFrame.marker;
      childFrame.marker = true;
      childFrame.installs += 1;
      return undefined;
    }
  };
  let currentUrl = "about:blank";
  const page: any = {
    isClosed: () => false,
    bringToFront: async () => undefined,
    goto: async (url: string) => { currentUrl = url; },
    url: () => currentUrl,
    frames: () => [mainFrame, childFrame],
    mainFrame: () => mainFrame,
    on: (event: string, callback: (...args: any[]) => void) => pageHandlers.set(event, callback)
  };
  const context: any = {
    pages: () => [page],
    newPage: async () => page,
    exposeBinding: async (name: string, callback: (source: unknown, event: any) => void) => { if (name === "__automationStudioRecord") recordBinding = callback; },
    addInitScript: async () => undefined,
    on: () => undefined,
    once: () => undefined,
    close: async () => undefined
  };
  const manager = new RecorderManager(async () => ({ chromium: { executablePath: () => executable, launchPersistentContext: async () => context } }) as never);
  try {
    const project = createDefaultProject({ id: "smartkms-frame-aware", targetUrl: "http://cbc-km:8081/SmartKMS/cbc/bbs/Home.action" });
    await manager.start(project);
    assert.ok(mainFrame.installs >= 1);
    assert.ok(childFrame.installs >= 1);

    manager.clear(project.id);
    recordBinding?.({ frame: childFrame }, {
      type: "click",
      label: "公告標題",
      url: childFrame.url(),
      selector: [{ strategy: "text", value: "公告標題", exact: true }]
    });
    const recorded = manager.status(project.id).events[0];
    assert.equal(recorded.frameUrl, childFrame.url());
    assert.equal(recorded.framePath?.length, 2);
    assert.match(recorded.framePath?.[1] ?? "", /docList/);

    const before = childFrame.installs;
    childFrame.marker = false; // simulate document.open/write or legacy frame document replacement
    pageHandlers.get("framenavigated")?.(childFrame);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(childFrame.installs > before, "frame navigation should repair recorder listeners immediately");
    const health = manager.status(project.id).frameHealth;
    assert.ok((health?.repairedFrames ?? 0) >= 1);
  } finally {
    await manager.stop("smartkms-frame-aware").catch(() => undefined);
    if (previous === undefined) delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    else process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = previous;
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("V1.1.1 錄製自 Frame 的步驟會保留 frame 規則並啟用跨 Frame fallback", () => {
  const [step] = recordedEventsToSteps([{
    id: "record-frame-click",
    createdAt: new Date().toISOString(),
    type: "click",
    label: "公告標題",
    url: "http://cbc-km:8081/SmartKMS/cbc/bbs/CategoryDocListEmbedded.action?cat=1",
    frameUrl: "http://cbc-km:8081/SmartKMS/cbc/bbs/CategoryDocListEmbedded.action?cat=1",
    framePath: [
      "http://cbc-km:8081/SmartKMS/cbc/bbs/Home.action",
      "docList :: http://cbc-km:8081/SmartKMS/cbc/bbs/CategoryDocListEmbedded.action?cat=1"
    ],
    selector: [{ strategy: "text", value: "公告標題", exact: true }]
  }]);
  assert.deepEqual(step.frame, { urlIncludes: "/SmartKMS/cbc/bbs/CategoryDocListEmbedded.action" });
  assert.equal(step.autoFrameSearch, true);
});

test("V1.1.1 失敗診斷會彙整主頁與所有 Frame 文字及階層", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "automation-studio-frame-diagnostics-"));
  const makeFrame = (url: string, text: string, parent: any = null, name = "") => ({
    url: () => url,
    name: () => name,
    parentFrame: () => parent,
    evaluate: async (_fn: Function, arg: any) => {
      if (arg && typeof arg === "object" && "maxBodyText" in arg) {
        return { url, title: name || "主頁", bodyText: text, elements: [] };
      }
      return undefined;
    }
  });
  const main: any = makeFrame("http://cbc-km:8081/SmartKMS/cbc/bbs/Home.action", "", null, "");
  const child: any = makeFrame("http://cbc-km:8081/SmartKMS/cbc/bbs/FormDocList.action", "文件清單內容", main, "formList");
  const nested: any = makeFrame("http://cbc-km:8081/SmartKMS/cbc/bbs/CategoryDocListEmbedded.action", "公告標題與資料內容", child, "docList");
  const page: any = {
    frames: () => [main, child, nested],
    url: () => main.url(),
    title: async () => "SmartKMS",
    screenshot: async () => undefined
  };
  try {
    await captureFailureDiagnostics(temporary, page);
    const summary = JSON.parse(await fs.readFile(path.join(temporary, "page-summary.json"), "utf8"));
    const text = await fs.readFile(path.join(temporary, "page-text.txt"), "utf8");
    assert.equal(summary.frames.length, 3);
    assert.equal(summary.frames[2].parentIndex, 1);
    assert.equal(summary.frames[2].path.length, 3);
    assert.match(text, /文件清單內容/);
    assert.match(text, /公告標題與資料內容/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});


test("V1.1.2 Recorder 在 Binding 未回傳時可由 Console / Frame Bridge 備援且跨通道去重", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "automation-studio-recorder-bridge-"));
  const executable = path.join(temporary, "chrome.exe");
  await fs.writeFile(executable, "test-browser");
  const previous = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = executable;
  const pageHandlers = new Map<string, (...args: any[]) => void>();
  let bridgeQueue: any[] = [];
  let marker = true;
  const mainFrame: any = {
    url: () => "http://cbc-km:8081/SmartKMS/cbc/bbs/Home.action",
    name: () => "",
    parentFrame: () => null,
    isDetached: () => false,
    evaluate: async (fn: Function, arg?: unknown) => {
      if (arg === "1.1.5-recorder-state-retention") return marker;
      const source = String(fn);
      if (source.includes("typeof window.__automationStudioRecord") || source.includes("typeof (window as any).__automationStudioRecord")) return false;
      if (source.includes("__automationStudioRecorderBridgeQueue")) {
        const current = bridgeQueue;
        bridgeQueue = [];
        return current;
      }
      marker = true;
      return undefined;
    }
  };
  let currentUrl = "about:blank";
  const page: any = {
    isClosed: () => false,
    bringToFront: async () => undefined,
    goto: async (url: string) => { currentUrl = url; },
    url: () => currentUrl,
    frames: () => [mainFrame],
    mainFrame: () => mainFrame,
    on: (event: string, callback: (...args: any[]) => void) => pageHandlers.set(event, callback)
  };
  const context: any = {
    pages: () => [page], newPage: async () => page,
    exposeBinding: async () => undefined,
    addInitScript: async () => undefined,
    on: () => undefined, once: () => undefined, close: async () => undefined
  };
  const manager = new RecorderManager(async () => ({ chromium: { executablePath: () => executable, launchPersistentContext: async () => context } }) as never);
  try {
    const project = createDefaultProject({ id: "smartkms-transport-bridge", targetUrl: "http://cbc-km:8081/SmartKMS/cbc/bbs/Home.action" });
    await manager.start(project);
    manager.clear(project.id);
    const payload = {
      transportId: "event-smartkms-1",
      type: "click",
      label: "公告標題",
      url: "http://cbc-km:8081/SmartKMS/cbc/bbs/CategoryDocListEmbedded.action?cat=1",
      frameUrl: "http://cbc-km:8081/SmartKMS/cbc/bbs/CategoryDocListEmbedded.action?cat=1",
      framePath: ["http://cbc-km:8081/SmartKMS/cbc/bbs/Home.action", "DocContent :: http://cbc-km:8081/SmartKMS/cbc/bbs/CategoryDocListEmbedded.action?cat=1"],
      selector: [{ strategy: "name", value: "docLink" }, { strategy: "text", value: "公告標題", exact: true }]
    };
    pageHandlers.get("console")?.({ text: () => `__AUTOMATION_STUDIO_RECORDER_BRIDGE__${JSON.stringify({ kind: "event", payload })}` });
    assert.equal(manager.status(project.id).events.length, 1, "binding 失效時 console beacon 仍應收回事件");
    assert.equal(manager.status(project.id).transportHealth?.lastTransport, "console");
    bridgeQueue = [{ kind: "event", payload }];
    await (manager as any).drainRecorderBridge(project.id);
    assert.equal(manager.status(project.id).events.length, 1, "相同 transportId 從 bridge 再抵達時不得重複建立事件");
    assert.ok((manager.status(project.id).transportHealth?.duplicates ?? 0) >= 1);
    assert.equal(manager.status(project.id).frameHealth?.bindingFrames, 0);
    const source = await fs.readFile(path.resolve("src/studio/recorder.ts"), "utf8");
    assert.match(source, /document\.addEventListener\("pointerdown"/);
    assert.match(source, /__automationStudioRecorderBridgeQueue/);
    assert.match(source, /RECORDER_CONSOLE_PREFIX/);
  } finally {
    await manager.stop("smartkms-transport-bridge").catch(() => undefined);
    if (previous === undefined) delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    else process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = previous;
    await fs.rm(temporary, { recursive: true, force: true });
  }
});


test("V1.1.3 Recorder long-poll 會在事件抵達後立即喚醒，不依賴背景頁籤 timer", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "automation-studio-recorder-watch-"));
  const executable = path.join(temporary, "chrome.exe");
  await fs.writeFile(executable, "test-browser");
  const previous = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = executable;
  let recordBinding: ((source: unknown, event: any) => void) | undefined;
  let currentUrl = "about:blank";
  const page: any = {
    isClosed: () => false,
    bringToFront: async () => undefined,
    goto: async (url: string) => { currentUrl = url; },
    url: () => currentUrl,
    on: () => undefined
  };
  const context: any = {
    pages: () => [page],
    newPage: async () => page,
    exposeBinding: async (name: string, callback: (source: unknown, event: any) => void) => { if (name === "__automationStudioRecord") recordBinding = callback; },
    addInitScript: async () => undefined,
    on: () => undefined,
    once: () => undefined,
    close: async () => undefined
  };
  const manager = new RecorderManager(async () => ({ chromium: { executablePath: () => executable, launchPersistentContext: async () => context } }) as never);
  try {
    const project = createDefaultProject({ id: "recorder-watch-test", targetUrl: "http://cbc-km:8081/SmartKMS/cbc/bbs/Home.action" });
    await manager.start(project);
    manager.clear(project.id);
    const revision = manager.status(project.id).revision;
    const waiting = manager.waitForStatus(project.id, revision, 5_000);
    setTimeout(() => recordBinding?.({}, {
      type: "click",
      label: "公告標題",
      url: currentUrl,
      selector: [{ strategy: "name", value: "docLink" }]
    }), 10);
    const updated = await waiting;
    assert.ok(updated.revision > revision);
    assert.equal(updated.events.length, 1);
    assert.equal(updated.events[0]?.label, "公告標題");
    const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
    assert.match(app, /\/recorder\/watch\?after=/);
    assert.doesNotMatch(app, /setInterval\(\(\) => void pollRecorder\(\), 1500\)/);
  } finally {
    await manager.stop("recorder-watch-test").catch(() => undefined);
    if (previous === undefined) delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    else process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = previous;
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("V1.1.3 錄製 selector 即使是單一物件或 JSON 字串也能加入流程", () => {
  const base = {
    id: "record-smartkms-selector",
    createdAt: new Date().toISOString(),
    type: "click" as const,
    label: "公告標題",
    url: "http://cbc-km:8081/SmartKMS/cbc/bbs/CategoryDocListEmbedded.action"
  };
  const [objectStep] = recordedEventsToSteps([{ ...base, selector: { strategy: "name", value: "docLink" } } as any]);
  const [stringStep] = recordedEventsToSteps([{ ...base, id: "record-smartkms-selector-json", selector: JSON.stringify({ strategy: "text", value: "公告標題", exact: true }) } as any]);
  assert.deepEqual(objectStep.selectors, [{ strategy: "name", value: "docLink" }]);
  assert.deepEqual(stringStep.selectors, [{ strategy: "text", value: "公告標題", exact: true }]);
});


test("V1.1.4 錄製工作站使用 SSE 即時串流並在視窗恢復時強制同步", async () => {
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  const router = await fs.readFile(path.resolve("src/studio/router.ts"), "utf8");
  assert.match(app, /new EventSource\(`\/api\/studio\/projects\/\$\{encodeURIComponent\(projectId\)\}\/recorder\/stream/);
  assert.match(app, /window\.addEventListener\("focus", syncRecorderWhenVisible\)/);
  assert.match(app, /document\.addEventListener\("visibilitychange", syncRecorderWhenVisible\)/);
  assert.match(router, /text\/event-stream/);
  assert.match(router, /streamRecorderStatus/);
});

test("V1.1.4 空 selector 會由公告文字與目標網址重建，並使用最深層 Frame 路徑", () => {
  const title = "【身心健康講座－第150期】10月6日（二）中午邀請營養師主講，歡迎同仁踴躍參加!";
  const [step] = recordedEventsToSteps([{
    id: "record-smartkms-empty-selector",
    createdAt: new Date().toISOString(),
    type: "click",
    label: title,
    url: "http://cbc-km:8081/SmartKMS/cbc/bbs/CategoryDocListEmbedded.action?categoryId=62&fromBBS=1",
    targetUrl: "http://cbc-km:8081/SmartKMS/do/cbc/bbs/readDocEmbedded?binderId=12345",
    frameUrl: "http://cbc-km:8081/SmartKMS/cbc/bbs/doc/FormDocList.action?formTypeId=12&fromBBS=1",
    framePath: [
      "http://cbc-km:8081/SmartKMS/cbc/bbs/Home.action",
      "mainFrame :: http://cbc-km:8081/SmartKMS/cbc/bbs/doc/FormDocList.action?formTypeId=12&fromBBS=1",
      "DocContent :: http://cbc-km:8081/SmartKMS/cbc/bbs/CategoryDocListEmbedded.action?categoryId=62&fromBBS=1"
    ],
    selector: []
  }]);
  assert.ok((step.selectors?.length ?? 0) >= 1);
  assert.equal(step.selectors?.[0]?.strategy, "text");
  assert.equal(step.selectors?.[0]?.value, title);
  assert.deepEqual(step.frame, { urlIncludes: "/SmartKMS/cbc/bbs/CategoryDocListEmbedded.action" });
  assert.equal(step.autoFrameSearch, true);
});

test("V1.1.4 Recorder 優先採用事件自身 Frame，並可由 selectorBackup 還原定位", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "automation-studio-recorder-recover-"));
  const executable = path.join(temporary, "chrome.exe");
  await fs.writeFile(executable, "test-browser");
  const previous = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = executable;
  let recordBinding: ((source: unknown, event: any) => void) | undefined;
  let currentUrl = "about:blank";
  const parentFrame: any = {
    url: () => "http://cbc-km:8081/SmartKMS/cbc/bbs/doc/FormDocList.action?formTypeId=12&fromBBS=1",
    name: () => "mainFrame",
    parentFrame: () => null,
    isDetached: () => false,
    evaluate: async () => true
  };
  const page: any = {
    isClosed: () => false,
    bringToFront: async () => undefined,
    goto: async (url: string) => { currentUrl = url; },
    url: () => currentUrl,
    frames: () => [parentFrame],
    mainFrame: () => parentFrame,
    on: () => undefined
  };
  const context: any = {
    pages: () => [page],
    newPage: async () => page,
    exposeBinding: async (name: string, callback: (source: unknown, event: any) => void) => { if (name === "__automationStudioRecord") recordBinding = callback; },
    addInitScript: async () => undefined,
    on: () => undefined,
    once: () => undefined,
    close: async () => undefined
  };
  const manager = new RecorderManager(async () => ({ chromium: { executablePath: () => executable, launchPersistentContext: async () => context } }) as never);
  try {
    const project = createDefaultProject({ id: "smartkms-selector-recover", targetUrl: "http://cbc-km:8081/SmartKMS/cbc/bbs/Home.action" });
    await manager.start(project);
    manager.clear(project.id);
    recordBinding?.({ frame: parentFrame }, {
      type: "click",
      label: "公告標題",
      url: "http://cbc-km:8081/SmartKMS/cbc/bbs/CategoryDocListEmbedded.action?categoryId=62&fromBBS=1",
      targetUrl: "http://cbc-km:8081/SmartKMS/do/cbc/bbs/readDocEmbedded?binderId=12345",
      selector: [],
      selectorBackup: JSON.stringify([{ strategy: "name", value: "docLink" }, { strategy: "text", value: "公告標題", exact: true }]),
      elementMeta: { tag: "a", name: "docLink", text: "公告標題", href: "/SmartKMS/do/cbc/bbs/readDocEmbedded?binderId=12345" },
      frameUrl: "http://cbc-km:8081/SmartKMS/cbc/bbs/CategoryDocListEmbedded.action?categoryId=62&fromBBS=1",
      framePath: [
        "http://cbc-km:8081/SmartKMS/cbc/bbs/Home.action",
        "mainFrame :: http://cbc-km:8081/SmartKMS/cbc/bbs/doc/FormDocList.action?formTypeId=12&fromBBS=1",
        "DocContent :: http://cbc-km:8081/SmartKMS/cbc/bbs/CategoryDocListEmbedded.action?categoryId=62&fromBBS=1"
      ]
    });
    const event = manager.status(project.id).events[0];
    assert.equal(event.frameUrl, "http://cbc-km:8081/SmartKMS/cbc/bbs/CategoryDocListEmbedded.action?categoryId=62&fromBBS=1");
    assert.equal(event.framePath?.at(-1)?.startsWith("DocContent ::"), true);
    assert.deepEqual(event.selector.slice(0, 2), [{ strategy: "name", value: "docLink" }, { strategy: "text", value: "公告標題", exact: true }]);
  } finally {
    await manager.stop("smartkms-selector-recover").catch(() => undefined);
    if (previous === undefined) delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    else process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = previous;
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("V1.1.5 Recorder 前端同步失敗保留最後有效事件且拒絕舊 revision 覆蓋", async () => {
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  assert.match(app, /recorderSnapshot: null/);
  assert.match(app, /function applyRecorderStatus\(status, options = \{\}\)/);
  assert.match(app, /incomingStartedAt === currentStartedAt && incomingRevision < currentRevision/);
  assert.match(app, /function markRecorderSyncError/);
  assert.match(app, /async function pollRecorder\(options = \{\}\)[\s\S]*catch \{[\s\S]*markRecorderSyncError\(\)/);
  assert.match(app, /錄製即時串流暫時中斷，正在自動重新連線；既有錄製事件不會清除/);
  assert.match(app, /async function loadProject\(id\) \{\s*stopRecorderWatch\(\);\s*resetRecorderSnapshot\(false\);/);
  assert.match(app, /recorder\/clear[\s\S]*resetRecorderSnapshot\(false\);[\s\S]*pollRecorder\(\{ allowEmptyReset: true \}\)/);
});

test("V1.1.5 停止錄製後仍保留未加入流程事件，明確清除才移除", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "automation-studio-recorder-pending-"));
  const executable = path.join(temporary, "chrome.exe");
  await fs.writeFile(executable, "test-browser");
  const previous = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = executable;
  let recordBinding: ((source: unknown, event: any) => void) | undefined;
  let currentUrl = "about:blank";
  const page: any = {
    isClosed: () => false,
    bringToFront: async () => undefined,
    goto: async (url: string) => { currentUrl = url; },
    url: () => currentUrl,
    frames: () => [],
    on: () => undefined
  };
  const context: any = {
    pages: () => [page],
    newPage: async () => page,
    exposeBinding: async (name: string, callback: (source: unknown, event: any) => void) => { if (name === "__automationStudioRecord") recordBinding = callback; },
    addInitScript: async () => undefined,
    on: () => undefined,
    once: () => undefined,
    close: async () => undefined
  };
  const manager = new RecorderManager(async () => ({ chromium: { executablePath: () => executable, launchPersistentContext: async () => context } }) as never);
  try {
    const project = createDefaultProject({ id: "recorder-pending-after-stop", targetUrl: "http://cbc-km:8081/SmartKMS/cbc/bbs/Home.action" });
    await manager.start(project);
    manager.clear(project.id);
    recordBinding?.({}, {
      type: "click",
      label: "公告標題",
      url: currentUrl,
      selector: [{ strategy: "name", value: "docLink" }]
    });
    assert.equal(manager.status(project.id).events.length, 1);
    await manager.stop(project.id);
    const stopped = manager.status(project.id);
    assert.equal(stopped.active, false);
    assert.equal(stopped.events.length, 1);
    assert.equal(stopped.events[0]?.label, "公告標題");
    manager.clear(project.id);
    assert.equal(manager.status(project.id).events.length, 0);
  } finally {
    await manager.stop("recorder-pending-after-stop").catch(() => undefined);
    if (previous === undefined) delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    else process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = previous;
    await fs.rm(temporary, { recursive: true, force: true });
  }
});


test("V1.1.6 Recorder 前端安全正規化非陣列 framePath", async () => {
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  assert.match(app, /function recorderFramePathList\(value\)/);
  assert.match(app, /const diagnosticFramePath = recorderFramePathList\(item\?\.framePath\)/);
  assert.doesNotMatch(app, /item\.framePath\.join\(" → "\)/);
});

test("V1.1.6 Recorder 診斷事件會在後端正規化 framePath", async () => {
  const recorder = await fs.readFile(path.resolve("src/studio/recorder.ts"), "utf8");
  assert.match(recorder, /const rawFramePath = normalizeFramePath\(\(diagnosticRaw as any\)\.framePath\)/);
  assert.match(recorder, /const sourceFramePath = normalizeFramePath\(frameInfo\.framePath\)/);
  assert.match(recorder, /framePath: rawFramePath\.length \? rawFramePath : sourceFramePath/);
});


test("V1.1.6 Recorder 停止前診斷的字串 framePath 會正規化成陣列", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "automation-studio-recorder-framepath-"));
  const executable = path.join(temporary, "chrome.exe");
  await fs.writeFile(executable, "test-browser");
  const previous = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = executable;
  let diagnosticBinding: ((source: unknown, event: any) => void) | undefined;
  let currentUrl = "about:blank";
  const page: any = {
    isClosed: () => false,
    bringToFront: async () => undefined,
    goto: async (url: string) => { currentUrl = url; },
    url: () => currentUrl,
    frames: () => [],
    on: () => undefined
  };
  const context: any = {
    pages: () => [page],
    newPage: async () => page,
    exposeBinding: async (name: string, callback: (source: unknown, event: any) => void) => { if (name === "__automationStudioDiagnostic") diagnosticBinding = callback; },
    addInitScript: async () => undefined,
    on: () => undefined,
    once: () => undefined,
    close: async () => undefined
  };
  const manager = new RecorderManager(async () => ({ chromium: { executablePath: () => executable, launchPersistentContext: async () => context } }) as never);
  try {
    const project = createDefaultProject({ id: "framepath-normalize", targetUrl: "http://cbc-km:8081/SmartKMS/cbc/bbs/Home.action" });
    await manager.start(project);
    diagnosticBinding?.({}, {
      eventType: "click", tag: "a", result: "recorded", reason: "test",
      frameUrl: "http://cbc-km:8081/SmartKMS/cbc/bbs/CategoryDocListEmbedded.action",
      framePath: JSON.stringify(["Home.action", "DocContent :: CategoryDocListEmbedded.action"])
    });
    const active = manager.status(project.id);
    assert.deepEqual(active.lastDiagnostic?.framePath, ["Home.action", "DocContent :: CategoryDocListEmbedded.action"]);
    await manager.stop(project.id);
    const stopped = manager.status(project.id);
    assert.deepEqual(stopped.lastDiagnostic?.framePath, ["Home.action", "DocContent :: CategoryDocListEmbedded.action"]);
  } finally {
    await manager.stop("framepath-normalize").catch(() => undefined);
    if (previous === undefined) delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    else process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = previous;
    await fs.rm(temporary, { recursive: true, force: true });
  }
});


test("V1.2.0 執行紀錄到期掃描節流 24 小時並保護非終止狀態", () => {
  const nowMs = Date.parse("2026-10-01T00:00:00.000Z");
  assert.equal(isRunHistoryCleanupDue(new Date(nowMs - 23 * 60 * 60 * 1000).toISOString(), nowMs), false);
  assert.equal(isRunHistoryCleanupDue(new Date(nowMs - 24 * 60 * 60 * 1000).toISOString(), nowMs), true);
  assert.equal(nextRunHistoryCleanupEligibleAt(new Date(nowMs).toISOString()), "2026-10-02T00:00:00.000Z");
  const expired = new Date(nowMs - 40 * 24 * 60 * 60 * 1000).toISOString();
  const recent = new Date(nowMs - 3 * 24 * 60 * 60 * 1000).toISOString();
  const candidates = findExpiredRunHistory({
    nowMs,
    retentionDays: 30,
    runs: [
      { id: "completed-old", status: "completed", endedAt: expired, updatedAt: expired },
      { id: "failed-old", status: "failed", endedAt: expired, updatedAt: expired },
      { id: "cancelled-recent", status: "cancelled", endedAt: recent, updatedAt: recent },
      { id: "queued-old", status: "queued", startedAt: expired, updatedAt: expired },
      { id: "running-old", status: "running", startedAt: expired, updatedAt: expired },
      { id: "paused-old", status: "paused", startedAt: expired, updatedAt: expired }
    ] as any
  });
  assert.deepEqual(candidates.runIds, ["completed-old", "failed-old"]);
  assert.equal(candidates.protectedRuns, 3);
});


test("V1.2.0 執行紀錄用量會分開計算紀錄與 Debug，診斷清理後回報不可用", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "automation-studio-run-history-usage-"));
  const runsDir = path.join(temporary, "runs");
  const debugRoot = path.join(temporary, "debug");
  const runId = "run-history-usage-test";
  const debugDir = path.join(debugRoot, "project-a", runId);
  try {
    await fs.mkdir(runsDir, { recursive: true });
    await fs.mkdir(debugDir, { recursive: true });
    await fs.writeFile(path.join(runsDir, `${runId}.json`), "{}", "utf8");
    await fs.writeFile(path.join(debugDir, "events.jsonl"), "12345", "utf8");
    const run: any = { id: runId, status: "failed", debugDir, startedAt: "2026-09-30T00:00:00.000Z" };
    assert.equal(await hasRunDiagnosticData(run, debugRoot), true);
    assert.equal(await hasRunDiagnosticData({ ...run, status: "completed" }, debugRoot), false);
    const usage = await calculateRunHistoryUsage({ runsDir, debugRoot, runs: [run] });
    assert.equal(usage.runCount, 1);
    assert.equal(usage.statusCounts.failed, 1);
    assert.equal(usage.runRecordBytes, 2);
    assert.equal(usage.debugBytes, 5);
    assert.equal(usage.totalBytes, 7);
    await fs.rm(debugDir, { recursive: true, force: true });
    assert.equal(await hasRunDiagnosticData(run, debugRoot), false);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});


test("V1.2.0 刪除執行紀錄會一併移除 Debug，並保護執行中與人工等待紀錄", async () => {
  const store = new StudioStore();
  await store.initialize();
  const root = store.getRootDir();
  const runId = `run-history-delete-${process.pid}-${Date.now()}`;
  const protectedIds = [`${runId}-running`, `${runId}-paused`, `${runId}-queued`];
  const debugRoot = path.resolve("./debug");
  const createRun = (id: string, status: string): any => ({
    id, projectId: "run-history-test", projectName: "紀錄管理測試", status, mode: "full", parameters: {},
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...( ["completed", "failed", "cancelled"].includes(status) ? { endedAt: new Date().toISOString() } : {}),
    completedSteps: 0, totalSteps: 0, steps: [], downloads: [], variables: {},
    debugDir: path.join(debugRoot, "run-history-tests", id)
  });
  const testRuns = [createRun(runId, "completed"), ...protectedIds.map((id, index) => createRun(id, ["running", "paused", "queued"][index]))];
  try {
    for (const run of testRuns) {
      await fs.mkdir(run.debugDir, { recursive: true });
      await fs.writeFile(path.join(run.debugDir, "test-debug.txt"), "test-debug", "utf8");
      await store.saveRun(run);
    }
    const result = await store.deleteRuns([runId, ...protectedIds]);
    assert.equal(result.requestedRuns, 4);
    assert.equal(result.deletedRuns, 1);
    assert.equal(result.protectedRuns, 3);
    assert.ok(result.reclaimedBytes > 0);
    await assert.rejects(fs.stat(path.join(root, "runs", `${runId}.json`)), { code: "ENOENT" });
    await assert.rejects(fs.stat(testRuns[0].debugDir), { code: "ENOENT" });
    for (const id of protectedIds) await fs.access(path.join(root, "runs", `${id}.json`));
    const summary = await store.getRunHistoryUsage();
    assert.equal(summary.runCount >= 3, true);
  } finally {
    for (const run of testRuns) {
      await fs.rm(path.join(root, "runs", `${run.id}.json`), { force: true });
      await fs.rm(run.debugDir, { recursive: true, force: true });
    }
  }
});


test("V1.2.0 執行紀錄提供失敗診斷下載、批次管理與獨立保留設定", async () => {
  const html = await fs.readFile(path.resolve("public/index.html"), "utf8");
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  const router = await fs.readFile(path.resolve("src/studio/router.ts"), "utf8");
  const store = await fs.readFile(path.resolve("src/studio/store.ts"), "utf8");
  assert.match(html, /id="runHistoryRetentionDays"/);
  assert.match(html, /id="selectFilteredRunsButton"/);
  assert.match(html, /id="deleteSelectedRunsButton"/);
  assert.match(html, /id="deleteFilteredRunsButton"/);
  assert.match(html, /id="clearCompletedRunsButton"/);
  assert.match(app, /run\.status === "failed"\) actions\.push\(`\<button[^`]*data-run-action="diagnostics"/);
  assert.match(app, /function downloadRunDiagnosticBundle\(runId\)/);
  assert.match(router, /parts\[2\] === "diagnostics"/);
  assert.match(router, /DIAGNOSTICS_PURGED/);
  assert.match(store, /maybeCleanupExpiredRunHistory/);
  assert.match(store, /runHistoryRetentionDays:/);
});

test("V2.0.4 專業介面：無遮罩右側步驟設定面板、動作元件分類篩選與單行緊湊型頂部列", async () => {
  const dialog = await fs.readFile(path.resolve("frontend/src/components/ui/dialog.tsx"), "utf8");
  const designer = await fs.readFile(path.resolve("frontend/src/components/Designer.tsx"), "utf8");
  const main = await fs.readFile(path.resolve("frontend/src/main.tsx"), "utf8");
  const styles = await fs.readFile(path.resolve("frontend/src/styles.css"), "utf8");
  const html = await fs.readFile(path.resolve("public/index.html"), "utf8");
  assert.match(dialog, /modal=\{!sheet\}/);
  assert.match(dialog, /\{!sheet&&<DialogPrimitive\.Overlay className="ui-overlay"\/>\}/);
  assert.match(dialog, /onInteractOutside=\{e=>\{if\(sheet\)e\.preventDefault\(\);\}\}/);
  assert.match(designer, /designer-sheet-open/);
  assert.match(designer, /搜尋動作元件/);
  assert.match(main, /modern-palette-search/);
  assert.match(main, /篩選動作元件/);
  assert.match(html, /data-palette-group="nav"/);
  assert.match(html, /data-palette-group="interact"/);
  assert.match(html, /data-palette-group="extract"/);
  assert.match(html, /data-palette-group="wait"/);
  assert.match(html, /data-palette-group="flow"/);
  assert.match(styles, /html\.modern-active\.designer-sheet-open #designerView/);
});

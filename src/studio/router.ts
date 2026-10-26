import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { applyRecordedEvents, createEbasExample, createGenericExample } from "./examples.ts";
import { openStudioDownloadArtifact } from "./downloadArtifacts.ts";
import { ExportService } from "./exporter.ts";
import { WorkflowRunner, findWorkflowStepById, preflightWorkflowDomains, runtimeStatus, selectWorkflowRunSteps } from "./executor.ts";
import { RecorderManager } from "./recorder.ts";
import { clearBrowserProfile, getBrowserProfileStatus } from "./profile.ts";
import { inspectCdpEndpoint } from "./cdp.ts";
import {inspectCDPTabs, detectCDPAuthentication} from "./authBridge/auth-discovery.mjs";
import { createDefaultProject, createImportedProject, StudioStore } from "./store.ts";
import { AIService } from "./ai/service.ts";
import { DEFAULT_AI_SETTINGS } from "./ai/config.ts";
import { redactText } from "./ai/sanitize.ts";
import { buildFailureDiagnosticZip, readFailurePageSummary } from "./debugDiagnostics.ts";
import { hasRunDiagnosticData } from "./runHistoryRetention.ts";
import { buildAIDebugAnalysisRequest, createAIDebugAnalysis } from "./ai/debugAnalyzer.ts";
import { buildAIWorkflowRequest, buildAIWorkflowRevisionRequest, createAIWorkflowDraft, createAIWorkflowRevision } from "./ai/workflowGenerator.ts";
import type { AIWorkflowDraftProject, AIWorkflowConversationTurn } from "./ai/workflowGenerator.ts";
import { AIWebsiteExplorer } from "./ai/siteExplorer.ts";
import type { AISettings } from "./ai/types.ts";
import type { ExportSelection, WorkflowProject, WorkflowRun } from "./types.ts";

export type StudioRouter = (
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL
) => Promise<boolean>;

export async function createStudioRouter(): Promise<StudioRouter> {
  const store = new StudioStore();
  const recorder = new RecorderManager();
  const runner = new WorkflowRunner(store, (projectId) => recorder.acquireActiveSession(projectId));
  const exporter = new ExportService();
  const aiExplorer = new AIWebsiteExplorer(recorder);
  const aiService = new AIService(async () => {
    const settings = await store.getSettings();
    return (settings.ai ?? DEFAULT_AI_SETTINGS) as AISettings;
  });

  await store.initialize();
  if (!(await store.listProjects()).length) {
    await store.saveProject(createGenericExample());
    await store.saveProject(createEbasExample());
  }
  // Natural-event cleanup: startup only checks the 24-hour throttle first.
  void store.maybeCleanupExpiredDebug("startup").catch((error) => {
    console.warn(`[debug-retention] 啟動時到期清理失敗：${error instanceof Error ? error.message : String(error)}`);
  });
  void store.maybeCleanupExpiredRunHistory("startup").catch((error) => {
    console.warn(`[run-history-retention] 啟動時到期清理失敗：${error instanceof Error ? error.message : String(error)}`);
  });

  return async (request, response, url) => {
    if (!url.pathname.startsWith("/api/studio")) return false;

    try {
      const relativePath = url.pathname.slice("/api/studio".length) || "/";
      const parts = relativePath.split("/").filter(Boolean);

      if (request.method === "GET" && relativePath === "/health") {
        sendJson(response, 200, {
          ok: true,
          server: "automation-studio",
          version: "2.4.1",
          baseVersion: "0.2.7",
          runtime: await runtimeStatus(),
          platform: process.platform
        });
        return true;
      }

      if (request.method === "GET" && relativePath === "/dashboard") {
        const [projects, runs] = await Promise.all([store.listProjects(), store.listRuns()]);
        const completed = runs.filter((run) => run.status === "completed").length;
        sendJson(response, 200, {
          projectCount: projects.length,
          readyCount: projects.filter((project) => project.status === "ready").length,
          runCount: runs.length,
          successRate: runs.length ? Math.round((completed / runs.length) * 100) : 0,
          recentProjects: projects.slice(0, 5),
          recentRuns: runs.slice(0, 6)
        });
        return true;
      }

      if (request.method === "GET" && relativePath === "/projects") {
        sendJson(response, 200, { projects: await store.listProjects() });
        return true;
      }

      if (request.method === "POST" && relativePath === "/projects") {
        const body = await readJsonBody(request);
        const project = createDefaultProject(body as Partial<WorkflowProject>);
        sendJson(response, 201, { project: await store.saveProject(project) });
        return true;
      }

      if (request.method === "POST" && relativePath === "/projects/import") {
        const body = await readJsonBody(request);
        const raw = (body.project ?? body) as Partial<WorkflowProject>;
        const project = createImportedProject(raw);
        sendJson(response, 201, { project: await store.saveProject(project) });
        return true;
      }

      if (parts[0] === "projects" && parts[1]) {
        const projectId = decodeURIComponent(parts[1]);
        if (request.method === "GET" && parts.length === 2) {
          sendJson(response, 200, { project: await store.getProject(projectId) });
          return true;
        }
        if (request.method === "PUT" && parts.length === 2) {
          const body = await readJsonBody(request);
          const current = await store.getProject(projectId);
          sendJson(response, 200, { project: await store.saveProject({ ...current, ...body, id: projectId } as WorkflowProject) });
          return true;
        }
        if (request.method === "DELETE" && parts.length === 2) {
          await recorder.stop(projectId).catch(() => undefined);
          await clearBrowserProfile(projectId).catch(() => undefined);
          await runner.authSessions.revoke(await store.getProject(projectId));
          await store.deleteProject(projectId);
          sendJson(response, 200, { ok: true });
          return true;
        }
        if (parts[2] === "auth" && parts.length >= 4) {
          const remote = String(request.socket.remoteAddress || "").replace(/^::ffff:/, "");
          if (!["127.0.0.1", "::1"].includes(remote)) throw new Error("登入狀態管理僅允許由本機 Automation Studio 操作。");
          const project = await store.getProject(projectId);
          const action = parts[3];
          if (request.method === "GET" && action === "status") {
            sendJson(response, 200, {auth: await runner.authSessions.status(project)});
            return true;
          }
          if (request.method === "GET" && action === "tabs") {
            const playwright = await import("playwright");
            const result = await inspectCDPTabs({chromium: playwright.chromium, endpoint: project.browser.cdpEndpoint || "http://127.0.0.1:9222", allowedDomains: project.allowedDomains});
            sendJson(response, 200, result);
            return true;
          }
          if (request.method === "POST" && action === "detect") {
            const origin = request.headers.origin;
            const host = request.headers.host;
            if (origin && (!host || new URL(origin).host !== host)) throw new Error("登入辨識僅接受同來源的本機操作。");
            const body = await readJsonBody(request);
            const mode = body.mode === "pick" ? "pick" : "auto";
            const index = body.tabIndex === null || body.tabIndex === undefined ? undefined : Number(body.tabIndex);
            const playwright = await import("playwright");
            const detected = await detectCDPAuthentication({chromium: playwright.chromium, endpoint: project.browser.cdpEndpoint || "http://127.0.0.1:9222", allowedDomains: project.allowedDomains, mode, tabIndex: index});
            sendJson(response, 200, {detected});
            return true;
          }
          if (request.method === "POST" && ["capture", "unlock", "lock"].includes(action) || request.method === "DELETE" && action === "saved") {
            const origin = request.headers.origin;
            const host = request.headers.host;
            if (origin && (!host || new URL(origin).host !== host)) throw new Error("登入狀態管理僅接受同來源的使用者操作。");
            if (request.method === "DELETE") {
              await runner.authSessions.revoke(project);
              sendJson(response, 200, {auth: await runner.authSessions.status(project)});
              return true;
            }
            if (action === "lock") {
              runner.authSessions.lock(project.id);
              sendJson(response, 200, {auth: await runner.authSessions.status(project)});
              return true;
            }
            const body = await readJsonBody(request);
            const passphrase = typeof body.passphrase === "string" ? body.passphrase : "";
            if (passphrase.length < 16 || passphrase.length > 1024) throw new Error("登入狀態加密密語必須為 16 至 1024 字元。");
            if (action === "capture") {
              const result = await runner.authSessions.capture(project, passphrase);
              sendJson(response, 200, {auth: await runner.authSessions.status(project), result});
            } else {
              await runner.authSessions.unlock(project, passphrase);
              sendJson(response, 200, {auth: await runner.authSessions.status(project)});
            }
            return true;
          }
        }
        if (parts[2] === "cdp" && parts[3] === "test" && request.method === "POST") {
          const body = await readJsonBody(request);
          const project = await store.getProject(projectId);
          const browser = { ...project.browser, ...((body.browser && typeof body.browser === "object") ? body.browser : {}) };
          const playwright = await import("playwright");
          sendJson(response, 200, { cdp: await inspectCdpEndpoint(playwright, browser) });
          return true;
        }
        if (parts[2] === "profile") {
          if (request.method === "GET" && parts.length === 3) {
            const project = await store.getProject(projectId);
            sendJson(response, 200, { profile: await getBrowserProfileStatus(projectId, project.browser.reuseProfile) });
            return true;
          }
          if (request.method === "DELETE" && parts.length === 3) {
            await recorder.stop(projectId).catch(() => undefined);
            await clearBrowserProfile(projectId);
            const project = await store.getProject(projectId);
            sendJson(response, 200, { profile: await getBrowserProfileStatus(projectId, project.browser.reuseProfile) });
            return true;
          }
        }
        if (request.method === "POST" && parts[2] === "duplicate") {
          const current = await store.getProject(projectId);
          const duplicate = createDefaultProject({
            ...structuredClone(current),
            id: `${current.id}-copy-${Date.now().toString(36)}`,
            name: `${current.name} 複本`,
            status: "draft",
            lastRunAt: undefined,
            lastRunStatus: undefined
          });
          sendJson(response, 201, { project: await store.saveProject(duplicate) });
          return true;
        }
        if (request.method === "POST" && parts[2] === "runs") {
          const body = await readJsonBody(request);
          const project = await store.getProject(projectId);
          const parameters = objectValues(body.parameters);
          const stepId = body.stepId ? String(body.stepId) : undefined;
          const requestedMode = String(body.runMode ?? (stepId ? "single-step" : "full"));
          const runMode: WorkflowRun["mode"] = requestedMode === "from-step"
            ? "from-step"
            : requestedMode === "single-step"
              ? "single-step"
              : "full";
          if ((runMode === "single-step" || runMode === "from-step") && !stepId) throw new Error("請先在流程設計器選取步驟。");
          const selectedSteps = stepId ? selectWorkflowRunSteps(project.steps, stepId, runMode) : project.steps;
          if (stepId && !selectedSteps.length) throw new Error(`找不到選取步驟：${stepId}`);
          const preflight = preflightWorkflowDomains(project, parameters, selectedSteps);
          if (preflight.missingDomains.length) throw new Error(`執行前檢查失敗：請先加入允許網域 ${preflight.missingDomains.join(", ")}`);
          const run = await runner.start(project, parameters, {
            mode: runMode,
            stepId
          });
          sendJson(response, 202, { run });
          return true;
        }
        if (request.method === "POST" && parts[2] === "batch") {
          const body = await readJsonBody(request);
          const project = await store.getProject(projectId);
          const rows = Array.isArray(body.rows) ? body.rows : [];
          const parameterRows: Array<Record<string, string | boolean>> = [];
          for (const row of rows) {
            if (row && typeof row === "object" && (row as Record<string, unknown>).enabled !== false) {
              const parameters = objectValues((row as Record<string, unknown>).parameters);
              const preflight = preflightWorkflowDomains(project, parameters);
              if (preflight.missingDomains.length) throw new Error(`批次執行前檢查失敗：請先加入允許網域 ${preflight.missingDomains.join(", ")}`);
              parameterRows.push(parameters);
            }
          }
          const runs = await runner.startBatch(project, parameterRows);
          sendJson(response, 202, { runs, concurrency: runs[0]?.batchConcurrency ?? 1 });
          return true;
        }
        if (request.method === "POST" && parts[2] === "export") {
          const selection = await readJsonBody(request) as unknown as ExportSelection;
          const result = await exporter.create(await store.getProject(projectId), selection);
          const buffer = await fs.readFile(result.filePath);
          sendBuffer(response, 200, buffer, "application/zip", result.fileName);
          return true;
        }
        if (parts[2] === "recorder") {
          if (request.method === "POST" && parts[3] === "start") {
            sendJson(response, 200, await recorder.start(await store.getProject(projectId)));
            return true;
          }
          if (request.method === "POST" && parts[3] === "stop") {
            await recorder.stop(projectId);
            sendJson(response, 200, { ok: true });
            return true;
          }
          if (request.method === "POST" && parts[3] === "assertion") {
            const body = await readJsonBody(request);
            const mode = body.mode;
            if (mode != null && !["visible", "text", "value"].includes(String(mode))) throw new Error("不支援的驗證種類。");
            await recorder.setAssertionMode(projectId, mode as "visible" | "text" | "value" | undefined);
            sendJson(response, 200, { ok: true });
            return true;
          }
          if (request.method === "POST" && parts[3] === "focus") {
            sendJson(response, 200, await recorder.focus(projectId));
            return true;
          }
          if (request.method === "POST" && parts[3] === "clear") {
            recorder.clear(projectId);
            sendJson(response, 200, { ok: true });
            return true;
          }
          if (request.method === "GET" && parts[3] === "stream") {
            const afterRevision = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
            await streamRecorderStatus(
              request,
              response,
              recorder,
              projectId,
              Number.isFinite(afterRevision) ? afterRevision : 0
            );
            return true;
          }
          if (request.method === "GET" && parts[3] === "watch") {
            const afterRevision = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
            const timeoutMs = Number.parseInt(url.searchParams.get("timeout") ?? "25000", 10);
            sendJson(response, 200, await recorder.waitForStatus(
              projectId,
              Number.isFinite(afterRevision) ? afterRevision : 0,
              Number.isFinite(timeoutMs) ? timeoutMs : 25_000
            ));
            return true;
          }
          if (request.method === "GET" && parts.length === 3) {
            sendJson(response, 200, recorder.status(projectId));
            return true;
          }
          if (request.method === "POST" && parts[3] === "commit") {
            await recorder.flush(projectId);
            const project = await store.getProject(projectId);
            project.steps = applyRecordedEvents(project.steps, recorder.status(projectId).events);
            recorder.clear(projectId);
            sendJson(response, 200, { project: await store.saveProject(project) });
            return true;
          }
        }
      }

      if (request.method === "GET" && relativePath === "/runs") {
        sendJson(response, 200, { runs: await store.listRuns(url.searchParams.get("projectId") ?? undefined) });
        return true;
      }

      if (request.method === "GET" && relativePath === "/runs/summary") {
        const [summary, cleanupStatus] = await Promise.all([store.getRunHistoryUsage(), store.getRunHistoryCleanupStatus()]);
        sendJson(response, 200, { summary, cleanupStatus });
        return true;
      }

      if (request.method === "POST" && relativePath === "/runs/delete") {
        const body = await readJsonBody(request);
        const runIds = Array.isArray(body.runIds) ? body.runIds.map((id: unknown) => String(id)) : [];
        if (!runIds.length) throw new Error("請先選取要刪除的執行紀錄。");
        if (runIds.length > 1000) throw new Error("單次最多可刪除 1,000 筆執行紀錄。");
        const result = await store.deleteRuns(runIds);
        const summary = await store.getRunHistoryUsage();
        sendJson(response, 200, { result, summary });
        return true;
      }

      if (request.method === "POST" && relativePath === "/runs/clear-completed") {
        const completed = (await store.listRuns()).filter((run) => run.status === "completed");
        const result = await store.deleteRuns(completed.map((run) => run.id));
        const summary = await store.getRunHistoryUsage();
        sendJson(response, 200, { result, summary });
        return true;
      }

      if (parts[0] === "runs" && parts[1]) {
        const runId = decodeURIComponent(parts[1]);
        if (request.method === "DELETE" && parts.length === 2) {
          const result = await store.deleteRuns([runId]);
          sendJson(response, 200, { result, summary: await store.getRunHistoryUsage() });
          return true;
        }
        if (request.method === "GET" && parts.length === 2) {
          sendJson(response, 200, { run: await store.getRun(runId) });
          return true;
        }
        if (request.method === "GET" && parts[2] === "debug") {
          const run = await store.getRun(runId);
          sendJson(response, 200, { debug: await readRunDebug(run) });
          return true;
        }
        if (request.method === "POST" && parts[2] === "cancel") {
          sendJson(response, 200, { run: await runner.cancel(runId) });
          return true;
        }
        if (request.method === "POST" && parts[2] === "continue") {
          sendJson(response, 200, { run: await runner.continueManual(runId) });
          return true;
        }
        if (request.method === "POST" && parts[2] === "ai-analyze") {
          const run = await store.getRun(runId);
          if (run.status !== "failed") throw new Error("只有執行失敗的紀錄可以使用 AI Debug 分析。 ");
          const project = await store.getProject(run.projectId);
          const debug = await readRunDebug(run);
          const failedAttempt = [...(run.steps ?? [])].reverse().find((step) => step.status === "failed");
          const failedStepId = failedAttempt?.stepId ?? run.currentStepId;
          const failedStep = failedStepId ? findWorkflowStepById(project.steps, failedStepId) : undefined;
          const pageSummary = await readFailurePageSummary(run.debugDir);
          const input = { project, run, failedStep, events: debug.events, pageSummary };
          const aiResponse = await aiService.generate(buildAIDebugAnalysisRequest(input));
          sendJson(response, 200, { analysis: createAIDebugAnalysis(aiResponse, input) });
          return true;
        }
        if (request.method === "GET" && parts[2] === "diagnostics") {
          const run = await store.getRun(runId);
          if (run.status !== "failed") throw new Error("只有執行失敗的紀錄可以下載失敗診斷包。 ");
          if (!(await hasRunDiagnosticData(run, path.resolve("./debug")))) {
            sendJson(response, 410, { error: { code: "DIAGNOSTICS_PURGED", message: "診斷資料已清理，無法產生失敗診斷包。" } });
            return true;
          }
          const project = await store.getProject(run.projectId);
          const debug = await readRunDebug(run);
          const failedAttempt = [...(run.steps ?? [])].reverse().find((step) => step.status === "failed");
          const failedStepId = failedAttempt?.stepId ?? run.currentStepId;
          const failedStep = failedStepId ? findWorkflowStepById(project.steps, failedStepId) : undefined;
          const pageSummary = await readFailurePageSummary(run.debugDir);
          const bundle = await buildFailureDiagnosticZip({ project, run, failedStep, events: debug.events, pageSummary });
          sendBuffer(response, 200, bundle.buffer, "application/zip", bundle.fileName);
          return true;
        }
        if (request.method === "POST" && parts[2] === "downloads" && parts[3] && (parts[4] === "open-file" || parts[4] === "open-folder")) {
          const index = Number(parts[3]);
          const run = await store.getRun(runId);
          if (!Number.isSafeInteger(index) || index < 0 || index >= run.downloads.length) throw new Error("下載檔案索引無效。");
          const settings = await store.getSettings();
          const downloadRoot = path.resolve(String(settings.defaultDownloadDir ?? "./downloads").trim() || "./downloads");
          const artifact = await openStudioDownloadArtifact(run.downloads[index], parts[4] === "open-file" ? "file" : "folder", downloadRoot);
          if (artifact.normalizedFrom) {
            run.downloads[index] = artifact.filePath;
            for (const step of run.steps) if (step.downloadPath === artifact.normalizedFrom) step.downloadPath = artifact.filePath;
            await store.saveRun(run);
          }
          sendJson(response, 200, { ok: true, ...artifact });
          return true;
        }
      }

      if (request.method === "GET" && relativePath === "/settings") {
        const settings = await store.getSettings();
        const [debugCleanupStatus, runHistoryCleanupStatus] = await Promise.all([store.getDebugCleanupStatus(), store.getRunHistoryCleanupStatus()]);
        sendJson(response, 200, { settings: publicStudioSettings({ ...settings, debugCleanupStatus, runHistoryCleanupStatus }) });
        return true;
      }
      if (request.method === "PUT" && relativePath === "/settings") {
        const body = await readJsonBody(request);
        const settings = await store.saveSettings(body);
        const [debugCleanupStatus, runHistoryCleanupStatus] = await Promise.all([store.getDebugCleanupStatus(), store.getRunHistoryCleanupStatus()]);
        sendJson(response, 200, { settings: publicStudioSettings({ ...settings, debugCleanupStatus, runHistoryCleanupStatus }) });
        return true;
      }
      if (request.method === "POST" && relativePath === "/settings/debug-cleanup") {
        const result = await store.maybeCleanupExpiredDebug("manual", true);
        const settings = await store.getSettings();
        const [debugCleanupStatus, runHistoryCleanupStatus] = await Promise.all([store.getDebugCleanupStatus(), store.getRunHistoryCleanupStatus()]);
        sendJson(response, 200, { result, settings: publicStudioSettings({ ...settings, debugCleanupStatus, runHistoryCleanupStatus }) });
        return true;
      }
      if (request.method === "POST" && relativePath === "/settings/run-history-cleanup") {
        const result = await store.maybeCleanupExpiredRunHistory("manual", true);
        const settings = await store.getSettings();
        const [debugCleanupStatus, runHistoryCleanupStatus] = await Promise.all([store.getDebugCleanupStatus(), store.getRunHistoryCleanupStatus()]);
        sendJson(response, 200, { result, settings: publicStudioSettings({ ...settings, debugCleanupStatus, runHistoryCleanupStatus }) });
        return true;
      }
      if (request.method === "POST" && relativePath === "/ai/test") {
        sendJson(response, 200, { result: await aiService.testActiveConnection() });
        return true;
      }
      if (request.method === "POST" && relativePath === "/ai/providers/test") {
        const body = await readJsonBody(request);
        const providerId = String(body.providerId ?? "").trim();
        if (!providerId) throw new Error("請指定要測試的 AI Provider。 ");
        sendJson(response, 200, { result: await aiService.testProvider(providerId) });
        return true;
      }
      if (request.method === "POST" && relativePath === "/ai/providers/diagnose") {
        const body = await readJsonBody(request);
        const providerId = String(body.providerId ?? "").trim();
        if (!providerId) throw new Error("請指定要診斷的 AI Provider。 ");
        sendJson(response, 200, { result: await aiService.diagnoseProvider(providerId) });
        return true;
      }
      if (request.method === "POST" && relativePath === "/ai/generate") {
        const body = await readJsonBody(request);
        const messages = Array.isArray(body.messages) ? body.messages : [];
        if (!messages.length) throw new Error("AI 產生請求至少需要一則 message。 ");
        const result = await aiService.generate({
          messages: messages.map((message) => ({ role: message?.role === "system" || message?.role === "assistant" ? message.role : "user", content: String(message?.content ?? "") })),
          temperature: Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : undefined,
          maxTokens: Number.isFinite(Number(body.maxTokens)) ? Math.max(1, Math.trunc(Number(body.maxTokens))) : undefined,
          responseFormat: body.responseFormat === "json" ? "json" : "text",
          metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : undefined
        });
        sendJson(response, 200, { result: { providerId: result.providerId, providerKind: result.providerKind, model: result.model, text: result.text, usage: result.usage } });
        return true;
      }
      if (request.method === "POST" && relativePath === "/ai/workflows/exploration/start") {
        const body = await readJsonBody(request);
        const targetUrl = String(body.targetUrl ?? "").trim();
        if (!targetUrl) throw new Error("請先輸入要檢視的目標網址。 ");
        const browserProjectId = String(body.browserProjectId ?? "").trim();
        const browserProject = browserProjectId ? await store.getProject(browserProjectId) : undefined;
        sendJson(response, 200, { exploration: await aiExplorer.start(targetUrl, browserProject) });
        return true;
      }
      if (request.method === "POST" && relativePath === "/ai/workflows/exploration/explore") {
        const body = await readJsonBody(request);
        const sessionId = String(body.sessionId ?? "").trim();
        const instruction = String(body.instruction ?? "").trim();
        if (!sessionId) throw new Error("找不到 AI 網站檢視工作階段。 ");
        if (!instruction) throw new Error("請先輸入要自動化的需求描述。 ");
        let projectContext: WorkflowProject | undefined;
        if (body.includeCurrentProject === true) {
          const projectId = String(body.projectId ?? "").trim();
          if (projectId) projectContext = await store.getProject(projectId);
        }
        sendJson(response, 200, { exploration: await aiExplorer.explore(sessionId, instruction, aiService, projectContext) });
        return true;
      }
      if (request.method === "GET" && relativePath === "/ai/workflows/exploration/status") {
        const sessionId = String(url.searchParams.get("sessionId") ?? "").trim();
        if (!sessionId) throw new Error("找不到 AI 網站檢視工作階段。 ");
        sendJson(response, 200, { exploration: aiExplorer.get(sessionId) });
        return true;
      }

      if (request.method === "POST" && relativePath === "/ai/workflows/exploration/focus") {
        const body = await readJsonBody(request);
        sendJson(response, 200, { exploration: await aiExplorer.focus(String(body.sessionId ?? "").trim()) });
        return true;
      }
      if (request.method === "POST" && relativePath === "/ai/workflows/exploration/stop") {
        const body = await readJsonBody(request);
        await aiExplorer.stop(String(body.sessionId ?? "").trim());
        sendJson(response, 200, { ok: true });
        return true;
      }

      if (request.method === "POST" && relativePath === "/ai/workflows/draft") {
        const body = await readJsonBody(request);
        const instruction = String(body.instruction ?? "").trim();
        if (!instruction) throw new Error("請先輸入要自動化的需求描述。 ");
        if (instruction.length > 20000) throw new Error("需求描述過長，請控制在 20,000 字元內。 ");
        const targetUrl = String(body.targetUrl ?? "").trim();
        let currentProject: WorkflowProject | undefined;
        if (body.includeCurrentProject === true) {
          const projectId = String(body.projectId ?? "").trim();
          if (!projectId) throw new Error("參考目前專案時必須指定 projectId。 ");
          currentProject = await store.getProject(projectId);
        }
        const explorationSessionId = String(body.explorationSessionId ?? "").trim();
        const siteEvidence = explorationSessionId ? aiExplorer.get(explorationSessionId) : undefined;
        if (siteEvidence?.requiresManual) throw new Error(siteEvidence.manualReason || "AI 網站探索仍需要人工操作，請完成後再繼續。 ");
        const input = { instruction, targetUrl, currentProject, siteEvidence };
        const aiResponse = await aiService.generate(buildAIWorkflowRequest(input));
        sendJson(response, 200, createAIWorkflowDraft(aiResponse, input));
        return true;
      }

      if (request.method === "POST" && relativePath === "/ai/workflows/revise") {
        const body = await readJsonBody(request);
        const instruction = String(body.instruction ?? "").trim();
        if (!instruction) throw new Error("請先輸入要修改流程的內容。 ");
        if (instruction.length > 12000) throw new Error("單次修改描述過長，請控制在 12,000 字元內。 ");
        if (!body.currentDraft || typeof body.currentDraft !== "object" || Array.isArray(body.currentDraft)) throw new Error("缺少目前 AI 流程草稿。 ");
        const currentDraft = body.currentDraft as AIWorkflowDraftProject;
        if (!Array.isArray(currentDraft.steps) || !Array.isArray(currentDraft.parameters)) throw new Error("目前 AI 流程草稿格式不完整。 ");
        const targetUrl = String(body.targetUrl ?? currentDraft.targetUrl ?? "").trim();
        let currentProject: WorkflowProject | undefined;
        if (body.includeCurrentProject === true) {
          const projectId = String(body.projectId ?? "").trim();
          if (!projectId) throw new Error("參考目前專案時必須指定 projectId。 ");
          currentProject = await store.getProject(projectId);
        }
        const conversation: AIWorkflowConversationTurn[] = Array.isArray(body.conversation)
          ? body.conversation.slice(-16).flatMap((turn: any) => {
              if (!turn || typeof turn !== "object") return [];
              const role = turn.role === "assistant" ? "assistant" : "user";
              const content = String(turn.content ?? "").trim().slice(0, 4000);
              return content ? [{ role, content } as AIWorkflowConversationTurn] : [];
            })
          : [];
        const explorationSessionId = String(body.explorationSessionId ?? "").trim();
        const siteEvidence = explorationSessionId ? aiExplorer.get(explorationSessionId) : undefined;
        // A paused/manual exploration session must not block revisions that only change workflow
        // logic, labels, timing, conditions, parameters, or ordering. The revision model decides
        // whether this specific change needs fresh site exploration; if it does, the UI resumes
        // exploration and handles the manual checkpoint there.
        const input = { instruction, targetUrl, currentProject, currentDraft, siteEvidence, conversation };
        const aiResponse = await aiService.generate(buildAIWorkflowRevisionRequest(input));
        sendJson(response, 200, createAIWorkflowRevision(aiResponse, input));
        return true;
      }

      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "找不到 Automation Studio API。" } });
      return true;
    } catch (error) {
      const status = error instanceof SyntaxError ? 400 : /ENOENT/.test(String(error)) ? 404 : 500;
      sendJson(response, status, {
        error: {
          code: status === 404 ? "NOT_FOUND" : (typeof (error as {code?: unknown})?.code === "string" ? (error as {code: string}).code : "REQUEST_FAILED"),
          message: redactText(error instanceof Error ? error.message : String(error))
        }
      });
      return true;
    }
  };
}


function publicStudioSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const output = structuredClone(settings);
  if (!output.ai || typeof output.ai !== "object" || Array.isArray(output.ai)) return output;
  const ai = output.ai as Record<string, unknown>;
  if (!Array.isArray(ai.providers)) return output;
  ai.providers = ai.providers.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const provider = raw as Record<string, unknown>;
    const secret = provider.secret && typeof provider.secret === "object" && !Array.isArray(provider.secret) ? provider.secret as Record<string, unknown> : undefined;
    const source = String(secret?.source ?? "env");
    const envName = String(secret?.envName ?? "").trim();
    const inlineConfigured = source === "inline" && Boolean(String(secret?.value ?? "").trim());
    const envConfigured = source === "env" && Boolean(envName && process.env[envName]);
    if (secret && "value" in secret) delete secret.value;
    if ("extraHeaders" in provider) delete provider.extraHeaders;
    return { ...provider, credentialConfigured: inlineConfigured || envConfigured };
  });
  return output;
}

async function readRunDebug(run: WorkflowRun): Promise<{ events: Record<string, unknown>[]; variables: Record<string, string | boolean>; downloads: string[]; debugDir: string }> {
  const debugRoot = path.resolve("./debug");
  const debugDir = path.resolve(run.debugDir);
  if (debugDir !== debugRoot && !debugDir.startsWith(`${debugRoot}${path.sep}`)) {
    throw new Error("Debug 路徑超出允許範圍。");
  }
  let events: Record<string, unknown>[] = [];
  try {
    const raw = await fs.readFile(path.join(debugDir, "events.jsonl"), "utf8");
    events = raw.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try {
        const value = JSON.parse(line);
        return value && typeof value === "object" ? [value as Record<string, unknown>] : [];
      } catch {
        return [];
      }
    });
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { events, variables: run.variables ?? {}, downloads: run.downloads ?? [], debugDir };
}

async function streamRecorderStatus(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  recorder: RecorderManager,
  projectId: string,
  afterRevision: number
): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-cache, must-revalidate",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff"
  });
  response.flushHeaders?.();
  let closed = false;
  const markClosed = () => { closed = true; };
  request.on("close", markClosed);
  response.on("close", markClosed);
  let revision = Math.max(0, afterRevision);
  let status = recorder.status(projectId);
  const push = (value: unknown) => {
    if (!closed && !response.writableEnded) response.write(`data: ${JSON.stringify(value)}\n\n`);
  };
  push(status);
  revision = status.revision;
  while (!closed && status.active) {
    status = await recorder.waitForStatus(projectId, revision, 15_000);
    if (closed) break;
    if (status.revision !== revision) {
      revision = status.revision;
      push(status);
    } else if (!response.writableEnded) {
      response.write(`: keepalive ${Date.now()}\n\n`);
    }
  }
  if (!closed && !response.writableEnded) response.end();
}

function readJsonBody(request: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10_000_000) reject(new Error("請求內容超過 10 MB。"));
    });
    request.on("end", () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function objectValues(value: unknown): Record<string, string | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === "boolean" ? item : String(item ?? "")]));
}

function sendJson(response: http.ServerResponse, status: number, value: unknown): void {
  sendText(response, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function sendText(response: http.ServerResponse, status: number, text: string, type: string): void {
  response.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(text);
}

function sendBuffer(
  response: http.ServerResponse,
  status: number,
  buffer: Buffer,
  type: string,
  downloadName: string
): void {
  response.writeHead(status, {
    "content-type": type,
    "content-length": buffer.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`
  });
  response.end(buffer);
}

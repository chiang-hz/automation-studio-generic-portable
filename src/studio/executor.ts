import { prepareStudioChromium } from "./stealth.ts";
import fs from "node:fs/promises";
import { captureWebData, saveCollectedDocument } from "./webData.ts";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createId, StudioStore } from "./store.ts";
import { browserLaunchMessage, DESKTOP_VIEWPORT, resolveStudioBrowser } from "./browser.ts";
import { connectToCdpBrowser } from "./cdp.ts";
import { AuthSessionManager } from "./authSessions.ts";
import { isPotentialLoginUrl, isRequestedUrlAlreadyOpen, scoreExistingSiteTab } from "./authNavigation.ts";
import { ensureManagedAuthentication } from "./managedAuthRecovery.ts";
import { ensurePdfDownloadPreference, resolveProjectProfileDir, resolveBatchWorkerProfileDir } from "./profile.ts";
import { effectiveBatchConcurrency, MAX_BATCH_CONCURRENCY } from "./concurrency.ts";
import { captureFailureDiagnostics } from "./debugDiagnostics.ts";
import { buildPagePdfFilename } from "../domain/localTimestamp.ts";
import { buildNativePagePdfOptions } from "../domain/pagePdf.ts";
import { createPeriodicPageRefresher } from "./periodicRefresh.ts";
import type {
  ConditionRule,
  LocatorMatchMode,
  SelectorRule,
  StepRunResult,
  WorkflowProject,
  WorkflowRun,
  WorkflowStep
} from "./types.ts";
import type { ActiveRecorderBrowserSession } from "./recorder.ts";

type PlaywrightModule = typeof import("playwright");
const recentRateLimits = new WeakMap<object, { status: number; url: string; at: number }>();

export function findWorkflowStepById(steps: WorkflowStep[], stepId: string): WorkflowStep | undefined {
  for (const step of steps) {
    if (step.id === stepId) return step;
    for (const childList of [step.thenSteps ?? [], step.elseSteps ?? [], step.steps ?? []]) {
      const found = findWorkflowStepById(childList, stepId);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Build the executable remainder beginning exactly at a selected step.
 * For nested selections, ancestor condition/loop containers are intentionally not
 * re-run: execution continues with the selected step, its remaining siblings in
 * that branch/body, and then the steps following each ancestor container.
 */
export function workflowStepsFromStepId(steps: WorkflowStep[], stepId: string): WorkflowStep[] | undefined {
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step.id === stepId) return steps.slice(index);
    for (const childList of [step.thenSteps ?? [], step.elseSteps ?? [], step.steps ?? []]) {
      const nested = workflowStepsFromStepId(childList, stepId);
      if (nested) return [...nested, ...steps.slice(index + 1)];
    }
  }
  return undefined;
}

export function selectWorkflowRunSteps(
  steps: WorkflowStep[],
  stepId: string,
  mode: WorkflowRun["mode"]
): WorkflowStep[] {
  if (mode === "single-step") {
    const selected = findWorkflowStepById(steps, stepId);
    return selected ? [selected] : [];
  }
  if (mode === "from-step") return workflowStepsFromStepId(steps, stepId) ?? [];
  return steps;
}

export class WorkflowRunner {
  private readonly activeRuns = new Map<string, {
    cancelled: boolean;
    manualContinue: boolean;
    completedBatchManualSteps: Set<string>;
    reusableBatchManualSteps: Set<string>;
  }>();
  private readonly queue: Array<{
    project: WorkflowProject;
    run: WorkflowRun;
    steps: WorkflowStep[];
    batchSessionId?: string;
    batchSessionLast?: boolean;
    batchWorker?: number;
    concurrency: number;
  }> = [];
  private readonly runProjectIds = new Map<string, string>();
  private readonly activeResources = new Set<string>();
  private readonly resourceOwners = new Map<string, string>();
  private exclusiveRunActive = false;
  private readonly batchSessions = new Map<string, {
    browser?: any;
    context: any;
    page: any;
    externalBrowser: boolean;
    completedManualStepIds: Set<string>;
  }>();
  private activeCount = 0;
  readonly authSessions = new AuthSessionManager();
  private readonly store: StudioStore;
  private readonly acquireActiveSession?: (projectId: string) => ActiveRecorderBrowserSession | undefined;

  constructor(store: StudioStore, acquireActiveSession?: (projectId: string) => ActiveRecorderBrowserSession | undefined) {
    this.store = store;
    this.acquireActiveSession = acquireActiveSession;
  }

  async start(
    project: WorkflowProject,
    parameters: Record<string, string | boolean>,
    options: { mode?: WorkflowRun["mode"]; stepId?: string; batchSessionId?: string; batchSessionLast?: boolean; batchWorker?: number; batchConcurrency?: number } = {}
  ): Promise<WorkflowRun> {
    const runId = createId("run");
    const debugDir = path.resolve("./debug", project.id, runId);
    const runMode = options.mode ?? (options.stepId ? "single-step" : "full");
    const selectedSteps = options.stepId
      ? selectWorkflowRunSteps(project.steps, options.stepId, runMode)
      : project.steps;
    if (options.stepId && !selectedSteps.length) throw new Error(`找不到選取步驟：${options.stepId}`);
    const run: WorkflowRun = {
      id: runId,
      projectId: project.id,
      projectName: project.name,
      status: "queued",
      mode: runMode,
      ...(options.batchWorker ? { batchWorker: options.batchWorker } : {}),
      ...(runMode === "batch" ? { batchConcurrency: options.batchConcurrency ?? 1 } : {}),
      parameters: materializeParameters(project, parameters),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedSteps: 0,
      totalSteps: countEnabledSteps(selectedSteps),
      steps: [],
      downloads: [],
      variables: {},
      debugDir
    };
    await fs.mkdir(debugDir, { recursive: true });
    await this.store.saveRun(run);
    this.runProjectIds.set(runId, project.id);
    this.activeRuns.set(runId, {
      cancelled: false,
      manualContinue: false,
      completedBatchManualSteps: new Set<string>(),
      reusableBatchManualSteps: new Set<string>()
    });
    this.queue.push({ project, run, steps: selectedSteps, batchSessionId: options.batchSessionId, batchSessionLast: options.batchSessionLast, batchWorker: options.batchWorker, concurrency: options.batchWorker ? effectiveBatchConcurrency(project) : 1 });
    setImmediate(() => this.pumpQueue());
    return run;
  }

  async startBatch(project: WorkflowProject, parameterRows: Array<Record<string, string | boolean>>): Promise<WorkflowRun[]> {
    if (project.browser.authStateEnabled === true) this.authSessions.getForRun(project);
    const concurrency = Math.min(effectiveBatchConcurrency(project), Math.max(1, parameterRows.length));
    const batchSessionIds = Array.from({ length: concurrency }, () => createId("batch-session"));
    const runs: WorkflowRun[] = [];
    for (let index = 0; index < parameterRows.length; index += 1) {
      runs.push(await this.start(project, parameterRows[index], {
        mode: "batch",
        batchSessionId: batchSessionIds[index % concurrency],
        batchSessionLast: index + concurrency >= parameterRows.length,
        batchConcurrency: concurrency,
        ...(concurrency > 1 ? { batchWorker: index % concurrency + 1 } : {})
      }));
    }
    return runs;
  }

  async cancel(runId: string): Promise<WorkflowRun> {
    const signal = this.activeRuns.get(runId);
    if (signal) signal.cancelled = true;
    const run = await this.store.getRun(runId);
    if (["queued", "running", "paused"].includes(run.status)) {
      run.status = "cancelled";
      run.endedAt = new Date().toISOString();
      await this.store.saveRun(run);
    }
    return run;
  }


  async continueManual(runId: string): Promise<WorkflowRun> {
    const signal = this.activeRuns.get(runId);
    if (!signal) throw new Error("找不到可繼續的執行流程，可能已結束或尚未開始。");
    const run = await this.store.getRun(runId);
    if (run.status !== "paused") throw new Error("目前流程不是等待人工操作狀態。");
    signal.manualContinue = true;
    return run;
  }

  private pumpQueue(): void {
    while (this.activeCount < MAX_BATCH_CONCURRENCY && !this.exclusiveRunActive) {
      const index = this.queue.findIndex((job) => {
        if (job.concurrency === 1 && this.activeCount > 0) return false;
        const resource = this.jobResource(job.project, job.batchWorker);
        const owner = this.resourceOwners.get(resource);
        return !this.activeResources.has(resource) && (!owner || owner === (job.batchSessionId ?? job.run.id));
      });
      if (index < 0) return;
      const [job] = this.queue.splice(index, 1);
      const resource = this.jobResource(job.project, job.batchWorker);
      this.activeResources.add(resource);
      this.resourceOwners.set(resource, job.batchSessionId ?? job.run.id);
      this.activeCount += 1;
      if (job.concurrency === 1) this.exclusiveRunActive = true;
      void this.execute(job.project, job.run, job.steps, {
        batchSessionId: job.batchSessionId,
        batchSessionLast: job.batchSessionLast === true,
        batchWorker: job.batchWorker
      }).catch((error) => {
        console.error(`[workflow-run] ${job.run.id}: ${error instanceof Error ? error.message : String(error)}`);
      }).finally(() => {
        this.activeCount -= 1;
        if (job.concurrency === 1) this.exclusiveRunActive = false;
        this.activeResources.delete(resource);
        if (!job.batchSessionId || !this.batchSessions.has(job.batchSessionId)) this.resourceOwners.delete(resource);
        this.pumpQueue();
      });
    }
  }

  private jobResource(project: WorkflowProject, batchWorker?: number): string {
    if (project.browser.connectionMode === "cdp") return `cdp:${String(project.browser.cdpEndpoint).replace(/\/$/, "")}`;
    return batchWorker ? resolveBatchWorkerProfileDir(project.id, batchWorker) : resolveProjectProfileDir(project.id);
  }

  private async execute(
    project: WorkflowProject,
    run: WorkflowRun,
    steps: WorkflowStep[],
    options: { batchSessionId?: string; batchSessionLast?: boolean; batchWorker?: number } = {}
  ): Promise<void> {
    let browser: any;
    let context: any;
    let page: any;
    let borrowedSession: ActiveRecorderBrowserSession | undefined;
    let detachObservability: (() => void) | undefined;
    let externalBrowser = false;
    let reusedBatchSession = false;
    const variables: Record<string, string | boolean> = {};
    try {
      if (this.activeRuns.get(run.id)?.cancelled) {
        // A cancelled queued row may be the final owner of a preserved session.
        // Close it before releasing its profile lease.
        const cached = options.batchSessionId ? this.batchSessions.get(options.batchSessionId) : undefined;
        if (cached) ({ browser, context, page, externalBrowser } = cached);
        run.status = "cancelled";
        run.endedAt = new Date().toISOString();
        return;
      }
      const preflight = preflightWorkflowDomains(project, run.parameters, steps);
      if (preflight.missingDomains.length) {
        throw new Error(`執行前檢查失敗：下列網域尚未加入允許清單：${preflight.missingDomains.join(", ")}。請先到「網站與瀏覽器工作站 > 允許網域」加入後再執行。`);
      }
      run.status = "running";
      await this.store.saveRun(run);
      await appendEvent(run.debugDir, "run_started", { projectId: project.id, parameters: redactParameters(project, run.parameters), batchWorker: options.batchWorker, batchConcurrency: run.batchConcurrency });

      const useSavedAuth = project.browser.connectionMode === "managed" && project.browser.authStateEnabled === true;
      // Reuse the *same* already-authorized context for later rows on this worker.
      // A freshly cloned Storage State is NOT equivalent to a browser session on
      // sites with per-browser or human verification requirements.
      const cachedBatchSession = options.batchSessionId ? this.batchSessions.get(options.batchSessionId) : undefined;
      if (cachedBatchSession && cachedBatchSession.context && !(cachedBatchSession.context.isClosed?.() ?? false)) {
        browser = cachedBatchSession.browser;
        context = cachedBatchSession.context;
        page = getActivePage(context, cachedBatchSession.page);
        externalBrowser = cachedBatchSession.externalBrowser;
        reusedBatchSession = true;
        const signal = this.activeRuns.get(run.id);
        if (signal) signal.reusableBatchManualSteps = new Set(cachedBatchSession.completedManualStepIds);
        await page.bringToFront().catch(() => undefined);
        await appendEvent(run.debugDir, "browser_session_reused", {
          source: externalBrowser ? "cdp-batch" : "managed-batch",
          url: page.url(),
          reason: "reuse-batch-session"
        });
      } else {
        // Parallel workers own independent profiles and never borrow the recorder.
        borrowedSession = options.batchWorker || useSavedAuth ? undefined : this.acquireActiveSession?.(project.id);
      }
      if (!reusedBatchSession && borrowedSession) {
        const expectedStealth = project.browser.stealth === true && project.browser.connectionMode !== "cdp";
        if ((borrowedSession.stealth === true) !== expectedStealth) {
          throw new Error("Stealth 設定已變更，請先停止錄製並重新啟動錄製瀏覽器，再執行流程。");
        }
        context = borrowedSession.context;
        page = borrowedSession.page;
        await page.bringToFront().catch(() => undefined);
        await appendEvent(run.debugDir, "browser_session_reused", {
          source: borrowedSession.browserSource,
          url: page.url(),
          reason: "reuse-active-recorder-session"
        });
      } else if (!reusedBatchSession) {
        const playwright = await loadPlaywright();
        const chromium = await prepareStudioChromium(playwright, project.browser);
        if (project.browser.connectionMode === "cdp") {
          const attached = await connectToCdpBrowser(playwright, project.browser, project.targetUrl);
          browser = attached.browser;
          context = attached.context;
          page = attached.page;
          externalBrowser = true;
          if (/^https?:/i.test(page.url())) assertAllowedUrl(page.url(), project.allowedDomains);
          await appendEvent(run.debugDir, "browser_cdp_attached", {
            endpoint: attached.endpoint,
            url: page.url(),
            tabCount: attached.tabs.length
          });
        } else {
          const browserResolution = await resolveStudioBrowser(playwright, project.browser.channel);
          if (browserResolution.available === false) {
            throw new Error(browserLaunchMessage(project.browser.channel, browserResolution, new Error("runtime unavailable")));
          }
          const launchOptions = {
            headless: project.browser.headless,
            slowMo: project.settings.humanizedPlayback === true
              ? Math.max(project.browser.slowMoMs, 120)
              : project.browser.slowMoMs,
            ...(browserResolution.channel ? { channel: browserResolution.channel } : {}),
            ...(browserResolution.executablePath ? { executablePath: browserResolution.executablePath } : {})
          };
          if (project.browser.reuseProfile && !useSavedAuth) {
            const profileDir = options.batchWorker ? resolveBatchWorkerProfileDir(project.id, options.batchWorker) : resolveProjectProfileDir(project.id);
            await fs.mkdir(profileDir, { recursive: true });
            if (project.browser.downloadPdfInsteadOfPreview === true) {
              await ensurePdfDownloadPreference(profileDir);
              await appendEvent(run.debugDir, "browser_pdf_download_preference", { enabled: true, profileDir });
            }
            try {
              context = await chromium.launchPersistentContext(profileDir, {
                ...launchOptions,
                acceptDownloads: true,
                viewport: DESKTOP_VIEWPORT
              });
            } catch (error) {
              throw new Error(browserLaunchMessage(project.browser.channel, browserResolution, error), { cause: error });
            }
          } else {
            try {
              browser = await chromium.launch(launchOptions);
            } catch (error) {
              throw new Error(browserLaunchMessage(project.browser.channel, browserResolution, error), { cause: error });
            }
            context = await browser.newContext({
              acceptDownloads: true,
              viewport: DESKTOP_VIEWPORT,
              ...(useSavedAuth ? { storageState: structuredClone(this.authSessions.getForRun(project).storageState) } : {})
            });
          }
          page = context.pages()[0] ?? await context.newPage();
        }
      }
      // Verify BOTH newly-created managed contexts and preserved batch-worker
      // contexts. Never proceed to click the site's actions before authentication.
      if (useSavedAuth) {
        // A locked/expired vault cannot be repaired by interacting with the
        // webpage; request an explicit unlock instead of a futile challenge.
        this.authSessions.getForRun(project);
        const outcome = await ensureManagedAuthentication({
          headless: project.browser.headless,
          verify: () => this.authSessions.verify(page, project),
          pauseForHuman: async () => {
            run.status = "paused";
            run.errorMessage = "已載入保存的登入狀態，但網站要求重新登入或人工安全驗證。請在顯示的管理瀏覽器完成網站驗證，再按『人工操作完成，繼續執行』。此功能不會自動通過 Cloudflare。";
            await this.store.saveRun(run);
            await page.bringToFront().catch(() => undefined);
            const signal = this.activeRuns.get(run.id);
            if (signal) signal.manualContinue = false;
            try {
              await waitForManualAction(
                page, run.debugDir, {
                  id: "managed-auth-checkpoint", name: "管理瀏覽器登入驗證", kind: "manual", enabled: true,
                  manualCompletionMode: "button", timeoutMs: 600_000,
                  value: "請在此管理瀏覽器完成登入或 Cloudflare 人工驗證後，再返回執行監控按『人工操作完成，繼續執行』。"
                } as WorkflowStep,
                run.parameters, variables, false,
                () => this.activeRuns.get(run.id)?.manualContinue === true,
                () => this.activeRuns.get(run.id)?.cancelled === true
              );
            } finally {
              if (run.status === "paused") {
                run.status = "running";
                run.errorMessage = undefined;
                await this.store.saveRun(run);
              }
            }
          }
        });
        await appendEvent(run.debugDir, "managed_auth_verified", {result: outcome, runId: run.id, reusedBatchSession});
      }
      await appendEvent(run.debugDir, "browser_stealth", {
        requested: project.browser.stealth === true,
        enabled: project.browser.stealth === true && project.browser.connectionMode !== "cdp",
        reason: project.browser.connectionMode === "cdp" ? "CDP 不套用 Stealth" : "managed"
      });
      initializeTabState(context, page);
      page.setDefaultTimeout(project.browser.defaultTimeoutMs);
      detachObservability = attachObservability(context, page, run, project.settings.captureConsole, project.settings.captureNetwork);
      await this.executeSteps(project, run, context, page, steps, variables);

      if (run.status !== "cancelled") {
        run.status = "completed";
        run.endedAt = new Date().toISOString();
        await appendEvent(run.debugDir, "run_completed", { downloads: run.downloads });
      }
    } catch (error) {
      if ((error as {code?: string})?.code === "AUTH_INVALID") {
        for (const pending of this.queue.filter(job => job.project.id === project.id && job.project.browser.authStateEnabled)) {
          const signal = this.activeRuns.get(pending.run.id);
          if (signal) signal.cancelled = true;
        }
        for (const [activeId, signal] of this.activeRuns.entries()) {
          if (activeId !== run.id && this.runProjectIds.get(activeId) === project.id) signal.cancelled = true;
        }
      }
      run.status = run.status === "cancelled" ? "cancelled" : "failed";
      run.errorCode = classifyError(error);
      run.errorMessage = error instanceof Error ? error.message : String(error);
      run.endedAt = new Date().toISOString();
      await appendEvent(run.debugDir, "run_failed", { code: run.errorCode, message: run.errorMessage });
      if (page) await captureFailure(project, run, getActivePage(context, page), error);
    } finally {
      run.variables = { ...variables };
      await this.store.saveRun(run);
      detachObservability?.();

      const keepBatchSession = Boolean(
        options.batchSessionId
        && options.batchSessionLast !== true
        && run.status === "completed"
        && !borrowedSession
        && context
      );
      if (keepBatchSession) {
        const signal = this.activeRuns.get(run.id);
        const completedManualStepIds = new Set<string>([
          ...(reusedBatchSession ? (this.batchSessions.get(options.batchSessionId!)?.completedManualStepIds ?? []) : []),
          ...(signal?.completedBatchManualSteps ?? [])
        ]);
        this.batchSessions.set(options.batchSessionId!, {
          browser,
          context,
          page: getActivePage(context, page),
          externalBrowser,
          completedManualStepIds
        });
        await appendEvent(run.debugDir, "batch_session_preserved", {
          batchSessionId: options.batchSessionId,
          nextRunWillReuseLogin: true
        }).catch(() => undefined);
      } else {
        if (options.batchSessionId) this.batchSessions.delete(options.batchSessionId);
        if (borrowedSession) borrowedSession.release();
        else if (externalBrowser) {
          // A CDP-attached Chrome is user-owned. browser.close() on a connected
          // browser disconnects this Playwright client; do not close the default
          // context, which would close the user's real tabs.
          await browser?.close().catch(() => undefined);
        } else {
          await context?.close().catch(() => undefined);
          await browser?.close().catch(() => undefined);
        }
      }
      this.activeRuns.delete(run.id);
      this.runProjectIds.delete(run.id);
      try {
        // "僅失敗任務"只刪除本次成功 run 的 Debug，不掃描其他歷史資料。
        await this.store.cleanupCompletedRunDebug(run);
      } catch (error) {
        console.warn(`[debug-retention] 無法清理本次成功任務 Debug (${run.id})：${error instanceof Error ? error.message : String(error)}`);
      }
      // 到期清理只做極輕量的 24 小時節流判斷；真正掃描最多每日一次。
      void this.store.maybeCleanupExpiredDebug("run-finished").catch((error) => {
        console.warn(`[debug-retention] 到期清理失敗：${error instanceof Error ? error.message : String(error)}`);
      });
      void this.store.maybeCleanupExpiredRunHistory("run-finished").catch((error) => {
        console.warn(`[run-history-retention] 到期清理失敗：${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  private resolveRunDownloadDir(project: WorkflowProject, run: WorkflowRun, directory: string): string {
    const root = path.resolve(directory);
    if (run.mode !== "batch" || project.browser.authStateEnabled !== true) return root;
    return path.join(root, "auth-batch", run.id);
  }

  private async executeSteps(
    project: WorkflowProject,
    run: WorkflowRun,
    context: any,
    page: any,
    steps: WorkflowStep[],
    variables: Record<string, string | boolean>
  ): Promise<void> {
    for (const step of steps) {
      if (!step.enabled) continue;
      if (this.activeRuns.get(run.id)?.cancelled) throw new Error("執行已由使用者取消。");
      const activePage = getActivePage(context, page);
      activePage.setDefaultTimeout?.(project.browser.defaultTimeoutMs);
      await this.executeStepWithRetry(project, run, context, activePage, step, variables);
      const stepDelay = playbackStepDelay(project.settings);
      // A PDF viewer/popup may close immediately after its response has been
      // captured. This inter-step pause must not turn a successful download
      // into a "Target page … closed" failure.
      await delay(stepDelay);
    }
  }

  private async executeStepWithRetry(
    project: WorkflowProject,
    run: WorkflowRun,
    context: any,
    page: any,
    step: WorkflowStep,
    variables: Record<string, string | boolean>
  ): Promise<void> {
    const retries = step.retryCount ?? project.settings.maxRetries;
    let lastError: unknown;
    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
      const result: StepRunResult = {
        stepId: step.id,
        name: step.name,
        kind: step.kind,
        status: "running",
        startedAt: new Date().toISOString(),
        attempt
      };
      run.currentStepId = step.id;
      run.steps.push(result);
      await this.store.saveRun(run);
      await appendEvent(run.debugDir, "step_started", { stepId: step.id, name: step.name, kind: step.kind, attempt });
      try {
        await waitForManualVerification(page, run.debugDir, project.browser.headless);
        if (step.kind === "extractWebData" && getTabState(context).pendingClickTabs) {
          await resolveExpectedTabAfterClick(context, step, project, run.debugDir, run.parameters, variables);
        } else if (step.kind !== "click") {
          getTabState(context).pendingClickTabs = undefined;
        }
        await applyWaitWithCdpAuth(context, getActivePage(context, page), step.waitBefore, project, run.debugDir, run.parameters, variables, step.autoFrameSearch === true);
        const currentForAction = getActivePage(context, page);
        const output = await this.performStep(project, run, context, currentForAction, step, variables);
        // A tab-control step may change the active page. Always continue checks
        // against the page selected by the shared tab state.
        let currentPage = getActivePage(context, page);
        let activePage = !isPageClosed(currentPage);
        if (activePage && step.kind !== "wait") await applyWaitWithCdpAuth(context, currentPage, step.waitAfter, project, run.debugDir, run.parameters, variables, step.autoFrameSearch === true);
        currentPage = getActivePage(context, page);
        activePage = !isPageClosed(currentPage);
        if (activePage) {
          await assertNoRecentRateLimit(currentPage);
          await waitForManualVerification(currentPage, run.debugDir, project.browser.headless);
          if (/^https?:/i.test(currentPage.url())) assertAllowedUrl(currentPage.url(), project.allowedDomains);
          if (step.verification && step.kind !== "assert") await verifyStep(currentPage, step, run.parameters, variables);
        } else if (step.kind !== "download") {
          throw new Error("執行步驟後目標頁面已關閉，無法繼續驗證。", { cause: output });
        }
        result.status = "completed";
        result.message = output.message;
        result.downloadPath = output.downloadPath;
        result.state = activePage
          ? await captureStepState(currentPage, step, run.parameters, variables)
          : { pageClosedAfterDownload: true, note: "PDF／下載來源頁已關閉，檔案已在關閉前保存。" };
        if (output.downloadPath) {
          run.downloads.push(output.downloadPath);
          result.downloadPath = output.downloadPath;
          await appendEvent(run.debugDir, "download_completed", { stepId: step.id, name: step.name, filePath: output.downloadPath });
        }
        if (project.settings.screenshotMode === "everyStep") {
          result.screenshotPath = path.join(run.debugDir, `${String(run.completedSteps + 1).padStart(3, "0")}-${safeFile(step.name)}.png`);
          await currentPage.screenshot({ path: result.screenshotPath, fullPage: true }).catch(() => undefined);
        }
        result.endedAt = new Date().toISOString();
        result.durationMs = Date.parse(result.endedAt) - Date.parse(result.startedAt);
        run.completedSteps += 1;
        run.variables = { ...variables };
        await appendEvent(run.debugDir, "step_completed", { stepId: step.id, durationMs: result.durationMs, state: result.state });
        await this.store.saveRun(run);
        return;
      } catch (error) {
        lastError = error;
        result.status = "failed";
        result.message = error instanceof Error ? error.message : String(error);
        result.endedAt = new Date().toISOString();
        result.durationMs = Date.parse(result.endedAt) - Date.parse(result.startedAt);
        await appendEvent(run.debugDir, "step_failed", { stepId: step.id, attempt, message: result.message });
        await this.store.saveRun(run);
        const verificationVisible = !isPageClosed(page) && await isHumanVerificationPage(page).catch(() => false);
        // A click/submit/download may already have taken effect when a later
        // wait fails. Never replay those side-effecting actions automatically.
        const noReplay = new Set(["click", "dblclick", "press", "download", "upload", "script", "saveDocument", "savePagePdf"]);
        const canRetry = attempt <= retries
          && !noReplay.has(step.kind)
          && !/AUTH_INVALID|AUTH_TIMEOUT|AUTH_REQUIRED|TAB_AMBIGUOUS|TAB_RESULT_TIMEOUT/.test(String(error))
          && !isHumanVerificationError(error)
          && !isRateLimitError(error)
          && !verificationVisible
          && step.kind !== "manual"
          && !isPageClosed(page);
        if (canRetry) await delay(5_000);
        else break;
      }
    }
    if (await isHumanVerificationPage(page).catch(() => false)) {
      throw new Error("自動化步驟觸發網站安全驗證。已停止重試，請在瀏覽器中人工完成驗證後重新執行此步驟。", { cause: lastError });
    }
    throw lastError;
  }

  private async performStep(
    project: WorkflowProject,
    run: WorkflowRun,
    context: any,
    page: any,
    step: WorkflowStep,
    variables: Record<string, string | boolean>
  ): Promise<{ message?: string; downloadPath?: string }> {
    const expand = (value: unknown) => interpolate(value, run.parameters, variables);
    const scoped = step.autoFrameSearch ? (resolveFrameOptional(page, step.frame) ?? page) : resolveFrame(page, step.frame);
    const timeout = step.timeoutMs ?? project.browser.defaultTimeoutMs;

    if (step.kind === "extractWebData") {
      const added = await captureWebData(scoped, { ...step, timeoutMs: timeout }, variables, expand, page.url());
      return { message: `已擷取 ${added} 筆資料至集合 {{${step.dataCollection || "records"}}}` };
    }
    if (step.kind === "saveDocument") {
      const settings = await this.store.getSettings();
      const directory = this.resolveRunDownloadDir(project, run, String(settings.defaultDownloadDir || "./downloads"));
      const filePath = await saveCollectedDocument(step, variables, directory, expand);
      return { message: `彙整文件已保存：${filePath}`, downloadPath: filePath };
    }
    if (step.kind === "manual") {
      const activeSignal = this.activeRuns.get(run.id);
      if (run.mode === "batch" && activeSignal?.reusableBatchManualSteps.has(step.id)) {
        await appendEvent(run.debugDir, "manual_step_reused_from_batch_session", {
          stepId: step.id,
          reason: "same manual checkpoint already completed in preserved batch browser session"
        });
        return { message: "已沿用本批次先前完成的人工登入工作階段" };
      }
      run.status = "paused";
      const instruction = interpolate(step.value ?? step.description ?? "請在瀏覽器中完成操作。", run.parameters, variables);
      const currentResult = run.steps.at(-1);
      if (currentResult) currentResult.message = `等待人工操作：${instruction}`;
      await this.store.saveRun(run);
      try {
        const signal = this.activeRuns.get(run.id);
        if (signal) signal.manualContinue = false;
        await waitForManualAction(
          page,
          run.debugDir,
          step,
          run.parameters,
          variables,
          project.browser.headless,
          () => this.activeRuns.get(run.id)?.manualContinue === true,
          () => this.activeRuns.get(run.id)?.cancelled === true
        );
        if (run.mode === "batch") this.activeRuns.get(run.id)?.completedBatchManualSteps.add(step.id);
        return { message: "人工操作已完成，驗證條件成立" };
      } finally {
        if (run.status === "paused") {
          run.status = "running";
          await this.store.saveRun(run);
        }
      }
    }

    if (step.kind === "newTab") {
      const rawUrl = expand(step.url || String(step.value || "about:blank"));
      if (/^https?:/i.test(rawUrl)) assertAllowedUrl(rawUrl, project.allowedDomains);
      const newPage = await context.newPage();
      newPage.setDefaultTimeout?.(project.browser.defaultTimeoutMs);
      if (rawUrl && rawUrl !== "about:blank") {
        await newPage.goto(rawUrl, { waitUntil: "domcontentloaded", timeout });
        if (/^https?:/i.test(newPage.url())) assertAllowedUrl(newPage.url(), project.allowedDomains, `導向後網址 ${newPage.url()}`);
        if (project.settings.safePlayback !== false) await waitForPageSettled(newPage, timeout);
      }
      const name = step.tabName?.trim();
      if (name) getTabState(context).named.set(name, newPage);
      getTabState(context).active = newPage;
      await newPage.bringToFront().catch(() => undefined);
      return { message: name ? `已開新分頁「${name}」：${newPage.url()}` : `已開新分頁：${newPage.url()}` };
    }

    if (step.kind === "switchTab") {
      const target = await resolveTabTarget(context, step, run.parameters, variables);
      getTabState(context).active = target;
      target.setDefaultTimeout?.(project.browser.defaultTimeoutMs);
      await target.bringToFront().catch(() => undefined);
      return { message: `已切換至分頁：${await describePage(target)}` };
    }

    if (step.kind === "navigate") {
      const url = expand(step.url || String(step.value || project.targetUrl));
      assertAllowedUrl(url, project.allowedDomains);
      getTabState(context).lastProtectedUrl = url;
      if (samePageUrl(page.url(), url)) return { message: `已在目標網址，沿用目前頁面：${url}` };
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      const resumed = await recoverCdpLoginIfNeeded(context, page, project, run.debugDir, url);
      if (/^https?:/i.test(resumed.url())) assertAllowedUrl(resumed.url(), project.allowedDomains, `導向後網址 ${resumed.url()}`);
      if (project.settings.safePlayback !== false) await waitForPageSettled(page, timeout);
      return { message: `已開啟 ${url}` };
    }
    if (step.kind === "wait") {
      await applyWait(page, step.waitAfter ?? { kind: "timeout", timeoutMs: Number(step.value ?? 1_000) }, run.parameters, variables, step.autoFrameSearch === true);
      return { message: "等待條件已完成" };
    }
    if (step.kind === "waitNewFirst") {
      const baselineName = step.sourceVariable?.trim();
      if (!baselineName) throw new Error("等待第一筆新資料尚未設定基準變數。");
      const baseline = String(variables[baselineName] ?? run.parameters[baselineName] ?? "").trim();
      if (!baseline) throw new Error(`基準變數 {{${baselineName}}} 為空白，無法判斷第一筆是否為新資料。`);
      const result = await waitForNewFirstItem(page, step, run.parameters, variables, baseline, () => this.activeRuns.get(run.id)?.cancelled === true);
      if (step.outputVariable?.trim()) variables[step.outputVariable.trim()] = result.text;
      return { message: `已偵測到新的第一筆資料${result.refreshCount ? `（期間重新整理 ${result.refreshCount} 次）` : ""}${step.outputVariable?.trim() ? `，並保存至 {{${step.outputVariable.trim()}}}` : ""}` };
    }
    if (step.kind === "captureListSnapshot") {
      const outputName = step.outputVariable?.trim();
      if (!outputName) throw new Error("擷取清單快照尚未設定輸出變數。");
      const items = await scanVisibleListItems(page, step, run.parameters, variables);
      if (!items.length) throw new Error("擷取清單快照時找不到任何可見清單項目。");
      variables[outputName] = JSON.stringify(items.map((item) => ({ fingerprint: item.fingerprint, text: item.text })));
      return { message: `已記錄 ${items.length} 筆清單基準至 {{${outputName}}}` };
    }
    if (step.kind === "waitNewListItem") {
      const baselineName = step.sourceVariable?.trim();
      if (!baselineName) throw new Error("等待新資料尚未設定基準變數。");
      const rawBaseline = String(variables[baselineName] ?? run.parameters[baselineName] ?? "").trim();
      if (!rawBaseline) throw new Error(`基準變數 {{${baselineName}}} 為空白，無法比對新資料。`);
      const result = await waitForNewListItem(page, step, run.parameters, variables, rawBaseline, project.settings.safePlayback !== false, project.settings.humanizedPlayback === true, () => this.activeRuns.get(run.id)?.cancelled === true);
      if (step.outputVariable?.trim()) variables[step.outputVariable.trim()] = result.text;
      return { message: `已找到基準集合以外的新資料${step.clickOnMatch ? "並點擊" : ""}${result.refreshCount ? `（期間重新整理 ${result.refreshCount} 次）` : ""}${step.outputVariable?.trim() ? `，保存至 {{${step.outputVariable.trim()}}}` : ""}` };
    }
    if (step.kind === "screenshot") {
      const filePath = path.join(run.debugDir, safeFile(expand(step.value || `${step.id}.png`)));
      await page.screenshot({ path: filePath, fullPage: true });
      return { message: `截圖已保存：${filePath}` };
    }
    if (step.kind === "savePagePdf") {
      if (typeof page.pdf !== "function") throw new Error("保存頁面 PDF 需要 Chromium／Chrome 瀏覽器分頁；目前連線不支援原生列印 PDF。");
      const studioSettings = await this.store.getSettings();
      const configuredDownloadDir = String(studioSettings.defaultDownloadDir ?? "./downloads").trim() || "./downloads";
      const targetDir = this.resolveRunDownloadDir(project, run, configuredDownloadDir);
      await fs.mkdir(targetDir, { recursive: true });
      const configuredName = expand(step.pdfFileName ?? "");
      const fileName = safeFile(buildPagePdfFilename(configuredName, step.name || step.id, step.pdfUseLocalTime !== false));
      let viewportPrintStyle: any;
      const pdfOptions = buildNativePagePdfOptions({
        ...step,
        pdfHeaderTemplate: expand(step.pdfHeaderTemplate ?? ""),
        pdfFooterTemplate: expand(step.pdfFooterTemplate ?? "")
      });
      const filePath = await uniquePath(targetDir, fileName);
      try {
        if (step.pdfFullPage === false) {
          const viewportHeight = await page.evaluate(() => Math.max(1, window.innerHeight));
          viewportPrintStyle = await page.addStyleTag({ content: `@media print { html, body { height: ${viewportHeight}px !important; max-height: ${viewportHeight}px !important; overflow: hidden !important; } }` });
        }
        await page.pdf({ path: filePath, ...pdfOptions });
        const stat = await fs.stat(filePath);
        if (!stat.size) throw new Error("保存的 PDF 檔案大小為 0 bytes。");
      } catch (error) {
        await fs.rm(filePath, { force: true }).catch(() => undefined);
        throw error;
      } finally {
        if (viewportPrintStyle) await viewportPrintStyle.evaluate((element: Element) => element.remove()).catch(() => undefined);
      }
      const orientation = pdfOptions.landscape ? "橫向" : "直向";
      const headerFooter = pdfOptions.displayHeaderFooter
        ? (pdfOptions.headerTemplate || pdfOptions.footerTemplate ? "已啟用" : "已啟用，但範本空白")
        : "未啟用";
      return {
        message: `頁面 PDF 已保存：${filePath}（${pdfOptions.format}、${orientation}、縮放 ${Math.round(pdfOptions.scale * 100)}%、頁首／頁尾${headerFooter}）`,
        downloadPath: filePath
      };
    }
    if (step.kind === "script") {
      const source = expand(step.script ?? String(step.value ?? ""));
      await page.evaluate((code: string) => (0, eval)(code), source);
      return { message: "頁面腳本已執行" };
    }
    if (step.kind === "condition") {
      const matched = await evaluateCondition(page, step.condition, run.parameters, variables);
      await this.executeSteps(project, run, context, page, matched ? step.thenSteps ?? [] : step.elseSteps ?? [], variables);
      return { message: matched ? "條件成立" : "條件不成立" };
    }
    if (step.kind === "loop") {
      const values = step.loopParameter
        ? String(run.parameters[step.loopParameter] ?? "").split(/\r?\n|,/).map((v) => v.trim()).filter(Boolean)
        : step.loopValues ?? [];
      for (const value of values) {
        variables[step.loopVariable || "item"] = value;
        await this.executeSteps(project, run, context, page, step.steps ?? [], variables);
      }
      return { message: `已完成 ${values.length} 次迴圈` };
    }
    if (step.kind === "assert") {
      await verifyStep(page, step, run.parameters, variables);
      return { message: "驗證通過" };
    }

    if (step.kind === "extractPattern") {
      const sourceName = step.sourceVariable?.trim();
      if (!sourceName) throw new Error("擷取樣式步驟尚未設定來源變數。");
      const outputName = step.outputVariable?.trim();
      if (!outputName) throw new Error("擷取樣式步驟尚未設定輸出變數。");
      const source = String(variables[sourceName] ?? run.parameters[sourceName] ?? "");
      const pattern = step.regexPattern ?? "\\b\\d{6}\\b";
      variables[outputName] = extractPatternValue(source, pattern, step.regexFlags ?? "", step.regexGroup ?? 0);
      return { message: `已擷取文字並保存至變數 {{${outputName}}}` };
    }

    if (step.kind === "clipboard") {
      const text = expand(step.value ?? "");
      await writeTextToClipboard(context, page, text);
      return { message: `已複製 ${text.length} 個字元至剪貼簿` };
    }

    if (step.kind === "download") {
      const mode = step.downloadMode ?? "auto";
      let capture: DownloadCapture | undefined;
      let automaticFallbackNote = "";
      if (mode !== "click") {
        capture = await directLinkDownload(
          context, page, scoped, step, run.parameters, variables, project.allowedDomains,
          step.timeoutMs ?? project.browser.downloadTimeoutMs
        ).catch((error) => {
          if (mode === "direct") throw error;
          automaticFallbackNote = isCertificateTrustError(error)
            ? "（直接下載遇到 TLS 憑證信任問題，已自動改用瀏覽器下載）"
            : "（直接下載未成功，已自動改用瀏覽器下載）";
          return undefined;
        });
      }
      // Auto mode gets a second, browser-network fallback before clicking the
      // source element.  This is deliberately different from context.request:
      // page.goto() uses Chrome's own TLS/cookie/session stack, so corporate CA
      // trust and inline PDF responses behave exactly like an interactive tab.
      if (!capture && mode === "auto") {
        capture = await browserNavigationDownload(
          context, page, scoped, step, run.parameters, variables, project.allowedDomains,
          step.timeoutMs ?? project.browser.downloadTimeoutMs
        ).catch(() => undefined);
        if (capture) automaticFallbackNote += "（已改由 Chrome 網路層直接取得檔案）";
      }
      if (!capture && project.browser.downloadPdfInsteadOfPreview === true) {
        capture = await browserCdpResourceDownload(
          context, page, scoped, step, run.parameters, variables, project.allowedDomains,
          step.timeoutMs ?? project.browser.downloadTimeoutMs
        ).catch(() => undefined);
        if (capture) automaticFallbackNote += " (Chrome DevTools network resource download)";
      }
      if (!capture) {
        capture = await clickAndWaitForDownload(
          context,
          page,
          scoped,
          step,
          project.browser.downloadTimeoutMs,
          run.parameters,
          variables,
          project.settings.safePlayback !== false,
          project.settings.humanizedPlayback === true,
          project.browser.downloadPdfInsteadOfPreview === true
        );
      }
      const studioSettings = await this.store.getSettings();
      const configuredDownloadDir = String(studioSettings.defaultDownloadDir ?? "./downloads").trim() || "./downloads";
      const targetDir = this.resolveRunDownloadDir(project, run, configuredDownloadDir);
      await fs.mkdir(targetDir, { recursive: true });
      const originalName = safeFile(capture.kind === "download"
        ? decodedDownloadNameFromUrl(capture.url ?? "") || capture.download.suggestedFilename?.() || `${step.id}.bin`
        : capture.filename || `${step.id}.bin`);
      const configuredName = resolveDownloadFileName(originalName, step, expand);
      const suggested = run.mode === "batch" ? appendDownloadTimestamp(configuredName, new Date()) : configuredName;
      const filePath = await uniquePath(targetDir, suggested);
      try {
        if (capture.kind === "download") {
          await saveNativeDownloadOrRecover(capture, context, filePath, project.allowedDomains);
        } else if (capture.kind === "browser-file") {
          await fs.copyFile(capture.stagedPath, filePath);
        } else {
          await fs.writeFile(filePath, capture.body);
        }
        const stat = await fs.stat(filePath);
        if (!stat.size) throw new Error("下載檔案大小為 0 bytes。");
      } catch (error) {
        await fs.rm(filePath, { force: true }).catch(() => undefined);
        throw error;
      } finally {
        if (capture.kind === "browser-file") {
          await fs.rm(capture.stagingDir, { recursive: true, force: true }).catch(() => undefined);
        }
        if (capture.popup && !capture.popup.isClosed?.()) await capture.popup.close().catch(() => undefined);
      }
      return {
        message: (capture.kind === "direct-response"
          ? `直接下載完成：${suggested}`
          : capture.kind === "browser-file"
            ? `Chrome 原生下載完成：${suggested}`
          : capture.kind === "pdf-response"
            ? `PDF 預覽內容已保存：${suggested}`
            : `下載完成：${suggested}`) + automaticFallbackNote,
        downloadPath: filePath
      };
    }

    if (step.componentPath || step.selectors?.some((rule) => rule.strategy === "component")) {
      await performComponentAction(scoped, step, expand(step.value));
      return { message: "元件狀態已同步" };
    }

    const locator = await resolveLocatorForStep(page, step, step.selectors ?? [], run.parameters, variables, step.matchMode, step.matchIndex);
    if (step.kind === "extractText") {
      const outputName = step.outputVariable?.trim();
      if (!outputName) throw new Error("擷取文字步驟尚未設定輸出變數。");
      const mode = step.extractMode ?? "text";
      let extracted: string;
      if (mode === "html") extracted = await locator.innerHTML();
      else if (mode === "attribute") {
        const attribute = step.extractAttribute?.trim();
        if (!attribute) throw new Error("擷取屬性模式需要填入屬性名稱。");
        extracted = String(await locator.getAttribute(attribute) ?? "");
      } else extracted = await locator.innerText();
      variables[outputName] = extracted.trim();
      return { message: `已擷取 ${extracted.trim().length} 個字元至變數 {{${outputName}}}` };
    }
    const humanized = project.settings.humanizedPlayback === true;
    if (step.kind !== "upload") await prepareInteraction(locator, page, timeout, project.settings.safePlayback !== false, humanized);
    if (step.kind === "click") {
      if (project.browser.connectionMode === "cdp") {
        const currentPages = (context.pages?.() ?? []).filter((item: any) => !isPageClosed(item));
        getTabState(context).pendingClickTabs = { origin: page, pages: new Map(currentPages.map((item: any) => [item, String(item.url())])) };
      }
      await locator.click({ timeout });
    }
    else if (step.kind === "dblclick") await locator.dblclick({ timeout });
    else if (step.kind === "fill") await fillLocator(locator, expand(step.value), timeout, humanized);
    else if (step.kind === "select") await locator.selectOption(expand(step.value));
    else if (step.kind === "upload") {
      const files = expand(step.value).split(/\r?\n/).map((file) => file.trim()).filter(Boolean);
      if (!files.length) throw new Error("上傳步驟缺少檔案路徑，請設定完整本機路徑（一行一個）。");
      await locator.setInputFiles(files.map((file) => path.resolve(file)));
    }
    else if (step.kind === "press") await locator.press(expand(step.value));
    else if (step.kind === "hover") await locator.hover({ timeout });
    else if (step.kind === "check") await locator.check({ timeout });
    else if (step.kind === "uncheck") await locator.uncheck({ timeout });
    else throw new Error(`尚未支援的步驟類型：${step.kind}`);
    return { message: "動作完成" };
  }
}

export function extractPatternValue(source: string, pattern: string, flags = "", group = 0): string {
  let expression: RegExp;
  try { expression = new RegExp(pattern, flags); }
  catch (error) { throw new Error(`正規表示式無效：${pattern}`, { cause: error }); }
  const match = expression.exec(source);
  if (!match) throw new Error(`找不到符合樣式的文字：${pattern}`);
  const index = Math.max(0, Math.trunc(Number(group || 0)));
  if (match[index] === undefined) throw new Error(`正規表示式沒有第 ${index} 群組。`);
  return match[index];
}

export async function runtimeStatus(): Promise<{ playwright: boolean; browser?: string; message: string }> {
  try {
    const playwright = await loadPlaywright();
    const resolution = await resolveStudioBrowser(playwright, "bundled");
    return {
      playwright: true,
      browser: resolution.source,
      message: resolution.executablePath || resolution.channel
        ? `Playwright 可用；瀏覽器：${resolution.source}`
        : `Playwright 套件可用，但${resolution.source}。`
    };
  } catch (error) {
    return { playwright: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    return await import("playwright");
  } catch (error) {
    throw new Error("找不到 Playwright 執行核心。請使用完整免安裝版，或在開發版執行 npm.cmd install。", { cause: error });
  }
}

async function resolveLocatorAcrossFrames(page: any, selectors: SelectorRule[], parameters: Record<string, string | boolean>, variables: Record<string, string | boolean>, matchMode: LocatorMatchMode = "unique", matchIndex?: number, preferredFrame?: WorkflowStep["frame"], allowHidden = false): Promise<any> {
  const scopes = orderedFrameScopes(page, preferredFrame);
  const errors: string[] = [];
  for (let index = 0; index < scopes.length; index += 1) {
    const scope = scopes[index];
    try {
      return await resolveLocator(scope, selectors, parameters, variables, matchMode, matchIndex, allowHidden);
    } catch (error) {
      const url = scope === page ? page.url() : scope.url?.() ?? "frameLocator";
      errors.push(`${scope === page ? "main" : `frame${index}`}(${url}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`主頁與所有 frame 均無法定位：${errors.join("；")}`);
}

async function resolveLocatorForStep(page: any, step: WorkflowStep, selectors: SelectorRule[], parameters: Record<string, string | boolean>, variables: Record<string, string | boolean>, matchMode: LocatorMatchMode = "unique", matchIndex?: number): Promise<any> {
  if (step.autoFrameSearch) {
    return resolveLocatorAcrossFrames(page, selectors, parameters, variables, matchMode, matchIndex, step.frame, step.kind === "upload");
  }
  return resolveLocator(resolveFrame(page, step.frame), selectors, parameters, variables, matchMode, matchIndex, step.kind === "upload");
}

function orderedFrameScopes(page: any, preferredFrame?: WorkflowStep["frame"]): any[] {
  const preferred = resolveFrameOptional(page, preferredFrame);
  const scopes = [preferred, page, ...(page.frames?.() ?? []).filter((frame: any) => frame !== page.mainFrame?.())].filter(Boolean);
  const seen = new Set<any>();
  return scopes.filter((scope: any) => {
    if (seen.has(scope)) return false;
    seen.add(scope);
    return true;
  });
}

async function resolveLocator(scope: any, selectors: SelectorRule[], parameters: Record<string, string | boolean>, variables: Record<string, string | boolean>, matchMode: LocatorMatchMode = "unique", matchIndex?: number, allowHidden = false): Promise<any> {
  if (!selectors.length) throw new Error("此步驟尚未設定元件定位方式。");
  const errors: string[] = [];
  for (const rule of selectors) {
    if (rule.strategy === "component") continue;
    const interpolated = interpolate(rule.value, parameters, variables);
    const value = rule.strategy === "css" ? stabilizeRecordedCssSelector(interpolated) : interpolated;
    try {
      let locator: any;
      if (rule.strategy === "role") locator = scope.getByRole(rule.role || "button", { name: value, exact: rule.exact });
      else if (rule.strategy === "label") locator = scope.getByLabel(value, { exact: rule.exact });
      else if (rule.strategy === "placeholder") locator = scope.getByPlaceholder(value, { exact: rule.exact });
      else if (rule.strategy === "text") locator = scope.getByText(value, { exact: rule.exact });
      else if (rule.strategy === "testId") locator = scope.getByTestId(value);
      else if (rule.strategy === "name") locator = scope.locator(`[name=${cssString(value)}]`);
      else if (rule.strategy === "xpath") locator = scope.locator(`xpath=${value}`);
      else locator = scope.locator(value);
      if (allowHidden) {
        const count = await locator.count();
        if (count === 1) return locator.nth(0);
        if (count > 0 && matchMode === "first") return locator.nth(0);
        if (count > 0 && matchMode === "last") return locator.nth(count - 1);
        const requested = Math.trunc(Number(matchIndex ?? 1));
        if (matchMode === "nth" && requested >= 1 && requested <= count) return locator.nth(requested - 1);
        errors.push(`${rule.strategy}:${value} 上傳元件數量 ${count}，請使用唯一定位或指定第 N 筆`);
        continue;
      }
      const visible = locator.filter({ visible: true });
      const desktopIndexes = await visible.evaluateAll((elements: Element[]) => elements
        .map((element, index) => ({ element, index }))
        .filter(({ element }) => !element.closest('[class*="mobile" i],[id*="mobile" i],[class*="hamburger" i],[class*="offcanvas" i],[class*="drawer" i],[aria-label*="手機"],[title*="手機"]'))
        .map(({ index }) => index));
      const visibleCount = desktopIndexes.length;
      if (visibleCount > 0) {
        if (matchMode === "first") return visible.nth(desktopIndexes[0]);
        if (matchMode === "last") return visible.nth(desktopIndexes[visibleCount - 1]);
        if (matchMode === "nth") {
          const requested = Math.trunc(Number(matchIndex ?? 1));
          if (requested < 1) {
            errors.push(`${rule.strategy}:${value} 第 N 筆必須大於或等於 1`);
            continue;
          }
          if (requested > visibleCount) {
            errors.push(`${rule.strategy}:${value} 只有 ${visibleCount} 個可見元件，無法選取第 ${requested} 筆`);
            continue;
          }
          return visible.nth(desktopIndexes[requested - 1]);
        }
        if (visibleCount === 1) return visible.nth(desktopIndexes[0]);
        errors.push(`${rule.strategy}:${value} 找到 ${visibleCount} 個可見元件，定位不唯一`);
        continue;
      }
      errors.push(`${rule.strategy}:${value} 找不到可見元件`);
    } catch (error) {
      errors.push(`${rule.strategy}:${value} ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`所有定位方式均失敗：${errors.join("；")}`);
}

async function prepareInteraction(locator: any, page: any, timeout: number, safePlayback: boolean, humanized = false): Promise<void> {
  // Let the page finish layout/menus before interacting. This is a stability
  // guard for dynamic desktop menus, not an attempt to hide automation.
  await locator.scrollIntoViewIfNeeded({ timeout }).catch(() => undefined);
  if (humanized) {
    const box = await locator.boundingBox?.().catch(() => undefined);
    if (box && page.mouse?.move) {
      const x = box.x + box.width * randomBetween(35, 65) / 100;
      const y = box.y + box.height * randomBetween(35, 65) / 100;
      await page.mouse.move(x, y, { steps: randomBetween(8, 16) });
    }
    await page.waitForTimeout(randomBetween(180, 420));
  } else if (safePlayback) await page.waitForTimeout(350);
}

async function fillLocator(locator: any, value: string, timeout: number, humanized: boolean): Promise<void> {
  if (!humanized) {
    await locator.fill(value);
    return;
  }
  await locator.click({ timeout });
  await locator.fill("");
  const delayMs = randomBetween(55, 115);
  if (typeof locator.pressSequentially === "function") await locator.pressSequentially(value, { delay: delayMs });
  else if (typeof locator.type === "function") await locator.type(value, { delay: delayMs });
  else await locator.fill(value);
}

function randomBetween(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

export function playbackStepDelay(settings: { safePlayback?: boolean; humanizedPlayback?: boolean; minStepDelayMs?: number }): number {
  if (settings.safePlayback === false && settings.humanizedPlayback !== true) return 800;
  const base = clamp(settings.minStepDelayMs ?? 2_000, 500, 10_000);
  return settings.humanizedPlayback === true ? base + randomBetween(150, 850) : base;
}

async function waitForPageSettled(page: any, timeout: number): Promise<void> {
  await page.waitForLoadState("load", { timeout: Math.min(timeout, 10_000) }).catch(() => undefined);
  await page.waitForTimeout(350);
}

async function assertNoRecentRateLimit(page: any): Promise<void> {
  const observed = recentRateLimits.get(page);
  if (!observed || Date.now() - observed.at > 15_000) return;
  throw new Error(`網站回傳 HTTP ${observed.status}，已停止重播以避免增加網站負載：${observed.url}`);
}

function resolveFrame(page: any, rule?: { name?: string; urlIncludes?: string; selector?: string }): any {
  if (!rule) return page;
  if (rule.selector) return page.frameLocator(rule.selector);
  const frame = page.frames().find((item: any) =>
    (rule.name && item.name() === rule.name) || (rule.urlIncludes && item.url().includes(rule.urlIncludes))
  );
  if (!frame) throw new Error("找不到指定的 iframe/frame。");
  return frame;
}

function resolveFrameOptional(page: any, rule?: WorkflowStep["frame"]): any | undefined {
  if (!rule) return page;
  try { return resolveFrame(page, rule); } catch { return undefined; }
}

async function performComponentAction(scope: any, step: WorkflowStep, expandedValue: string): Promise<void> {
  const componentPath = step.componentPath ?? step.selectors?.find((rule) => rule.strategy === "component")?.value;
  if (!componentPath) throw new Error("元件動作缺少 componentPath。");
  await scope.evaluate(({ componentPath: targetPath, kind, value, adapter }: { componentPath: string; kind: string; value: string; adapter?: string }) => {
    const win = window as any;
    const direct = targetPath.split(".").reduce((value: any, key: string) => value?.[key], win);
    const ext = win.Ext?.getCmp?.(targetPath);
    const component = direct ?? ext;
    if (!component) throw new Error(`找不到頁面元件 ${targetPath}`);
    if (kind === "fill" || kind === "select") component.setValue?.(value);
    else if (kind === "check") component.setValue?.(adapter === "ksi" ? value || true : true);
    else if (kind === "uncheck") component.setValue?.(false);
    else if (kind === "click") component.fireEvent?.("click", component);
    component.fireEvent?.("change", component, component.getValue?.());
    component.fireEvent?.("select", component, component.getStore?.()?.findRecord?.("value", value));
  }, { componentPath, kind: step.kind, value: expandedValue, adapter: step.adapter });
}

type DownloadCapture =
  | { kind: "download"; download: any; url?: string; popup?: any; stagedFilePromise?: Promise<string | undefined>; recoveryHeaders?: Record<string, string> }
  | { kind: "browser-file"; stagedPath: string; stagingDir: string; filename: string; url: string }
  | { kind: "pdf-response"; body: Buffer; filename: string; url: string; popup?: any }
  | { kind: "direct-response"; body: Buffer; filename: string; url: string; popup?: any };

async function directLinkDownload(context: any, page: any, scope: any, step: WorkflowStep, parameters: Record<string, string | boolean>, variables: Record<string, string | boolean>, allowedDomains: string[], timeoutMs: number): Promise<DownloadCapture | undefined> {
  const locator = await resolveLocatorForStep(page, step, step.selectors ?? [], parameters, variables, step.matchMode, step.matchIndex);
  const url = await readAnchorUrl(locator, page.url());
  if (!url) return undefined;
  assertAllowedUrl(url, allowedDomains, "直接下載網址");
  const response = await context.request.get(url, { timeout: timeoutMs });
  if (!response.ok()) throw new Error(`直接下載失敗：HTTP ${response.status()}。`);
  const body = Buffer.from(await response.body());
  if (!body.length) throw new Error("直接下載內容為空白。");
  return { kind: "direct-response", body, filename: responseDownloadFilename(response, url, step), url };
}


async function browserCdpResourceDownload(context: any, page: any, scope: any, step: WorkflowStep, parameters: Record<string, string | boolean>, variables: Record<string, string | boolean>, allowedDomains: string[], timeoutMs: number): Promise<DownloadCapture | undefined> {
  const locator = await resolveLocatorForStep(page, step, step.selectors ?? [], parameters, variables, step.matchMode, step.matchIndex);
  const url = await readAnchorUrl(locator, page.url());
  if (!url || !isLikelyPdfDownloadUrl(url)) return undefined;
  assertAllowedUrl(url, allowedDomains, "Chrome DevTools direct resource URL");
  if (typeof context?.newCDPSession !== "function") return undefined;

  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "automation-studio-cdp-resource-"));
  let session: any;
  let streamHandle = "";
  let output: any;
  try {
    session = await context.newCDPSession(page);
    const frameTree = await session.send("Page.getFrameTree");
    const frameId = String(frameTree?.frameTree?.frame?.id ?? "");
    if (!frameId) throw new Error("CDP main frame id is unavailable.");

    const load = session.send("Network.loadNetworkResource", {
      frameId,
      url,
      options: { disableCache: true, includeCredentials: true }
    });
    const loaded: any = await Promise.race([
      load,
      delay(Math.max(1000, timeoutMs)).then(() => { throw new Error(`CDP resource download timed out (${timeoutMs} ms).`); })
    ]);
    const resource = loaded?.resource;
    if (!resource?.success) {
      throw new Error(`CDP resource download failed${resource?.netErrorName ? `: ${resource.netErrorName}` : "."}`);
    }
    const status = Number(resource.httpStatusCode ?? 0);
    if (status && (status < 200 || status >= 400)) throw new Error(`CDP resource download returned HTTP ${status}.`);
    streamHandle = String(resource.stream ?? "");
    if (!streamHandle) throw new Error("CDP resource download did not return a stream.");

    const filename = safeFile(decodedDownloadNameFromUrl(url) || (step.name && /\.pdf$/i.test(step.name) ? step.name : `${step.name || step.id}.pdf`));
    const stagedPath = path.join(stagingDir, filename);
    output = await fs.open(stagedPath, "w");
    while (true) {
      const part: any = await session.send("IO.read", { handle: streamHandle, size: 1024 * 1024 });
      const data = String(part?.data ?? "");
      if (data) {
        const chunk = part?.base64Encoded ? Buffer.from(data, "base64") : Buffer.from(data, "utf8");
        if (chunk.length) await output.write(chunk);
      }
      if (part?.eof) break;
    }
    await output.close();
    output = undefined;
    await session.send("IO.close", { handle: streamHandle }).catch(() => undefined);
    streamHandle = "";

    const stat = await fs.stat(stagedPath);
    if (!stat.size) throw new Error("CDP resource download is empty.");
    if (isLikelyPdfDownloadUrl(url)) {
      const file = await fs.open(stagedPath, "r");
      try {
        const header = Buffer.alloc(5);
        const read = await file.read(header, 0, 5, 0);
        if (read.bytesRead < 5 || header.toString("ascii") !== "%PDF-") throw new Error("CDP resource is not a PDF file.");
      } finally {
        await file.close().catch(() => undefined);
      }
    }
    return { kind: "browser-file", stagedPath, stagingDir, filename, url };
  } catch (error) {
    await output?.close?.().catch(() => undefined);
    if (session && streamHandle) await session.send("IO.close", { handle: streamHandle }).catch(() => undefined);
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await session?.detach?.().catch(() => undefined);
  }
}

async function browserNavigationDownload(context: any, page: any, scope: any, step: WorkflowStep, parameters: Record<string, string | boolean>, variables: Record<string, string | boolean>, allowedDomains: string[], timeoutMs: number): Promise<DownloadCapture | undefined> {
  const locator = await resolveLocatorForStep(page, step, step.selectors ?? [], parameters, variables, step.matchMode, step.matchIndex);
  const url = await readAnchorUrl(locator, page.url());
  if (!url) return undefined;
  assertAllowedUrl(url, allowedDomains, "Chrome 直接導覽下載網址");

  const recoveryHeaders = await snapshotDownloadRecoveryHeaders(context, page, url);
  const tempPage = await context.newPage();
  let keepPageOpen = false;
  try {
    const nativeDownload = tempPage.waitForEvent("download", { timeout: timeoutMs })
      .then((download: any) => ({ kind: "download", download, url: download.url?.() || url, popup: tempPage, stagedFilePromise: stageNativeDownload(download), recoveryHeaders } as DownloadCapture))
      .catch(() => undefined);

    const navigationCapture = tempPage.goto(url, { waitUntil: "commit", timeout: timeoutMs })
      .then(async (response: any) => {
        if (!response) return undefined;
        let body: Buffer;
        try { body = Buffer.from(await response.body()); } catch { return undefined; }
        if (!body.length) return undefined;
        const isPdfBody = body.subarray(0, 5).toString("ascii").startsWith("%PDF-");
        if (!isPdfBody && !isPdfResponse(response)) return undefined;
        if (!isPdfBody) return undefined;
        return {
          kind: "pdf-response",
          body,
          filename: responseDownloadFilename(response, url, step),
          url,
          popup: tempPage
        } as DownloadCapture;
      })
      .catch(() => undefined);

    const first = await Promise.race([nativeDownload, navigationCapture]);
    if (first) { keepPageOpen = true; return first; }

    // A navigation response can settle before Chrome emits the download event.
    // Give the alternate path a short grace period without repeating the request.
    const second = await Promise.race([
      Promise.all([nativeDownload, navigationCapture]).then(([download, navigation]) => download ?? navigation),
      delay(Math.min(1500, Math.max(250, Math.trunc(timeoutMs / 10)))).then(() => undefined)
    ]);
    if (second) { keepPageOpen = true; return second; }
    return undefined;
  } finally {
    if (!keepPageOpen && !tempPage.isClosed?.()) await tempPage.close().catch(() => undefined);
  }
}

async function clickAndWaitForDownload(context: any, page: any, scope: any, step: WorkflowStep, timeoutMs: number, parameters: Record<string, string | boolean>, variables: Record<string, string | boolean>, safePlayback: boolean, humanized: boolean, forcePdfDownload = false): Promise<DownloadCapture> {
  // Resolve the source link and snapshot request metadata before the click. Some
  // download endpoints close their temporary page very quickly; the recovery
  // path must not need to query a BrowserContext that may already be gone.
  const locator = await resolveLocatorForStep(page, step, step.selectors ?? [], parameters, variables, step.matchMode, step.matchIndex);
  const sourceUrl = await readAnchorUrl(locator, page.url());
  const recoveryHeaders = sourceUrl ? await snapshotDownloadRecoveryHeaders(context, page, sourceUrl) : {};

  // For PDF links, prepare a Chrome DevTools download sink before clicking.
  // Chrome writes the file directly to an isolated staging directory, so the
  // workflow no longer depends on Playwright Download.saveAs()/path() after a
  // short-lived popup or page has already closed. This is especially important
  // for DGBAS Download.ashx responses, which can close the initiating target
  // immediately after Chrome hands the response to the download manager.
  const browserFileSink = forcePdfDownload && sourceUrl && isLikelyPdfDownloadUrl(sourceUrl)
    ? await createCdpDownloadSink(context, page, sourceUrl, timeoutMs).catch(() => undefined)
    : undefined;

  // Observe native downloads at the BrowserContext level by attaching a
  // download listener to every current page and every page created later.
  // Unlike page.waitForEvent(), closing a short-lived EBAS print/export page
  // does not reject the whole capture operation.
  const nativeDownload = waitForNativeDownload(context, timeoutMs);

  // PDF preview capture remains useful for links that render a PDF instead of
  // emitting a native browser download. Attach the rejection handler now so a
  // context/page closing while we prepare the click cannot become an unhandled
  // Promise rejection in Node.
  const pdfFromContext = waitForPdfResponse(context, timeoutMs, step);
  const safePdfFromContext = pdfFromContext.catch(() => undefined);

  // Attach all listeners before clicking. A download or PDF response can be
  // emitted immediately after the click.
  const capturePromise: Promise<DownloadCapture | undefined> = Promise.any([
    nativeDownload,
    pdfFromContext
  ]).catch(() => undefined);
  await prepareInteraction(locator, page, step.timeoutMs ?? timeoutMs, safePlayback, humanized);
  if (forcePdfDownload && sourceUrl && isLikelyPdfDownloadUrl(sourceUrl)) {
    await preparePdfAnchorForDirectDownload(locator, sourceUrl);
  }
  await locator.click({ timeout: step.timeoutMs ?? timeoutMs });

  // Prefer the browser-owned staging directory when CDP download behavior was
  // configured successfully. The directory is outside the Page/BrowserContext
  // object lifetime, so even an instantly closing download target cannot make
  // the already-written bytes disappear. Legacy Playwright events continue to
  // run in parallel and remain the fallback for browsers where CDP is absent.
  if (browserFileSink) {
    const browserFileCapture = await browserFileSink.capturePromise.catch(() => undefined);
    await browserFileSink.close().catch(() => undefined);
    if (browserFileCapture) return browserFileCapture;
    await fs.rm(browserFileSink.stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }

  let capture = await capturePromise;

  // A native download event can arrive just before a PDF response. Keep the
  // previous preference for an already-buffered PDF, but never let a closed
  // page/context rejection escape as an unhandled error.
  if (capture?.kind === "download") {
    const pdfCapture = await Promise.race([
      safePdfFromContext,
      delay(750).then(() => undefined)
    ]);
    if (pdfCapture) capture = pdfCapture;
  }
  if (capture) return capture.kind === "download" ? { ...capture, url: capture.url ?? sourceUrl, recoveryHeaders } : capture;

  const pages = context.pages().map((candidate: any) => candidate.url()).join(", ");
  throw new Error(`列印或匯出後未收到下載或 PDF 預覽回應。已觀察頁面：${pages}`);
}

type CdpDownloadSink = {
  stagingDir: string;
  capturePromise: Promise<Extract<DownloadCapture, { kind: "browser-file" }>>;
  close: () => Promise<void>;
};

async function createCdpDownloadSink(context: any, page: any, url: string, timeoutMs: number): Promise<CdpDownloadSink> {
  if (typeof context?.newCDPSession !== "function") throw new Error("目前瀏覽器不支援 CDP 下載接管。");
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "automation-studio-chrome-download-"));
  const session = await context.newCDPSession(page);
  let behaviorCommand = "";
  try {
    // Page.setDownloadBehavior is target-scoped and therefore also works for
    // non-default/incognito BrowserContexts. It is deprecated upstream but is
    // still supported by Chromium; Browser.setDownloadBehavior is the fallback
    // for newer channels that remove the Page command.
    try {
      await session.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: stagingDir });
      behaviorCommand = "Page.setDownloadBehavior";
    } catch {
      await session.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: stagingDir, eventsEnabled: true });
      behaviorCommand = "Browser.setDownloadBehavior";
    }
  } catch (error) {
    await session.detach().catch(() => undefined);
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  const capturePromise = waitForCompletedBrowserFile(stagingDir, url, timeoutMs);
  const close = async (): Promise<void> => {
    try {
      if (behaviorCommand === "Page.setDownloadBehavior") {
        await session.send("Page.setDownloadBehavior", { behavior: "default" }).catch(() => undefined);
      } else if (behaviorCommand === "Browser.setDownloadBehavior") {
        await session.send("Browser.setDownloadBehavior", { behavior: "default", eventsEnabled: false }).catch(() => undefined);
      }
    } finally {
      await session.detach().catch(() => undefined);
    }
  };
  return { stagingDir, capturePromise, close };
}

async function waitForCompletedBrowserFile(stagingDir: string, url: string, timeoutMs: number): Promise<Extract<DownloadCapture, { kind: "browser-file" }>> {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  const previousSizes = new Map<string, number>();
  while (Date.now() <= deadline) {
    const entries = await fs.readdir(stagingDir, { withFileTypes: true }).catch(() => [] as any[]);
    const names = entries.filter((entry: any) => entry.isFile?.()).map((entry: any) => String(entry.name));
    const partialNames = new Set(names.filter((name) => /\.(?:crdownload|tmp)$/i.test(name)));
    const completed = names.filter((name) => !/\.(?:crdownload|tmp)$/i.test(name));
    for (const name of completed) {
      const candidate = path.join(stagingDir, name);
      const stat = await fs.stat(candidate).catch(() => undefined);
      if (!stat?.size) continue;
      const previousSize = previousSizes.get(candidate);
      previousSizes.set(candidate, stat.size);
      const matchingPartial = partialNames.has(`${name}.crdownload`) || partialNames.has(`${name}.tmp`);
      if (matchingPartial || previousSize !== stat.size) continue;

      // For PDF download links, verify the file signature before declaring the
      // step successful. This prevents an HTML proxy/error page from being saved
      // with a .pdf filename.
      if (isLikelyPdfDownloadUrl(url)) {
        const handle = await fs.open(candidate, "r").catch(() => undefined);
        if (!handle) continue;
        try {
          const header = Buffer.alloc(5);
          const read = await handle.read(header, 0, 5, 0);
          if (read.bytesRead < 5 || header.toString("ascii") !== "%PDF-") continue;
        } finally {
          await handle.close().catch(() => undefined);
        }
      }
      return {
        kind: "browser-file",
        stagedPath: candidate,
        stagingDir,
        filename: decodedDownloadNameFromUrl(url) || safeFile(name),
        url
      };
    }
    await delay(150);
  }
  throw new Error(`Chrome 已接管下載路徑，但在 ${timeoutMs} ms 內沒有找到完整下載檔案。`);
}

/**
 * Wait for the first native browser download without binding the lifetime of
 * the wait to any single Page. EBAS and similar systems often create a print
 * page, trigger the file download, then close/replace that page immediately.
 * page.waitForEvent("download") rejects when such a page closes; event
 * listeners do not, so page closure is treated as a normal candidate ending.
 */
function waitForNativeDownload(context: any, timeoutMs: number): Promise<DownloadCapture> {
  return new Promise<DownloadCapture>((resolve, reject) => {
    const initialPages = new Set<any>(context.pages());
    const pageHandlers = new Map<any, (download: any) => void>();
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      context.off?.("page", onPage);
      for (const [candidate, handler] of pageHandlers) candidate.off?.("download", handler);
      pageHandlers.clear();
    };

    const finish = (capture: DownloadCapture) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(capture);
    };

    const attachPage = (candidate: any) => {
      if (!candidate || candidate.isClosed?.() || pageHandlers.has(candidate)) return;
      const handler = (download: any) => finish({
        kind: "download",
        download,
        url: download.url?.(),
        popup: initialPages.has(candidate) ? undefined : candidate,
        // Start copying the browser-owned temporary download immediately when
        // the event fires.  Some sites close the download/preview page almost
        // instantly; waiting until later can make saveAs/createReadStream fail
        // on a subsequent run because the page/context has already disappeared.
        stagedFilePromise: stageNativeDownload(download)
      });
      pageHandlers.set(candidate, handler);
      candidate.on?.("download", handler);
    };

    const onPage = (candidate: any) => attachPage(candidate);
    for (const candidate of initialPages) attachPage(candidate);
    context.on?.("page", onPage);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`等待瀏覽器下載逾時（${timeoutMs} ms）。`));
    }, timeoutMs);
  });
}

function isLikelyPdfDownloadUrl(url: string): boolean {
  return /\.pdf(?:$|[?#])/i.test(url) || /\.pdf$/i.test(decodedDownloadNameFromUrl(url));
}

async function preparePdfAnchorForDirectDownload(locator: any, url: string): Promise<void> {
  const filename = decodedDownloadNameFromUrl(url) || (() => {
    try {
      const candidate = decodeURIComponent(path.basename(new URL(url).pathname));
      return /\.pdf$/i.test(candidate) ? candidate : "download.pdf";
    } catch { return "download.pdf"; }
  })();
  await locator.evaluate((element: Element, suggestedName: string) => {
    const anchor = element instanceof HTMLAnchorElement ? element : element.closest("a");
    if (!anchor) return;
    // A download step should never need target=_blank. Removing it prevents a
    // PDF preview tab from opening while Chrome's PDF-download preference turns
    // the same navigation into a native download.
    anchor.removeAttribute("target");
    if (!anchor.getAttribute("download")) anchor.setAttribute("download", suggestedName);
  }, filename).catch(() => undefined);
}

async function readAnchorUrl(locator: any, baseUrl: string): Promise<string | undefined> {
  const href = await locator.evaluate((element: Element) => {
    const anchor = element instanceof HTMLAnchorElement ? element : element.closest("a");
    return anchor?.getAttribute("href") ?? "";
  }).catch(() => "");
  if (!href) return undefined;
  try { return new URL(href, baseUrl).href; } catch { return undefined; }
}


function isCertificateTrustError(error: unknown): boolean {
  const messages: string[] = [];
  let current: any = error;
  const seen = new Set<any>();
  while (current && !seen.has(current)) {
    seen.add(current);
    messages.push(current instanceof Error ? current.message : String(current));
    current = current?.cause;
  }
  const text = messages.join(" ").toLowerCase();
  return [
    "unable to get local issuer certificate",
    "unable to verify the first certificate",
    "self signed certificate",
    "self-signed certificate",
    "depth_zero_self_signed_cert",
    "unable_to_get_issuer_cert",
    "unable_to_verify_leaf_signature"
  ].some((needle) => text.includes(needle));
}


async function stageNativeDownload(download: any): Promise<string | undefined> {
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "automation-studio-download-"));
  const stagedPath = path.join(stagingDir, safeFile(download.suggestedFilename?.() || "download.bin"));
  try {
    // Prefer Playwright's browser-owned temporary file. download.path() waits
    // for completion and is not tied to the lifetime of the popup that started
    // the download. Copy it immediately while the BrowserContext still exists.
    if (typeof download?.path === "function") {
      const browserOwnedPath = await download.path();
      if (browserOwnedPath) {
        await fs.copyFile(browserOwnedPath, stagedPath);
        const stat = await fs.stat(stagedPath);
        if (stat.size) return stagedPath;
      }
    }
  } catch { /* continue with legacy staging methods */ }
  try {
    await download.saveAs(stagedPath);
    const stat = await fs.stat(stagedPath);
    if (!stat.size) throw new Error("staged download is empty");
    return stagedPath;
  } catch {
    try {
      if (await saveDownloadStream(download, stagedPath)) return stagedPath;
    } catch { /* fall through */ }
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    return undefined;
  }
}

async function saveDownloadStream(download: any, filePath: string): Promise<boolean> {
  if (typeof download?.createReadStream !== "function") return false;
  const stream = await download.createReadStream();
  if (!stream) return false;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  if (!body.length) return false;
  await fs.writeFile(filePath, body);
  return true;
}

async function snapshotDownloadRecoveryHeaders(context: any, page: any, url: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  try {
    const userAgent = String(await page.evaluate(() => navigator.userAgent) ?? "").replace(/[\r\n]+/g, " ").trim();
    if (userAgent) headers["User-Agent"] = userAgent;
  } catch { /* best effort */ }
  try {
    const referer = String(page.url?.() ?? "").replace(/[\r\n]+/g, " ").trim();
    if (/^https?:/i.test(referer)) headers.Referer = referer;
  } catch { /* best effort */ }
  try {
    const cookies = await context.cookies(url);
    const cookieHeader = (cookies ?? []).map((cookie: any) => `${cookie.name}=${cookie.value}`).join("; ");
    if (cookieHeader) headers.Cookie = cookieHeader;
  } catch { /* best effort */ }
  return headers;
}

async function runSpawnedCommand(command: string, args: string[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`下載命令逾時（${timeoutMs} ms）。`));
    }, timeoutMs);
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 8192) stderr += String(chunk);
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} 結束代碼 ${code}`));
    });
  });
}

async function downloadWithWindowsNative(url: string, filePath: string, headers: Record<string, string> = {}): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const sanitizedHeaders = Object.entries(headers).filter(([name, value]) => name && value && !/[\r\n]/.test(name + value));
  const commonArgs = ["--location", "--fail", "--silent", "--show-error", "--connect-timeout", "20", "--max-time", "90", "--output", filePath];
  for (const [name, value] of sanitizedHeaders) commonArgs.push("--header", `${name}: ${value}`);
  commonArgs.push(url);
  const systemRoot = process.env.SystemRoot || "C:\Windows";
  const candidates = [path.join(systemRoot, "System32", "curl.exe"), "curl.exe"];
  for (const command of candidates) {
    try {
      await runSpawnedCommand(command, commonArgs, 100_000);
      const stat = await fs.stat(filePath);
      if (stat.size) return true;
    } catch {
      await fs.writeFile(filePath, "").catch(() => undefined);
    }
  }
  return false;
}

async function saveNativeDownloadOrRecover(capture: Extract<DownloadCapture, { kind: "download" }>, context: any, filePath: string, allowedDomains: string[]): Promise<void> {
  // Prefer the copy that was started at the exact moment the browser emitted
  // the download event.  This remains usable even if a short-lived download
  // page closes before the workflow reaches its normal save stage.
  if (capture.stagedFilePromise) {
    const stagedPath = await capture.stagedFilePromise.catch(() => undefined);
    if (stagedPath) {
      try {
        await fs.copyFile(stagedPath, filePath);
        return;
      } finally {
        await fs.rm(path.dirname(stagedPath), { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
  try {
    await capture.download.saveAs(filePath);
    return;
  } catch (saveError) {
    // Prefer the bytes already owned by Playwright before issuing a second HTTPS
    // request. This preserves the old browser-download path and avoids turning a
    // successful browser download into a Node CA failure on corporate networks.
    try {
      if (await saveDownloadStream(capture.download, filePath)) return;
    } catch {
      // Continue to the legacy URL recovery below.
    }

    const url = capture.url;
    if (!url) throw new Error("下載來源頁已關閉，且無法取得原始下載網址以保存檔案。", { cause: saveError });
    assertAllowedUrl(url, allowedDomains);

    // On Windows, use the OS curl (Schannel) before BrowserContext.request.
    // This recovery is independent of Playwright page/context lifetime and uses
    // the Windows certificate store, which is important on corporate networks.
    if (await downloadWithWindowsNative(url, filePath, capture.recoveryHeaders ?? {}).catch(() => false)) return;

    try {
      const response = await context.request.get(url, { timeout: 60_000 });
      if (!response.ok()) throw new Error(`重新取得下載內容失敗：HTTP ${response.status()}。`);
      const body = Buffer.from(await response.body());
      if (!body.length) throw new Error("重新取得的下載內容為空白。");
      await fs.writeFile(filePath, body);
    } catch (recoveryError) {
      const certificateHint = isCertificateTrustError(recoveryError)
        ? " 已嘗試使用瀏覽器既有下載內容，但無可用資料；Node 重新請求又遇到 TLS 憑證信任問題。"
        : "";
      throw new Error(`下載事件已收到，但保存檔案時來源頁面已關閉；重新取得下載內容也失敗。${certificateHint}${recoveryError instanceof Error ? ` ${recoveryError.message}` : ""}`, { cause: saveError });
    }
  }
}

async function waitForPdfResponse(page: any, timeoutMs: number, step: WorkflowStep): Promise<DownloadCapture> {
  const response = await page.waitForEvent("response", {
    timeout: timeoutMs,
    predicate: (candidate: any) => isPdfResponse(candidate)
  });
  const body = Buffer.from(await response.body());
  if (!body.subarray(0, 5).toString("ascii").startsWith("%PDF-")) {
    throw new Error(`PDF 回應內容格式不正確：${response.url()}`);
  }
  return {
    kind: "pdf-response",
    body,
    filename: pdfFilename(response, step),
    url: response.url()
  };
}


export function decodedDownloadNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of ["n", "u"]) {
      const encoded = parsed.searchParams.get(key);
      if (!encoded) continue;
      try {
        const decoded = Buffer.from(encoded, "base64").toString("utf8").trim();
        if (!decoded) continue;
        const normalized = decoded.replace(/\\/g, "/");
        const name = path.basename(normalized);
        if (name && path.extname(name)) return name;
      } catch { /* not a base64 filename/path */ }
    }
  } catch { /* invalid URL */ }
  return "";
}

function isPdfResponse(response: any): boolean {
  const status = Number(response.status?.() ?? 0);
  if (status < 200 || status >= 400) return false;
  const headers = response.headers?.() ?? {};
  const contentType = String(headers["content-type"] ?? "").toLowerCase();
  const disposition = String(headers["content-disposition"] ?? "").toLowerCase();
  const contentRange = String(headers["content-range"] ?? "");
  const url = String(response.url?.() ?? "");
  if (/^bytes\s+\d+-/i.test(contentRange) && !/^bytes\s+0-/i.test(contentRange)) return false;
  const encodedName = decodedDownloadNameFromUrl(url);
  return contentType.includes("application/pdf") || /\.pdf(?:$|[?#])/i.test(url) || /filename[^;=]*=[^;]*\.pdf/i.test(disposition) || /\.pdf$/i.test(encodedName);
}

function pdfFilename(response: any, step: WorkflowStep): string {
  const headers = response.headers?.() ?? {};
  const disposition = String(headers["content-disposition"] ?? "");
  const encoded = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  const quoted = disposition.match(/filename\s*=\s*["']?([^;"']+)/i)?.[1];
  const urlName = (() => {
    try { return decodeURIComponent(path.basename(new URL(response.url()).pathname)); } catch { return ""; }
  })();
  const queryName = decodedDownloadNameFromUrl(response.url());
  const fallback = step.name && /\.pdf$/i.test(step.name) ? step.name : `${step.name || step.id}.pdf`;
  const name = encoded ? decodeURIComponent(encoded) : quoted || (queryName && /\.pdf$/i.test(queryName) ? queryName : "") || (urlName && /\.pdf$/i.test(urlName) ? urlName : fallback);
  return safeFile(name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`);
}


function responseDownloadFilename(response: any, url: string, step: WorkflowStep): string {
  const headers = response.headers?.() ?? {};
  const disposition = String(headers["content-disposition"] ?? "");
  const encoded = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  const quoted = disposition.match(/filename\s*=\s*["']?([^;"']+)/i)?.[1];
  const urlName = (() => {
    try { return decodeURIComponent(path.basename(new URL(url).pathname)); } catch { return ""; }
  })();
  const contentType = String(headers["content-type"] ?? "").toLowerCase();
  const queryName = decodedDownloadNameFromUrl(url);
  let name = encoded ? decodeURIComponent(encoded) : quoted || queryName || urlName || step.name || step.id;
  if (!path.extname(name) && contentType.includes("application/pdf")) name += ".pdf";
  if (!path.extname(name)) name += ".bin";
  return safeFile(name);
}

async function writeTextToClipboard(context: any, page: any, text: string): Promise<void> {
  const origin = (() => { try { return new URL(page.url()).origin; } catch { return undefined; } })();
  if (origin && /^https?:/i.test(origin)) await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin }).catch(() => undefined);
  const copied = await page.evaluate(async (value: string) => {
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return true; }
    } catch { /* fall through */ }
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }, text);
  if (!copied) throw new Error("無法寫入系統剪貼簿。請確認瀏覽器允許剪貼簿權限。");
}

type ScannedListItem = { locator: any; text: string; fingerprint: string };

async function scanVisibleListItems(page: any, step: WorkflowStep, parameters: Record<string, string | boolean>, variables: Record<string, string | boolean>): Promise<ScannedListItem[]> {
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(step.listLimit ?? 20))));
  const scopes = step.autoFrameSearch
    ? orderedFrameScopes(page, step.frame)
    : [resolveFrame(page, step.frame)];
  const found: ScannedListItem[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    for (const rule of step.selectors ?? []) {
      if (rule.strategy === "component") continue;
      const interpolated = interpolate(rule.value, parameters, variables);
      const value = rule.strategy === "css" ? stabilizeRecordedCssSelector(interpolated) : interpolated;
      let locator: any;
      try {
        if (rule.strategy === "role") locator = scope.getByRole(rule.role || "button", { name: value, exact: rule.exact });
        else if (rule.strategy === "label") locator = scope.getByLabel(value, { exact: rule.exact });
        else if (rule.strategy === "placeholder") locator = scope.getByPlaceholder(value, { exact: rule.exact });
        else if (rule.strategy === "text") locator = scope.getByText(value, { exact: rule.exact });
        else if (rule.strategy === "testId") locator = scope.getByTestId(value);
        else if (rule.strategy === "name") locator = scope.locator(`[name=${cssString(value)}]`);
        else if (rule.strategy === "xpath") locator = scope.locator(`xpath=${value}`);
        else locator = scope.locator(value);
        const count = Math.min(await locator.count().catch(() => 0), limit * 3);
        for (let index = 0; index < count && found.length < limit; index += 1) {
          const item = locator.nth(index);
          if (!await item.isVisible().catch(() => false)) continue;
          const mobile = await item.evaluate((element: Element) => Boolean(element.closest('[class*="mobile" i],[id*="mobile" i],[class*="hamburger" i],[class*="offcanvas" i],[class*="drawer" i],[aria-label*="手機"],[title*="手機"]'))).catch(() => false);
          if (mobile) continue;
          const data = await item.evaluate((element: Element) => {
            const html = element as HTMLElement;
            const anchor = element instanceof HTMLAnchorElement ? element : element.closest("a");
            const dataset = Object.fromEntries(Object.entries(html.dataset || {}).filter(([key, val]) => val && /id|key|item|message|conversation|mail/i.test(key)).sort(([a], [b]) => a.localeCompare(b)));
            return {
              text: String(html.innerText || element.textContent || "").replace(/\s+/g, " ").trim(),
              id: html.id || "",
              role: html.getAttribute("role") || "",
              aria: html.getAttribute("aria-label") || "",
              title: html.getAttribute("title") || "",
              href: anchor?.getAttribute("href") || "",
              dataset
            };
          }).catch(() => ({ text: "", id: "", role: "", aria: "", title: "", href: "", dataset: {} }));
          const text = String(data.text || "").trim();
          if (!text) continue;
          const fingerprint = JSON.stringify(data);
          if (seen.has(fingerprint)) continue;
          seen.add(fingerprint);
          found.push({ locator: item, text, fingerprint });
        }
      } catch { /* try next selector/scope */ }
      if (found.length >= limit) return found;
    }
  }
  return found;
}

async function waitForNewListItem(page: any, step: WorkflowStep, parameters: Record<string, string | boolean>, variables: Record<string, string | boolean>, rawBaseline: string, safePlayback: boolean, humanized: boolean, cancelled: () => boolean = () => false): Promise<{ text: string; refreshCount: number }> {
  let baselineRows: Array<{ fingerprint?: string; text?: string }>;
  try {
    const parsed = JSON.parse(rawBaseline);
    if (!Array.isArray(parsed)) throw new Error("not array");
    baselineRows = parsed;
  } catch {
    throw new Error("等待新資料的基準變數不是有效的清單快照；請先使用「擷取清單快照」步驟。");
  }
  const baselineFingerprints = new Set(baselineRows.map((row) => String(row?.fingerprint || "")).filter(Boolean));
  const baselineTexts = new Set(baselineRows.map((row) => String(row?.text || "").replace(/\s+/g, " ").trim()).filter(Boolean));
  const patternSource = step.regexPattern?.trim();
  let pattern: RegExp | undefined;
  if (patternSource) {
    try { pattern = new RegExp(patternSource, step.regexFlags ?? "i"); }
    catch (error) { throw new Error(`等待新資料的正規表示式無效：${error instanceof Error ? error.message : String(error)}`); }
  }
  const deadline = Date.now() + (step.timeoutMs ?? 180_000);
  const refresher = createPeriodicPageRefresher(page, step, deadline);
  let lastSummary = "";
  while (Date.now() <= deadline) {
    if (cancelled()) throw new Error("執行已由使用者取消。");
    await refresher.refreshIfDue();
    const items = await scanVisibleListItems(page, step, parameters, variables).catch(() => [] as ScannedListItem[]);
    lastSummary = items.slice(0, 5).map((item) => item.text).join(" | ");
    for (const item of items) {
      const normalizedText = item.text.replace(/\s+/g, " ").trim();
      const isNew = !baselineFingerprints.has(item.fingerprint) && !baselineTexts.has(normalizedText);
      if (!isNew) continue;
      if (pattern) { pattern.lastIndex = 0; if (!pattern.test(item.text)) continue; }
      if (step.clickOnMatch) {
        await prepareInteraction(item.locator, page, step.timeoutMs ?? 30_000, safePlayback, humanized);
        await item.locator.click({ timeout: Math.min(step.timeoutMs ?? 30_000, 30_000) });
      }
      return { text: item.text, refreshCount: refresher.count() };
    }
    await page.waitForTimeout(Math.min(750, Math.max(1, deadline - Date.now()))).catch(() => undefined);
  }
  throw new Error(`等待基準集合以外的新資料逾時${patternSource ? `（需符合：${patternSource}）` : ""}。目前前幾筆：${lastSummary || "(無)"}`);
}

async function waitForNewFirstItem(page: any, step: WorkflowStep, parameters: Record<string, string | boolean>, variables: Record<string, string | boolean>, baseline: string, cancelled: () => boolean = () => false): Promise<{ text: string; refreshCount: number }> {
  const timeout = step.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeout;
  const refresher = createPeriodicPageRefresher(page, step, deadline);
  const patternSource = step.regexPattern?.trim();
  let pattern: RegExp | undefined;
  if (patternSource) {
    try { pattern = new RegExp(patternSource, step.regexFlags ?? "i"); }
    catch (error) { throw new Error(`等待第一筆新資料的正規表示式無效：${error instanceof Error ? error.message : String(error)}`); }
  }
  let lastText = "";
  while (Date.now() <= deadline) {
    if (cancelled()) throw new Error("執行已由使用者取消。");
    await refresher.refreshIfDue();
    try {
      const locator = await resolveLocatorForStep(page, step, step.selectors ?? [], parameters, variables, "first");
      const text = String((await locator.innerText?.().catch(() => "")) || (await locator.textContent?.().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      if (text) {
        lastText = text;
        const changed = text !== baseline.replace(/\s+/g, " ").trim();
        const matched = !pattern || pattern.test(text);
        if (changed && matched) return { text, refreshCount: refresher.count() };
      }
    } catch { /* list may still be refreshing */ }
    await page.waitForTimeout(Math.min(500, Math.max(1, deadline - Date.now()))).catch(() => undefined);
  }
  const patternLabel = patternSource ? `，且符合樣式 ${patternSource}` : "";
  throw new Error(`等待第一筆新資料逾時：目前第一筆仍未與基準資料不同${patternLabel}。最後讀到：${lastText || "(無)"}`);
}

/** Adopt only a fresh result tab containing the next extraction's explicit wait selector.
 * Never replay the preceding click or adopt a stale tab based only on its URL. */
async function resolveExpectedTabAfterClick(context: any, step: WorkflowStep, project: WorkflowProject, debugDir: string,
  parameters: Record<string, string | boolean>, variables: Record<string, string | boolean>): Promise<void> {
  const state = getTabState(context);
  const pending = state.pendingClickTabs;
  state.pendingClickTabs = undefined;
  const rule = step.waitBefore;
  if (!pending || rule?.kind !== "visible" || !rule.value) return;
  const selector = stabilizeRecordedCssSelector(interpolate(rule.value, parameters, variables));
  const timeout = rule.timeoutMs ?? step.timeoutMs ?? project.browser.defaultTimeoutMs;
  const deadline = Date.now() + timeout;
  let lastTabs = "";
  while (Date.now() < deadline) {
    const pages = (context.pages?.() ?? []).filter((page: any) => !isPageClosed(page));
    const candidates = pages.filter((page: any) => page === pending.origin || !pending.pages.has(page) || pending.pages.get(page) !== page.url());
    const matches: any[] = [];
    for (const candidate of candidates) {
      try {
        const url = String(candidate.url());
        if (!/^https?:/i.test(url)) continue;
        assertAllowedUrl(url, project.allowedDomains);
        if (isPotentialLoginUrl(url)) continue;
        const scopes = step.autoFrameSearch ? [candidate, ...(candidate.frames?.() ?? []).filter((f: any) => f !== candidate.mainFrame?.())] : [candidate];
        for (const scope of scopes) {
          if (await scope.locator(selector).first().isVisible().catch(() => false)) { matches.push(candidate); break; }
        }
      } catch { /* closed tab or inaccessible site */ }
    }
    if (matches.length > 1) throw new Error("TAB_AMBIGUOUS: 多個新結果分頁同時符合擷取元素；請設定更精確的 waitBefore CSS。");
    if (matches.length === 1) {
      state.active = matches[0];
      await appendEvent(debugDir, "cdp_result_tab_adopted", { url: safeAuthUrl(matches[0].url()), fromPopup: matches[0] !== pending.origin });
      return;
    }
    lastTabs = pages.map((item: any) => safeAuthUrl(item.url())).join(" | ");
    await delay(300);
  }
  throw new Error(`TAB_RESULT_TIMEOUT: 點擊後未在新舊目標分頁找到指定擷取元素；分頁：${lastTabs}`);
}

/** Recover only a site-requested login, not a missing CSS selector.
 * This is a same-session, user-driven checkpoint; it cannot bypass MFA or a challenge. */
async function recoverCdpLoginIfNeeded(context: any, page: any, project: WorkflowProject, debugDir: string, resumeTarget?: string): Promise<any> {
  if (project.browser.connectionMode !== "cdp" || project.browser.authStateEnabled !== true) return page;
  const state = getTabState(context);
  const verifyUrl = String(project.browser.authVerifyUrl || project.targetUrl || "");
  const loginVisible = async (candidate: any): Promise<boolean> => {
    if (isPotentialLoginUrl(String(candidate.url?.() ?? ""))) return true;
    try { return await candidate.locator('input[type="password"]:visible,iframe[src*="turnstile"],iframe[src*="recaptcha"]').count() > 0; }
    catch { return false; }
  };
  const currentUrl = String(page.url?.() ?? "");
  const errorPage = /^\/(?:404|403|401|error)\/?$/i.test((() => { try { return new URL(currentUrl).pathname; } catch { return ""; } })());
  const siteLoginPeer = errorPage && (context.pages?.() ?? []).some((candidate: any) => candidate !== page && isPotentialLoginUrl(String(candidate.url?.() ?? "")));
  if (!(await loginVisible(page)) && !siteLoginPeer) return page;
  if (state.authRecovered) throw new Error("AUTH_INVALID: 登入後網站再次要求登入，已停止以避免重複登入。");
  if (project.browser.headless) throw new Error("AUTH_REQUIRED: 此網站需要可見 Chrome 完成人工登入。" );
  state.authRecovered = true;
  const initial = new Map<any, string>((context.pages?.() ?? []).filter((p: any) => !p.isClosed?.()).map((p: any) => [p, String(p.url?.() ?? "")]));
  await appendEvent(debugDir, "cdp_login_required", { url: safeAuthUrl(currentUrl), openTabs: initial.size });
  const deadline = Date.now() + 180_000;
  let stable = 0;
  let selected: any;
  while (Date.now() < deadline) {
    const tabs = (context.pages?.() ?? []).filter((p: any) => !p.isClosed?.());
    const candidates = tabs.filter((candidate: any) => scoreExistingSiteTab(String(candidate.url?.() ?? ""), verifyUrl) >= 10);
    const currentValid = candidates.includes(page) && !(await loginVisible(page));
    const fresh = candidates.filter((candidate: any) => candidate !== page && (!initial.has(candidate) || initial.get(candidate) !== candidate.url()));
    selected = currentValid ? page : fresh.find((candidate: any) => resumeTarget && isRequestedUrlAlreadyOpen(candidate.url(), resumeTarget))
      ?? fresh.sort((a: any, b: any) => scoreExistingSiteTab(b.url(), verifyUrl) - scoreExistingSiteTab(a.url(), verifyUrl))[0];
    if (selected) { stable++; if (stable >= 3) break; } else stable = 0;
    await delay(700);
  }
  if (!selected || stable < 3) throw new Error("AUTH_TIMEOUT: 在 CDP Chrome 等待人工登入已達 180 秒；請確認在同一 Chrome 工作階段登入。");
  state.active = selected;
  selected.setDefaultTimeout?.(project.browser.defaultTimeoutMs);
  const target = resumeTarget || state.lastProtectedUrl;
  if (target && !isRequestedUrlAlreadyOpen(selected.url(), target)) {
    assertAllowedUrl(target, project.allowedDomains);
    await selected.goto(target, { waitUntil: "domcontentloaded", timeout: project.browser.defaultTimeoutMs });
    if (await loginVisible(selected)) throw new Error("AUTH_INVALID: 人工登入後仍轉回登入頁，已停止避免登入循環。");
  }
  await appendEvent(debugDir, "cdp_login_resumed", { url: safeAuthUrl(selected.url()), openTabs: context.pages?.().length ?? 0 });
  return selected;
}

function safeAuthUrl(raw: string): string {
  try { const url = new URL(raw); return url.origin + url.pathname; }
  catch { return String(raw).split("?")[0].split("#")[0]; }
}

/** Bounded, resumable wait for protected CDP routes; no retry of click/submit actions. */
async function applyWaitWithCdpAuth(context: any, page: any, rule: WorkflowStep["waitAfter"], project: WorkflowProject,
  debugDir: string, parameters: Record<string, string | boolean>, variables: Record<string, string | boolean>, autoFrameSearch = false): Promise<void> {
  if (!rule) return;
  if (project.browser.connectionMode !== "cdp" || project.browser.authStateEnabled !== true || !["visible", "attached", "url"].includes(rule.kind)) {
    await applyWait(page, rule, parameters, variables, autoFrameSearch); return;
  }
  let deadline = Date.now() + (rule.timeoutMs ?? project.browser.defaultTimeoutMs);
  while (Date.now() < deadline) {
    const current = getActivePage(context, page);
    const recovered = await recoverCdpLoginIfNeeded(context, current, project, debugDir);
    if (recovered !== current) deadline = Date.now() + (rule.timeoutMs ?? project.browser.defaultTimeoutMs);
    const slice = Math.min(1000, Math.max(100, deadline - Date.now()));
    try { await applyWait(getActivePage(context, page), {...rule, timeoutMs: slice}, parameters, variables, autoFrameSearch); return; }
    catch (error) {
      if (!/timeout|逾時|Timeout/i.test(String(error))) throw error;
    }
  }
  const current = getActivePage(context, page);
  throw new Error(`WAIT_TIMEOUT: ${rule.kind} on ${safeAuthUrl(String(current.url()))}; selector not ready or site still loading.`);
}

async function applyWait(page: any, rule: WorkflowStep["waitAfter"], parameters: Record<string, string | boolean>, variables: Record<string, string | boolean>, autoFrameSearch = false): Promise<void> {
  if (!rule) return;
  autoFrameSearch = autoFrameSearch || rule.autoFrameSearch === true;
  const timeout = rule.timeoutMs ?? 30_000;
  const interpolated = interpolate(rule.value ?? "", parameters, variables);
  const value = ["visible", "hidden", "attached"].includes(rule.kind)
    ? stabilizeRecordedCssSelector(interpolated)
    : interpolated;
  if (rule.kind === "timeout") await page.waitForTimeout(rule.timeoutMs ?? Number(value || 1_000));
  else if (rule.kind === "networkIdle") await page.waitForLoadState("networkidle", { timeout });
  else if (rule.kind === "url") await page.waitForURL(value, { timeout });
  else if (rule.kind === "visible" || rule.kind === "attached") {
    if (autoFrameSearch) await waitForSelectorAcrossFrames(page, value, rule.kind, timeout);
    else await page.locator(value).first().waitFor({ state: rule.kind, timeout });
  } else if (rule.kind === "hidden") await page.locator(value).waitFor({ state: "hidden", timeout });
}

async function waitForSelectorAcrossFrames(page: any, selector: string, state: "visible" | "attached", timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastDetails: string[] = [];
  while (Date.now() <= deadline) {
    const scopes = [page, ...page.frames().filter((frame: any) => frame !== page.mainFrame?.())];
    const details: string[] = [];
    for (let index = 0; index < scopes.length; index += 1) {
      const scope = scopes[index];
      const locator = scope.locator(selector);
      const count = await locator.count().catch(() => 0);
      let visibleCount = 0;
      if (state === "attached" && count > 0) return;
      if (state === "visible" && count > 0) {
        const scanCount = Math.min(count, 100);
        for (let itemIndex = 0; itemIndex < scanCount; itemIndex += 1) {
          if (await locator.nth(itemIndex).isVisible().catch(() => false)) {
            visibleCount += 1;
            return;
          }
        }
      }
      const url = index === 0 ? page.url() : scope.url?.() ?? "";
      details.push(`${index === 0 ? "main" : `frame${index}`}(${url})=${count}${state === "visible" ? `/visible:${visibleCount}` : ""}`);
    }
    lastDetails = details;
    await page.waitForTimeout(Math.min(200, Math.max(25, deadline - Date.now()))).catch(() => undefined);
  }
  throw new Error(`等待元素逾時：${selector}；已搜尋主頁與所有 frame：${lastDetails.join("；")}`);
}

export function stabilizeRecordedCssSelector(value: string): string {
  if (!/google\.[a-z.]+\/url\?|client=internal-element-cse|[?&](?:ved|usg|fexp)=/i.test(value)) return value;
  const title = value.match(/^([a-z][\w-]*).*?(\[title="(?:\\.|[^"])*"\])/i);
  return title ? `${title[1]}${title[2]}:visible` : value;
}

async function verifyStep(page: any, step: WorkflowStep, parameters: Record<string, string | boolean>, variables: Record<string, string | boolean>): Promise<void> {
  const rule = step.verification;
  if (!rule) return;
  const expected = typeof rule.expected === "string" ? interpolate(rule.expected, parameters, variables) : rule.expected;
  if (rule.kind === "url") {
    const actual = page.url();
    if (!actual.includes(String(expected ?? ""))) throw new Error(`網址驗證失敗。預期包含 ${expected}，實際為 ${actual}`);
    return;
  }
  const locator = await resolveLocatorForStep(page, step, rule.selector ?? step.selectors ?? [], parameters, variables);
  const timeout = rule.timeoutMs ?? step.timeoutMs ?? 30_000;
  if (rule.kind === "visible") await locator.waitFor({ state: "visible", timeout });
  else if (rule.kind === "hidden") await locator.waitFor({ state: "hidden", timeout });
  else if (rule.kind === "exists") {
    if (!(await locator.count())) throw new Error("驗證失敗：元件不存在。");
  } else if (rule.kind === "value") {
    const deadline = Date.now() + timeout;
    let actual = await locator.inputValue();
    while (actual !== String(expected ?? "") && Date.now() < deadline) {
      await page.waitForTimeout(Math.min(200, Math.max(1, deadline - Date.now())));
      actual = await locator.inputValue();
    }
    if (actual !== String(expected ?? "")) throw new Error(`欄位值驗證失敗。預期 ${expected}，實際 ${actual}`);
  } else if (rule.kind === "text") {
    const deadline = Date.now() + timeout;
    let actual = (await locator.textContent())?.trim() ?? "";
    while (!actual.includes(String(expected ?? "")) && Date.now() < deadline) {
      await page.waitForTimeout(Math.min(200, Math.max(1, deadline - Date.now())));
      actual = (await locator.textContent())?.trim() ?? "";
    }
    if (!actual.includes(String(expected ?? ""))) throw new Error(`文字驗證失敗。預期包含 ${expected}，實際 ${actual}`);
  } else if (rule.kind === "checked") {
    const actual = await locator.isChecked();
    if (actual !== Boolean(expected)) throw new Error(`勾選狀態驗證失敗。預期 ${expected}，實際 ${actual}`);
  }
}

async function evaluateCondition(page: any, rule: ConditionRule | undefined, parameters: Record<string, string | boolean>, variables: Record<string, string | boolean>): Promise<boolean> {
  if (!rule) return false;
  let actual: unknown;
  if (rule.source === "parameter") actual = parameters[rule.name ?? ""];
  else if (rule.source === "variable") actual = variables[rule.name ?? ""];
  else if (rule.source === "url") actual = page.url();
  else {
    const locator = await resolveLocator(page, rule.selector ?? [], parameters, variables).catch(() => undefined);
    actual = locator ? await locator.count() : 0;
  }
  const expected = interpolate(rule.value ?? "", parameters, variables);
  if (rule.operator === "exists") return Boolean(actual);
  if (rule.operator === "notExists") return !actual;
  if (rule.operator === "equals") return String(actual) === expected;
  if (rule.operator === "notEquals") return String(actual) !== expected;
  return String(actual).includes(expected);
}

async function captureStepState(page: any, step: WorkflowStep, parameters: Record<string, string | boolean>, variables: Record<string, string | boolean>): Promise<Record<string, unknown>> {
  const state: Record<string, unknown> = { url: page.url(), title: await page.title().catch(() => "") };
  if (step.selectors?.length) {
    const locator = await resolveLocatorForStep(page, step, step.selectors, parameters, variables, step.matchMode, step.matchIndex).catch(() => undefined);
    if (locator) {
      state.visible = await locator.isVisible().catch(() => false);
      state.value = await locator.inputValue().catch(() => undefined);
      state.text = await locator.textContent().catch(() => undefined);
      state.checked = await locator.isChecked().catch(() => undefined);
    }
  }
  if (step.componentPath) {
    state.component = await page.evaluate((targetPath: string) => {
      const win = window as any;
      const component = targetPath.split(".").reduce((value: any, key: string) => value?.[key], win) ?? win.Ext?.getCmp?.(targetPath);
      return component?.getValue?.();
    }, step.componentPath).catch(() => undefined);
  }
  return state;
}

function attachObservability(context: any, currentPage: any, run: WorkflowRun, captureConsole: boolean, captureNetwork: boolean): () => void {
  const detachPages: Array<() => void> = [];
  const onPage = (page: any) => {
    void appendEvent(run.debugDir, "page_opened", { url: page.url() });
    detachPages.push(attachPageObservability(page, run, captureConsole, captureNetwork));
  };
  context.on("page", onPage);
  detachPages.push(attachPageObservability(currentPage, run, captureConsole, captureNetwork));
  return () => {
    context.off("page", onPage);
    for (const detach of detachPages) detach();
  };
}

function attachPageObservability(page: any, run: WorkflowRun, captureConsole: boolean, captureNetwork: boolean): () => void {
  const listeners: Array<[string, (...args: any[]) => void]> = [];
  const listen = (event: string, handler: (...args: any[]) => void) => {
    page.on(event, handler);
    listeners.push([event, handler]);
  };
  if (captureConsole) listen("console", (message: any) => void appendEvent(run.debugDir, "console", { level: message.type(), text: message.text(), url: page.url() }));
  if (captureNetwork) {
    listen("requestfailed", (request: any) => void appendEvent(run.debugDir, "request_failed", { url: request.url(), method: request.method(), failure: request.failure()?.errorText }));
    listen("response", (response: any) => {
      if (response.status() >= 400) void appendEvent(run.debugDir, "http_error", { url: response.url(), status: response.status() });
      if ([403, 429].includes(response.status()) && response.request().resourceType() === "document" && response.frame() === page.mainFrame()) {
        recentRateLimits.set(page, { status: response.status(), url: response.url(), at: Date.now() });
      }
    });
  }
  listen("dialog", (dialog: any) => void appendEvent(run.debugDir, "dialog", { dialogType: dialog.type(), message: dialog.message() }));
  return () => {
    for (const [event, handler] of listeners) page.off(event, handler);
  };
}

async function captureFailure(project: WorkflowProject, run: WorkflowRun, page: any, error: unknown): Promise<void> {
  await captureFailureDiagnostics(run.debugDir, page).catch(() => undefined);
  if (project.settings.screenshotMode !== "never") await page.screenshot({ path: path.join(run.debugDir, "failure.png"), fullPage: true }).catch(() => undefined);
  if (project.settings.saveHtmlOnFailure) {
    await fs.writeFile(path.join(run.debugDir, "page.html"), await page.content().catch(() => ""), "utf8");
    const frames = page.frames();
    for (let index = 0; index < frames.length; index += 1) {
      await fs.writeFile(path.join(run.debugDir, `frame-${index}.html`), await frames[index].content().catch(() => ""), "utf8");
    }
  }
  await fs.writeFile(path.join(run.debugDir, "error.txt"), error instanceof Error ? error.stack ?? error.message : String(error), "utf8");
  await fs.writeFile(path.join(run.debugDir, "url.txt"), page.url(), "utf8");
}

async function appendEvent(debugDir: string, type: string, data: Record<string, unknown>): Promise<void> {
  await fs.mkdir(debugDir, { recursive: true });
  await fs.appendFile(path.join(debugDir, "events.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), type, ...data })}\n`, "utf8");
}

async function isHumanVerificationPage(page: any): Promise<boolean> {
  const url = String(page.url?.() ?? "");
  if (/captcha|challenge|recaptcha|turnstile/i.test(url)) return true;
  const challengeFrame = await page.locator('iframe[src*="recaptcha" i],iframe[src*="turnstile" i],iframe[title*="challenge" i]').count().catch(() => 0);
  if (challengeFrame) return true;
  const text = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
  return /機器人驗證|確認您不是機器人|驗證您是人類|安全性檢查|robot verification|verify you are human|checking your browser/i.test(text);
}

async function waitForManualVerification(page: any, debugDir: string, headless: boolean): Promise<void> {
  if (!(await isHumanVerificationPage(page))) return;
  await appendEvent(debugDir, "human_verification_required", { url: page.url(), timeoutMs: 300_000 });
  if (headless) throw new Error("偵測到網站機器人驗證。請關閉背景模式，於顯示的瀏覽器中人工完成驗證後再執行；系統不會自動破解驗證。");
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    if (!(await isHumanVerificationPage(page))) {
      await appendEvent(debugDir, "human_verification_completed", { url: page.url() });
      await page.waitForTimeout(1_000);
      return;
    }
  }
  throw new Error("等待人工完成機器人驗證已超過 5 分鐘。請完成驗證後重新執行此步驟。");
}

async function waitForManualAction(
  page: any,
  debugDir: string,
  step: WorkflowStep,
  parameters: Record<string, string | boolean>,
  variables: Record<string, string | boolean>,
  headless: boolean,
  manuallyContinued: () => boolean,
  cancelled: () => boolean
): Promise<void> {
  if (headless) throw new Error("人工操作步驟需要顯示瀏覽器；請關閉背景模式後再執行。 ");
  const mode = step.manualCompletionMode
    ?? (step.verification?.kind === "url" ? "url" : step.verification ? "element" : "button");
  const timeout = step.timeoutMs ?? 300_000;
  const instruction = interpolate(step.value ?? step.description ?? "請在瀏覽器中完成操作。", parameters, variables);
  const verification: WorkflowStep["verification"] = mode === "url"
    ? { kind: "url", expected: step.manualExpected ?? String(step.verification?.expected ?? "") }
    : mode === "element"
      ? { kind: "visible", selector: step.selectors?.length ? step.selectors : step.verification?.selector }
      : undefined;
  if (mode === "url" && !String(verification?.expected ?? "").trim()) {
    throw new Error("人工操作步驟選擇『網址符合』時，請填入登入後網址包含的文字。 ");
  }
  if (mode === "element" && !(verification?.selector?.length)) {
    throw new Error("人工操作步驟選擇『指定元素出現』時，請在定位方式中設定至少一個 selector。 ");
  }
  await appendEvent(debugDir, "manual_action_required", {
    stepId: step.id,
    instruction,
    completionMode: mode,
    verification,
    timeoutMs: timeout
  });
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (cancelled()) throw new Error("執行已由使用者取消。");
    if (mode === "button") {
      if (manuallyContinued()) {
        await appendEvent(debugDir, "manual_action_completed", { stepId: step.id, url: page.url(), completionMode: mode });
        return;
      }
    } else {
      try {
        await verifyStep(page, { ...step, verification }, parameters, variables);
        await appendEvent(debugDir, "manual_action_completed", { stepId: step.id, url: page.url(), completionMode: mode });
        return;
      } catch {
        // Keep waiting while the user completes login/OTP in the visible browser.
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`人工操作步驟逾時：${instruction}`);
}

function materializeParameters(project: WorkflowProject, input: Record<string, string | boolean>): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (const parameter of project.parameters) {
    const value = input[parameter.name] ?? parameter.defaultValue ?? (parameter.type === "boolean" ? false : "");
    if (parameter.required && value === "") throw new Error(`缺少必填參數：${parameter.label}`);
    result[parameter.name] = value;
  }
  for (const [key, value] of Object.entries(input)) result[key] = value;
  return result;
}

function redactParameters(project: WorkflowProject, parameters: Record<string, string | boolean>): Record<string, string | boolean> {
  const sensitive = new Set(project.parameters.filter((item) => item.sensitive || item.type === "secret").map((item) => item.name));
  return Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, sensitive.has(key) ? "[REDACTED]" : value]));
}

function interpolate(value: unknown, parameters: Record<string, string | boolean>, variables: Record<string, string | boolean>): string {
  return String(value ?? "").replace(/{{\s*([^}]+)\s*}}/g, (_, rawName: string) => {
    const name = rawName.trim();
    return String(variables[name] ?? parameters[name] ?? "");
  });
}

export function normalizeAllowedDomain(value: string): string {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("*.")) return `*.${raw.slice(2).replace(/^\.+|\.+$/g, "")}`;
  try { return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase(); }
  catch { return raw.replace(/^\.+|\.+$/g, ""); }
}

export function isAllowedHostname(hostname: string, allowedDomains: string[]): boolean {
  const host = hostname.toLowerCase();
  if (!allowedDomains.length) return true;
  return allowedDomains.some((entry) => {
    const domain = normalizeAllowedDomain(entry);
    if (!domain) return false;
    if (domain.startsWith("*.")) {
      const base = domain.slice(2);
      return host !== base && host.endsWith(`.${base}`);
    }
    return host === domain;
  });
}

export function assertAllowedUrl(url: string, allowedDomains: string[], context = "網址"): void {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("只允許 http 或 https 網址。");
  if (!isAllowedHostname(parsed.hostname, allowedDomains)) {
    throw new Error(`${context} 的網域 ${parsed.hostname} 不在允許清單內。請加入 ${parsed.hostname}；若確實需要允許其所有子網域，可明確加入 *.${parsed.hostname.split(".").slice(-2).join(".")}。`);
  }
}

export function preflightWorkflowDomains(project: WorkflowProject, parameters: Record<string, string | boolean>, steps: WorkflowStep[] = project.steps): { requiredDomains: string[]; missingDomains: string[] } {
  const variables: Record<string, string | boolean> = {};
  const expandValue = (value: unknown) => String(value ?? "").replace(/{{\s*([^}]+)\s*}}/g, (_m, raw: string) => String(variables[raw.trim()] ?? parameters[raw.trim()] ?? ""));
  const urls: string[] = [];
  const visit = (items: WorkflowStep[]) => {
    for (const step of items) {
      if (!step.enabled) continue;
      if (step.kind === "navigate" || step.kind === "newTab") {
        const raw = expandValue(step.url || String(step.value || (step.kind === "navigate" ? project.targetUrl : "")));
        if (/^https?:/i.test(raw)) urls.push(raw);
      }
      visit(step.thenSteps ?? []);
      visit(step.elseSteps ?? []);
      visit(step.steps ?? []);
    }
  };
  visit(steps);
  const requiredDomains = Array.from(new Set(urls.map((url) => new URL(url).hostname.toLowerCase())));
  const missingDomains = requiredDomains.filter((host) => !isAllowedHostname(host, project.allowedDomains));
  return { requiredDomains, missingDomains };
}

type StudioTabState = { active: any; named: Map<string, any>; lastProtectedUrl?: string; authRecovered?: boolean;
  pendingClickTabs?: { origin: any; pages: Map<any, string> } };

function getTabState(context: any): StudioTabState {
  if (!context.__automationStudioTabState) {
    const first = context.pages?.()[0];
    context.__automationStudioTabState = { active: first, named: new Map<string, any>() };
  }
  return context.__automationStudioTabState as StudioTabState;
}

function initializeTabState(context: any, page: any): void {
  const state = getTabState(context);
  state.active = page;
  state.lastProtectedUrl = undefined;
  state.authRecovered = false;
  state.pendingClickTabs = undefined;
}

function getActivePage(context: any, fallback: any): any {
  const state = getTabState(context);
  if (state.active && !isPageClosed(state.active)) return state.active;
  const open = context.pages?.().filter((item: any) => !isPageClosed(item)) ?? [];
  state.active = open.at(-1) ?? fallback;
  return state.active;
}

async function resolveTabTarget(context: any, step: WorkflowStep, parameters: Record<string, string | boolean>, variables: Record<string, string | boolean>): Promise<any> {
  const state = getTabState(context);
  const pages = (context.pages?.() ?? []).filter((item: any) => !isPageClosed(item));
  const mode = step.tabTargetMode ?? "name";
  const targetValue = interpolate(step.tabTarget ?? step.value ?? "", parameters, variables).trim();
  let target: any;
  if (mode === "name") {
    target = state.named.get(targetValue);
    if (target && isPageClosed(target)) target = undefined;
  } else if (mode === "url") {
    target = pages.find((item: any) => String(item.url?.() ?? "").includes(targetValue));
  } else if (mode === "title") {
    for (const candidate of pages) {
      const title = await candidate.title().catch(() => "");
      if (title.includes(targetValue)) { target = candidate; break; }
    }
  } else if (mode === "index") {
    const index = Math.max(1, Math.trunc(Number(step.tabIndex ?? step.tabTarget ?? 1)));
    target = pages[index - 1];
  }
  if (!target) {
    const summary = await Promise.all(pages.map(async (candidate: any, index: number) => `${index + 1}. ${await describePage(candidate)}`));
    throw new Error(`找不到指定分頁（模式：${mode}，條件：${targetValue || step.tabIndex || "未填"}）。目前分頁：${summary.join("；") || "無"}`);
  }
  return target;
}

async function describePage(page: any): Promise<string> {
  const title = await page.title?.().catch(() => "") ?? "";
  return title ? `${title} (${page.url()})` : page.url();
}

function countEnabledSteps(steps: WorkflowStep[]): number {
  return steps.reduce((total, step) => total + (step.enabled ? 1 : 0) + countEnabledSteps(step.thenSteps ?? []) + countEnabledSteps(step.elseSteps ?? []) + countEnabledSteps(step.steps ?? []), 0);
}

function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if ((error as {code?: string})?.code === "AUTH_INVALID") return "AUTH_INVALID";
  if (isHumanVerificationError(error)) return "HUMAN_VERIFICATION_REQUIRED";
  if (isRateLimitError(error)) return "RATE_LIMITED";
  if (/Playwright 執行核心/.test(message)) return "RUNTIME_MISSING";
  if (/download|下載/i.test(message)) return "DOWNLOAD_FAILED";
  if (/timeout|逾時/i.test(message)) return "TIMEOUT";
  if (/selector|定位|找不到/.test(message)) return "ELEMENT_NOT_FOUND";
  return "WORKFLOW_FAILED";
}

function isHumanVerificationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /機器人驗證|安全驗證|人工完成驗證|驗證已超過|Cloudflare|Turnstile/i.test(message);
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP (403|429)|RATE_LIMITED|網站負載/i.test(message);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : minimum));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isPageClosed(page: any): boolean {
  try { return !page || Boolean(page.isClosed?.()); } catch { return true; }
}

export function safeFile(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").trim() || "artifact";
  // Keep the extension when truncating.  A PDF response can have a very long
  // Content-Disposition filename; slicing the whole string after adding .pdf
  // previously removed the extension and Windows could not associate it with
  // a PDF viewer.
  const extension = path.extname(cleaned);
  const base = extension ? cleaned.slice(0, -extension.length) : cleaned;
  const maximum = 180;
  if (cleaned.length <= maximum) return cleaned;
  if (extension && extension.length < maximum) return `${base.slice(0, maximum - extension.length)}${extension}`;
  return base.slice(0, maximum) || "artifact";
}

function samePageUrl(current: string, target: string): boolean {
  try {
    const currentUrl = new URL(current);
    const targetUrl = new URL(target);
    currentUrl.hash = "";
    targetUrl.hash = "";
    return currentUrl.href === targetUrl.href;
  } catch {
    return current === target;
  }
}

export function resolveDownloadFileName(originalName: string, step: WorkflowStep, expand: (value: unknown) => string): string {
  if (step.downloadFileNameMode !== "custom") return safeFile(originalName);
  const configured = expand(step.downloadFileName ?? "").trim();
  if (!configured) throw new Error("下載檔名已設定為自訂，但尚未填入名稱。");
  const originalExtension = path.extname(originalName);
  const configuredBase = path.basename(configured, path.extname(configured)).trim() || "download";
  // The source file decides its content type. Keep its extension even when a
  // user supplies another extension, so a PDF is never saved as a misleading
  // .txt/.bin file.
  return safeFile(`${configuredBase}${originalExtension}`);
}

export function appendDownloadTimestamp(fileName: string, now = new Date()): string {
  const extension = path.extname(fileName);
  const base = extension ? fileName.slice(0, -extension.length) : fileName;
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return safeFile(`${base}-${stamp}${extension}`);
}

export async function uniquePath(directory: string, fileName: string): Promise<string> {
  const extension = path.extname(fileName);
  const base = extension ? fileName.slice(0, -extension.length) : fileName;
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = path.join(directory, index === 1 ? fileName : `${base} (${index})${extension}`);
    try {
      const reservation = await fs.open(candidate, "wx");
      await reservation.close();
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`無法建立不重複的下載檔名：${fileName}`);
}

function cssString(value: string): string {
  return JSON.stringify(value);
}

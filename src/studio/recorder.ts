import { prepareStudioChromium } from "./stealth.ts";
import { browserLaunchMessage, DESKTOP_VIEWPORT, resolveStudioBrowser } from "./browser.ts";
import { connectToCdpBrowser } from "./cdp.ts";
import { createId } from "./store.ts";
import { ensurePdfDownloadPreference, resolveProjectProfileDir } from "./profile.ts";
import type { RecorderEvent, WorkflowProject } from "./types.ts";

const RECORDER_DOCUMENT_VERSION = "1.2.2-recorder-keyboard-upload-assertion";
const RECORDER_WATCHDOG_MS = 2_500;
const RECORDER_BRIDGE_POLL_MS = 500;
const RECORDER_CONSOLE_PREFIX = "__AUTOMATION_STUDIO_RECORDER_BRIDGE__";

interface RecorderSession {
  projectId: string;
  browser?: any;
  context: any;
  page: any;
  events: RecorderEvent[];
  startedAt: string;
  browserSource: string;
  stealth?: boolean;
  navigationError?: string;
  recordingEnabled: boolean;
  assertionMode?: "visible" | "text" | "value";
  lastDiagnostic?: RecorderDiagnostic;
  externalBrowser: boolean;
  watchedPages: WeakSet<object>;
  healthTimer?: ReturnType<typeof setInterval>;
  bridgeTimer?: ReturnType<typeof setInterval>;
  healthCheckRunning: boolean;
  healthCheckPromise?: Promise<void>;
  bridgeDrainRunning: boolean;
  frameHealth: RecorderFrameHealth;
  transportHealth: RecorderTransportHealth;
  seenTransportIds: Map<string, number>;
  revision: number;
  waiters: Set<() => void>;
}

interface RecorderDiagnostic {
  createdAt: string;
  eventType: string;
  tag: string;
  role?: string;
  className?: string;
  frameUrl?: string;
  framePath?: string[];
  result: "recorded" | "ignored";
  reason: string;
}

interface RecorderFrameHealth {
  lastCheckedAt?: string;
  pages: number;
  frames: number;
  healthyFrames: number;
  bindingFrames: number;
  repairedFrames: number;
  lastRepairAt?: string;
}

interface RecorderTransportHealth {
  bindingEvents: number;
  bridgeEvents: number;
  consoleEvents: number;
  duplicates: number;
  lastEventAt?: string;
  lastTransport?: "binding" | "bridge" | "console";
}

export interface ActiveRecorderBrowserSession {
  context: any;
  page: any;
  browserSource: string;
  stealth?: boolean;
  release: () => void;
}

interface RecorderStatus {
  active: boolean;
  assertionMode?: "visible" | "text" | "value";
  revision: number;
  startedAt?: string;
  events: RecorderEvent[];
  url?: string;
  browserSource?: string;
  navigationError?: string;
  lastDiagnostic?: RecorderDiagnostic;
  frameHealth?: RecorderFrameHealth;
  transportHealth?: RecorderTransportHealth;
}

export class RecorderManager {
  private readonly sessions = new Map<string, RecorderSession>();
  private readonly pendingStatuses = new Map<string, RecorderStatus>();
  private readonly loadPlaywright: typeof importPlaywright;

  constructor(loadPlaywright: typeof importPlaywright = importPlaywright) {
    this.loadPlaywright = loadPlaywright;
  }

  async start(project: WorkflowProject): Promise<{ projectId: string; startedAt: string; browserSource: string; url: string; navigationError?: string }> {
    await this.stop(project.id).catch(() => undefined);
    this.pendingStatuses.delete(project.id);
    const playwright = await this.loadPlaywright();
    const cdpMode = project.browser.connectionMode === "cdp";
    const chromium = await prepareStudioChromium(playwright, project.browser);
    const profileDir = resolveProjectProfileDir(project.id);
    let context: any;
    let page: any;
    let launchedBrowser: any;
    let browserSource = "";
    let externalBrowser = false;

    if (cdpMode) {
      const attached = await connectToCdpBrowser(playwright, project.browser);
      launchedBrowser = attached.browser;
      context = attached.context;
      page = attached.page;
      browserSource = `既有 Chrome（CDP：${attached.endpoint}）`;
      externalBrowser = true;
      if (project.browser.stealth === true) browserSource += "（CDP 不套用 Stealth）";
    } else {
      const browser = await resolveStudioBrowser(playwright, project.browser.channel);
      if (browser.available === false) throw new Error(browserLaunchMessage(project.browser.channel, browser, new Error("runtime unavailable")));
      const launchOptions = {
        headless: false,
        ...(browser.channel ? { channel: browser.channel } : {}),
        ...(browser.executablePath ? { executablePath: browser.executablePath } : {}),
        args: ["--new-window"],
        slowMo: project.browser.slowMoMs
      };
      try {
        if (project.browser.reuseProfile) {
          if (project.browser.downloadPdfInsteadOfPreview === true) await ensurePdfDownloadPreference(profileDir);
          context = await chromium.launchPersistentContext(profileDir, {
            ...launchOptions,
            acceptDownloads: true,
            viewport: DESKTOP_VIEWPORT
          });
        } else {
          launchedBrowser = await chromium.launch(launchOptions);
          context = await launchedBrowser.newContext({ acceptDownloads: true, viewport: DESKTOP_VIEWPORT });
        }
      } catch (error) {
        await launchedBrowser?.close?.().catch(() => undefined);
        throw new Error(browserLaunchMessage(project.browser.channel, browser, error), { cause: error });
      }
      page = context.pages()[0] ?? await context.newPage();
      browserSource = browser.source + (project.browser.stealth === true ? "（Stealth 已啟用）" : "");
    }

    const session: RecorderSession = {
      projectId: project.id,
      browser: launchedBrowser,
      context,
      page,
      events: [],
      startedAt: new Date().toISOString(),
      browserSource,
      stealth: project.browser.stealth === true && !cdpMode,
      recordingEnabled: true,
      externalBrowser,
      watchedPages: new WeakSet<object>(),
      healthCheckRunning: false,
      bridgeDrainRunning: false,
      frameHealth: { pages: 0, frames: 0, healthyFrames: 0, bindingFrames: 0, repairedFrames: 0 },
      transportHealth: { bindingEvents: 0, bridgeEvents: 0, consoleEvents: 0, duplicates: 0 },
      seenTransportIds: new Map<string, number>(),
      revision: 1,
      waiters: new Set<() => void>()
    };
    this.sessions.set(project.id, session);
    const initialUrl = page.url();
    session.events.push({
      id: createId("record"),
      createdAt: new Date().toISOString(),
      type: "navigate",
      label: cdpMode ? "接管目前分頁" : "開啟目標網站",
      url: cdpMode && /^https?:/i.test(initialUrl) ? initialUrl : project.targetUrl,
      selector: []
    });
    context.once("close", () => {
      const current = this.sessions.get(project.id);
      if (current?.context === context) {
        if (current.healthTimer) clearInterval(current.healthTimer);
        if (current.bridgeTimer) clearInterval(current.bridgeTimer);
        this.notifySession(current);
        this.preserveStoppedSession(current);
        this.sessions.delete(project.id);
      }
    });
    context.on?.("response", (response: any) => {
      const current = this.sessions.get(project.id);
      if (!current || !isPdfResponse(response)) return;
      const cutoff = Date.now() - 10_000;
      const recent = [...current.events].reverse().find((event) =>
        event.type === "click"
        && Date.parse(event.createdAt) >= cutoff
        && pdfResponseMatchesTarget(response, event.targetUrl)
      );
      if (recent) recent.type = "download";
    });
    await context.exposeBinding("__automationStudioDiagnostic", (source: unknown, raw: Omit<RecorderDiagnostic, "createdAt"> & { transportId?: string }) => {
      this.ingestRecorderDiagnostic(project.id, raw, recorderFrameInfo(source), "binding");
    });
    await context.exposeBinding("__automationStudioRecord", (source: unknown, raw: Omit<RecorderEvent, "id" | "createdAt"> & { transportId?: string }) => {
      this.ingestRecorderEvent(project.id, raw, recorderFrameInfo(source), "binding");
    });
    await context.addInitScript(recorderScript);

    // Keep the recorder attached to every page/frame for the entire recording
    // lifetime. addInitScript covers normal navigations; the lifecycle hooks and
    // low-frequency watchdog also repair legacy pages that replace their
    // Document in-place (document.open/write, ExtJS frame refresh, old KMS UI).
    for (const existingPage of context.pages?.() ?? []) this.attachRecorderPageLifecycle(project.id, existingPage);
    context.on?.("page", (newPage: any) => {
      const current = this.sessions.get(project.id);
      if (!current || newPage?.isClosed?.()) return;
      current.page = newPage;
      this.notifySession(current);
      this.attachRecorderPageLifecycle(project.id, newPage);
      void this.refreshRecorderHealth(project.id, true);
    });
    await this.refreshRecorderHealth(project.id, true);
    session.healthTimer = setInterval(() => void this.refreshRecorderHealth(project.id, false), RECORDER_WATCHDOG_MS);
    (session.healthTimer as any).unref?.();
    session.bridgeTimer = setInterval(() => void this.drainRecorderBridge(project.id), RECORDER_BRIDGE_POLL_MS);
    (session.bridgeTimer as any).unref?.();
    await page.bringToFront().catch(() => undefined);
    if (!cdpMode) {
      try {
        await page.goto(project.targetUrl, { waitUntil: "commit", timeout: 45_000 });
      } catch (error) {
        session.navigationError = error instanceof Error ? error.message : String(error);
      }
      await page.bringToFront().catch(() => undefined);
      await this.refreshRecorderHealth(project.id, true);
    }
    return {
      projectId: project.id,
      startedAt: session.startedAt,
      browserSource,
      url: page.url(),
      navigationError: session.navigationError
    };
  }

  status(projectId: string): RecorderStatus {
    const session = this.sessions.get(projectId);
    if (session) {
      return {
        active: Boolean(currentRecorderPage(session)),
        revision: session.revision,
        assertionMode: session.assertionMode,
        startedAt: session.startedAt,
        events: session.events,
        url: currentRecorderPage(session)?.url() ?? session.page.url(),
        browserSource: session.browserSource,
        navigationError: session.navigationError,
        lastDiagnostic: session.lastDiagnostic,
        frameHealth: session.frameHealth,
        transportHealth: session.transportHealth
      };
    }
    const pending = this.pendingStatuses.get(projectId);
    return pending ? { ...pending, events: [...pending.events] } : { active: false, revision: 0, events: [] };
  }

  async waitForStatus(projectId: string, afterRevision: number, timeoutMs = 25_000): Promise<RecorderStatus> {
    const session = this.sessions.get(projectId);
    if (!session || session.revision !== afterRevision) return this.status(projectId);
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        session.waiters.delete(finish);
        resolve();
      };
      timer = setTimeout(finish, Math.max(1_000, Math.min(30_000, timeoutMs)));
      (timer as any).unref?.();
      session.waiters.add(finish);
      if (session.revision !== afterRevision || this.sessions.get(projectId) !== session) finish();
    });
    return this.status(projectId);
  }

  async focus(projectId: string): Promise<RecorderStatus> {
    const session = this.sessions.get(projectId);
    const page = session ? currentRecorderPage(session) : undefined;
    if (!session || !page) {
      throw new Error("目前沒有可顯示的錄製瀏覽器。請重新按「啟動瀏覽器並錄製」。");
    }
    session.page = page;
    await page.bringToFront();
    return this.status(projectId);
  }

  clear(projectId: string): void {
    const session = this.sessions.get(projectId);
    this.pendingStatuses.delete(projectId);
    if (session) {
      session.events.length = 0;
      this.notifySession(session);
    }
  }

  peekActiveSession(projectId: string): ActiveRecorderBrowserSession | undefined {
    const session = this.sessions.get(projectId);
    const page = session ? currentRecorderPage(session) : undefined;
    if (!session || !page) return undefined;
    session.page = page;
    return { context: session.context, page, browserSource: session.browserSource, stealth: session.stealth, release: () => undefined };
  }

  async adoptNewestPage(projectId: string): Promise<ActiveRecorderBrowserSession | undefined> {
    const session = this.sessions.get(projectId);
    if (!session) return undefined;
    const pages = (session.context.pages?.() ?? []).filter((page: any) => !page.isClosed?.());
    const page = pages.at(-1) ?? currentRecorderPage(session);
    if (!page) return undefined;
    session.page = page;
    await page.bringToFront?.().catch(() => undefined);
    return { context: session.context, page, browserSource: session.browserSource, stealth: session.stealth, release: () => undefined };
  }

  acquireActiveSession(projectId: string): ActiveRecorderBrowserSession | undefined {
    const session = this.sessions.get(projectId);
    const page = session ? currentRecorderPage(session) : undefined;
    if (!session || !page) return undefined;
    session.page = page;
    session.recordingEnabled = false;
    let released = false;
    return {
      context: session.context,
      page,
      browserSource: session.browserSource,
      stealth: session.stealth,
      release: () => {
        if (released) return;
        released = true;
        const current = this.sessions.get(projectId);
        if (current === session) current.recordingEnabled = true;
      }
    };
  }

  private attachRecorderPageLifecycle(projectId: string, page: any): void {
    const session = this.sessions.get(projectId);
    if (!session || !page || session.watchedPages.has(page)) return;
    session.watchedPages.add(page);
    const refreshFrame = (frame: any) => void this.installRecorderInFrame(projectId, frame);
    page.on?.("frameattached", refreshFrame);
    page.on?.("framenavigated", refreshFrame);
    page.on?.("console", (message: any) => this.ingestRecorderConsole(projectId, message));
    page.on?.("domcontentloaded", () => void this.refreshRecorderHealth(projectId, true));
    page.on?.("load", () => void this.refreshRecorderHealth(projectId, true));
    void this.refreshRecorderHealth(projectId, true);
  }

  async flush(projectId: string): Promise<void> {
    const session = this.sessions.get(projectId);
    if (!session || !session.recordingEnabled) return;
    for (const page of session.context.pages?.() ?? []) {
      for (const frame of page.frames?.() ?? [page]) {
        if (typeof frame.evaluate !== "function") continue;
        const envelopes = await frame.evaluate(() => {
          const win = window as any;
          win.__automationStudioRecorderFlush?.();
          let bridgeWindow = win;
          try { if (win.top && win.top.location?.origin === location.origin) bridgeWindow = win.top; } catch { /* cross-origin owns its queue */ }
          const queue = bridgeWindow.__automationStudioRecorderBridgeQueue;
          bridgeWindow.__automationStudioRecorderBridgeQueue = [];
          return Array.isArray(queue) ? queue : [];
        }).catch(() => []);
        for (const envelope of Array.isArray(envelopes) ? envelopes : []) {
          if (envelope?.kind === "event" && envelope.payload) this.ingestRecorderEvent(projectId, envelope.payload, {}, "bridge");
        }
      }
    }
  }

  async setAssertionMode(projectId: string, mode?: "visible" | "text" | "value"): Promise<void> {
    const session = this.sessions.get(projectId);
    if (!session || !session.recordingEnabled) throw new Error("請先啟動錄製。");
    if (mode && !["visible", "text", "value"].includes(mode)) throw new Error("不支援的驗證種類。");
    session.assertionMode = mode;
    await this.refreshRecorderHealth(projectId, true);
    this.notifySession(session);
  }

  private async installRecorderInFrame(projectId: string, frame: any): Promise<boolean> {
    const session = this.sessions.get(projectId);
    if (!session || !frame || frame.isDetached?.()) return false;
    try {
      const healthy = await frame.evaluate((version: string) => (document as any).__automationStudioRecorderDocumentVersion === version, RECORDER_DOCUMENT_VERSION);
      if (!healthy) await frame.evaluate(recorderScript);
      await frame.evaluate((mode: string | undefined) => {
        (window as any).__automationStudioAssertionMode = mode;
      }, session.assertionMode);
      if (healthy) return true;
      const repaired = await frame.evaluate((version: string) => (document as any).__automationStudioRecorderDocumentVersion === version, RECORDER_DOCUMENT_VERSION).catch(() => false);
      if (repaired) {
        session.frameHealth.repairedFrames += 1;
        session.frameHealth.lastRepairAt = new Date().toISOString();
      }
      return Boolean(repaired);
    } catch {
      return false;
    }
  }

  private async refreshRecorderHealth(projectId: string, force: boolean): Promise<void> {
    const session = this.sessions.get(projectId);
    if (!session) return;
    if (session.healthCheckPromise) {
      await session.healthCheckPromise;
      if (!force) return;
    }
    const task = this.performRecorderHealthRefresh(projectId, force);
    session.healthCheckPromise = task;
    try { await task; } finally {
      if (session.healthCheckPromise === task) session.healthCheckPromise = undefined;
    }
  }

  private async performRecorderHealthRefresh(projectId: string, force: boolean): Promise<void> {
    const session = this.sessions.get(projectId);
    if (!session || session.healthCheckRunning) return;
    if (!force && session.frameHealth.lastCheckedAt && Date.now() - Date.parse(session.frameHealth.lastCheckedAt) < RECORDER_WATCHDOG_MS - 100) return;
    session.healthCheckRunning = true;
    try {
      const pages = (session.context.pages?.() ?? []).filter((candidate: any) => !candidate.isClosed?.());
      let frames = 0;
      let healthyFrames = 0;
      let bindingFrames = 0;
      for (const candidate of pages) {
        if (!session.watchedPages.has(candidate)) this.attachRecorderPageLifecycle(projectId, candidate);
        const candidateFrames = candidate.frames?.() ?? [];
        if (!candidateFrames.length) {
          frames += 1;
          if (await this.installRecorderInFrame(projectId, candidate)) healthyFrames += 1;
          if (await recorderBindingAvailable(candidate)) bindingFrames += 1;
          continue;
        }
        for (const frame of candidateFrames) {
          frames += 1;
          if (await this.installRecorderInFrame(projectId, frame)) healthyFrames += 1;
          if (await recorderBindingAvailable(frame)) bindingFrames += 1;
        }
      }
      session.frameHealth.pages = pages.length;
      session.frameHealth.frames = frames;
      session.frameHealth.healthyFrames = healthyFrames;
      session.frameHealth.bindingFrames = bindingFrames;
      session.frameHealth.lastCheckedAt = new Date().toISOString();
    } finally {
      session.healthCheckRunning = false;
    }
  }

  private ingestRecorderEvent(
    projectId: string,
    raw: Omit<RecorderEvent, "id" | "createdAt"> & { transportId?: string },
    frameInfo: Pick<RecorderEvent, "frameUrl" | "framePath">,
    transport: "binding" | "bridge" | "console"
  ): void {
    const current = this.sessions.get(projectId);
    if (!current || !current.recordingEnabled) return;
    const transportId = String(raw.transportId ?? "").trim();
    if (transportId && this.isDuplicateTransport(current, transportId)) return;
    const rawEvent = raw as any;
    if (rawEvent.cancelled === true) {
      current.assertionMode = undefined;
      void this.refreshRecorderHealth(projectId, true);
      this.notifySession(current);
      return;
    }
    const selector = normalizeRecorderSelectorCandidates(rawEvent);
    const {
      transportId: _transportId,
      selector: _selector,
      selectors: _selectors,
      selectorBackup: _selectorBackup,
      elementMeta: _elementMeta,
      ...eventRaw
    } = rawEvent;
    // The page itself knows the exact child frame that dispatched the DOM event.
    // On old nested-frame sites Playwright's binding source can occasionally point
    // at the parent execution context, so only use source-derived frame data as a
    // fallback. Otherwise a click recorded in DocContent is incorrectly replayed
    // against mainFrame.
    const enriched = {
      ...frameInfo,
      ...eventRaw,
      selector,
      ...(validFrameUrl(rawEvent.frameUrl) ? { frameUrl: String(rawEvent.frameUrl) } : {}),
      ...(normalizeFramePath(rawEvent.framePath).length ? { framePath: normalizeFramePath(rawEvent.framePath) } : {})
    } as Omit<RecorderEvent, "id" | "createdAt">;
    if (enriched.type === "assert") {
      current.assertionMode = undefined;
      void this.refreshRecorderHealth(projectId, true);
    }
    if (enriched.type === "dblclick") removeRecentMatchingClicks(current.events, enriched);
    current.events.push({ ...enriched, id: createId("record"), createdAt: new Date().toISOString() });
    this.noteTransportEvent(current, transport);
    this.notifySession(current);
  }

  private ingestRecorderDiagnostic(
    projectId: string,
    raw: Omit<RecorderDiagnostic, "createdAt"> & { transportId?: string },
    frameInfo: Pick<RecorderEvent, "frameUrl" | "framePath">,
    transport: "binding" | "bridge" | "console"
  ): void {
    const current = this.sessions.get(projectId);
    if (!current || !current.recordingEnabled) return;
    const transportId = String(raw.transportId ?? "").trim();
    if (transportId && this.isDuplicateTransport(current, transportId)) return;
    const { transportId: _transportId, ...diagnosticRaw } = raw as any;
    const rawFramePath = normalizeFramePath((diagnosticRaw as any).framePath);
    const sourceFramePath = normalizeFramePath(frameInfo.framePath);
    const rawFrameUrl = validFrameUrl((diagnosticRaw as any).frameUrl) ? String((diagnosticRaw as any).frameUrl) : undefined;
    const sourceFrameUrl = validFrameUrl(frameInfo.frameUrl) ? String(frameInfo.frameUrl) : undefined;
    current.lastDiagnostic = {
      ...diagnosticRaw,
      ...(rawFrameUrl || sourceFrameUrl ? { frameUrl: rawFrameUrl ?? sourceFrameUrl } : {}),
      ...(rawFramePath.length || sourceFramePath.length ? { framePath: rawFramePath.length ? rawFramePath : sourceFramePath } : {}),
      createdAt: new Date().toISOString()
    };
    this.noteTransportEvent(current, transport);
    this.notifySession(current);
  }


  private notifySession(session: RecorderSession): void {
    session.revision += 1;
    const waiters = [...session.waiters];
    session.waiters.clear();
    for (const waiter of waiters) waiter();
  }

  private isDuplicateTransport(session: RecorderSession, transportId: string): boolean {
    const now = Date.now();
    const previous = session.seenTransportIds.get(transportId);
    if (previous) {
      session.transportHealth.duplicates += 1;
      return true;
    }
    session.seenTransportIds.set(transportId, now);
    if (session.seenTransportIds.size > 600) {
      const cutoff = now - 120_000;
      for (const [key, at] of session.seenTransportIds) {
        if (at < cutoff || session.seenTransportIds.size > 450) session.seenTransportIds.delete(key);
        if (session.seenTransportIds.size <= 450) break;
      }
    }
    return false;
  }

  private noteTransportEvent(session: RecorderSession, transport: "binding" | "bridge" | "console"): void {
    if (transport === "binding") session.transportHealth.bindingEvents += 1;
    else if (transport === "bridge") session.transportHealth.bridgeEvents += 1;
    else session.transportHealth.consoleEvents += 1;
    session.transportHealth.lastEventAt = new Date().toISOString();
    session.transportHealth.lastTransport = transport;
  }

  private ingestRecorderConsole(projectId: string, message: any): void {
    const text = String(message?.text?.() ?? "");
    if (!text.startsWith(RECORDER_CONSOLE_PREFIX)) return;
    try {
      const envelope = JSON.parse(text.slice(RECORDER_CONSOLE_PREFIX.length));
      if (envelope?.kind === "event" && envelope.payload) this.ingestRecorderEvent(projectId, envelope.payload, {}, "console");
      else if (envelope?.kind === "diagnostic" && envelope.payload) this.ingestRecorderDiagnostic(projectId, envelope.payload, {}, "console");
    } catch { /* ignore malformed recorder beacon */ }
  }

  private async drainRecorderBridge(projectId: string): Promise<void> {
    const session = this.sessions.get(projectId);
    if (!session || session.bridgeDrainRunning || !session.recordingEnabled) return;
    session.bridgeDrainRunning = true;
    try {
      const pages = (session.context.pages?.() ?? []).filter((page: any) => !page.isClosed?.());
      for (const page of pages) {
        const mainFrame = page.mainFrame?.() ?? page;
        if (typeof mainFrame?.evaluate !== "function") continue;
        const envelopes = await mainFrame.evaluate(() => {
          const win = window as any;
          const queue = Array.isArray(win.__automationStudioRecorderBridgeQueue) ? win.__automationStudioRecorderBridgeQueue : [];
          win.__automationStudioRecorderBridgeQueue = [];
          return queue.slice(0, 500);
        }).catch(() => []);
        for (const envelope of envelopes ?? []) {
          if (envelope?.kind === "event" && envelope.payload) this.ingestRecorderEvent(projectId, envelope.payload, {}, "bridge");
          else if (envelope?.kind === "diagnostic" && envelope.payload) this.ingestRecorderDiagnostic(projectId, envelope.payload, {}, "bridge");
        }
      }
    } finally {
      session.bridgeDrainRunning = false;
    }
  }

  private preserveStoppedSession(session: RecorderSession): void {
    let url: string | undefined;
    try { url = currentRecorderPage(session)?.url() ?? session.page?.url?.(); } catch { url = undefined; }
    this.pendingStatuses.set(session.projectId, {
      active: false,
      revision: session.revision,
      startedAt: session.startedAt,
      events: [...session.events],
      url,
      browserSource: session.browserSource,
      navigationError: session.navigationError,
      lastDiagnostic: session.lastDiagnostic,
      frameHealth: session.frameHealth,
      transportHealth: session.transportHealth
    });
  }

  async stop(projectId: string): Promise<void> {
    const session = this.sessions.get(projectId);
    if (!session) return;
    await this.flush(projectId);
    if (session.healthTimer) clearInterval(session.healthTimer);
    if (session.bridgeTimer) clearInterval(session.bridgeTimer);
    this.notifySession(session);
    this.preserveStoppedSession(session);
    this.sessions.delete(projectId);
    if (session.externalBrowser) {
      // For connectOverCDP this disconnects Automation Studio while leaving the
      // user-owned Chrome default context and tabs open.
      await session.browser?.close?.().catch(() => undefined);
    } else {
      await session.context.close().catch(() => undefined);
      await session.browser?.close?.().catch(() => undefined);
    }
  }
}


function recorderFrameInfo(source: any): Pick<RecorderEvent, "frameUrl" | "framePath"> {
  const frame = source?.frame;
  if (!frame) return {};
  const path: string[] = [];
  let current: any = frame;
  while (current) {
    const url = String(current.url?.() ?? "");
    const name = String(current.name?.() ?? "").trim();
    if (url || name) path.unshift(name ? `${name} :: ${url}` : url);
    current = current.parentFrame?.() ?? null;
  }
  const isChild = Boolean(frame.parentFrame?.());
  return {
    ...(isChild ? { frameUrl: String(frame.url?.() ?? "") || undefined } : {}),
    ...(path.length > 1 ? { framePath: path } : {})
  };
}

async function recorderBindingAvailable(frame: any): Promise<boolean> {
  try {
    return Boolean(await frame.evaluate(() => typeof (window as any).__automationStudioRecord === "function"));
  } catch {
    return false;
  }
}

function currentRecorderPage(session: RecorderSession): any | undefined {
  if (session.page && !session.page.isClosed?.()) return session.page;
  return session.context.pages?.().find((page: any) => !page.isClosed?.());
}

async function importPlaywright(): Promise<typeof import("playwright")> {
  try {
    return await import("playwright");
  } catch (error) {
    throw new Error("找不到 Playwright 執行核心，無法啟動錄製瀏覽器。請使用完整免安裝版。", { cause: error });
  }
}

export function recorderScript(): void {
  const win = window as any;
  const doc = document as any;
  const documentVersion = "1.2.2-recorder-keyboard-upload-assertion";
  // A Window can survive document.open()/document.write() while its Document
  // and event listeners are replaced. Mark the Document, not just the Window,
  // so the host watchdog can safely re-install listeners into the new DOM.
  if (doc.__automationStudioRecorderDocumentVersion === documentVersion) return;
  doc.__automationStudioRecorderDocumentVersion = documentVersion;
  win.__automationStudioRecorderReady = true;
  const consolePrefix = "__AUTOMATION_STUDIO_RECORDER_BRIDGE__";
  const createTransportId = (kind: string): string => `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const framePathOf = (): string[] | undefined => {
    try {
      const path: string[] = [];
      let current: Window = window;
      while (true) {
        const name = String(current.name || "").trim();
        const url = String(current.location?.href || "");
        path.unshift(name ? `${name} :: ${url}` : url);
        if (current === current.top) break;
        current = current.parent;
      }
      return path.length > 1 ? path : undefined;
    } catch {
      return window.top === window ? undefined : [location.href];
    }
  };
  const enqueueBridge = (kind: "event" | "diagnostic", payload: any): void => {
    const envelope = { kind, payload };
    let bridgeWindow: any = win;
    try {
      if (win.top && win.top !== win && win.top.location?.origin === location.origin) bridgeWindow = win.top;
    } catch { bridgeWindow = win; }
    try {
      if (!Array.isArray(bridgeWindow.__automationStudioRecorderBridgeQueue)) bridgeWindow.__automationStudioRecorderBridgeQueue = [];
      bridgeWindow.__automationStudioRecorderBridgeQueue.push(envelope);
      if (bridgeWindow.__automationStudioRecorderBridgeQueue.length > 500) bridgeWindow.__automationStudioRecorderBridgeQueue.splice(0, bridgeWindow.__automationStudioRecorderBridgeQueue.length - 500);
    } catch { /* binding/console channels remain available */ }
    try { console.debug(consolePrefix + JSON.stringify(envelope)); } catch { /* ignore */ }
  };
  const emitBinding = (name: "__automationStudioRecord" | "__automationStudioDiagnostic", payload: any): void => {
    try {
      const fn = win[name];
      if (typeof fn === "function") {
        const result = fn(payload);
        if (result && typeof result.catch === "function") void result.catch(() => undefined);
      }
    } catch { /* bridge remains available */ }
  };

  const labelOf = (element: HTMLElement): string => {
    const aria = element.getAttribute("aria-label");
    if (aria) return aria;
    const id = element.id;
    const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent : undefined;
    return label?.trim() || element.innerText?.trim().slice(0, 80) || element.getAttribute("name") || element.getAttribute("title") || element.tagName.toLowerCase();
  };
  const googleRedirectTarget = (rawHref: string | undefined): URL | undefined => {
    if (!rawHref) return undefined;
    try {
      const redirect = new URL(rawHref, location.href);
      const target = redirect.searchParams.get("q") || redirect.searchParams.get("url");
      const isGoogleRedirect = /(^|\.)google\.[a-z.]+$/i.test(redirect.hostname) && redirect.pathname === "/url";
      return isGoogleRedirect && target && /^https?:\/\//i.test(target) ? new URL(target) : undefined;
    } catch {
      return undefined;
    }
  };
  const cssAttr = (name: string, value: string): string => `[${name}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
  const stableClassSelector = (element: HTMLElement): string | undefined => {
    const classes = Array.from(element.classList ?? []).filter((name) =>
      name.length > 1
      && name.length < 50
      && !/^(?:active|selected|hover|focus|checked|disabled|read|unread)$/i.test(name)
      && !/^(?:ext-gen|x-grid3-row-|ms-)[0-9a-f_-]+$/i.test(name)
      && !/\d{5,}/.test(name)
    ).slice(0, 2);
    return classes.length ? `${element.tagName.toLowerCase()}${classes.map((name) => `.${CSS.escape(name)}`).join("")}:visible` : undefined;
  };
  const selectorsOf = (element: HTMLElement): Array<Record<string, unknown>> => {
    const result: Array<Record<string, unknown>> = [];
    const tag = element.tagName.toLowerCase();
    // Hidden native file inputs must be attached rather than visible for setInputFiles.
    if (element instanceof HTMLInputElement && element.type === "file") {
      if (element.id) result.push({ strategy: "css", value: `#${CSS.escape(element.id)}` });
      if (element.name) result.push({ strategy: "css", value: `input[type="file"]${cssAttr("name", element.name)}` });
      if (!result.length) result.push({ strategy: "css", value: 'input[type="file"]' });
      return result;
    }
    const title = element.getAttribute("title")?.trim();
    const href = element instanceof HTMLAnchorElement ? element.getAttribute("href")?.trim() : undefined;
    const redirectTarget = googleRedirectTarget(href);
    const stableHref = redirectTarget ? undefined : href;
    const role = element.getAttribute("role")?.trim();
    const target = `${tag}${role ? cssAttr("role", role) : ""}${title ? cssAttr("title", title) : ""}${stableHref ? cssAttr("href", stableHref) : ""}:visible`;
    const group = element.closest("[data-groupsn]")?.getAttribute("data-groupsn");
    if (group) result.push({ strategy: "css", value: `[data-groupsn="${group}"] ${target}`, description: "桌面版錄製路徑與穩定父選單" });
    if (role) result.push({ strategy: "css", value: `${tag}${cssAttr("role", role)}:visible`, description: "錄製時角色相符的可操作元件" });
    if (element.hasAttribute("onclick")) result.push({ strategy: "css", value: `${tag}[onclick]:visible`, description: "舊式網站 onclick 可操作元件" });
    if (element.hasAttribute("ondblclick")) result.push({ strategy: "css", value: `${tag}[ondblclick]:visible`, description: "舊式網站 ondblclick 可操作元件" });
    const stableClass = stableClassSelector(element);
    if (stableClass) result.push({ strategy: "css", value: stableClass, description: "錄製時穩定類別路徑；適合清單型資料搭配第一筆/最後一筆" });
    if (redirectTarget) {
      if (title) result.push({ strategy: "css", value: `${tag}${cssAttr("title", title)}:visible`, description: "Google 搜尋結果的穩定標題" });
      const destination = `${redirectTarget.pathname.replace(/^\//, "")}${redirectTarget.search}`;
      if (destination) result.push({ strategy: "css", value: `${tag}[href*="${encodeURIComponent(destination)}"]:visible`, description: "Google 站內搜尋的穩定目標網址" });
    } else if (href) {
      const attributes = `${title ? cssAttr("title", title) : ""}${cssAttr("href", href)}`;
      result.push({ strategy: "css", value: `${tag}${attributes}:visible`, description: "錄製時實際可見的連結與網址" });
    }
    if (title && !redirectTarget) result.push({ strategy: "css", value: `${tag}${cssAttr("title", title)}:visible`, description: "錄製時實際可見且 title 相符的元件" });
    const testId = element.getAttribute("data-testid");
    if (testId) result.push({ strategy: "testId", value: testId });
    if (element.getAttribute("aria-label")) result.push({ strategy: "label", value: element.getAttribute("aria-label") });
    const elementName = element.getAttribute("name")?.trim();
    if (elementName) result.push({ strategy: "name", value: elementName });
    if (element.id && !/^(?:ext-gen\d+|[a-f0-9]{12,}|ctl\d+_)/i.test(element.id)) result.push({ strategy: "css", value: `#${CSS.escape(element.id)}:visible` });
    const text = element.innerText?.replace(/\s+/g, " ").trim();
    if (text && text.length <= 600) result.push({ strategy: "text", value: text, exact: true });
    if (!result.length) result.push({ strategy: "css", value: tag });
    const unique: Array<Record<string, unknown>> = [];
    const promoteCss = (value: string): void => {
      try { if (document.querySelectorAll(value).length === 1) unique.push({ strategy: "css", value: `${value}:visible`, description: "錄製時唯一且穩定的元素識別" }); } catch { /* existing candidates remain */ }
    };
    if (testId) promoteCss(cssAttr("data-testid", testId));
    if (element.id && !/^(?:ext-gen\d+|[a-f0-9]{12,}|ctl\d+_)/i.test(element.id)) promoteCss(`#${CSS.escape(element.id)}`);
    if (elementName) promoteCss(`${tag}${cssAttr("name", elementName)}`);
    return [...unique, ...result];
  };
  win.__automationStudioSelectorsOf = (element: HTMLElement) => selectorsOf(element);
  const diagnostic = (eventType: string, target: HTMLElement | null, result: "recorded" | "ignored", reason: string): void => {
    if (!target) return;
    const payload = {
      transportId: createTransportId("diagnostic"),
      eventType,
      tag: target.tagName?.toLowerCase?.() || "unknown",
      role: target.getAttribute?.("role") || undefined,
      className: typeof target.className === "string" ? target.className.slice(0, 160) : undefined,
      frameUrl: window.top === window ? undefined : location.href,
      framePath: framePathOf(),
      result,
      reason
    };
    emitBinding("__automationStudioDiagnostic", payload);
    enqueueBridge("diagnostic", payload);
  };
  const actionableSelector = [
    "button", "a", 'input[type="button"]', 'input[type="submit"]',
    '[role="button"]', '[role="link"]', '[role="option"]', '[role="row"]', '[role="menuitem"]',
    "[onclick]", "[ondblclick]", '[tabindex]:not([tabindex="-1"])'
  ].join(",");
  const fallbackSelector = "tr,td,li,div,span";
  const legacyInteractiveClass = /(?:mail|message|item|row|list|entry|click|select|folder|subject|inbox|x-grid|x-tree|x-menu|x-tab|x-btn|x-combo|node|cell|record|topic|bbs|board|article|document|menu|tree|grid)/i;
  const findActionableElement = (target: HTMLElement | null): HTMLElement | null => {
    if (!target?.closest) return null;
    const standard = target.closest(actionableSelector) as HTMLElement | null;
    if (standard) return standard;
    // Legacy KMS/ExtJS pages often attach click handlers through event
    // delegation instead of onclick/role/tabindex. Walk a few ancestors and
    // accept a meaningful table/list/text cell even when cursor=default.
    let candidate = target.closest(fallbackSelector) as HTMLElement | null;
    for (let depth = 0; candidate && depth < 6; depth += 1, candidate = candidate.parentElement?.closest?.(fallbackSelector) as HTMLElement | null) {
      const style = getComputedStyle(candidate);
      const className = String(candidate.className || "");
      const text = String(candidate.innerText || candidate.textContent || "").replace(/\s+/g, " ").trim();
      const hasInteractiveClass = legacyInteractiveClass.test(className);
      const hasInteractiveCue = style.cursor === "pointer" || candidate.hasAttribute("tabindex") || Boolean(candidate.getAttribute("role")) || hasInteractiveClass;
      const meaningfulLegacyCell = /^(?:TR|TD|LI|DIV|SPAN)$/i.test(candidate.tagName)
        && text.length > 0 && text.length <= 160
        && (Boolean(candidate.id) || className.trim().length > 0 || /^(?:TR|TD|LI)$/i.test(candidate.tagName));
      if (hasInteractiveCue || meaningfulLegacyCell) return candidate;
    }
    return null;
  };
  const send = (type: string, element: HTMLElement, value?: string, extra: Record<string, unknown> = {}): void => {
    const input = element as HTMLInputElement;
    const safeValue = input.type === "password" ? "" : value;
    const anchor = element instanceof HTMLAnchorElement ? element : element.closest("a");
    const rawHref = anchor?.getAttribute("href") ?? undefined;
    let targetUrl: string | undefined;
    try { targetUrl = googleRedirectTarget(rawHref)?.href ?? (rawHref ? new URL(rawHref, location.href).href : undefined); } catch { targetUrl = undefined; }
    const selectorSnapshot = selectorsOf(element);
    const payload = {
      transportId: createTransportId("event"),
      type,
      label: labelOf(element),
      url: location.href,
      targetUrl,
      value: safeValue,
      selector: selectorSnapshot,
      // Keep a JSON backup plus primitive target metadata. Some legacy pages
      // replace their frame/document synchronously while a binding call is being
      // serialized; these fields let the backend reconstruct a locator even if
      // the primary selector array arrives empty.
      selectorBackup: JSON.stringify(selectorSnapshot),
      elementMeta: {
        tag: element.tagName.toLowerCase(),
        id: element.id || undefined,
        name: element.getAttribute("name") || undefined,
        role: element.getAttribute("role") || undefined,
        title: element.getAttribute("title") || undefined,
        href: rawHref,
        text: String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 600) || undefined
      },
      frameUrl: window.top === window ? undefined : location.href,
      framePath: framePathOf(),
      sensitive: input.type === "password",
      ...extra
    };
    emitBinding("__automationStudioRecord", payload);
    enqueueBridge("event", payload);
    diagnostic(type, element, "recorded", "已找到可操作元件並加入錄製事件");
  };
  const recordedValues = new WeakMap<HTMLElement, string>();
  const recordValue = (element: HTMLElement): void => {
    const input = element as HTMLInputElement;
    if (input.type === "hidden" || input.type === "file" || input.type === "password") return;
    if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement || element.isContentEditable)) return;
    if (["button", "submit", "reset", "image"].includes(input.type)) return;
    const value = element.isContentEditable ? element.textContent || "" : input.value;
    const signature = [input.type, input.checked, value].join("|");
    if (recordedValues.get(element) === signature) return;
    recordedValues.set(element, signature);
    if (element instanceof HTMLSelectElement) send("select", element, value);
    else if (input.type === "checkbox" || input.type === "radio") send("check", element, String(input.checked));
    else send("fill", element, value);
  };
  win.__automationStudioRecorderFlush = () => {
    if (!win.__automationStudioAssertionMode && document.activeElement) recordValue(document.activeElement as HTMLElement);
  };
  const recordedHoverTargets = new WeakSet<HTMLElement>();
  document.addEventListener("pointerover", (event) => {
    if (win.__automationStudioAssertionMode) return;
    const element = (event.target as HTMLElement)?.closest('a[role="button"],button[aria-haspopup],[aria-haspopup="menu"],[aria-haspopup="true"]') as HTMLElement | null;
    if (!element || recordedHoverTargets.has(element)) return;
    recordedHoverTargets.add(element);
    send("hover", element);
  }, true);
  let assertionClickUntil = 0;
  const interceptAssertion = (event: Event, record: boolean): boolean => {
    const mode = win.__automationStudioAssertionMode;
    if (!mode && Date.now() > assertionClickUntil) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!record || !mode) return true;
    const target = event.target as HTMLElement;
    if (!target || !target.tagName) return true;
    if (mode === "value" && (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) || ["password", "file"].includes((target as HTMLInputElement).type))) {
      diagnostic("assert", target, "ignored", "值驗證請選取非密碼、非檔案的輸入欄位");
      return true;
    }
    const expected = mode === "value" ? (target as HTMLInputElement).value : mode === "text" ? (target.textContent || "").trim() : undefined;
    if (mode === "text" && !expected) {
      diagnostic("assert", target, "ignored", "選取的元素沒有文字，請選取其他元素");
      return true;
    }
    send("assert", target, undefined, { verification: { kind: mode, expected, timeoutMs: 10000 } });
    win.__automationStudioAssertionMode = undefined;
    assertionClickUntil = Date.now() + 600;
    return true;
  };
  const recordPointerAction = (type: "click" | "dblclick", event: Event): void => {
    const target = event.target as HTMLElement | null;
    const formControl = target?.closest?.("input,select,textarea") as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
    if (formControl) {
      const inputType = formControl instanceof HTMLInputElement ? String(formControl.type || "text").toLowerCase() : "";
      // Text/select/checkbox/radio controls are recorded by change. Recording
      // their containing TD/DIV as a click creates noisy SmartKMS steps such as
      // an entire filter panel or hidden backing field. Buttons remain clicks.
      if (!(formControl instanceof HTMLInputElement && ["button", "submit", "image", "reset"].includes(inputType))) return;
    }
    const element = findActionableElement(target);
    if (!element) {
      diagnostic(type, target, "ignored", "找不到可可靠重播的可操作父元素");
      return;
    }
    const anchor = element.closest("a") as HTMLAnchorElement | null;
    const href = anchor?.getAttribute("href") ?? "";
    const title = anchor?.getAttribute("title") ?? "";
    const isDownload = type === "click" && Boolean(
      anchor?.hasAttribute("download") ||
      /\.pdf(?:$|[?#])/i.test(href) ||
      /\.pdf(?:$|\s)/i.test(title) ||
      /\/Download\.ashx(?:\?|$)/i.test(href) ||
      /\/(?:File\/Doc|download|attachment)(?:\/|\?|$)/i.test(href) ||
      anchor?.closest("li.pdf")
    );
    send(isDownload ? "download" : type, element);
  };
  let lastPointerDownSignature = "";
  let lastPointerDownAt = 0;
  const targetSignature = (element: HTMLElement | null): string => {
    if (!element) return "";
    const selector = selectorsOf(element)[0];
    return `${location.href}|${labelOf(element)}|${String(selector?.strategy ?? "")}|${String(selector?.value ?? "")}`;
  };
  document.addEventListener("pointerdown", (event) => {
    if (interceptAssertion(event, false)) return;
    if ((event as PointerEvent).button !== 0) return;
    const focused = document.activeElement as HTMLElement | null;
    if (focused) recordValue(focused);
    const target = event.target as HTMLElement | null;
    const element = findActionableElement(target);
    if (!element) return;
    // Some legacy intranet applications navigate on mousedown/pointerdown and
    // never dispatch a normal click to the old Document. Record the actionable
    // target now; the following click is coalesced below when it does occur.
    lastPointerDownSignature = targetSignature(element);
    lastPointerDownAt = Date.now();
    recordPointerAction("click", event);
  }, true);
  document.addEventListener("click", (event) => {
    if (interceptAssertion(event, true)) return;
    // Do not delay this call. Legacy intranet pages can navigate synchronously
    // during the click, which destroys timers belonging to the old document.
    const element = findActionableElement(event.target as HTMLElement | null);
    const signature = targetSignature(element);
    if (signature && signature === lastPointerDownSignature && Date.now() - lastPointerDownAt < 1_200) return;
    recordPointerAction("click", event);
  }, true);
  for (const type of ["mousedown", "mouseup", "pointerup"]) {
    document.addEventListener(type, (event) => { interceptAssertion(event, false); }, true);
  }
  document.addEventListener("dblclick", (event) => {
    if (interceptAssertion(event, false)) return;
    recordPointerAction("dblclick", event);
  }, true);
  document.addEventListener("change", (event) => {
    const element = event.target as HTMLInputElement | HTMLSelectElement;
    if (!element) return;
    if (win.__automationStudioAssertionMode) return;
    if (element instanceof HTMLInputElement && element.type === "file") {
      const fileNames = Array.from(element.files || []).map((file) => file.name);
      if (fileNames.length) send("upload", element, fileNames.join("\n"), { fileNames });
    } else if (element.type === "password") send("fill", element, "");
    else recordValue(element);
  }, true);
  document.addEventListener("focusout", (event) => {
    if (!win.__automationStudioAssertionMode) recordValue(event.target as HTMLElement);
  }, true);
  document.addEventListener("keydown", (event) => {
    const keyboard = event as KeyboardEvent;
    if (win.__automationStudioAssertionMode) {
      if (keyboard.key === "Escape") { win.__automationStudioAssertionMode = undefined; send("assert", document.body, undefined, { verification: undefined, cancelled: true }); }
      return;
    }
    if (keyboard.isComposing || keyboard.repeat || keyboard.key === "Process" || keyboard.key === "Dead") return;
    const target = event.target as HTMLElement;
    if (!target?.tagName || (target as HTMLInputElement).type === "password") return;
    const modifier = keyboard.ctrlKey || keyboard.metaKey || keyboard.altKey;
    const supported = ["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Backspace", "Delete", " "];
    if (!modifier && !supported.includes(keyboard.key)) return;
    if (["Control", "Meta", "Alt", "Shift", "CapsLock", "NumLock", "ScrollLock"].includes(keyboard.key)) return;
    // Commit text before Enter/Tab or shortcut can submit, move focus or navigate.
    recordValue(target);
    const key = keyboard.key === " " ? "Space" : keyboard.key.length === 1 && modifier ? keyboard.key.toLowerCase() : keyboard.key;
    const combo = [keyboard.ctrlKey ? "Control" : "", keyboard.metaKey ? "Meta" : "", keyboard.altKey ? "Alt" : "", keyboard.shiftKey ? "Shift" : "", key].filter(Boolean).join("+");
    send("press", target, combo);
  }, true);
}


function normalizeRecorderSelectorCandidates(rawEvent: Record<string, unknown>): RecorderEvent["selector"] {
  for (const candidate of [rawEvent.selector, rawEvent.selectors, rawEvent.selectorBackup]) {
    const normalized = normalizeRecorderSelectorPayload(candidate);
    if (normalized.length) return normalized;
  }
  return fallbackRecorderSelectors(rawEvent);
}

function fallbackRecorderSelectors(rawEvent: Record<string, unknown>): RecorderEvent["selector"] {
  const meta = rawEvent.elementMeta && typeof rawEvent.elementMeta === "object" && !Array.isArray(rawEvent.elementMeta)
    ? rawEvent.elementMeta as Record<string, unknown>
    : {};
  const result: RecorderEvent["selector"] = [];
  const tag = /^[a-z][a-z0-9-]*$/i.test(String(meta.tag ?? "")) ? String(meta.tag).toLowerCase() : "";
  const name = String(meta.name ?? "").trim();
  const id = String(meta.id ?? "").trim();
  const text = String(meta.text ?? rawEvent.label ?? "").replace(/\s+/g, " ").trim();
  const targetUrl = String(rawEvent.targetUrl ?? "").trim();
  if (id) result.push({ strategy: "css", value: `[id=${cssQuoted(id)}]:visible`, description: "由錄製事件備援資料重建 id selector" });
  if (name) result.push({ strategy: "name", value: name, description: "由錄製事件備援資料重建 name selector" });
  if (text && text.length <= 600 && !/^(?:a|div|span|td|tr|button|input)$/i.test(text)) {
    result.push({ strategy: "text", value: text, exact: true, description: "由錄製事件文字重建 selector" });
  }
  if (targetUrl && tag === "a") {
    try {
      const parsed = new URL(targetUrl);
      const pathAndQuery = `${parsed.pathname}${parsed.search}`;
      if (pathAndQuery) result.push({ strategy: "css", value: `a[href=${cssQuoted(pathAndQuery)}]:visible`, description: "由錄製目標網址重建連結 selector" });
      const tail = `${parsed.pathname.split("/").pop() ?? ""}${parsed.search}`;
      if (tail) result.push({ strategy: "css", value: `a[href*=${cssQuoted(tail)}]:visible`, description: "由錄製目標網址重建相對連結 selector" });
    } catch { /* text/name fallback remains */ }
  }
  const seen = new Set<string>();
  return result.filter((rule) => {
    const key = `${rule.strategy}|${rule.value}|${rule.exact ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cssQuoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function validFrameUrl(value: unknown): boolean {
  const text = String(value ?? "").trim();
  return Boolean(text && /^(?:https?:|about:|file:)/i.test(text));
}

function normalizeFramePath(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flat(4).map((item) => String(item ?? "").trim()).filter(Boolean).slice(-12);
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      if (parsed !== value) return normalizeFramePath(parsed);
    } catch { /* keep legacy plain-string path as one segment */ }
    return [text];
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const candidate = record.path ?? record.framePath ?? record.url ?? record.frameUrl ?? record.name;
    return candidate == null ? [] : normalizeFramePath(candidate);
  }
  return [];
}

function normalizeRecorderSelectorPayload(value: unknown): RecorderEvent["selector"] {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return []; }
  }
  const queue: unknown[] = Array.isArray(parsed) ? parsed.flat(4) : parsed && typeof parsed === "object" ? [parsed] : [];
  return queue.flatMap((item) => {
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
    } as any];
  });
}

function removeRecentMatchingClicks(events: RecorderEvent[], raw: Omit<RecorderEvent, "id" | "createdAt">): void {
  const cutoff = Date.now() - 1_500;
  let removed = 0;
  for (let index = events.length - 1; index >= 0 && removed < 2; index -= 1) {
    const event = events[index];
    const created = Date.parse(event.createdAt);
    if (Number.isFinite(created) && created < cutoff) break;
    if (event.type !== "click" || !sameRecorderTarget(event, raw)) continue;
    events.splice(index, 1);
    removed += 1;
  }
}

function sameRecorderTarget(left: Pick<RecorderEvent, "label" | "url" | "frameUrl" | "selector">, right: Pick<RecorderEvent, "label" | "url" | "frameUrl" | "selector">): boolean {
  if (left.url !== right.url || left.frameUrl !== right.frameUrl || left.label !== right.label) return false;
  const a = normalizeRecorderSelectorPayload((left as any).selector)[0];
  const b = normalizeRecorderSelectorPayload((right as any).selector)[0];
  return a?.strategy === b?.strategy && a?.value === b?.value;
}

function decodedRecordedDownloadName(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of ["n", "u"]) {
      const encoded = parsed.searchParams.get(key);
      if (!encoded) continue;
      try {
        const decoded = Buffer.from(encoded, "base64").toString("utf8").trim().replace(/\\/g, "/");
        const name = decoded.split("/").pop() ?? "";
        if (/\.[a-z0-9]{1,8}$/i.test(name)) return name;
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return "";
}

function isPdfResponse(response: any): boolean {
  try {
    const status = Number(response.status?.() ?? 0);
    if (status < 200 || status >= 400) return false;
    const headers = response.headers?.() ?? {};
    const contentType = String(headers["content-type"] ?? "").toLowerCase();
    const disposition = String(headers["content-disposition"] ?? "").toLowerCase();
    const url = String(response.url?.() ?? "");
    const encodedName = decodedRecordedDownloadName(url);
    return contentType.includes("application/pdf")
      || /filename[^;=]*=[^;]*\.pdf/i.test(disposition)
      || /\.pdf(?:$|[?#])/i.test(url)
      || /\.pdf$/i.test(encodedName);
  } catch {
    return false;
  }
}

function pdfResponseMatchesTarget(response: any, targetUrl: string | undefined): boolean {
  if (!targetUrl) return false;
  const candidates: string[] = [String(response.url?.() ?? "")];
  try {
    let request = response.request?.();
    while (request) {
      candidates.push(String(request.url?.() ?? ""));
      request = request.redirectedFrom?.();
    }
  } catch { /* use the response URL */ }
  return candidates.some((candidate) => sameRequestTarget(candidate, targetUrl));
}

function sameRequestTarget(candidate: string, target: string): boolean {
  try {
    const actual = new URL(candidate);
    const expected = new URL(target);
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) return false;
    for (const [name, value] of expected.searchParams) {
      if (actual.searchParams.get(name) !== value) return false;
    }
    return true;
  } catch {
    return false;
  }
}

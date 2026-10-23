import { bindContextCancellation } from "./cancellation.ts";
import { localFilenameTimestamp } from "../domain/localTimestamp.ts";
import fs from "node:fs/promises";
import path from "node:path";
import type { Browser, Dialog, Download, Frame, Locator, Page } from "playwright";
import type { AppConfig } from "../config.ts";
import { ErrorCodes, FlowError } from "../domain/errors.ts";
import type { ReportDefinition, ReportId, ReportParameterDefinition } from "../domain/types.ts";
import type { DownloadReportInput, DownloadReportOutput, ReportAdapter } from "./reportAdapter.ts";
import { resolveChromiumExecutablePath } from "./chromiumExecutable.ts";
import {
  getEbasReportDefinition,
  listDownloadableEbasReportDefinitions,
  toEbasParameterDefinitions,
  toReportDefinition,
  type EbasReportDefinition
} from "./ebasReportDefinitions.ts";

import { normalizeBrowserMode, type BrowserMode } from "../domain/browserMode.ts";

type BrowserLauncher = (options: { headless: boolean; slowMo: number; executablePath?: string }) => Promise<Browser>;
type PageScope = Page | Frame;

interface EbasReportFormFields {
  year: string;
  stage: string;
  outputFormat: string;
  kind: string;
  printLevel: string;
  usagePrintStopLevel: string;
  accountLevel: string;
  accountCode: string;
  accountPrintLevel: string;
}

export class EbasReportAdapter implements ReportAdapter {
  private readonly config: AppConfig;
  private readonly browserPromises = new Map<BrowserMode, Promise<Browser>>();
  private readonly browserLauncher?: BrowserLauncher;
  private readonly closeBrowserOnExit: () => void;

  constructor(config: AppConfig, browserLauncher?: BrowserLauncher) {
    this.config = config;
    this.browserLauncher = browserLauncher;
    this.closeBrowserOnExit = () => {
      void this.disposeBrowser();
    };
    process.once("exit", this.closeBrowserOnExit);
    process.once("SIGINT", this.closeBrowserOnExit);
    process.once("SIGTERM", this.closeBrowserOnExit);
  }

  async listReports(): Promise<ReportDefinition[]> {
    const definitions = await listDownloadableEbasReportDefinitions(this.config.ebasReportDefinitionsPath);
    return definitions.map(toReportDefinition);
  }

  async getReportParameters(reportId: ReportId): Promise<ReportParameterDefinition[]> {
    const definition = await this.getReportDefinition(reportId);
    return toEbasParameterDefinitions(definition);
  }

  async downloadReport(input: DownloadReportInput): Promise<DownloadReportOutput> {
    input.signal?.throwIfAborted();
    const definition = await this.getReportDefinition(input.reportId);
    const storageStatePath = input.storageStatePath ?? this.config.ebasStorageStatePath;
    await this.assertStorageStateExists(storageStatePath);
    await fs.mkdir(this.config.downloadDir, { recursive: true });
    input.signal?.throwIfAborted();
    const browser = await this.getBrowser(normalizeBrowserMode(input.browserMode));
    input.signal?.throwIfAborted();

    try {
      return await this.runDownload(browser, input, definition, storageStatePath);
    } catch (error) {
      throw error instanceof FlowError
        ? error
        : new FlowError(
            ErrorCodes.DOWNLOAD_FAILED,
            "EBAS 1103 download flow failed. Check session, menu labels, selectors, and permissions.",
            error
          );
    }
  }

  private async getBrowser(mode: BrowserMode): Promise<Browser> {
    let pending = this.browserPromises.get(mode);
    if (!pending) {
      pending = this.launchBrowser(mode);
      this.browserPromises.set(mode, pending);
    }
    try { return await pending; } catch (error) {
      if (this.browserPromises.get(mode) === pending) this.browserPromises.delete(mode);
      throw error;
    }
  }

  private async launchBrowser(mode: BrowserMode): Promise<Browser> {
    const launch = this.browserLauncher ?? (async (options) => {
      const { chromium } = await import("playwright");
      return chromium.launch(options);
    });
    const executablePath = await resolveChromiumExecutablePath(this.config);
    const browser = await launch({
      headless: mode === "headless",
      slowMo: this.config.slowMo,
      ...(executablePath ? { executablePath } : {})
    });
    const launchedPromise = this.browserPromises.get(mode);
    browser.once("disconnected", () => {
      // A late disconnect from an older instance must not clear its replacement.
      if (this.browserPromises.get(mode) === launchedPromise) this.browserPromises.delete(mode);
    });
    return browser;
  }

  private async disposeBrowser(): Promise<void> {
    const pending = [...this.browserPromises.values()];
    this.browserPromises.clear();
    await Promise.all(pending.map(async (task) => {
      const browser = await task.catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }));
  }

  private async runDownload(
    browser: Browser,
    input: DownloadReportInput,
    definition: EbasReportDefinition,
    storageStatePath: string
  ): Promise<DownloadReportOutput> {
    const context = await browser.newContext({
      acceptDownloads: true,
      storageState: storageStatePath
    });
    const releaseContext = bindContextCancellation(context, input.signal);
    let page: Page | undefined;
    let debug: DebugRecorder | undefined;
    try {
      input.signal?.throwIfAborted();
      page = await context.newPage();
      debug = input.debugEnabled ? await DebugRecorder.create(this.config.ebasDebugDir, input.reportId) : undefined;
      await debug?.event("task_started", {
        reportId: input.reportId,
        browserMode: normalizeBrowserMode(input.browserMode),
        workerId: input.workerId,
        parameters: input.parameters,
        entryUrl: this.config.ebasEntryUrl
      });
      await page.goto(this.config.ebasEntryUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000
      });
      await debug?.capture(page, "01-entry-loaded");

      await this.ensureLoggedIn(page);
      await debug?.event("login_checked", { url: page.url() });
      await this.selectTopFilters(page, input, definition);
      await debug?.capture(page, "02-top-filters-selected");
      await this.selectReportMenu(page, definition);
      await debug?.capture(page, "03-report-menu-selected");
      const fields = await this.fillReportParameters(page, input, definition);
      await debug?.capture(page, "04-report-parameters-filled");

      const download = await this.clickPrintAndWaitForDownload(page, fields, debug, input.signal);
      await debug?.event("download_started", {
        suggestedFilename: download.suggestedFilename()
      });
      const suggested = sanitizeFileName(download.suggestedFilename() || "ebas-1103-income-statement.xlsx");
      const finalName = withTimestamp(input.reportName ?? definition.name, path.extname(suggested));
      const finalPath = path.join(this.config.downloadDir, finalName);
      await download.saveAs(finalPath);
      await debug?.event("task_completed", { filePath: finalPath });

      return { filePath: finalPath, debugDir: debug?.dir };
    } catch (error) {
      if (input.signal?.aborted || !page) throw error;
      const debugDir = debug
        ? await debug.captureError(page, error)
        : undefined;
      const message = error instanceof Error ? error.message : String(error);
      const debugMessage = debugDir ? ` Debug artifacts saved in ${debugDir}` : "";
      throw new FlowError(
        error instanceof FlowError ? error.code : ErrorCodes.DOWNLOAD_FAILED,
        `EBAS flow failed: ${message}.${debugMessage}`,
        {
          debugDir,
          url: page.url()
        }
      );
    } finally {
      await releaseContext();
    }
  }

  private async ensureLoggedIn(page: Page): Promise<void> {
    const title = await page.title().catch(() => "");
    const url = page.url();

    if (/login|Account\/Login/i.test(url) || /登入|Login/i.test(title)) {
      throw new FlowError(
        ErrorCodes.LOGIN_REQUIRED,
        "EBAS session is not logged in. Run npm.cmd run ebas:login first."
      );
    }
  }

  private async selectTopFilters(
    page: Page,
    input: DownloadReportInput,
    definition: EbasReportDefinition
  ): Promise<void> {
    await ensureDefaultDbSelected(page);

    const businessType = input.parameters.businessType || definition.businessType;
    const fundType = input.parameters.fundType || definition.fundType;
    const businessSelected = await selectExtBusinessType(page, businessType);
    if (!businessSelected) {
      await chooseByLabelOrNearbyText(page, "業務別", businessType);
    }

    const fundSelected = await selectExtFundFunction(page, "P", fundType);
    if (!fundSelected) {
      await clickByText(page, "營業基金");
      await clickByText(page, fundType);
    }
  }

  private async selectReportMenu(page: Page, definition: EbasReportDefinition): Promise<void> {
    const reportName = definition.menuPath.at(-1) || definition.name;
    const menuPathCandidates = [
      definition.menuPath,
      definition.menuPath.slice(1),
      definition.menuPath.slice(2),
      ["決算書表", "書表列印", reportName],
      ["決算主要表", reportName],
      [reportName]
    ];

    for (const menuPath of menuPathCandidates) {
      if (menuPath.length === 0) continue;
      const selectedByTreeApi = await selectExtTreePath(page, menuPath);
      if (selectedByTreeApi) return;
    }

    const selectedByRecursiveSearch = await selectExtTreeNodeByText(page, reportName);
    if (selectedByRecursiveSearch) return;

    const treeDump = await dumpExtTree(page);
    throw new FlowError(
      ErrorCodes.DOWNLOAD_FAILED,
      `Unable to find EBAS tree node: ${reportName}. Current tree nodes: ${treeDump.slice(0, 2000)}`
    );
  }

  private async fillReportParameters(
    page: Page,
    input: DownloadReportInput,
    definition: EbasReportDefinition
  ): Promise<EbasReportFormFields> {
    const scope = await getMainFrame(page);
    const fields = {
      year: input.parameters.year || definition.year,
      stage: input.parameters.stage || definition.stage,
      outputFormat: input.parameters.outputFormat || definition.outputFormat,
      kind: input.parameters.kind || definition.kind || definition.kindOptions[0] || "",
      printLevel: input.parameters.printLevel || definition.printLevel,
      usagePrintStopLevel: input.parameters.usagePrintStopLevel || definition.usagePrintStopLevel,
      accountLevel: input.parameters.accountLevel || definition.accountLevel,
      accountCode: input.parameters.accountCode || definition.accountCode,
      accountPrintLevel: input.parameters.accountPrintLevel || definition.accountPrintLevel
    };

    await waitForEbasReportFormReady(scope);

    if (fields.kind) {
      await applyInteractiveEbasKindSelections(scope, fields, this.config.ebasUiIdleTimeoutMs);
    }

    await ensureEbasReportFormFields(scope, fields, this.config.ebasUiIdleTimeoutMs);

    return fields;
  }

  private async clickPrintAndWaitForDownload(
    page: Page,
    fields: EbasReportFormFields,
    debug?: DebugRecorder,
    signal?: AbortSignal
  ) {
    const scope = await getMainFrame(page);

    await waitForEbasUiIdle(scope, this.config.ebasUiIdleTimeoutMs);
    await page.waitForLoadState("networkidle", {
      timeout: this.config.ebasPrePrintNetworkIdleTimeoutMs
    }).catch(() => undefined);
    await ensureEbasReportFormFields(scope, fields, this.config.ebasUiIdleTimeoutMs);

    assertPageOpen(page, "before clicking EBAS print");
    const downloadPromise = waitForEbasDownload(page, this.config.ebasDownloadTimeoutMs, debug, signal);
    const printResponsePromise = waitForEbasPrintResponse(
      page,
      fields.outputFormat,
      this.config.ebasDownloadTimeoutMs,
      debug
    );

    // Attach rejection handlers immediately: cancellation can close the context
    // while the print click is still pending.
    void downloadPromise.catch(() => undefined);
    void printResponsePromise.catch(() => undefined);
    const printButton = scope.locator("#print").first();
    try {
      if (await isVisible(printButton, 2_000)) {
        await printButton.click({ timeout: this.config.ebasPrintClickTimeoutMs });
      } else {
        await clickByText(scope, "??");
      }
    } catch (error) {
      await downloadPromise.catch(() => undefined);
      throw new FlowError(
        ErrorCodes.DOWNLOAD_FAILED,
        `Unable to click EBAS print button: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    try {
      await printResponsePromise;
    } catch (error) {
      void downloadPromise.catch(() => undefined);
      throw error;
    }

    const downloadResult = await downloadPromise;
    await debug?.event("download_event_received", {
      source: downloadResult.source,
      pageUrl: downloadResult.page.isClosed() ? "" : downloadResult.page.url(),
      suggestedFilename: downloadResult.download.suggestedFilename()
    });
    return downloadResult.download;
  }

  private async getReportDefinition(reportId: ReportId): Promise<EbasReportDefinition> {
    const definition = await getEbasReportDefinition(
      this.config.ebasReportDefinitionsPath,
      reportId
    );
    if (!definition) {
      throw new FlowError(ErrorCodes.REPORT_NOT_FOUND, `Unknown EBAS report: ${reportId}`);
    }
    return definition;
  }

  private async assertStorageStateExists(storageStatePath = this.config.ebasStorageStatePath): Promise<void> {
    try {
      await fs.access(storageStatePath);
    } catch {
      throw new FlowError(
        ErrorCodes.LOGIN_REQUIRED,
        `EBAS storage state not found: ${storageStatePath}. Please complete manual login for the selected worker first.`
      );
    }
  }
}

function assertPageOpen(page: Page, phase: string): void {
  if (page.isClosed()) {
    throw new FlowError(
      ErrorCodes.DOWNLOAD_FAILED,
      `EBAS page was closed ${phase}.`
    );
  }
}

function buildDownloadWaitError(
  page: Page,
  error: unknown,
  dialogMessages: string[],
  popupStates: EbasPopupState[] = []
): FlowError {
  const message = error instanceof Error ? error.message : String(error);
  const pageState = page.isClosed()
    ? "page was closed before a download event was emitted"
    : `current URL: ${page.url()}`;
  const dialogText = dialogMessages.length > 0
    ? ` Dialog messages: ${dialogMessages.join(" | ")}.`
    : "";
  const popupText = popupStates.length > 0
    ? ` Popup states: ${popupStates.map(formatPopupState).join(" | ")}.`
    : "";

  return new FlowError(
    ErrorCodes.DOWNLOAD_FAILED,
    `EBAS print did not produce a downloadable file before the download wait ended; ${pageState}.${dialogText}${popupText} Original error: ${message}`
  );
}

interface EbasDownloadResult {
  download: Download;
  source: "page" | "popup";
  page: Page;
}

interface EbasPopupState {
  url: string;
  title: string;
  closed: boolean;
  bodySnippet: string;
}

interface EbasPrintResponseResult {
  requestedFormat: "EXCEL" | "PDF" | "XML" | "ODS";
  dataSize: number | null;
  filePath: string;
  responseStatus: number;
}

async function waitForEbasPrintResponse(
  page: Page,
  outputFormat: string,
  timeoutMs: number,
  debug?: DebugRecorder
): Promise<EbasPrintResponseResult> {
  const response = await page.waitForResponse((candidate) => {
    const request = candidate.request();
    return candidate.url().includes("/ActionServlet") &&
      request.method() === "POST" &&
      (request.postData() || "").includes("action=printReport");
  }, { timeout: timeoutMs });

  const request = response.request();
  const requestPostData = request.postData() || "";
  const responseStatus = response.status();
  const rawResponseText = await response.text();
  const payload = parseEbasPrintResponse(rawResponseText);
  const requestedFormat = toEbasResponseFormatKey(outputFormat);
  const dataSizeValue = payload.obj?.DATASIZE;
  const dataSize = Number.isFinite(Number(dataSizeValue)) ? Number(dataSizeValue) : null;
  const filePath = String(payload.obj?.[requestedFormat] ?? payload.info ?? "").trim();

  await debug?.event("print_response_received", {
    requestedFormat,
    dataSize,
    filePath,
    responseStatus,
    requestPostData,
    responseTextSnippet: rawResponseText.slice(0, 2_000)
  });

  if (payload.success !== true) {
    throw new FlowError(
      ErrorCodes.DOWNLOAD_FAILED,
      `EBAS print request failed for ${requestedFormat}. Response: ${payload.info || rawResponseText}`
    );
  }

  if (isNullEbasOutputPath(filePath)) {
    throw new FlowError(
      ErrorCodes.DOWNLOAD_FAILED,
      `EBAS did not produce a downloadable ${requestedFormat} file. Server path: ${filePath || "(empty)"}. DATASIZE=${dataSize ?? "unknown"}.`
    );
  }

  return {
    requestedFormat,
    dataSize,
    filePath,
    responseStatus
  };
}

function parseEbasPrintResponse(rawResponseText: string): {
  success: boolean;
  info?: string;
  obj?: Record<string, unknown>;
} {
  try {
    const parsed = JSON.parse(rawResponseText) as Record<string, unknown>;
    return {
      success: parsed.success === true,
      info: typeof parsed.info === "string" ? parsed.info : undefined,
      obj: parsed.obj && typeof parsed.obj === "object" ? parsed.obj as Record<string, unknown> : undefined
    };
  } catch {
    return { success: false, info: rawResponseText };
  }
}

function toEbasResponseFormatKey(outputFormat: string): "EXCEL" | "PDF" | "XML" | "ODS" {
  switch (outputFormat.toLowerCase()) {
    case "pdf":
      return "PDF";
    case "xml":
      return "XML";
    case "ods":
      return "ODS";
    case "excel":
    default:
      return "EXCEL";
  }
}

function isNullEbasOutputPath(filePath: string): boolean {
  if (!filePath) return true;
  return filePath === "/output/null" || /(^|\/)null$/i.test(filePath);
}

export async function waitForEbasDownload(
  page: Page,
  timeoutMs: number,
  debug?: DebugRecorder,
  signal?: AbortSignal
): Promise<EbasDownloadResult> {
  const context = page.context();
  const dialogMessages: string[] = [];
  const trackedPages = new Set<Page>();
  const popupPages = new Set<Page>();
  const cleanup: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const summarizePopups = async () => Promise.all(
    [...popupPages].map((popup) => summarizeEbasPopupState(popup))
  );

  return await new Promise<EbasDownloadResult>((resolve, reject) => {
    let settled = false;

    const clearAll = () => {
      if (timer) {
        clearTimeout(timer);
      }
      for (const dispose of cleanup.splice(0)) {
        dispose();
      }
    };

    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearAll();
      action();
    };

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearAll();
      void summarizePopups()
        .then((popupStates) => reject(
          buildDownloadWaitError(
            page,
            new Error(`Timed out after ${timeoutMs}ms waiting for a download event.`),
            dialogMessages,
            popupStates
          )
        ))
        .catch((error) => reject(buildDownloadWaitError(page, error, dialogMessages)));
    }, timeoutMs);

    const onAbort = () => settle(() => reject(signal?.reason ?? new Error("任務已中斷")));
    const onContextClose = () => settle(() => reject(new Error("下載 context 已關閉")));
    signal?.addEventListener("abort", onAbort, { once: true });
    context.on("close", onContextClose);
    cleanup.push(() => signal?.removeEventListener("abort", onAbort));
    cleanup.push(() => context.off("close", onContextClose));
    if (signal?.aborted) { onAbort(); return; }

    const attachPage = (candidate: Page, source: "page" | "popup") => {
      if (trackedPages.has(candidate)) return;
      trackedPages.add(candidate);

      if (candidate !== page) {
        popupPages.add(candidate);
        void debug?.event("download_popup_opened", {
          source,
          url: candidate.url()
        });
      }

      const onDownload = (download: Download) => {
        settle(() => resolve({ download, source, page: candidate }));
      };
      const onDialog = async (dialog: Dialog) => {
        dialogMessages.push(dialog.message());
        await dialog.accept().catch(() => undefined);
      };

      candidate.on("download", onDownload);
      candidate.on("dialog", onDialog);
      cleanup.push(() => candidate.off("download", onDownload));
      cleanup.push(() => candidate.off("dialog", onDialog));
    };

    const onContextPage = (candidate: Page) => {
      attachPage(candidate, "popup");
    };

    context.on("page", onContextPage);
    cleanup.push(() => context.off("page", onContextPage));

    attachPage(page, "page");
    for (const candidate of context.pages()) {
      attachPage(candidate, candidate === page ? "page" : "popup");
    }
  });
}

async function summarizeEbasPopupState(page: Page): Promise<EbasPopupState> {
  if (page.isClosed()) {
    return {
      url: "",
      title: "",
      closed: true,
      bodySnippet: ""
    };
  }

  const [title, bodySnippet] = await Promise.all([
    page.title().catch(() => ""),
    page.locator("body").innerText({ timeout: 1_500 })
      .then((value) => normalizeDebugSnippet(value))
      .catch(() => "")
  ]);

  return {
    url: page.url(),
    title,
    closed: false,
    bodySnippet
  };
}

function normalizeDebugSnippet(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

function formatPopupState(state: EbasPopupState): string {
  const parts = [
    state.closed ? "closed" : "open",
    state.url ? `url=${state.url}` : "",
    state.title ? `title=${normalizeDebugSnippet(state.title)}` : "",
    state.bodySnippet ? `body=${state.bodySnippet}` : ""
  ].filter(Boolean);
  return parts.join(", ");
}

async function selectExtBusinessType(page: Page, value: string): Promise<boolean> {
  await waitForExtReady(page);

  const selected = await page.evaluate((businessText) => {
    const win = window as typeof window & { Ext?: any; business?: any };
    const safeGetCmp = (id: string) => {
      try {
        return win.Ext?.ComponentMgr?.all ? win.Ext.getCmp(id) : null;
      } catch {
        return null;
      }
    };
    const business = win.business || safeGetCmp("toolbar-B");
    if (!business?.menu?.items?.items) return false;

    const items = business.menu.items.items;
    const normalized = (text: unknown) => String(text ?? "").replace(/\s+/g, "");
    const item = items.find((entry: any) => normalized(entry?.text) === normalized(businessText))
      || business.menu.find?.("id", "b1")?.[0];
    if (!item?.handler) return false;

    business.setDisabled?.(false);
    item.setDisabled?.(false);
    item.handler(item);
    return true;
  }, value).catch(() => false);

  if (selected) {
    await page.waitForTimeout(800);
  }

  return Boolean(selected);
}

async function getMainFrame(page: Page): Promise<Frame> {
  await page.waitForFunction(() => {
    const frame = document.querySelector<HTMLIFrameElement>("iframe[name='main'], iframe#main");
    const href = frame?.contentWindow?.location?.href || "";
    const bodyText = frame?.contentDocument?.body?.innerText || "";
    const hasReportForm = Boolean(
      frame?.contentDocument?.querySelector("#q_year, #q_stage, #print") ||
      bodyText.includes("輸出格式")
    );
    return Boolean(frame && href.includes("/SFUND/") && bodyText.trim().length > 0 && hasReportForm);
  }, undefined, { timeout: 45_000 }).catch(() => undefined);

  const frame = page.frame({ name: "main" });
  if (!frame) {
    throw new FlowError(
      ErrorCodes.DOWNLOAD_FAILED,
      "Unable to locate EBAS main iframe after selecting report menu."
    );
  }
  return frame;
}

async function waitForEbasReportFormReady(page: PageScope): Promise<void> {
  await page.waitForFunction(() => {
    const win = window as typeof window & { q?: any; mst1?: any; onMstChangeEvent?: any };
    const bodyText = document.body?.innerText || "";
    const hasYear = Boolean(document.querySelector("#q_year") || win.q?.q_year);
    const hasStage = Boolean(document.querySelector("#q_stage") || win.q?.q_stage);
    return hasYear && hasStage && !bodyText.includes("資料載入中");
  }, undefined, { timeout: 60_000 }).catch(() => undefined);
}

async function waitForEbasUiIdle(page: PageScope, timeout: number): Promise<void> {
  await page.waitForFunction(() => {
    const bodyText = document.body?.innerText || "";
    const masks = Array.from(document.querySelectorAll<HTMLElement>(
      ".ext-el-mask, .x-mask, .x-mask-loading, .ext-mb-content"
    ));
    const hasVisibleMask = masks.some((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || "1") !== 0 &&
        rect.width > 0 &&
        rect.height > 0;
    });

    return !hasVisibleMask && !bodyText.includes("資料載入中");
  }, undefined, { timeout });
}

async function ensureEbasReportFormFields(
  page: PageScope,
  fields: EbasReportFormFields,
  idleTimeout: number
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await setEbasReportFormFields(page, fields);
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= 2) {
        throw error;
      }

      await waitForEbasUiIdle(page, idleTimeout).catch(() => undefined);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new FlowError(ErrorCodes.DOWNLOAD_FAILED, "Unable to verify EBAS report form values.");
}

async function setEbasReportFormFields(
  page: PageScope,
  fields: EbasReportFormFields
): Promise<void> {
  const result = await page.evaluate(({
    year,
    stage,
    outputFormat,
    kind,
    printLevel,
    usagePrintStopLevel,
    accountLevel,
    accountCode,
    accountPrintLevel
  }) => {
    const win = window as typeof window & { q?: any; mst1?: any; onMstChangeEvent?: any };
    const stageCodeMap: Record<string, string> = {
      自編預算: "0",
      主編預算: "0",
      預算案: "2",
      法定預算: "3",
      自編決算: "1",
      院編決算: "2",
      審定決算: "3"
    };

    const normalize = (value: unknown) => String(value ?? "").replace(/\s+/g, "");
    const dispatch = (element: Element | null | undefined, eventName: string) => {
      element?.dispatchEvent(new Event(eventName, { bubbles: true }));
    };
    const setHiddenValue = (selector: string, value: string) => {
      const input = document.querySelector<HTMLInputElement>(selector);
      if (!input) return false;
      input.value = value;
      dispatch(input, "input");
      dispatch(input, "change");
      return true;
    };
    const setExtValue = (component: any, value: string, label?: string) => {
      if (!component) return false;

      try {
        let record: any = null;
        let recordIndex = -1;
        const valuesMatch = (left: string, right: string) => {
          if (left === right) return true;
          if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
            return left.replace(/^0+/, "") === right.replace(/^0+/, "");
          }
          return false;
        };
        const store = component.store;
        const count = Number(store?.getCount?.() ?? 0);
        for (let index = 0; index < count; index += 1) {
          const candidate = store.getAt?.(index);
          const data = candidate?.data || {};
          const code = String(data.code_no ?? data.value ?? data.id ?? "");
          const text = String(data.code_na ?? data.text ?? data.name ?? "");
          const normalizedText = normalize(text);
          const normalizedLabel = normalize(label || value);
          if (
            valuesMatch(code, value) ||
            normalizedText === normalizedLabel ||
            normalizedText.startsWith(normalizedLabel) ||
            normalizedLabel.startsWith(normalizedText)
          ) {
            record = candidate;
            recordIndex = index;
            break;
          }
        }

        const resolvedValue = record
          ? String((record.data || {}).code_no ?? (record.data || {}).value ?? (record.data || {}).id ?? value)
          : value;

        component.setValue?.(resolvedValue);
        if (record) {
          const data = record.data || {};
          const rawValue = String(data.code_na ?? data.text ?? data.name ?? label ?? value);
          component.setRawValue?.(rawValue);
          component.fireEvent?.("select", component, record, recordIndex);
        } else if (label) {
          component.setRawValue?.(label);
        }
        component.fireEvent?.("change", component, resolvedValue);
        component.validate?.();
        return true;
      } catch {
        // Some ExtJS TwinComboBox fields fire page-specific change handlers while being set.
        // Do not abort the whole form update; hidden transformed inputs are still the
        // values used by EBAS print/query parameters on many report pages.
        return false;
      }
    };
    const resolveExtOptionValue = (component: any, value: string, label?: string) => {
      if (!component) return value;

      try {
        const valuesMatch = (left: string, right: string) => {
          if (left === right) return true;
          if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
            return left.replace(/^0+/, "") === right.replace(/^0+/, "");
          }
          return false;
        };

        const normalizedLabel = normalize(label || value);
        const count = Number(component?.store?.getCount?.() ?? 0);
        for (let index = 0; index < count; index += 1) {
          const candidate = component.store.getAt?.(index);
          const data = candidate?.data || {};
          const code = String(data.code_no ?? data.value ?? data.id ?? "");
          const text = String(data.code_na ?? data.text ?? data.name ?? "");
          const normalizedText = normalize(text);
          if (
            valuesMatch(code, value) ||
            normalizedText === normalizedLabel ||
            normalizedText.startsWith(normalizedLabel) ||
            normalizedLabel.startsWith(normalizedText)
          ) {
            return code || value;
          }
        }
      } catch {
        // Fall through to the original value.
      }

      return value;
    };
    const readComponentValue = (component: any) => {
      try {
        const value = component?.getValue?.();
        return String(value ?? "").trim();
      } catch {
        return "";
      }
    };
    const readDomValue = (selector: string) => {
      const element = document.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(selector);
      return String(element?.value ?? "").trim();
    };
    const readFirstValue = (components: any[], selectors: string[]) => {
      for (const component of components) {
        const value = readComponentValue(component);
        if (value) return value;
      }

      for (const selector of selectors) {
        const value = readDomValue(selector);
        if (value) return value;
      }

      return "";
    };
    const readExtFormValue = (components: any[], selectors: string[]) => {
      const componentValue = readFirstValue(components, []);
      if (componentValue) return componentValue;

      for (const selector of selectors) {
        const hiddenValue = readDomValue(`input[type="hidden"]${selector.startsWith("#") ? selector : ""}`);
        if (hiddenValue) return hiddenValue;
      }

      for (const selector of selectors) {
        const value = readDomValue(selector);
        if (value) return value;
      }

      return "";
    };
    const setFormValue = (selectors: string[], labels: string[], value: string) => {
      const setElementValue = (element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => {
        if (element instanceof HTMLSelectElement) {
          const option = Array.from(element.options).find((candidate) =>
            candidate.value === value || normalize(candidate.textContent) === normalize(value)
          );
          if (option) element.value = option.value;
        } else if (element.type === "radio") {
          const radio = document.querySelector<HTMLInputElement>(
            `input[type="radio"][name="${element.name}"][value="${value}"]`
          );
          if (radio) radio.checked = true;
        } else {
          element.value = value;
        }

        dispatch(element, "input");
        dispatch(element, "change");
        try {
          const wrapper = win.mst1?.[element.id] || win.q?.[element.id];
          wrapper?.setValue?.(value);
          win.onMstChangeEvent?.(wrapper, 1);
        } catch {
          // Some EBAS wrappers are read-only or absent on specific reports.
        }
        return true;
      };

      for (const selector of selectors) {
        const element = document.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(selector);
        if (element && setElementValue(element)) return true;
      }

      const rows = Array.from(document.querySelectorAll("tr, .x-form-item, .x-panel, div"));
      for (const label of labels) {
        const target = normalize(label);
        for (const row of rows) {
          if (!normalize(row.textContent).includes(target)) continue;
          const element = row.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
            "select, input:not([type='hidden']):not([type='checkbox']), textarea"
          );
          if (element && setElementValue(element)) return true;
        }
      }

      return false;
    };

    const stageCode = stageCodeMap[stage] || stage;
    const yearExtSet = setExtValue(win.q?.q_year, year);
    const yearHiddenSet = setHiddenValue("#q_year", year);
    const stageExtSet = setExtValue(win.q?.q_stage, stageCode, stage);
    const resolvedStageCode = String(win.q?.q_stage?.getValue?.() || stageCode);
    const stageHiddenSet = setHiddenValue("#q_stage", resolvedStageCode);
    const yearSet = yearExtSet || yearHiddenSet;
    const stageSet = stageExtSet || stageHiddenSet;
    const isApplicableLevel = (value: string) => ["1", "2", "3", "4", "5"].includes(value);
    const toEbasPrintLevelCode = (value: string) => {
      if (/^[1-5]$/.test(value)) return value.padStart(2, "0");
      return value;
    };
    const normalizePrintLevelValue = (value: string) => {
      const trimmed = String(value ?? "").trim();
      if (/^0[1-5]$/.test(trimmed)) return trimmed;
      if (/^[1-5]$/.test(trimmed)) return trimmed.padStart(2, "0");
      return trimmed;
    };
    const printLevelSelectors = [
      "#printLevel",
      "#print_level",
      "#printlevel",
      "#prtLevel",
      "#prt_level",
      "#rptLevel",
      "#rpt_level",
      "#level",
      "[name='printLevel']",
      "[name='print_level']",
      "[name='prtLevel']",
      "[name='prt_level']",
      "[name='rptLevel']",
      "[name='rpt_level']",
      "[name='level']"
    ];
    const printLevelComponents = [
      win.mst1?.printLevel,
      win.mst1?.print_level,
      win.mst1?.printlevel,
      win.mst1?.prtLevel,
      win.mst1?.prt_level,
      win.mst1?.rptLevel,
      win.mst1?.rpt_level,
      win.mst1?.level
    ];
    const setPrintLevel = (value: string) => {
      const code = toEbasPrintLevelCode(value);
      let extSet = false;
      for (const component of printLevelComponents) {
        extSet = setExtValue(component, code, value) || extSet;
      }

      let hiddenSet = false;
      for (const selector of printLevelSelectors) {
        const element = document.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(selector);
        if (element instanceof HTMLInputElement && element.type === "hidden") {
          hiddenSet = setHiddenValue(selector, code) || hiddenSet;
        }
      }

      const formSet = setFormValue(printLevelSelectors, ["列印層級"], code);

      try {
        const wrapper = printLevelComponents.find((component) => component);
        win.onMstChangeEvent?.(wrapper, 1);
      } catch {
        // Some EBAS pages do not expose onMstChangeEvent for this field.
      }

      return extSet || hiddenSet || formSet;
    };
    const printLevelSet = isApplicableLevel(printLevel)
      ? setPrintLevel(printLevel)
      : false;
    const setUsagePrintStopLevel = (value: string) => {
      const extSet = setExtValue(win.mst1?.use_level, value, value);
      const hiddenSet = setHiddenValue("#use_level", value);
      const formSet = setFormValue(
        [
          "#use_level",
          "#usagePrintStopLevel",
          "#usage_print_stop_level",
          "#usePrintStopLevel",
          "#printStopLevel",
          "#stopLevel",
          "[name='use_level']",
          "[name='usagePrintStopLevel']",
          "[name='usage_print_stop_level']",
          "[name='usePrintStopLevel']",
          "[name='printStopLevel']",
          "[name='stopLevel']"
        ],
        ["用途別列印截止層級", "用途別截止層級"],
        value
      );

      try {
        const wrapper = win.mst1?.use_level;
        win.onMstChangeEvent?.(wrapper, 1);
      } catch {
        // Some EBAS pages do not expose onMstChangeEvent for this field.
      }

      return extSet || hiddenSet || formSet;
    };
    const usagePrintStopLevelSet = isApplicableLevel(usagePrintStopLevel)
      ? setUsagePrintStopLevel(usagePrintStopLevel)
      : false;
    const accountLevelSelectors = [
      "#start_level",
      "#accountLevel",
      "#account_level",
      "#accountlevel",
      "#acctLevel",
      "#acct_level",
      "#accLevel",
      "#acc_level",
      "#subjectLevel",
      "#subject_level",
      "#itemLevel",
      "#item_level",
      "[name='start_level']",
      "[name='accountLevel']",
      "[name='account_level']",
      "[name='acctLevel']",
      "[name='acct_level']",
      "[name='accLevel']",
      "[name='acc_level']",
      "[name='subjectLevel']",
      "[name='subject_level']",
      "[name='itemLevel']",
      "[name='item_level']"
    ];
    const accountLevelComponents = [
      win.mst1?.start_level,
      win.mst1?.accountLevel,
      win.mst1?.account_level,
      win.mst1?.accountlevel,
      win.mst1?.acctLevel,
      win.mst1?.acct_level,
      win.mst1?.accLevel,
      win.mst1?.acc_level,
      win.mst1?.subjectLevel,
      win.mst1?.subject_level,
      win.mst1?.itemLevel,
      win.mst1?.item_level
    ];
    const accountCodeSelectors = [
      "#acct_code",
      "#accountCode",
      "#account_code",
      "#account",
      "#acctCode",
      "#acct",
      "#accCode",
      "#acc_code",
      "#acc",
      "#subjectCode",
      "#subject_code",
      "#subject",
      "[name='acct_code']",
      "[name='accountCode']",
      "[name='account_code']",
      "[name='account']",
      "[name='acctCode']",
      "[name='acct']",
      "[name='accCode']",
      "[name='acc_code']",
      "[name='acc']",
      "[name='subjectCode']",
      "[name='subject_code']",
      "[name='subject']"
    ];
    const accountCodeComponents = [
      win.mst1?.acct_code,
      win.mst1?.accountCode,
      win.mst1?.account_code,
      win.mst1?.account,
      win.mst1?.acctCode,
      win.mst1?.acct,
      win.mst1?.accCode,
      win.mst1?.acc_code,
      win.mst1?.acc,
      win.mst1?.subjectCode,
      win.mst1?.subject_code,
      win.mst1?.subject
    ];
    const accountPrintLevelSelectors = [
      "#code_level",
      "#end_level",
      "#accountPrintLevel",
      "#account_print_level",
      "#accountLevelPrint",
      "#account_level_print",
      "#acctPrintLevel",
      "#acct_print_level",
      "#accPrintLevel",
      "#acc_print_level",
      "#subjectPrintLevel",
      "#subject_print_level",
      "[name='code_level']",
      "[name='end_level']",
      "[name='accountPrintLevel']",
      "[name='account_print_level']",
      "[name='accountLevelPrint']",
      "[name='account_level_print']",
      "[name='acctPrintLevel']",
      "[name='acct_print_level']",
      "[name='accPrintLevel']",
      "[name='acc_print_level']",
      "[name='subjectPrintLevel']",
      "[name='subject_print_level']"
    ];
    const accountPrintLevelComponents = [
      win.mst1?.code_level,
      win.mst1?.end_level,
      win.mst1?.accountPrintLevel,
      win.mst1?.account_print_level,
      win.mst1?.accountLevelPrint,
      win.mst1?.account_level_print,
      win.mst1?.acctPrintLevel,
      win.mst1?.acct_print_level,
      win.mst1?.accPrintLevel,
      win.mst1?.acc_print_level,
      win.mst1?.subjectPrintLevel,
      win.mst1?.subject_print_level
    ];
    const setGenericField = (
      components: any[],
      selectors: string[],
      labels: string[],
      value: string,
      extLabel = value
    ) => {
      let extSet = false;
      for (const component of components) {
        extSet = setExtValue(component, value, extLabel) || extSet;
      }

      let hiddenSet = false;
      for (const selector of selectors) {
        const element = document.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(selector);
        if (element instanceof HTMLInputElement && element.type === "hidden") {
          hiddenSet = setHiddenValue(selector, value) || hiddenSet;
        }
      }

      const formSet = setFormValue(selectors, labels, value);
      try {
        const wrapper = components.find((component) => component);
        win.onMstChangeEvent?.(wrapper, 1);
      } catch {
        // Some EBAS pages do not expose onMstChangeEvent for this field.
      }

      return extSet || hiddenSet || formSet;
    };
    const kindSelectors = [
      "#kind",
      "[name='kind']"
    ];
    const kindComponents = [
      win.mst1?.kind
    ];
    const resolvedKindValue = kind
      ? resolveExtOptionValue(win.mst1?.kind, kind, kind)
      : "";
    const kindSet = kind
      ? setGenericField(kindComponents, kindSelectors, ["\u5831\u8868\u7a2e\u985e"], resolvedKindValue, kind)
      : false;
    const startPageSelectors = [
      "#startpage",
      "[name='startpage']"
    ];
    const startPageComponents = [
      win.mst1?.startpage
    ];
    const startPagePresent = Boolean(document.querySelector("#startpage, [name='startpage']") || win.mst1?.startpage);
    const startPageSet = startPagePresent
      ? setGenericField(startPageComponents, startPageSelectors, ["\u8d77\u59cb\u9801\u78bc", "startpage"], "1")
      : false;
    const isApplicableText = (value: string) => Boolean(value && value !== "\u4e0d\u9069\u7528");
    const toEbasStartLevelCode = (value: string) => /^[1-5]$/.test(value) ? value.padStart(2, "0") : value;
    const accountLevelCode = toEbasStartLevelCode(accountLevel);
    const accountLevelSet = isApplicableLevel(accountLevel)
      ? setGenericField(accountLevelComponents, accountLevelSelectors, ["科目層級"], accountLevelCode, accountLevel)
      : false;
    const accountCodeSet = isApplicableText(accountCode)
      ? setGenericField(accountCodeComponents, accountCodeSelectors, ["會計科目"], accountCode)
      : false;
    const accountPrintLevelCode = toEbasStartLevelCode(accountPrintLevel);
    const accountPrintLevelSet = isApplicableLevel(accountPrintLevel)
      ? setGenericField(
          accountPrintLevelComponents,
          accountPrintLevelSelectors,
          ["會計科目列印截止層級", "會計科目列印層級", "科目列印層級"],
          accountPrintLevelCode,
          accountPrintLevel
        )
      : false;

    const setEbasCheckbox = (id: string, checked: boolean) => {
      const input = document.querySelector<HTMLInputElement>(`#${id}`);
      if (!input) return false;

      if (input.checked !== checked) {
        input.click();
      }

      if (input.checked !== checked) {
        input.checked = checked;
      }

      input.defaultChecked = checked;
      dispatch(input, "input");
      dispatch(input, "change");

      const wrapper = win.mst1?.[id];
      try {
        wrapper?.setValue?.(checked ? input.value : "");
      } catch {
        // Some EBAS checkbox wrappers only expose getValue.
      }
      try {
        win.onMstChangeEvent?.(wrapper, 1);
      } catch {
        // The DOM state is the source of truth for report submission.
      }

      return input.checked === checked;
    };

    const wantsExcel = outputFormat.toLowerCase() === "excel";
    const formatIds = ["pdf", "excel", "xml", "ods"];
    let excelChecked = false;
    for (const id of formatIds) {
      const checked = wantsExcel ? id === "excel" : id === outputFormat.toLowerCase();
      const selected = setEbasCheckbox(id, checked);
      if (id === "excel") {
        excelChecked = selected && Boolean(document.querySelector<HTMLInputElement>("#excel")?.checked);
      }
    }

    return {
      yearSet,
      stageSet,
      yearValue: readExtFormValue([win.q?.q_year], ["#q_year", "[name='q_year']"]),
      stageValue: readExtFormValue([win.q?.q_stage], ["#q_stage", "[name='q_stage']"]),
      stageExpectedValue: resolvedStageCode,
      kindSet,
      kindValue: readExtFormValue(kindComponents, kindSelectors),
      startPagePresent,
      startPageSet,
      startPageValue: readFirstValue(startPageComponents, startPageSelectors),
      excelChecked,
      pdfChecked: Boolean(document.querySelector<HTMLInputElement>("#pdf")?.checked),
      printLevelSet,
      printLevelValue: normalizePrintLevelValue(readFirstValue(printLevelComponents, printLevelSelectors)),
      printLevelExpectedValue: toEbasPrintLevelCode(printLevel),
      usagePrintStopLevelSet,
      usagePrintStopLevelValue: String(
        win.mst1?.use_level?.getValue?.() ||
        document.querySelector<HTMLInputElement>("#use_level")?.value ||
        ""
      ).trim(),
      accountLevelSet,
      accountLevelValue: normalizePrintLevelValue(readFirstValue(accountLevelComponents, accountLevelSelectors)),
      accountLevelExpectedValue: accountLevelCode,
      accountCodeSet,
      accountCodeValue: readFirstValue(accountCodeComponents, accountCodeSelectors),
      accountPrintLevelSet,
      accountPrintLevelValue: normalizePrintLevelValue(readFirstValue(accountPrintLevelComponents, accountPrintLevelSelectors)),
      accountPrintLevelExpectedValue: accountPrintLevelCode
    };
  }, fields).catch((error) => ({
    yearSet: false,
    stageSet: false,
    yearValue: "",
    stageValue: "",
    stageExpectedValue: "",
    kindSet: false,
    kindValue: "",
    startPagePresent: false,
    startPageSet: false,
    startPageValue: "",
    excelChecked: false,
    pdfChecked: false,
    printLevelSet: false,
    printLevelValue: "",
    printLevelExpectedValue: "",
    usagePrintStopLevelSet: false,
    usagePrintStopLevelValue: "",
    accountLevelSet: false,
    accountLevelValue: "",
    accountLevelExpectedValue: "",
    accountCodeSet: false,
    accountCodeValue: "",
    accountPrintLevelSet: false,
    accountPrintLevelValue: "",
    accountPrintLevelExpectedValue: "",
    error: error instanceof Error ? error.message : String(error)
  }));

  if (!result.yearSet || result.yearValue !== fields.year) {
    throw new FlowError(
      ErrorCodes.DOWNLOAD_FAILED,
      `Unable to set EBAS 年度 to "${fields.year}". Current value: "${result.yearValue}".${result.error ? ` Internal error: ${result.error}` : ""}`
    );
  }

  if (!result.stageSet) {
    throw new FlowError(
      ErrorCodes.DOWNLOAD_FAILED,
      `Unable to set EBAS 階段 to "${fields.stage}". Current value: "${result.stageValue}".`
    );
  }

  if (result.stageExpectedValue && result.stageValue !== result.stageExpectedValue) {
    throw new FlowError(
      ErrorCodes.DOWNLOAD_FAILED,
      `Unable to verify EBAS 階段 "${fields.stage}". Expected code: "${result.stageExpectedValue}", current value: "${result.stageValue}".`
    );
  }

  if (fields.kind && (!result.kindSet || !accountCodeMatches(result.kindValue, fields.kind))) {
    throw new FlowError(
      ErrorCodes.DOWNLOAD_FAILED,
      `Unable to set EBAS report kind to "${fields.kind}". Current value: "${result.kindValue}".`
    );
  }

  if (fields.outputFormat.toLowerCase() === "excel" && !result.excelChecked) {
    throw new FlowError(
      ErrorCodes.DOWNLOAD_FAILED,
      "Unable to select EBAS output format: EXCEL."
    );
  }

  if (result.startPagePresent && (!result.startPageSet || !result.startPageValue)) {
    throw new FlowError(
      ErrorCodes.DOWNLOAD_FAILED,
      `Unable to set EBAS start page. Current value: "${result.startPageValue}".`
    );
  }

  if (
    ["1", "2", "3", "4", "5"].includes(fields.printLevel) &&
    (!result.printLevelSet || result.printLevelValue !== result.printLevelExpectedValue)
  ) {
    throw new FlowError(
      ErrorCodes.DOWNLOAD_FAILED,
      `Unable to set EBAS 列印層級 to "${fields.printLevel}". Expected EBAS value: "${result.printLevelExpectedValue}". Current value: "${result.printLevelValue}".`
    );
  }

  if (
    ["1", "2", "3", "4", "5"].includes(fields.usagePrintStopLevel) &&
    (!result.usagePrintStopLevelSet || result.usagePrintStopLevelValue !== fields.usagePrintStopLevel)
  ) {
    throw new FlowError(
      ErrorCodes.DOWNLOAD_FAILED,
      `Unable to set EBAS 用途別列印截止層級 to "${fields.usagePrintStopLevel}". Current value: "${result.usagePrintStopLevelValue}".`
    );
  }

  if (
    ["1", "2", "3", "4", "5"].includes(fields.accountLevel) &&
    (!result.accountLevelSet || result.accountLevelValue !== result.accountLevelExpectedValue)
  ) {
    throw new FlowError(
      ErrorCodes.DOWNLOAD_FAILED,
      `Unable to set EBAS 科目層級 to "${fields.accountLevel}". Expected EBAS value: "${result.accountLevelExpectedValue}". Current value: "${result.accountLevelValue}".`
    );
  }

  if (
    fields.accountCode &&
    fields.accountCode !== "不適用" &&
    (!result.accountCodeSet || !accountCodeMatches(result.accountCodeValue, fields.accountCode))
  ) {
    throw new FlowError(
      ErrorCodes.DOWNLOAD_FAILED,
      `Unable to set EBAS 會計科目 to "${fields.accountCode}". Current value: "${result.accountCodeValue}".`
    );
  }

  if (
    ["1", "2", "3", "4", "5"].includes(fields.accountPrintLevel) &&
    (!result.accountPrintLevelSet || result.accountPrintLevelValue !== result.accountPrintLevelExpectedValue)
  ) {
    throw new FlowError(
      ErrorCodes.DOWNLOAD_FAILED,
      `Unable to set EBAS 會計科目列印層級 to "${fields.accountPrintLevel}". Expected EBAS value: "${result.accountPrintLevelExpectedValue}". Current value: "${result.accountPrintLevelValue}".`
    );
  }
}

function accountCodeMatches(actual: string, expected: string): boolean {
  const normalize = (value: string) => value.trim().replace(/\s+/g, "");
  const actualText = normalize(actual);
  const expectedText = normalize(expected);
  return actualText === expectedText ||
    actualText.startsWith(expectedText) ||
    expectedText.startsWith(actualText);
}

async function selectExtFundFunction(
  page: Page,
  fundType: "P",
  functionText: string
): Promise<boolean> {
  await waitForExtReady(page);

  const selected = await page.evaluate(({ fundType, functionText }) => {
    const win = window as typeof window & { Ext?: any };
    const safeGetCmp = (id: string) => {
      try {
        return win.Ext?.ComponentMgr?.all ? win.Ext.getCmp(id) : null;
      } catch {
        return null;
      }
    };
    const toolbar = safeGetCmp(`toolbar-${fundType}`);
    if (!toolbar?.menu?.items?.items) return false;

    const items = toolbar.menu.items.items;
    const normalized = (text: unknown) => String(text ?? "").replace(/\s+/g, "");
    const target = normalized(functionText);
    const fallbackCodeByLabel: Record<string, string> = {
      [normalized("\u9810\u7b97\u7de8\u88fd")]: "B",
      [normalized("\u9810\u7b97\u57f7\u884c")]: "E",
      [normalized("\u9810\u7b97\u63a7\u5236")]: "C",
      [normalized("\u6c7a(\u7d50)\u7b97\u7de8\u88fd")]: "F",
      [normalized("\u9810\u7b97\u5148\u671f\u7de8\u5be9")]: "R"
    };
    const fallbackCode = fallbackCodeByLabel[target];
    const item = items.find((entry: any) => normalized(entry?.text) === target)
      || (fallbackCode ? toolbar.menu.find?.("id", `${fundType}${fallbackCode}`)?.[0] : null);
    if (!item?.handler) return false;

    toolbar.setDisabled?.(false);
    item.setDisabled?.(false);
    item.handler(item);
    return true;
  }, { fundType, functionText }).catch(() => false);

  if (selected) {
    await waitForTreeLoaded(page);
  }

  return Boolean(selected);
}

async function selectExtTreePath(page: Page, menuPath: string[]): Promise<boolean> {
  await waitForTreeLoaded(page);

  const selected = await page.evaluate(async (pathLabels) => {
    const win = window as typeof window & { Ext?: any; tree?: any; setTitle?: any };
    const safeGetCmp = (id: string) => {
      try {
        return win.Ext?.ComponentMgr?.all ? win.Ext.getCmp(id) : null;
      } catch {
        return null;
      }
    };
    const tree = win.tree || safeGetCmp("west-panel");
    if (!tree?.root) return false;

    function normalize(value: unknown): string {
      return String(value ?? "").replace(/\s+/g, "");
    }

    function findChildByText(node: any, label: string): any {
      const target = normalize(label);
      let found: any = null;
      node.eachChild?.((child: any) => {
        if (found) return;
        if (normalize(child.text) === target) {
          found = child;
        }
      });
      return found;
    }

    const expandNode = (node: any) => new Promise<void>((resolve) => {
      if (!node || node.leaf || node.isExpanded?.()) {
        resolve();
        return;
      }
      node.expand?.(false, false, () => resolve());
      window.setTimeout(() => resolve(), 3000);
    });

    let current = tree.root;
    await expandNode(current);
    for (const label of pathLabels) {
      const next = findChildByText(current, label);
      if (!next) return false;
      current = next;
      await expandNode(current);
    }

    current.select?.();
    current.fireEvent?.("click", current);
    if (typeof win.setTitle === "function") {
      win.setTitle(current, current.attributes?.link, current.attributes?.id);
    }
    return true;
  }, menuPath).catch(() => false);

  if (selected) {
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(800);
  }

  return Boolean(selected);
}

async function selectExtTreeNodeByText(page: Page, targetText: string): Promise<boolean> {
  await waitForTreeLoaded(page);

  const selected = await page.evaluate(async (targetText) => {
    const win = window as typeof window & { Ext?: any; tree?: any; setTitle?: any };
    const safeGetCmp = (id: string) => {
      try {
        return win.Ext?.ComponentMgr?.all ? win.Ext.getCmp(id) : null;
      } catch {
        return null;
      }
    };
    const tree = win.tree || safeGetCmp("west-panel");
    if (!tree?.root) return false;

    const normalize = (value: unknown) => String(value ?? "").replace(/\s+/g, "");
    const target = normalize(targetText);
    const visited = new Set<string>();

    const expandNode = (node: any) => new Promise<void>((resolve) => {
      if (!node || node.leaf || node.isLoaded?.()) {
        resolve();
        return;
      }
      node.expand?.(false, false, () => resolve());
      window.setTimeout(() => resolve(), 3000);
    });

    const find = async (node: any): Promise<any> => {
      if (!node) return null;
      const nodeId = String(node.id ?? node.attributes?.id ?? Math.random());
      if (visited.has(nodeId)) return null;
      visited.add(nodeId);

      if (normalize(node.text) === target) return node;
      await expandNode(node);

      const children = Array.from(node.childNodes || []);
      for (const child of children) {
        const found = await find(child);
        if (found) return found;
      }
      return null;
    };

    const found = await find(tree.root);
    if (!found) return false;

    found.ensureVisible?.();
    found.select?.();
    found.fireEvent?.("click", found);
    if (typeof win.setTitle === "function") {
      win.setTitle(found, found.attributes?.link, found.attributes?.id);
    }
    return true;
  }, targetText).catch(() => false);

  if (selected) {
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(1000);
  }

  return Boolean(selected);
}

async function dumpExtTree(page: Page): Promise<string> {
  return page.evaluate(() => {
    const win = window as typeof window & { Ext?: any; tree?: any };
    const safeGetCmp = (id: string) => {
      try {
        return win.Ext?.ComponentMgr?.all ? win.Ext.getCmp(id) : null;
      } catch {
        return null;
      }
    };
    const tree = win.tree || safeGetCmp("west-panel");
    if (!tree?.root) return "NO_TREE";

    const rows: string[] = [];
    const walk = (node: any, depth: number) => {
      rows.push(`${"  ".repeat(depth)}- ${node.text || node.id || "(blank)"} [${node.id || ""}]`);
      for (const child of Array.from(node.childNodes || [])) {
        walk(child, depth + 1);
      }
    };
    walk(tree.root, 0);
    return rows.join("\n");
  }).catch((error) => `TREE_DUMP_FAILED: ${error instanceof Error ? error.message : String(error)}`);
}

async function ensureDefaultDbSelected(page: Page): Promise<void> {
  await waitForExtRegistry(page);

  const selected = await page.evaluate(() => {
    const win = window as typeof window & { Ext?: any };
    const safeGetCmp = (id: string) => {
      try {
        return win.Ext?.ComponentMgr?.all ? win.Ext.getCmp(id) : null;
      } catch {
        return null;
      }
    };
    const sysid = safeGetCmp("sysid");
    const domValue = (document.querySelector<HTMLInputElement>("#sysid")?.value || "").trim();
    if (domValue) return Promise.resolve(true);
    if (!sysid?.store) return Promise.resolve(false);

    const currentValue = String(sysid.getValue?.() || "").trim();
    const currentRawValue = String(sysid.getRawValue?.() || "").trim();
    if (currentValue || currentRawValue) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      const chooseFirst = (records?: any[]) => {
        const record = records?.[0] || sysid.store.getAt?.(0);
        if (!record?.data?.code_no) {
          resolve(false);
          return;
        }

        sysid.setValue?.(record.data.code_no);
        sysid.setRawValue?.(record.data.code_na);
        sysid.fireEvent?.("select", sysid, record, 0);
        resolve(true);
      };

      const count = sysid.store.getCount?.() ?? 0;
      if (count > 0) {
        chooseFirst();
        return;
      }

      const timer = window.setTimeout(() => {
        const lateDomValue = (document.querySelector<HTMLInputElement>("#sysid")?.value || "").trim();
        const lateRawValue = String(sysid.getRawValue?.() || "").trim();
        resolve(Boolean(lateDomValue || lateRawValue));
      }, 20_000);
      sysid.store.load({
        callback(records: any[]) {
          window.clearTimeout(timer);
          chooseFirst(records);
        }
      });
    });
  }).catch(() => false);

  if (!selected) {
    await page.waitForFunction(() => {
      const win = window as typeof window & { Ext?: any };
      const domValue = (document.querySelector<HTMLInputElement>("#sysid")?.value || "").trim();
      if (domValue) return true;

      try {
        const sysid = win.Ext?.ComponentMgr?.all ? win.Ext.getCmp("sysid") : null;
        return Boolean(String(sysid?.getRawValue?.() || sysid?.getValue?.() || "").trim());
      } catch {
        return false;
      }
    }, undefined, { timeout: 60_000 }).catch(() => undefined);
  }

  await waitForExtReady(page);
}

async function waitForExtReady(page: Page): Promise<void> {
  await waitForExtRegistry(page);

  await page.waitForFunction(() => {
    const win = window as typeof window & { Ext?: any };
    const safeGetCmp = (id: string) => {
      try {
        return win.Ext?.ComponentMgr?.all ? win.Ext.getCmp(id) : null;
      } catch {
        return null;
      }
    };
    const business = safeGetCmp("toolbar-B");
    return Boolean(business?.menu?.items?.items);
  }, undefined, { timeout: 45_000 });
}

async function waitForExtRegistry(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const win = window as typeof window & { Ext?: any };
    return Boolean(
      win.Ext &&
      typeof win.Ext.getCmp === "function" &&
      win.Ext.ComponentMgr &&
      win.Ext.ComponentMgr.all
    );
  }, undefined, { timeout: 45_000 });
}

async function waitForTreeLoaded(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const win = window as typeof window & { Ext?: any; tree?: any };
    const safeGetCmp = (id: string) => {
      try {
        return win.Ext?.ComponentMgr?.all ? win.Ext.getCmp(id) : null;
      } catch {
        return null;
      }
    };
    const tree = win.tree || safeGetCmp("west-panel");
    return Boolean(tree?.root && tree.root.childNodes && tree.root.childNodes.length > 0);
  }, undefined, { timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(800);
}

interface EbasInteractiveComboTarget {
  key: string;
  resolveSelectionText: () => Promise<string>;
}

async function applyInteractiveEbasKindSelections(
  page: PageScope,
  fields: EbasReportFormFields,
  idleTimeout: number
): Promise<void> {
  const sequence: EbasInteractiveComboTarget[] = [
    {
      key: "kind",
      resolveSelectionText: () =>
        resolveEbasComboOptionText(page, "mst1", "kind", fields.kind, fields.kind)
    },
    {
      key: "q_year",
      resolveSelectionText: async () => fields.year
    },
    {
      key: "q_fund",
      resolveSelectionText: () => readEbasComboDisplayValue(page, "q", "q_fund")
    },
    {
      key: "q_version",
      resolveSelectionText: () => readEbasComboDisplayValue(page, "q", "q_version")
    },
    {
      key: "q_stage",
      resolveSelectionText: () =>
        resolveEbasComboOptionText(page, "q", "q_stage", fields.stage, fields.stage)
    }
  ];

  for (const target of sequence) {
    const displayValue = (await target.resolveSelectionText()).trim();
    if (!displayValue) continue;

    const selected = await selectEbasTwinComboValue(page, target.key, displayValue);
    if (!selected) {
      throw new FlowError(
        ErrorCodes.DOWNLOAD_FAILED,
        `Unable to interactively select EBAS ${target.key} value "${displayValue}".`
      );
    }

    await waitForEbasUiIdle(page, idleTimeout).catch(() => undefined);
    await page.waitForTimeout(400);
  }
}

async function readEbasComboDisplayValue(
  page: PageScope,
  group: "q" | "mst1",
  key: string
): Promise<string> {
  return page.evaluate(({ group, key }) => {
    const win = window as typeof window & { q?: any; mst1?: any };
    const owner = group === "q" ? win.q : win.mst1;
    const component = owner?.[key];
    const rawValue = String(component?.getRawValue?.() || "").trim();
    if (rawValue) return rawValue;

    const elementValue = document.querySelector<HTMLInputElement>(`#${key}`)?.value || "";
    return String(elementValue).trim();
  }, { group, key }).catch(() => "");
}

async function resolveEbasComboOptionText(
  page: PageScope,
  group: "q" | "mst1",
  key: string,
  value: string,
  label = value
): Promise<string> {
  return page.evaluate(({ group, key, value, label }) => {
    const win = window as typeof window & { q?: any; mst1?: any };
    const owner = group === "q" ? win.q : win.mst1;
    const component = owner?.[key];

    const normalize = (candidate: unknown) => String(candidate ?? "").replace(/\s+/g, "");
    const valuesMatch = (left: string, right: string) => {
      if (left === right) return true;
      if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
        return left.replace(/^0+/, "") === right.replace(/^0+/, "");
      }
      return false;
    };

    const normalizedLabel = normalize(label || value);
    const count = Number(component?.store?.getCount?.() ?? 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = component.store.getAt?.(index);
      const data = candidate?.data || {};
      const code = String(data.code_no ?? data.value ?? data.id ?? "");
      const text = String(data.code_na ?? data.text ?? data.name ?? "").trim();
      const normalizedText = normalize(text);
      if (
        valuesMatch(code, value) ||
        normalizedText === normalizedLabel ||
        normalizedText.includes(normalizedLabel) ||
        normalizedLabel.includes(normalizedText)
      ) {
        return text;
      }
    }

    return String(label || value).trim();
  }, { group, key, value, label }).catch(() => String(label || value).trim());
}

async function selectEbasTwinComboValue(
  page: PageScope,
  hiddenInputId: string,
  value: string
): Promise<boolean> {
  const wrapper = page
    .locator(`xpath=//input[@id=${xpathString(hiddenInputId)}]/ancestor::div[contains(@class, "x-form-field-wrap")][1]`)
    .first();
  if (!await isVisible(wrapper, 2_000)) {
    return false;
  }

  const trigger = wrapper.locator(".x-form-arrow-trigger").first();
  const visibleInput = wrapper.locator("input.x-form-text, input:not([type='hidden'])").first();

  if (await isVisible(trigger, 1_000)) {
    await trigger.click();
  } else if (await isVisible(visibleInput, 1_000)) {
    await visibleInput.click();
  } else {
    return false;
  }

  await page.waitForTimeout(250);
  if (await clickDropdownOption(page, value)) {
    return true;
  }

  if (await isVisible(visibleInput, 1_000)) {
    await visibleInput.fill(value).catch(() => undefined);
    await page.waitForTimeout(250);
    if (await clickDropdownOption(page, value)) {
      return true;
    }
  }

  return false;
}

async function chooseByLabelOrNearbyText(page: PageScope, label: string, value: string): Promise<void> {
  const direct = page.getByLabel(label).first();
  if (await isVisible(direct)) {
    if (await tryNativeSelect(direct, value)) return;
    await direct.click();
    if (await clickDropdownOption(page, value)) return;
    await direct.fill(value).catch(() => undefined);
    if (await clickDropdownOption(page, value)) return;
    return;
  }

  const container = page
    .locator("tr, li, .row, .form-group, .form-row, .k-form-field, .form-inline, div")
    .filter({ hasText: label })
    .first();
  const rowSelect = container.locator("select").first();
  if (await isVisible(rowSelect)) {
    if (await tryNativeSelect(rowSelect, value)) return;
  }

  const combobox = container.locator("[role='combobox'], input[aria-autocomplete], input.k-input, .k-dropdown, .k-picker, .k-combobox, .select2-selection").first();
  if (await isVisible(combobox, 2_000)) {
    await combobox.click();
    if (await clickDropdownOption(page, value)) return;
  }

  const trigger = container.locator("button, .k-select, .k-input-button, .select2-selection__arrow, [aria-haspopup='listbox']").first();
  if (await isVisible(trigger, 2_000)) {
    await trigger.click();
    if (await clickDropdownOption(page, value)) return;
  }

  const textLabel = page.getByText(label, { exact: false }).first();
  if (await isVisible(textLabel, 2_000)) {
    await textLabel.click();
    if (await clickDropdownOption(page, value)) return;
  }

  throw new FlowError(
    ErrorCodes.DOWNLOAD_FAILED,
    `Unable to choose EBAS dropdown value "${value}" for label "${label}".`
  );
}

async function fillByLabelOrNearbyText(page: PageScope, label: string, value: string): Promise<void> {
  const direct = page.getByLabel(label).first();
  if (await isVisible(direct)) {
    await setInputValue(direct, value);
    return;
  }

  const rowXpathInput = page
    .locator(`xpath=//*[contains(normalize-space(.), ${xpathString(label)})]/ancestor::tr[1]//input[not(@type='hidden')]`)
    .first();
  if (await isVisible(rowXpathInput, 2_000)) {
    await setInputValue(rowXpathInput, value);
    return;
  }

  const rowInput = page
    .locator("tr, .row, .form-group, .form-row, div")
    .filter({ hasText: label })
    .locator("input")
    .first();
  if (await isVisible(rowInput)) {
    await setInputValue(rowInput, value);
    return;
  }

  const setByDom = await setInputValueNearText(page, label, value);
  if (setByDom) {
    return;
  }

  throw new FlowError(
    ErrorCodes.DOWNLOAD_FAILED,
    `Unable to find input field for EBAS label: ${label}`
  );
}

async function checkOutputFormat(page: PageScope, format: string): Promise<void> {
  if (format.toLowerCase() === "excel") {
    await setCheckboxNearText(page, "PDF", false);
    if (await setCheckboxNearText(page, "EXCEL", true)) return;
    if (await setCheckboxNearText(page, "Excel", true)) return;
    if (await setCheckboxNearText(page, "excel", true)) return;
  }

  const excel = page.getByLabel(/excel|Excel|EXCEL/i).first();
  if (await isVisible(excel)) {
    await excel.check();
    return;
  }

  const rowCheckbox = page
    .locator("tr, .row, .form-group, .form-row, div")
    .filter({ hasText: /輸出格式|excel/i })
    .locator("input[type='checkbox'], input[type='radio']")
    .first();
  if (await isVisible(rowCheckbox)) {
    await rowCheckbox.check();
    return;
  }

  await clickByText(page, format).catch(async () => clickByText(page, "excel"));
}

async function clickQueryIfPresent(page: PageScope): Promise<void> {
  const query = page.getByRole("button", { name: /查詢|搜尋|確認/i }).first();
  if (await isVisible(query, 2_000)) {
    await query.click();
    return;
  }

  const textQuery = page.getByText(/查詢|搜尋|確認/i).first();
  if (await isVisible(textQuery, 2_000)) {
    await textQuery.click();
  }
}

async function clickByText(page: PageScope, text: string): Promise<void> {
  const roleButton = page.getByRole("button", { name: text, exact: true }).first();
  if (await isVisible(roleButton, 2_000)) {
    await roleButton.click();
    return;
  }

  const roleLink = page.getByRole("link", { name: text, exact: true }).first();
  if (await isVisible(roleLink, 2_000)) {
    await roleLink.click();
    return;
  }

  const textLocator = page.getByText(text, { exact: true }).first();
  if (await isVisible(textLocator, 5_000)) {
    await textLocator.click();
    return;
  }

  throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `Unable to click EBAS text: ${text}`);
}

async function isVisible(locator: Locator, timeout = 5_000): Promise<boolean> {
  try {
    await locator.waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}

async function setInputValue(locator: Locator, value: string): Promise<void> {
  await locator.evaluate((element, nextValue) => {
    const input = element as HTMLInputElement | HTMLTextAreaElement;
    input.focus();
    input.value = nextValue;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
  }, value);
}

async function setInputValueNearText(
  page: PageScope,
  label: string,
  value: string
): Promise<boolean> {
  return page.evaluate(({ label, value }) => {
    const normalize = (text: string | null | undefined) => String(text ?? "").replace(/\s+/g, "");
    const target = normalize(label);
    const rows = Array.from(document.querySelectorAll("tr, .x-form-item, .x-panel, div"));

    for (const row of rows) {
      if (!normalize(row.textContent).includes(target)) continue;
      const input = row.querySelector<HTMLInputElement | HTMLTextAreaElement>("input:not([type='hidden']), textarea");
      if (!input) continue;
      input.focus();
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.blur();
      return true;
    }

    return false;
  }, { label, value }).catch(() => false);
}

async function setCheckboxNearText(
  page: PageScope,
  text: string,
  checked: boolean
): Promise<boolean> {
  const checkbox = page
    .locator(`xpath=//*[contains(normalize-space(.), ${xpathString(text)})]/preceding::input[@type='checkbox'][1]`)
    .first();

  if (await isVisible(checkbox, 1_000)) {
    const isChecked = await checkbox.isChecked().catch(() => false);
    if (isChecked !== checked) {
      await checkbox.setChecked(checked);
    }
    return true;
  }

  return page.evaluate(({ text, checked }) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();

    while (node) {
      if (String(node.textContent ?? "").includes(text)) {
        const element = node.parentElement;
        const row = element?.closest("tr, div") ?? element?.parentElement;
        const inputs = Array.from(row?.querySelectorAll<HTMLInputElement>("input[type='checkbox']") ?? []);
        const input = inputs.find((candidate) => {
          const parentText = candidate.parentElement?.textContent ?? "";
          return parentText.includes(text) || String(row?.textContent ?? "").includes(text);
        }) ?? inputs[0];

        if (input) {
          input.checked = checked;
          input.dispatchEvent(new Event("click", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }
      node = walker.nextNode();
    }

    return false;
  }, { text, checked }).catch(() => false);
}

function xpathString(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes("\"")) return `"${value}"`;
  return `concat(${value.split("'").map((part) => `'${part}'`).join(", \"'\", ")})`;
}

async function tryNativeSelect(locator: Locator, value: string): Promise<boolean> {
  try {
    await locator.selectOption({ label: value });
    return true;
  } catch {
    try {
      await locator.selectOption(value);
      return true;
    } catch {
      return false;
    }
  }
}

async function clickDropdownOption(page: PageScope, value: string): Promise<boolean> {
  const optionCandidates = [
    page.getByRole("option", { name: value, exact: true }).first(),
    page.locator("[role='listbox'], .k-list, .k-animation-container, .select2-results, .x-combo-list, .x-layer, ul, table")
      .getByText(value, { exact: true })
      .first(),
    page.locator(".x-combo-list-item, .search-item").getByText(value, { exact: true }).first(),
    page.getByText(value, { exact: true }).first()
  ];

  for (const candidate of optionCandidates) {
    if (await isVisible(candidate, 3_000)) {
      await candidate.click();
      return true;
    }
  }

  return false;
}

class DebugRecorder {
  public readonly dir: string;
  private step = 0;

  private constructor(dir: string) {
    this.dir = dir;
  }

  static async create(rootDir: string, reportId: string): Promise<DebugRecorder> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = path.join(rootDir, `${stamp}-${sanitizeFileName(reportId)}`);
    await fs.mkdir(dir, { recursive: true });
    const recorder = new DebugRecorder(dir);
    await recorder.event("debug_enabled", { reportId });
    return recorder;
  }

  async event(name: string, details: Record<string, unknown> = {}): Promise<void> {
    const entry = {
      time: new Date().toISOString(),
      name,
      details
    };
    await fs.appendFile(
      path.join(this.dir, "events.jsonl"),
      `${JSON.stringify(entry)}\n`,
      "utf8"
    ).catch(() => undefined);
  }

  async capture(page: Page, label: string): Promise<void> {
    this.step += 1;
    const safeLabel = sanitizeFileName(label);
    const prefix = `${String(this.step).padStart(2, "0")}-${safeLabel}`;
    await this.event("checkpoint", {
      label,
      url: page.url()
    });

    await page.screenshot({
      path: path.join(this.dir, `${prefix}-page.png`),
      fullPage: true
    }).catch(() => undefined);

    const pageHtml = await page.content()
      .catch((error) => contentCapturePlaceholder(page.url(), error));
    await fs.writeFile(path.join(this.dir, `${prefix}-page.html`), pageHtml, "utf8")
      .catch(() => undefined);

    const frames = page.frames();
    await Promise.all(frames.map(async (frame, index) => {
      await fs.writeFile(path.join(this.dir, `${prefix}-frame-${index}.url.txt`), frame.url(), "utf8")
        .catch(() => undefined);
      const frameHtml = await frame.content()
        .catch((error) => contentCapturePlaceholder(frame.url(), error));
      await fs.writeFile(path.join(this.dir, `${prefix}-frame-${index}.html`), frameHtml, "utf8")
        .catch(() => undefined);
    }));
  }

  async captureError(page: Page, error: unknown): Promise<string> {
    await this.event("task_failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    await this.capture(page, "error");
    await fs.writeFile(
      path.join(this.dir, "error.txt"),
      error instanceof Error ? `${error.name}\n${error.message}\n${error.stack ?? ""}` : String(error),
      "utf8"
    ).catch(() => undefined);
    await fs.writeFile(path.join(this.dir, "url.txt"), page.url(), "utf8")
      .catch(() => undefined);
    return this.dir;
  }
}

async function saveDebugArtifacts(page: Page, rootDir: string, error: unknown): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const debugDir = path.join(rootDir, stamp);
  await fs.mkdir(debugDir, { recursive: true });

  await page.screenshot({
    path: path.join(debugDir, "failure.png"),
    fullPage: true
  }).catch(() => undefined);

  const pageHtml = await page.content()
    .catch((error) => contentCapturePlaceholder(page.url(), error));
  await fs.writeFile(path.join(debugDir, "page.html"), pageHtml, "utf8")
    .catch(() => undefined);

  const frames = page.frames();
  await Promise.all(frames.map(async (frame, index) => {
    await fs.writeFile(path.join(debugDir, `frame-${index}.url.txt`), frame.url(), "utf8")
      .catch(() => undefined);
    const frameHtml = await frame.content()
      .catch((error) => contentCapturePlaceholder(frame.url(), error));
    await fs.writeFile(path.join(debugDir, `frame-${index}.html`), frameHtml, "utf8")
      .catch(() => undefined);
  }));

  await fs.writeFile(
    path.join(debugDir, "error.txt"),
    error instanceof Error ? `${error.name}\n${error.message}\n${error.stack ?? ""}` : String(error),
    "utf8"
  ).catch(() => undefined);

  await fs.writeFile(path.join(debugDir, "url.txt"), page.url(), "utf8")
    .catch(() => undefined);

  return debugDir;
}

function contentCapturePlaceholder(url: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `<!-- capture unavailable for ${url}: ${message} -->`;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

export function withTimestamp(name: string, extension = path.extname(name), now = new Date()): string {
  const baseName = path.basename(sanitizeFileName(name), path.extname(name));
  const safeExtension = extension || path.extname(name) || ".xlsx";
  const stamp = localFilenameTimestamp(now);
  return `${baseName}-${stamp}${safeExtension}`;
}

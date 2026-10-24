export type ProjectStatus = "draft" | "ready" | "archived";
export type RunStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type BrowserChannel = "bundled" | "chrome";
export type BrowserConnectionMode = "managed" | "cdp";
export type CdpInitialPageMode = "first" | "url" | "index";
export type AdapterKind = "generic" | "extjs" | "ksi" | "ebas";

export type StepKind =
  | "navigate"
  | "manual"
  | "click"
  | "dblclick"
  | "fill"
  | "select"
  | "upload"
  | "press"
  | "hover"
  | "check"
  | "uncheck"
  | "wait"
  | "assert"
  | "download"
  | "savePagePdf"
  | "screenshot"
  | "script"
  | "condition"
  | "loop"
  | "extractWebData"
  | "saveDocument"
  | "extractText"
  | "extractPattern"
  | "clipboard"
  | "newTab"
  | "switchTab"
  | "waitNewFirst"
  | "captureListSnapshot"
  | "waitNewListItem";

export type SelectorStrategy =
  | "role"
  | "label"
  | "placeholder"
  | "text"
  | "name"
  | "testId"
  | "css"
  | "xpath"
  | "component";

export interface SelectorRule {
  strategy: SelectorStrategy;
  value: string;
  role?: string;
  exact?: boolean;
  description?: string;
  manualInstruction?: string;
}

export interface FrameRule {
  name?: string;
  urlIncludes?: string;
  selector?: string;
}

export interface WaitRule {
  /** Search all frames for this wait independently of the action scope. */
  autoFrameSearch?: boolean;
  kind: "timeout" | "visible" | "hidden" | "attached" | "networkIdle" | "url";
  value?: string;
  timeoutMs?: number;
}

export interface VerificationRule {
  kind: "visible" | "hidden" | "exists" | "value" | "text" | "url" | "checked" | "download";
  expected?: string | boolean;
  selector?: SelectorRule[];
  timeoutMs?: number;
}

export interface ConditionRule {
  source: "parameter" | "variable" | "url" | "element";
  name?: string;
  operator: "equals" | "notEquals" | "contains" | "exists" | "notExists";
  value?: string;
  selector?: SelectorRule[];
}

export type LocatorMatchMode = "unique" | "first" | "last" | "nth";
export type ManualCompletionMode = "button" | "element" | "url";
export type TabTargetMode = "name" | "url" | "title" | "index";

export interface WorkflowStep {
  id: string;
  name: string;
  kind: StepKind;
  enabled: boolean;
  description?: string;
  value?: string | boolean;
  url?: string;
  selectors?: SelectorRule[];
  /** How to choose a target when a selector matches multiple visible desktop elements. */
  matchMode?: LocatorMatchMode;
  /** 1-based item number used when matchMode is "nth". */
  matchIndex?: number;
  frame?: FrameRule;
  /** Search the main document and all child frames when locating/waiting for elements. */
  autoFrameSearch?: boolean;
  /** How an interactive/manual checkpoint is considered complete. */
  manualCompletionMode?: ManualCompletionMode;
  /** URL fragment used when manualCompletionMode is "url". */
  manualExpected?: string;
  waitBefore?: WaitRule;
  waitAfter?: WaitRule;
  verification?: VerificationRule;
  timeoutMs?: number;
  retryCount?: number;
  adapter?: AdapterKind;
  componentPath?: string;
  script?: string;
  condition?: ConditionRule;
  thenSteps?: WorkflowStep[];
  elseSteps?: WorkflowStep[];
  loopVariable?: string;
  loopValues?: string[];
  loopParameter?: string;
  steps?: WorkflowStep[];
  dataCollection?: string;
  dataMode?: "single" | "list" | "table";
  dataRowSelector?: string;
  dataFields?: { name: string; selector: string; mode?: "text" | "html" | "attribute"; attribute?: string; required?: boolean }[];
  dataAppend?: boolean;
  dataIncludeSource?: boolean;
  dataLimit?: number;
  documentFormat?: "docx" | "json" | "xlsx";
  documentTitle?: string;
  documentFileName?: string;
  documentColumns?: string[];
  documentLayout?: "table" | "paragraphs";
  documentUseLocalTime?: boolean;
  documentSheetName?: string;
  /** Variable name that receives text/pattern extraction output. */
  outputVariable?: string;
  /** Text extraction mode for extractText. */
  extractMode?: "text" | "html" | "attribute";
  /** Attribute name when extractMode is "attribute". */
  extractAttribute?: string;
  /** Source variable for extractPattern / wait-new-data baselines. */
  sourceVariable?: string;
  /** Maximum number of visible list items to snapshot/scan. */
  listLimit?: number;
  /** Click the newly matched list item immediately after detection. */
  clickOnMatch?: boolean;
  /** Reload the active page periodically while waiting for new list data; disabled by default. */
  periodicRefresh?: boolean;
  /** Number of seconds between reloads (5–600), default 10 when enabled. */
  refreshIntervalSeconds?: number;
  /** JavaScript-compatible regular expression source for extractPattern. */
  regexPattern?: string;
  /** Optional regular expression flags for extractPattern / waitNewFirst. */
  regexFlags?: string;
  /** 0-based regular expression capture group to save. */
  regexGroup?: number;
  /** Optional logical name assigned to a tab created by newTab. */
  tabName?: string;
  /** How switchTab chooses the destination tab. */
  tabTargetMode?: TabTargetMode;
  /** Name/URL/title fragment used by switchTab. */
  tabTarget?: string;
  /** 1-based page number when tabTargetMode is "index". */
  tabIndex?: number;
  /** Download strategy: auto prefers direct href fetch, direct never clicks, click uses browser download/preview events. */
  downloadMode?: "auto" | "direct" | "click";
  /** How a downloaded artifact is named. Original is the safe default. */
  downloadFileNameMode?: "original" | "custom";
  /** User-defined base filename; may contain {{parameter}} placeholders. */
  downloadFileName?: string;
  /** Filename used when printing the current page to PDF. */
  pdfFileName?: string;
  pdfPageSize?: "A4" | "Letter";
  pdfOrientation?: "portrait" | "landscape";
  pdfPrintBackground?: boolean;
  pdfMarginTopMm?: number;
  pdfMarginRightMm?: number;
  pdfMarginBottomMm?: number;
  pdfMarginLeftMm?: number;
  /** Print Chromium header and footer templates with the PDF. */
  pdfDisplayHeaderFooter?: boolean;
  /** HTML print header template; supports Chromium's date/title/url/pageNumber/totalPages classes. */
  pdfHeaderTemplate?: string;
  /** HTML print footer template; supports Chromium's date/title/url/pageNumber/totalPages classes. */
  pdfFooterTemplate?: string;
  /** Chromium PDF scale, from 0.1 to 2.0 (10% to 200%). */
  pdfScale?: number;
  /** When false, print only the current viewport instead of the full document. */
  pdfFullPage?: boolean;
  /** Append the computer's local YYYYMMDD_HHmmss timestamp to the file name. */
  pdfUseLocalTime?: boolean;
}

export interface WorkflowParameter {
  id: string;
  name: string;
  label: string;
  type: "text" | "number" | "date" | "boolean" | "select" | "secret";
  required: boolean;
  defaultValue?: string | boolean;
  description?: string;
  options?: string[];
  /** Optional parent parameter key for a dependent select. */
  dependsOn?: string;
  /** Parent value -> allowed options mapping for a dependent select. */
  dependentOptions?: Record<string, string[]>;
  sensitive?: boolean;
}

export interface BrowserSettings {
  /** managed = Automation Studio launches the browser; cdp = attach to an existing local Chromium browser. */
  connectionMode: BrowserConnectionMode;
  channel: BrowserChannel;
  headless: boolean;
  /** Optional per-project plugin; effective only for managed browsers. */
  stealth?: boolean;
  slowMoMs: number;
  defaultTimeoutMs: number;
  downloadTimeoutMs: number;
  viewportWidth: number;
  viewportHeight: number;
  reuseProfile: boolean;
  /** Explicit opt-in: load encrypted CDP login state into isolated managed contexts. */
  authStateEnabled?: boolean;
  authVerifyUrl?: string;
  authSuccessSelector?: string;
  /** When true, the dedicated managed browser profile downloads PDFs instead of opening Chrome PDF preview. */
  downloadPdfInsteadOfPreview: boolean;
  /** Local Chrome DevTools Protocol endpoint used when connectionMode is cdp. */
  cdpEndpoint: string;
  /** Automatically start a dedicated local Chrome instance when CDP is unavailable. */
  cdpAutoLaunch: boolean;
  /** How to choose the initial page after attaching over CDP. */
  cdpInitialPageMode: CdpInitialPageMode;
  /** URL fragment used when cdpInitialPageMode is url. */
  cdpInitialPageTarget: string;
  /** 1-based page number used when cdpInitialPageMode is index. */
  cdpInitialPageIndex: number;
}

export interface WorkflowSettings {
  maxRetries: number;
  safePlayback: boolean;
  /** Use visible cursor movement, paced typing and varied pauses. */
  humanizedPlayback: boolean;
  minStepDelayMs: number;
  screenshotMode: "never" | "failure" | "everyStep";
  saveHtmlOnFailure: boolean;
  captureConsole: boolean;
  captureNetwork: boolean;
  defaultConcurrency: number;
}

export interface WorkflowProject {
  id: string;
  name: string;
  description: string;
  /** Version-specific release notes shown on the Publish page. */
  releaseNotes?: string;
  version: string;
  status: ProjectStatus;
  targetUrl: string;
  allowedDomains: string[];
  adapter: AdapterKind;
  browser: BrowserSettings;
  settings: WorkflowSettings;
  parameters: WorkflowParameter[];
  steps: WorkflowStep[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastRunStatus?: RunStatus;
}

export interface StepRunResult {
  stepId: string;
  name: string;
  kind: StepKind;
  status: "running" | "completed" | "failed" | "skipped";
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  attempt?: number;
  message?: string;
  screenshotPath?: string;
  downloadPath?: string;
  state?: Record<string, unknown>;
}

export interface WorkflowRun {
  id: string;
  projectId: string;
  projectName: string;
  status: RunStatus;
  mode: "full" | "single-step" | "from-step" | "batch";
  /** Independent browser workstation used by a parallel batch. */
  batchWorker?: number;
  batchConcurrency?: number;
  parameters: Record<string, string | boolean>;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  currentStepId?: string;
  completedSteps: number;
  totalSteps: number;
  steps: StepRunResult[];
  downloads: string[];
  /** Latest workflow variables snapshot for the designer Debug drawer. */
  variables?: Record<string, string | boolean>;
  debugDir: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface BatchRow {
  id: string;
  enabled: boolean;
  parameters: Record<string, string | boolean>;
}

export interface ExportSelection {
  portableWorkflow: boolean;
  typescript: boolean;
  skill: boolean;
  includeTests?: boolean;
  includeExamples?: boolean;
  includeDebugSample?: boolean;
}

export interface RecorderEvent {
  id: string;
  type: "click" | "dblclick" | "fill" | "select" | "check" | "navigate" | "download" | "hover" | "press" | "upload" | "assert";
  label: string;
  url: string;
  /** Resolved href/action of the element that was operated. */
  targetUrl?: string;
  value?: string;
  selector: SelectorRule[];
  verification?: VerificationRule;
  fileNames?: string[];
  sensitive?: boolean;
  frameUrl?: string;
  /** Top-to-current frame URL/name chain captured by the recorder. */
  framePath?: string[];
  createdAt: string;
}

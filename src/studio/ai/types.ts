export type AIProviderKind = "openai" | "gemini" | "ollama" | "openai_compatible" | "custom_gateway";
export type AIAuthMode = "none" | "api_key" | "bearer_token" | "custom_header";
export type AISecretSource = "env" | "inline";

export interface AISecretRef {
  source: AISecretSource;
  envName?: string;
  value?: string;
}

export interface AIProviderConfig {
  id: string;
  name: string;
  kind: AIProviderKind;
  enabled: boolean;
  endpoint: string;
  model?: string;
  timeoutMs?: number;
  authMode?: AIAuthMode;
  secret?: AISecretRef;
  apiKeyHeader?: string;
  customHeaderName?: string;
  extraHeaders?: Record<string, string>;
}

export interface AISettings {
  enabled: boolean;
  activeProviderId?: string;
  providers: AIProviderConfig[];
}

export interface AIMessage { role: "system" | "user" | "assistant"; content: string; }
export interface AIGenerateRequest {
  messages: AIMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "text" | "json";
  metadata?: Record<string, unknown>;
}
export interface AIGenerateResponse {
  providerId: string;
  providerKind: AIProviderKind;
  model?: string;
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  raw?: unknown;
}
export interface AIConnectionTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  providerId: string;
  providerKind: AIProviderKind;
  model?: string;
}
export interface AINetworkDiagnosticResult {
  ok: boolean;
  endpoint: string;
  httpStatus?: number;
  latencyMs: number;
  nodeVersion: string;
  tls: {
    systemCARequested: boolean;
    extraCAConfigured: boolean;
    extraCAPath?: string;
    verificationDisabled: boolean;
  };
  error?: { message: string; code?: string; cause?: string };
  guidance: string[];
}
export interface AIProvider {
  readonly config: AIProviderConfig;
  generate(request: AIGenerateRequest): Promise<AIGenerateResponse>;
  testConnection(): Promise<AIConnectionTestResult>;
}

export interface AIObservedElement {
  ref: string;
  frameIndex: number;
  frameUrl: string;
  tag: string;
  role?: string;
  type?: string;
  text?: string;
  ariaLabel?: string;
  placeholder?: string;
  name?: string;
  href?: string;
  download?: boolean;
  options?: string[];
}

export interface AIObservedPage {
  observedAt: string;
  url: string;
  title: string;
  elements: AIObservedElement[];
}

export interface AIExplorationTraceStep {
  index: number;
  action: "click" | "fill" | "select" | "check" | "uncheck" | "press" | "download" | "manual";
  label: string;
  pageUrl: string;
  frameUrl?: string;
  elementRef?: string;
  selectors?: import("../types.ts").SelectorRule[];
  workflowValue?: string;
  result?: string;
}


export interface AIWorkflowMonitorState {
  phase: "idle" | "page_scan" | "ai_planning" | "selector_probe" | "browser_action" | "page_wait" | "manual" | "complete" | "failed";
  status: "idle" | "running" | "waiting" | "manual" | "completed" | "failed";
  label: string;
  detail?: string;
  waitingFor?: string;
  currentAction?: string;
  currentElementRef?: string;
  currentSelector?: string;
  currentUrl?: string;
  attempt?: number;
  maxAttempts?: number;
  phaseStartedAt: string;
  updatedAt: string;
  lastSuccess?: string;
  lastSuccessAt?: string;
  repeatCount?: number;
  warning?: string;
}

export interface AIWorkflowSiteEvidence {
  sessionId: string;
  startedAt: string;
  targetUrl: string;
  currentUrl: string;
  pages: AIObservedPage[];
  trace: AIExplorationTraceStep[];
  verifiedSelectors: import("../types.ts").SelectorRule[];
  readyForDraft: boolean;
  requiresManual: boolean;
  manualReason?: string;
  browserSource?: string;
  monitor?: AIWorkflowMonitorState;
}

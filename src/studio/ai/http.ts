import type { AINetworkDiagnosticResult, AIProviderConfig } from "./types.ts";
import { resolveSecret } from "./config.ts";
import { AIProviderError } from "./errors.ts";
import { redactText } from "./sanitize.ts";

const DEFAULT_RETRY_DELAYS = [1000, 2000, 4000];
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export function buildAuthHeaders(config: AIProviderConfig): Record<string, string> {
  const headers: Record<string, string> = { ...(config.extraHeaders ?? {}) };
  const secret = resolveSecret(config);
  switch (config.authMode ?? "none") {
    case "none": return headers;
    case "bearer_token": if (secret) headers.Authorization = `Bearer ${secret}`; return headers;
    case "api_key": if (secret) headers[config.apiKeyHeader || "x-api-key"] = secret; return headers;
    case "custom_header": if (secret && config.customHeaderName) headers[config.customHeaderName] = secret; return headers;
  }
}

export async function fetchJson<T>(config: AIProviderConfig, url: string, init: RequestInit, options?: { retryDelaysMs?: number[] }): Promise<T> {
  const retryDelays = options?.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      return await fetchJsonOnce<T>(config, url, init);
    } catch (error) {
      lastError = error;
      const status = error instanceof AIProviderError ? error.status : undefined;
      const retryable = error instanceof AIProviderError ? error.retryable === true : false;
      if (!retryable || status === undefined || attempt >= retryDelays.length) throw error;
      await delay(retryDelays[attempt] ?? 1000);
    }
  }
  throw lastError;
}

async function fetchJsonOnce<T>(config: AIProviderConfig, url: string, init: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, config.timeoutMs ?? 180000));
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let parsed: unknown = undefined;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
    if (!response.ok) {
      const detail = extractApiErrorMessage(parsed) || response.statusText;
      const friendly = friendlyHttpMessage(config, response.status, detail);
      throw new AIProviderError(redactText(friendly), {
        providerId: config.id,
        status: response.status,
        code: extractApiErrorCode(parsed),
        retryable: RETRYABLE_STATUS.has(response.status)
      });
    }
    return parsed as T;
  } catch (error) {
    if (error instanceof AIProviderError) throw error;
    const timeoutMs = Math.max(1000, config.timeoutMs ?? 180000);
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new AIProviderError(`AI 回應逾時：等待超過 ${Math.ceil(timeoutMs / 1000)} 秒，已停止本次請求。`, { providerId: config.id, code: "AI_TIMEOUT", cause: error });
    }
    const details = describeNetworkError(error);
    throw new AIProviderError(redactText(details.message), { providerId: config.id, code: details.code, cause: error });
  } finally {
    clearTimeout(timer);
  }
}

export async function diagnoseProviderNetwork(config: AIProviderConfig): Promise<AINetworkDiagnosticResult> {
  const started = Date.now();
  const endpoint = diagnosticUrl(config);
  const base = {
    endpoint,
    latencyMs: 0,
    nodeVersion: process.version,
    tls: {
      systemCARequested: process.env.NODE_USE_SYSTEM_CA === "1",
      extraCAConfigured: Boolean(process.env.NODE_EXTRA_CA_CERTS),
      extraCAPath: process.env.NODE_EXTRA_CA_CERTS || undefined,
      verificationDisabled: process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0"
    }
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(Math.max(3000, config.timeoutMs ?? 15000), 30000));
  try {
    const response = await fetch(endpoint, { method: "GET", signal: controller.signal, headers: { accept: "application/json" } });
    return { ...base, ok: true, httpStatus: response.status, latencyMs: Date.now() - started, guidance: networkGuidance(undefined, base.tls) };
  } catch (error) {
    const details = describeNetworkError(error);
    return {
      ...base,
      ok: false,
      latencyMs: Date.now() - started,
      error: { message: details.message, code: details.code, cause: details.cause },
      guidance: networkGuidance(details.code, base.tls)
    };
  } finally {
    clearTimeout(timer);
  }
}

export function joinUrl(base: string, path: string): string { return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`; }

function diagnosticUrl(config: AIProviderConfig): string {
  if (config.kind === "gemini") return joinUrl(config.endpoint, "models");
  if (config.kind === "ollama") return joinUrl(config.endpoint, "api/tags");
  if (config.kind === "openai" || config.kind === "openai_compatible") return joinUrl(config.endpoint, "models");
  return config.endpoint;
}

function friendlyHttpMessage(config: AIProviderConfig, status: number, detail: string): string {
  if (config.kind === "gemini" && status === 503) return `Gemini 模型目前高負載（503 UNAVAILABLE）。系統已自動重試 3 次；請稍後再試或改用其他模型。Google 回覆：${detail}`;
  if (status === 429) return `AI 服務目前達到速率或額度限制（429）。系統已自動重試；請稍後再試。${detail ? ` ${detail}` : ""}`;
  if (status >= 500) return `AI 服務暫時不可用（HTTP ${status}）。系統已自動重試。${detail ? ` ${detail}` : ""}`;
  return `AI request failed (HTTP ${status}): ${detail}`;
}

function extractApiErrorMessage(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 1200);
  if (value && typeof value === "object") {
    const raw = value as Record<string, unknown>;
    const error = raw.error && typeof raw.error === "object" ? raw.error as Record<string, unknown> : undefined;
    const message = error?.message ?? raw.message;
    if (message !== undefined) return String(message).slice(0, 1200);
    return JSON.stringify(value).slice(0, 1200);
  }
  return "";
}

function extractApiErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const error = raw.error && typeof raw.error === "object" ? raw.error as Record<string, unknown> : undefined;
  const code = error?.status ?? error?.code ?? raw.code;
  return code === undefined ? undefined : String(code);
}

function describeNetworkError(error: unknown): { message: string; code?: string; cause?: string } {
  const root = rootCause(error);
  const topMessage = error instanceof Error ? error.message : String(error);
  const causeMessage = root instanceof Error ? root.message : root ? String(root) : "";
  const code = root && typeof root === "object" && "code" in root ? String((root as { code?: unknown }).code ?? "") || undefined : undefined;
  const parts = [`AI 連線失敗：${topMessage}`];
  if (code || causeMessage) parts.push(`底層原因：${[code, causeMessage].filter(Boolean).join(" - ")}`);
  if (code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" || /local issuer certificate/i.test(causeMessage)) {
    parts.push("這通常代表 Node.js 不信任公司 TLS/HTTPS 檢查憑證。請設定 NODE_EXTRA_CA_CERTS 為公司 Root/Intermediate CA PEM；不要長期使用 NODE_TLS_REJECT_UNAUTHORIZED=0。");
  }
  return { message: parts.join("；"), code, cause: causeMessage || undefined };
}

function rootCause(error: unknown): unknown {
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && "cause" in current && !seen.has(current)) {
    seen.add(current);
    const next = (current as { cause?: unknown }).cause;
    if (!next) break;
    current = next;
  }
  return current;
}

function networkGuidance(code: string | undefined, tls: { systemCARequested: boolean; extraCAConfigured: boolean; verificationDisabled: boolean }): string[] {
  const out: string[] = [];
  if (code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY") {
    out.push("目前是 TLS 憑證鏈信任問題，不是 API Key 問題。", "向資訊單位取得公司 Root/Intermediate CA 的 PEM，並以 NODE_EXTRA_CA_CERTS 指向該檔案。", "修改 CA 後需完全重新啟動 Automation Studio。 ");
  }
  if (tls.systemCARequested && code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY") out.push("NODE_USE_SYSTEM_CA=1 已啟用但仍失敗，表示 Windows 系統 CA 尚不足以建立完整憑證鏈。 ");
  if (tls.verificationDisabled) out.push("目前 NODE_TLS_REJECT_UNAUTHORIZED=0：僅適合短暫診斷，正式使用前請恢復 TLS 驗證。 ");
  if (!tls.extraCAConfigured && code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY") out.push("目前未設定 NODE_EXTRA_CA_CERTS。 ");
  if (!out.length) out.push("網路/TLS 連線已取得 HTTP 回應；若 Provider 測試仍失敗，請檢查 API Key、模型名稱或服務額度。 ");
  return out;
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

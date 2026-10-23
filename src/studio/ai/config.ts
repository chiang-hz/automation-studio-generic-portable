import type { AIProviderConfig, AISettings } from "./types.ts";
import { AIProviderError } from "./errors.ts";

export const DEFAULT_AI_SETTINGS: AISettings = {
  enabled: false,
  providers: [
    { id: "openai-default", name: "OpenAI", kind: "openai", enabled: false, endpoint: "https://api.openai.com/v1", authMode: "bearer_token", secret: { source: "env", envName: "OPENAI_API_KEY" }, timeoutMs: 180000 },
    { id: "gemini-default", name: "Gemini", kind: "gemini", enabled: false, endpoint: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-3.5-flash-lite", authMode: "api_key", apiKeyHeader: "x-goog-api-key", secret: { source: "env", envName: "GEMINI_API_KEY" }, timeoutMs: 180000 },
    { id: "ollama-local", name: "Ollama / Local", kind: "ollama", enabled: false, endpoint: "http://127.0.0.1:11434", authMode: "none", timeoutMs: 180000 },
    { id: "openai-compatible", name: "OpenAI-compatible", kind: "openai_compatible", enabled: false, endpoint: "http://127.0.0.1:8000/v1", authMode: "none", timeoutMs: 180000 },
    { id: "custom-gateway", name: "Company AI Gateway", kind: "custom_gateway", enabled: false, endpoint: "http://127.0.0.1:8080/api/ai", authMode: "none", timeoutMs: 180000 }
  ]
};

export function resolveSecret(config: AIProviderConfig): string | undefined {
  if (!config.secret) return undefined;
  if (config.secret.source === "env") {
    const name = config.secret.envName?.trim();
    return name ? process.env[name] : undefined;
  }
  return config.secret.value;
}

export function assertProviderConfig(config: AIProviderConfig): void {
  if (!config.id?.trim()) throw new AIProviderError("AI provider id is required.");
  if (!config.endpoint?.trim()) throw new AIProviderError("AI provider endpoint is required.", { providerId: config.id });
  if (config.authMode && config.authMode !== "none" && !resolveSecret(config)) {
    throw new AIProviderError("AI 憑證尚未設定，請檢查密鑰來源或環境變數。", { providerId: config.id, code: "AI_CREDENTIAL_MISSING" });
  }
  if (config.authMode === "custom_header" && !config.customHeaderName?.trim()) {
    throw new AIProviderError("自訂 Header 驗證需要 Header 名稱。", { providerId: config.id });
  }
}

export function getActiveProviderConfig(settings: AISettings): AIProviderConfig {
  if (!settings.enabled) throw new AIProviderError("AI 功能尚未啟用。", { code: "AI_DISABLED" });
  const config = settings.providers.find((provider) => provider.id === settings.activeProviderId && provider.enabled);
  if (!config) throw new AIProviderError("目前沒有已啟用的 AI Provider。", { code: "AI_PROVIDER_NOT_FOUND" });
  assertProviderConfig(config);
  return config;
}

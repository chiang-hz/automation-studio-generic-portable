import type { AIConnectionTestResult, AIGenerateRequest, AIGenerateResponse, AIProvider, AIProviderConfig } from "../types.ts";
import { buildAuthHeaders, fetchJson, joinUrl } from "../http.ts";
import { AIProviderError } from "../errors.ts";
import { resolveSecret } from "../config.ts";
interface Shape { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }; modelVersion?: string; }
export class GeminiProvider implements AIProvider {
  config: AIProviderConfig;
  constructor(config: AIProviderConfig) { this.config = config; }
  async generate(request: AIGenerateRequest): Promise<AIGenerateResponse> {
    if (!this.config.model) throw new AIProviderError("Gemini model is required.", { providerId: this.config.id });
    const endpoint = joinUrl(this.config.endpoint, `models/${encodeURIComponent(this.config.model)}:generateContent`);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if ((this.config.authMode ?? "api_key") === "api_key") {
      const key = resolveSecret(this.config);
      if (!key) throw new AIProviderError("Gemini API Key 尚未設定。", { providerId: this.config.id, code: "AI_CREDENTIAL_MISSING" });
      headers[this.config.apiKeyHeader || "x-goog-api-key"] = key;
    } else Object.assign(headers, buildAuthHeaders(this.config));
    const systemText = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const contents = request.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    const data = await fetchJson<Shape>(this.config, endpoint, { method: "POST", headers, body: JSON.stringify({ systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined, contents, generationConfig: { temperature: request.temperature, maxOutputTokens: request.maxTokens, responseMimeType: request.responseFormat === "json" ? "application/json" : "text/plain" } }) });
    const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    return { providerId: this.config.id, providerKind: this.config.kind, model: data.modelVersion ?? this.config.model, text, raw: data, usage: { inputTokens: data.usageMetadata?.promptTokenCount, outputTokens: data.usageMetadata?.candidatesTokenCount, totalTokens: data.usageMetadata?.totalTokenCount } };
  }
  async testConnection(): Promise<AIConnectionTestResult> { const started = Date.now(); const r = await this.generate({ messages: [{ role: "user", content: "Reply with OK only." }], maxTokens: 8, temperature: 0 }); return { ok: Boolean(r.text), message: r.text ? "Gemini 連線成功。" : "Gemini 已連線但沒有回傳文字。", latencyMs: Date.now() - started, providerId: this.config.id, providerKind: this.config.kind, model: r.model }; }
}

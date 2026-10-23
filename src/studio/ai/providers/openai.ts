import type { AIConnectionTestResult, AIGenerateRequest, AIGenerateResponse, AIProvider, AIProviderConfig } from "../types.ts";
import { buildAuthHeaders, fetchJson, joinUrl } from "../http.ts";
import { AIProviderError } from "../errors.ts";
interface Shape { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; model?: string; }
export class OpenAIProvider implements AIProvider {
  config: AIProviderConfig;
  constructor(config: AIProviderConfig) { this.config = config; }
  async generate(request: AIGenerateRequest): Promise<AIGenerateResponse> {
    if (!this.config.model) throw new AIProviderError("OpenAI model is required.", { providerId: this.config.id });
    const data = await fetchJson<Shape>(this.config, joinUrl(this.config.endpoint, "chat/completions"), { method: "POST", headers: { "content-type": "application/json", ...buildAuthHeaders({ ...this.config, authMode: this.config.authMode ?? "bearer_token" }) }, body: JSON.stringify({ model: this.config.model, messages: request.messages, temperature: request.temperature, max_tokens: request.maxTokens, response_format: request.responseFormat === "json" ? { type: "json_object" } : undefined }) });
    const text = data.choices?.[0]?.message?.content ?? "";
    return { providerId: this.config.id, providerKind: this.config.kind, model: data.model ?? this.config.model, text, raw: data, usage: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens, totalTokens: data.usage?.total_tokens } };
  }
  async testConnection(): Promise<AIConnectionTestResult> { const started = Date.now(); const r = await this.generate({ messages: [{ role: "user", content: "Reply with OK only." }], maxTokens: 8, temperature: 0 }); return { ok: Boolean(r.text), message: r.text ? "Connection successful." : "Connected, but no text returned.", latencyMs: Date.now() - started, providerId: this.config.id, providerKind: this.config.kind, model: r.model }; }
}

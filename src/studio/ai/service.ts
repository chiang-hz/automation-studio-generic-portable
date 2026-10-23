import type { AIConnectionTestResult, AIGenerateRequest, AIGenerateResponse, AINetworkDiagnosticResult, AISettings } from "./types.ts";
import { createAIProvider } from "./factory.ts";
import { getActiveProviderConfig } from "./config.ts";
import { diagnoseProviderNetwork } from "./http.ts";
export class AIService {
  getSettings: () => Promise<AISettings> | AISettings;
  constructor(getSettings: () => Promise<AISettings> | AISettings) { this.getSettings = getSettings; }
  async generate(request: AIGenerateRequest): Promise<AIGenerateResponse> { const settings = await this.getSettings(); return createAIProvider(getActiveProviderConfig(settings)).generate(request); }
  async testActiveConnection(): Promise<AIConnectionTestResult> { const settings = await this.getSettings(); return createAIProvider(getActiveProviderConfig(settings)).testConnection(); }
  async testProvider(providerId: string): Promise<AIConnectionTestResult> { const settings = await this.getSettings(); const config = settings.providers.find((p) => p.id === providerId); if (!config) throw new Error(`AI provider not found: ${providerId}`); return createAIProvider(config).testConnection(); }
  async diagnoseProvider(providerId: string): Promise<AINetworkDiagnosticResult> { const settings = await this.getSettings(); const config = settings.providers.find((p) => p.id === providerId); if (!config) throw new Error(`AI provider not found: ${providerId}`); return diagnoseProviderNetwork(config); }
}

import type { AIProvider, AIProviderConfig } from "./types.ts";
import { assertProviderConfig } from "./config.ts";
import { OpenAIProvider } from "./providers/openai.ts";
import { GeminiProvider } from "./providers/gemini.ts";
import { OllamaProvider } from "./providers/ollama.ts";
import { OpenAICompatibleProvider } from "./providers/openaiCompatible.ts";
import { CustomGatewayProvider } from "./providers/customGateway.ts";
import { AIProviderError } from "./errors.ts";
export function createAIProvider(config: AIProviderConfig): AIProvider { assertProviderConfig(config); switch (config.kind) { case "openai": return new OpenAIProvider(config); case "gemini": return new GeminiProvider(config); case "ollama": return new OllamaProvider(config); case "openai_compatible": return new OpenAICompatibleProvider(config); case "custom_gateway": return new CustomGatewayProvider(config); default: throw new AIProviderError(`Unsupported AI provider kind: ${(config as AIProviderConfig).kind}`, { providerId: config.id }); } }

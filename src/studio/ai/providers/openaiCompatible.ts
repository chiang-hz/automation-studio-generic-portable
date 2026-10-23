import { OpenAIProvider } from "./openai.ts";
import type { AIProviderConfig } from "../types.ts";
export class OpenAICompatibleProvider extends OpenAIProvider { constructor(config: AIProviderConfig) { super(config); } }

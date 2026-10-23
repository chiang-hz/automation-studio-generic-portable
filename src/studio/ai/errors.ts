export class AIProviderError extends Error {
  providerId?: string;
  status?: number;
  code?: string;
  retryable?: boolean;

  constructor(message: string, options?: { providerId?: string; status?: number; code?: string; retryable?: boolean; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "AIProviderError";
    this.providerId = options?.providerId;
    this.status = options?.status;
    this.code = options?.code;
    this.retryable = options?.retryable;
  }
}

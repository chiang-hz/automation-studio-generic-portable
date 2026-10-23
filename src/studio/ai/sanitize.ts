const SECRET_KEYS = ["authorization", "api-key", "apikey", "x-api-key", "x-goog-api-key", "token", "access_token", "password", "secret"];

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEYS.some((secret) => key.toLowerCase().includes(secret)) ? "***" : redactSecrets(val);
  }
  return out;
}

export function redactText(input: string): string {
  return input
    .replace(/(bearer\s+)[a-z0-9._~+/=-]+/gi, "$1***")
    .replace(/((?:x-goog-api-key|api[-_ ]?key|token|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1***")
    .replace(/([?&]key=)[^&\s]+/gi, "$1***");
}

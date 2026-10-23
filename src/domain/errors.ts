export class FlowError extends Error {
  public readonly code: string;
  public readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    details?: unknown
  ) {
    super(message);
    this.name = "FlowError";
    this.code = code;
    this.details = details;
  }
}

export const ErrorCodes = {
  REPORT_NOT_FOUND: "REPORT_NOT_FOUND",
  INVALID_PARAMETERS: "INVALID_PARAMETERS",
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  DOWNLOAD_FAILED: "DOWNLOAD_FAILED",
  DOWNLOAD_TIMEOUT: "DOWNLOAD_TIMEOUT",
  LOGIN_REQUIRED: "LOGIN_REQUIRED",
  MFA_REQUIRED: "MFA_REQUIRED",
  CAPTCHA_REQUIRED: "CAPTCHA_REQUIRED",
  FILE_PARSE_FAILED: "FILE_PARSE_FAILED",
  PLAYWRIGHT_NOT_CONFIGURED: "PLAYWRIGHT_NOT_CONFIGURED"
} as const;

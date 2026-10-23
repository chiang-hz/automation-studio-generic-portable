import path from "node:path";

export type AdapterKind = "mock" | "playwright" | "ebas";

export interface AppConfig {
  adapter: AdapterKind;
  downloadDir: string;
  targetBaseUrl?: string;
  targetUsername?: string;
  targetPassword?: string;
  ebasLoginUrl: string;
  ebasEntryUrl: string;
  ebasStorageStatePath: string;
  ebasWorkerAuthDir: string;
  ebasDebugDir: string;
  ebasReportDefinitionsPath: string;
  ebasPrintClickTimeoutMs: number;
  ebasDownloadTimeoutMs: number;
  ebasUiIdleTimeoutMs: number;
  ebasPrePrintNetworkIdleTimeoutMs: number;
  chromiumExecutablePath?: string;
  slowMo: number;
  headless: boolean;
}

export function loadConfig(): AppConfig {
  const adapter = (process.env.REPORT_ADAPTER ?? "mock") as AdapterKind;
  const downloadDir = path.resolve(process.env.DOWNLOAD_DIR ?? "./downloads");

  return {
    adapter,
    downloadDir,
    targetBaseUrl: process.env.TARGET_BASE_URL,
    targetUsername: process.env.TARGET_USERNAME,
    targetPassword: process.env.TARGET_PASSWORD,
    ebasLoginUrl: process.env.EBAS_LOGIN_URL ??
      "https://sso.ebas.gov.tw/Account/Login?ReturnUrl=%2Fconnect%2Fauthorize%2Fcallback%3Fresponse_type%3Dcode%26client_id%3DId_80f2567f55b64813a57c8c5f8781769b%26state%3Drelese%26redirect_uri%3Dhttps%253A%252F%252Febasnew.ebas.gov.tw%252Flogin%252FVerify%26scope%3Demail%2520openid%2520profile",
    ebasEntryUrl: process.env.EBAS_ENTRY_URL ?? "https://ebasnew.ebas.gov.tw/SSO/ToLink/0/1103",
    ebasStorageStatePath: path.resolve(process.env.EBAS_STORAGE_STATE ?? "./.auth/ebas-storage-state.json"),
    ebasWorkerAuthDir: path.resolve(process.env.EBAS_WORKER_AUTH_DIR ?? "./.auth"),
    ebasDebugDir: path.resolve(process.env.EBAS_DEBUG_DIR ?? "./debug/ebas"),
    ebasReportDefinitionsPath: path.resolve(process.env.EBAS_REPORT_DEFINITIONS ?? "./data/ebas-report-definitions.json"),
    ebasPrintClickTimeoutMs: Number(process.env.EBAS_PRINT_CLICK_TIMEOUT_MS ?? "30000"),
    ebasDownloadTimeoutMs: Number(process.env.EBAS_DOWNLOAD_TIMEOUT_MS ?? "60000"),
    ebasUiIdleTimeoutMs: Number(process.env.EBAS_UI_IDLE_TIMEOUT_MS ?? "60000"),
    ebasPrePrintNetworkIdleTimeoutMs: Number(process.env.EBAS_PRE_PRINT_NETWORK_IDLE_TIMEOUT_MS ?? "5000"),
    chromiumExecutablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_EXECUTABLE_PATH,
    slowMo: Number(process.env.SLOW_MO ?? "0"),
    headless: (process.env.HEADLESS ?? "true").toLowerCase() !== "false"
  };
}


export const EBAS_WORKER_IDS = ["A", "B"] as const;
export type EbasWorkerId = typeof EBAS_WORKER_IDS[number];

export function resolveEbasWorkerStorageStatePath(config: AppConfig, workerId: string): string {
  const normalized = workerId.trim().toUpperCase();
  return path.join(config.ebasWorkerAuthDir, `ebas-worker-${normalized.toLowerCase()}-storage-state.json`);
}

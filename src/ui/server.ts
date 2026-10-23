import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page } from "playwright";
import { EBAS_WORKER_IDS, loadConfig, resolveEbasWorkerStorageStatePath } from "../config.ts";
import {
  deleteEbasReportDefinition,
  importEbasReportDefinitions,
  listEbasReportDefinitions,
  loadSampleEbasReportDefinition,
  saveEbasReportDefinition
} from "../adapters/ebasReportDefinitions.ts";
import { resolveChromiumExecutablePath } from "../adapters/chromiumExecutable.ts";
import { createReportService } from "../container.ts";
import { formatToolError, MinimalMcpServer } from "../mcp/server.ts";
import { createStudioRouter } from "../studio/router.ts";
import { openInterfaceOnStartup } from "./startup.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../../public");
const batchMemoryPath = path.resolve(__dirname, "../../data/ui-batch-items.json");
const batchPresetsPath = path.resolve(__dirname, "../../data/batch-presets.json");
const port = Number(process.env.UI_PORT ?? "4173");
const config = loadConfig();

const service = await createReportService();
const mcpServer = new MinimalMcpServer(service);
const studioRouter = await createStudioRouter();
const manualLoginSessions = new Map<string, ManualLoginSession>();

interface ManualLoginSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  startedAt: string;
}

interface BatchMemoryItem {
  reportId: string;
  reportName: string;
  parameters: Record<string, string>;
}

interface BatchPreset {
  id: string;
  name: string;
  description: string;
  continueOnError: boolean;
  items: BatchMemoryItem[];
  createdAt: string;
  updatedAt: string;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (await studioRouter(request, response, url)) {
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, {
        ok: true,
        server: "playwright-mcp-report-flow-ui"
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/mcp/tools") {
      sendJson(response, 200, await mcpServer.listTools());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/batch-memory") {
      sendJson(response, 200, {
        items: await readBatchMemory()
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/batch-memory") {
      const body = await readJsonBody(request);
      const items = normalizeBatchMemoryItems(body.items);
      await writeBatchMemory(items);
      sendJson(response, 200, {
        items
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/batch-presets") {
      sendJson(response, 200, {
        presets: await readBatchPresets()
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/batch-presets") {
      const body = await readJsonBody(request);
      const preset = await saveBatchPreset(body);
      sendJson(response, 200, {
        preset,
        presets: await readBatchPresets()
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/batch-presets/reorder") {
      const body = await readJsonBody(request);
      const presets = await reorderBatchPresets(Array.isArray(body.ids) ? body.ids.map(String) : []);
      sendJson(response, 200, { presets });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/batch-presets/import") {
      const body = await readJsonBody(request);
      const presets = await importBatchPresets(Array.isArray(body.presets) ? body.presets : []);
      sendJson(response, 200, { presets });
      return;
    }

    if (request.method === "DELETE" && url.pathname === "/api/batch-presets") {
      const id = url.searchParams.get("id") ?? "";
      const presets = await deleteBatchPreset(id);
      sendJson(response, 200, { presets });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/downloads/open") {
      sendJson(response, 200, await openDownloadDirectory());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/ebas/report-definitions") {
      sendJson(response, 200, {
        definitions: await listEbasReportDefinitions(config.ebasReportDefinitionsPath)
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ebas/report-definitions/sample") {
      const definition = await loadSampleEbasReportDefinition(config.ebasReportDefinitionsPath);
      sendJson(response, 200, {
        definition,
        definitions: await listEbasReportDefinitions(config.ebasReportDefinitionsPath)
      });
      return;
    }

    if (request.method === "DELETE" && url.pathname === "/api/ebas/report-definitions") {
      const reportId = url.searchParams.get("id") ?? "";
      sendJson(response, 200, {
        definitions: await deleteEbasReportDefinition(config.ebasReportDefinitionsPath, reportId)
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ebas/report-definitions/import") {
      const body = await readJsonBody(request);
      const definitions = await importEbasReportDefinitions(
        config.ebasReportDefinitionsPath,
        Array.isArray(body.definitions) ? body.definitions : []
      );
      sendJson(response, 200, { definitions });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/ebas/workers/status") {
      sendJson(response, 200, {
        workers: await Promise.all(EBAS_WORKER_IDS.map((workerId) => getManualLoginStatus(workerId)))
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ebas/workers/start") {
      const body = await readJsonBody(request);
      sendJson(response, 200, await startManualLogin(normalizeWorkerId(body.workerId)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ebas/workers/complete") {
      const body = await readJsonBody(request);
      sendJson(response, 200, await completeManualLogin(normalizeWorkerId(body.workerId)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ebas/workers/cancel") {
      const body = await readJsonBody(request);
      sendJson(response, 200, await closeManualLoginSession(normalizeWorkerId(body.workerId), "cancelled"));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ebas/workers/check") {
      const body = await readJsonBody(request);
      sendJson(response, 200, await checkWorkerSession(normalizeWorkerId(body.workerId)));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/ebas/manual-login/status") {
      sendJson(response, 200, await getManualLoginStatus("A"));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ebas/manual-login/start") {
      sendJson(response, 200, await startManualLogin("A"));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ebas/manual-login/complete") {
      sendJson(response, 200, await completeManualLogin("A"));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ebas/manual-login/cancel") {
      sendJson(response, 200, await closeManualLoginSession("A", "cancelled"));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ebas/report-definitions") {
      const body = await readJsonBody(request);
      const definition = await saveEbasReportDefinition(config.ebasReportDefinitionsPath, {
        id: String(body.id ?? ""),
        name: String(body.name ?? ""),
        description: String(body.description ?? ""),
        menuPath: Array.isArray(body.menuPath) ? body.menuPath.map(String) : String(body.menuPath ?? ""),
        businessType: String(body.businessType ?? ""),
        fundType: String(body.fundType ?? ""),
        year: String(body.year ?? ""),
        stage: String(body.stage ?? ""),
        outputFormat: String(body.outputFormat ?? ""),
        kind: String(body.kind ?? ""),
        kindOptions: Array.isArray(body.kindOptions)
          ? body.kindOptions.map((item) => String(item))
          : String(body.kindOptions ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
        printLevel: String(body.printLevel ?? ""),
        usagePrintStopLevel: String(body.usagePrintStopLevel ?? ""),
        accountLevel: String(body.accountLevel ?? ""),
        accountCode: String(body.accountCode ?? ""),
        accountPrintLevel: String(body.accountPrintLevel ?? "")
      });
      sendJson(response, 200, { definition });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/mcp/call") {
      const body = await readJsonBody(request);
      const toolName = String(body.toolName ?? "");
      const args = normalizeObject(body.arguments);

      if (!toolName) {
        sendJson(response, 400, {
          error: {
            code: "INVALID_REQUEST",
            message: "toolName is required."
          }
        });
        return;
      }

      sendJson(response, 200, await mcpServer.callTool(toolName, args));
      return;
    }

    await serveStaticFile(url.pathname, response);
  } catch (error) {
    sendJson(response, 500, {
      error: formatToolError(error)
    });
  }
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      [
        `UI 啟動失敗：連接埠 ${port} 已被占用。`,
        "通常代表上一個 UI 程序還在執行。",
        `請先關閉舊的程序，或改用其他埠，例如 PowerShell 執行：$env:UI_PORT=\"4280\"; npm.cmd run ui`
      ].join("\n")
    );
    process.exitCode = 1;
    return;
  }

  console.error("UI 啟動失敗：", error);
  process.exitCode = 1;
});

server.listen(port, () => {
  console.log(`MCP UI ready: http://localhost:${port}`);
  void openInterfaceOnStartup(port)
    .catch(() => console.warn(`無法自動開啟介面，請手動開啟 http://127.0.0.1:${port}/`));
});

async function startManualLogin(workerId = "A"): Promise<Record<string, unknown>> {
  const normalizedWorkerId = normalizeWorkerId(workerId);
  const existing = manualLoginSessions.get(normalizedWorkerId);
  if (existing && !existing.page.isClosed()) {
    await existing.page.bringToFront().catch(() => undefined);
    return {
      ...(await getManualLoginStatus(normalizedWorkerId)),
      status: "already_open",
      message: `工作站 ${normalizedWorkerId} 的登入瀏覽器已開啟。`
    };
  }

  await closeManualLoginSession(normalizedWorkerId, "replaced");
  const storageStatePath = resolveEbasWorkerStorageStatePath(config, normalizedWorkerId);
  await fs.mkdir(path.dirname(storageStatePath), { recursive: true });

  const { chromium } = await import("playwright");
  const executablePath = await resolveChromiumExecutablePath(config);
  const browser = await chromium.launch({
    headless: false,
    slowMo: config.slowMo,
    ...(executablePath ? { executablePath } : {})
  });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: {
      width: 1280,
      height: 800
    }
  });
  const page = await context.newPage();

  manualLoginSessions.set(normalizedWorkerId, {
    browser,
    context,
    page,
    startedAt: new Date().toISOString()
  });

  await page.goto(config.ebasEntryUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });
  await page.bringToFront().catch(() => undefined);

  return {
    ...(await getManualLoginStatus(normalizedWorkerId)),
    status: "opened",
    message: `已開啟工作站 ${normalizedWorkerId} 的 EBAS 入口頁。`
  };
}

async function completeManualLogin(workerId = "A"): Promise<Record<string, unknown>> {
  const normalizedWorkerId = normalizeWorkerId(workerId);
  const session = manualLoginSessions.get(normalizedWorkerId);
  if (!session || session.page.isClosed()) {
    return {
      ...(await getManualLoginStatus(normalizedWorkerId)),
      status: "not_open",
      message: `工作站 ${normalizedWorkerId} 尚未啟動登入瀏覽器。`
    };
  }

  await session.page.waitForLoadState("domcontentloaded", {
    timeout: 10_000
  }).catch(() => undefined);
  const storageStatePath = resolveEbasWorkerStorageStatePath(config, normalizedWorkerId);
  await fs.mkdir(path.dirname(storageStatePath), { recursive: true });
  await session.context.storageState({
    path: storageStatePath
  });
  if (normalizedWorkerId === "A") {
    await fs.mkdir(path.dirname(config.ebasStorageStatePath), { recursive: true });
    await session.context.storageState({ path: config.ebasStorageStatePath });
  }

  const status = await getManualLoginStatus(normalizedWorkerId);
  await closeManualLoginSession(normalizedWorkerId, "completed");

  return {
    ...status,
    active: false,
    status: "saved",
    workerId: normalizedWorkerId,
    storageStatePath,
    message: status.authenticated
      ? `工作站 ${normalizedWorkerId} 的登入 session 已儲存。`
      : `已儲存工作站 ${normalizedWorkerId} session，但 UI 尚未偵測到登入後文字。`
  };
}

async function getManualLoginStatus(workerId = "A"): Promise<Record<string, unknown>> {
  const normalizedWorkerId = normalizeWorkerId(workerId);
  const storageStatePath = resolveEbasWorkerStorageStatePath(config, normalizedWorkerId);
  const storageStateExists = await fileExists(storageStatePath);
  const session = manualLoginSessions.get(normalizedWorkerId);

  if (!session || session.page.isClosed()) {
    return {
      workerId: normalizedWorkerId,
      active: false,
      authenticated: false,
      storageStateExists,
      loginUrl: config.ebasLoginUrl,
      entryUrl: config.ebasEntryUrl,
      storageStatePath
    };
  }

  const page = session.page;
  const title = await page.title().catch(() => "");
  const authenticated = await looksAuthenticated(page);

  return {
    workerId: normalizedWorkerId,
    active: true,
    authenticated,
    storageStateExists,
    startedAt: session.startedAt,
    url: page.url(),
    title,
    loginUrl: config.ebasLoginUrl,
    entryUrl: config.ebasEntryUrl,
    storageStatePath
  };
}

async function closeManualLoginSession(workerId = "A", reason: string): Promise<Record<string, unknown>> {
  const normalizedWorkerId = normalizeWorkerId(workerId);
  const session = manualLoginSessions.get(normalizedWorkerId);
  if (session) {
    await session.browser.close().catch(() => undefined);
    manualLoginSessions.delete(normalizedWorkerId);
  }
  return {
    ...(await getManualLoginStatus(normalizedWorkerId)),
    status: reason,
    message: `工作站 ${normalizedWorkerId} 登入視窗已關閉。`
  };
}

function normalizeWorkerId(value: unknown): string {
  const candidate = String(value ?? "A").trim().toUpperCase();
  return EBAS_WORKER_IDS.includes(candidate as typeof EBAS_WORKER_IDS[number]) ? candidate : "A";
}

async function checkWorkerSession(workerId = "A"): Promise<Record<string, unknown>> {
  const normalizedWorkerId = normalizeWorkerId(workerId);
  const storageStatePath = resolveEbasWorkerStorageStatePath(config, normalizedWorkerId);
  const storageStateExists = await fileExists(storageStatePath);

  if (!storageStateExists) {
    return {
      ...(await getManualLoginStatus(normalizedWorkerId)),
      status: "no_session",
      message: `工作站 ${normalizedWorkerId} 沒有已儲存的 session。`
    };
  }

  const { chromium } = await import("playwright");
  const executablePath = await resolveChromiumExecutablePath(config);
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {})
  });

  let isAuthenticated = false;
  try {
    const context = await browser.newContext({
      storageState: storageStatePath
    });
    const page = await context.newPage();
    await page.goto(config.ebasEntryUrl, {
      waitUntil: "networkidle",
      timeout: 15_000
    }).catch(() => undefined); // 即使 timeout 也繼續檢查
    
    // 多給一點時間讓任何前端跳轉完成
    await page.waitForTimeout(2000);
    
    isAuthenticated = await looksAuthenticated(page);
  } catch (error) {
    console.error(`工作站 ${normalizedWorkerId} Session 檢查失敗:`, error);
    isAuthenticated = false;
  } finally {
    await browser.close().catch(() => undefined);
  }

  if (!isAuthenticated) {
    await fs.unlink(storageStatePath).catch(() => undefined);
    return {
      ...(await getManualLoginStatus(normalizedWorkerId)),
      status: "expired",
      message: `工作站 ${normalizedWorkerId} session 已過期並自動刪除。`
    };
  }

  return {
    ...(await getManualLoginStatus(normalizedWorkerId)),
    status: "valid",
    message: `工作站 ${normalizedWorkerId} session 驗證通過，仍然有效。`
  };
}

async function openDownloadDirectory(): Promise<Record<string, unknown>> {
  await fs.mkdir(config.downloadDir, { recursive: true });
  await launchAndVerifyDirectory(config.downloadDir);

  return {
    ok: true,
    opened: true,
    downloadDir: config.downloadDir
  };
}

interface OpenDirectoryCommand {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

async function launchAndVerifyDirectory(directory: string): Promise<void> {
  if (process.platform !== "win32") {
    await launchDirectory(directory);
    return;
  }

  const commands = openDirectoryCommands(directory);
  let lastError: unknown;

  for (const command of commands) {
    try {
      await runOpenCommand(command);
      if (await waitForWindowsExplorerDirectory(directory, 5_000)) {
        return;
      }
      lastError = new Error(`已執行開啟命令，但未偵測到下載資料夾視窗：${directory}`);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`無法開啟下載資料夾：${directory}`);
}

async function launchDirectory(directory: string): Promise<void> {
  const commands = openDirectoryCommands(directory);
  let lastError: unknown;

  for (const command of commands) {
    try {
      await runOpenCommand(command);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`無法開啟下載資料夾：${directory}`);
}

function runOpenCommand(command: OpenDirectoryCommand, timeoutMs = 4_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      detached: false,
      stdio: "ignore",
      windowsHide: true,
      env: command.env ? { ...process.env, ...command.env } : process.env
    });

    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };
    const timer = setTimeout(() => {
      finish(new Error(`${command.command} 執行逾時`));
    }, timeoutMs);

    child.once("error", finish);
    child.once("exit", (code) => {
      if (code && code !== 0) {
        finish(new Error(`${command.command} 結束代碼 ${code}`));
        return;
      }
      finish();
    });
    child.unref();
  });
}

async function waitForWindowsExplorerDirectory(directory: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isWindowsExplorerDirectoryOpen(directory)) {
      return true;
    }
    await delay(300);
  }

  return false;
}

async function isWindowsExplorerDirectoryOpen(directory: string): Promise<boolean> {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$target = [System.IO.Path]::GetFullPath($env:TARGET_DIR).TrimEnd('\\\\')",
    "$shell = New-Object -ComObject Shell.Application",
    "$open = $false",
    "foreach ($window in @($shell.Windows())) {",
    "  try {",
    "    $path = $window.Document.Folder.Self.Path",
    "    if ($path -and ([System.IO.Path]::GetFullPath($path).TrimEnd('\\\\') -ieq $target)) {",
    "      $open = $true",
    "      break",
    "    }",
    "  } catch {}",
    "}",
    "if ($open) { exit 0 }",
    "exit 1"
  ].join("; ");

  try {
    await runOpenCommand({
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      env: {
        TARGET_DIR: directory
      }
    }, 3_000);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openDirectoryCommands(directory: string): OpenDirectoryCommand[] {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    return [
      {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "Start-Process -FilePath explorer.exe -ArgumentList @($env:TARGET_DIR)"
        ],
        env: {
          TARGET_DIR: directory
        }
      },
      {
        command: "cmd.exe",
        args: ["/c", "start", "", "/D", directory, "."]
      },
      {
        command: path.join(systemRoot, "explorer.exe"),
        args: [directory]
      },
      {
        command: "explorer.exe",
        args: [directory]
      }
    ];
  }

  if (process.platform === "darwin") {
    return [
      {
        command: "open",
        args: [directory]
      }
    ];
  }

  return [
    {
      command: "xdg-open",
      args: [directory]
    }
  ];
}

async function readBatchMemory(): Promise<BatchMemoryItem[]> {
  try {
    const text = await fs.readFile(batchMemoryPath, "utf8");
    const value = JSON.parse(text) as unknown;
    return normalizeBatchMemoryItems(value);
  } catch (error) {
    if (isFileNotFound(error)) return [];
    throw error;
  }
}

async function writeBatchMemory(items: BatchMemoryItem[]): Promise<void> {
  await fs.mkdir(path.dirname(batchMemoryPath), { recursive: true });
  await fs.writeFile(batchMemoryPath, `${JSON.stringify(items, null, 2)}\n`, "utf8");
}

async function readBatchPresets(): Promise<BatchPreset[]> {
  try {
    const text = await fs.readFile(batchPresetsPath, "utf8");
    const value = JSON.parse(text) as unknown;
    return normalizeBatchPresets(value);
  } catch (error) {
    if (isFileNotFound(error)) return [];
    throw error;
  }
}

async function writeBatchPresets(presets: BatchPreset[]): Promise<void> {
  await fs.mkdir(path.dirname(batchPresetsPath), { recursive: true });
  await fs.writeFile(batchPresetsPath, `${JSON.stringify(presets, null, 2)}\n`, "utf8");
}

async function saveBatchPreset(value: unknown): Promise<BatchPreset> {
  const input = normalizeObject(value);
  const now = new Date().toISOString();
  const presets = await readBatchPresets();
  const id = String(input.id ?? "").trim() || crypto.randomUUID();
  const current = presets.find((preset) => preset.id === id);
  const preset: BatchPreset = {
    id,
    name: String(input.name ?? current?.name ?? "").trim(),
    description: String(input.description ?? current?.description ?? "").trim(),
    continueOnError: input.continueOnError !== false,
    items: normalizeBatchMemoryItems(input.items),
    createdAt: current?.createdAt ?? now,
    updatedAt: now
  };

  if (!preset.name) {
    throw new Error("Preset name is required.");
  }

  const next = current
    ? presets.map((item) => item.id === id ? preset : item)
    : [...presets, preset];
  await writeBatchPresets(next);
  return preset;
}

async function deleteBatchPreset(id: string): Promise<BatchPreset[]> {
  const presets = (await readBatchPresets()).filter((preset) => preset.id !== id);
  await writeBatchPresets(presets);
  return presets;
}

async function reorderBatchPresets(ids: string[]): Promise<BatchPreset[]> {
  const presets = await readBatchPresets();
  const byId = new Map(presets.map((preset) => [preset.id, preset]));
  const ordered = ids.map((id) => byId.get(id)).filter((preset): preset is BatchPreset => Boolean(preset));
  const missing = presets.filter((preset) => !ids.includes(preset.id));
  const next = [...ordered, ...missing];
  await writeBatchPresets(next);
  return next;
}

async function importBatchPresets(value: unknown[]): Promise<BatchPreset[]> {
  const imported = normalizeBatchPresets(value);
  const current = await readBatchPresets();
  const next = [...current];

  for (const preset of imported) {
    const replacement = {
      ...preset,
      updatedAt: new Date().toISOString()
    };
    const index = next.findIndex((item) =>
      item.id === preset.id || item.name.trim().toLowerCase() === preset.name.trim().toLowerCase()
    );
    if (index >= 0) {
      next[index] = {
        ...replacement,
        id: next[index].id,
        createdAt: next[index].createdAt
      };
    } else {
      next.push(replacement);
    }
  }

  await writeBatchPresets(next);
  return next;
}

function normalizeBatchMemoryItems(value: unknown): BatchMemoryItem[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      const object = normalizeObject(item);
      return {
        reportId: String(object.reportId ?? ""),
        reportName: String(object.reportName ?? object.reportId ?? ""),
        parameters: normalizeStringRecord(object.parameters)
      };
    })
    .filter((item) => item.reportId);
}

function normalizeBatchPresets(value: unknown): BatchPreset[] {
  if (!Array.isArray(value)) return [];
  const now = new Date().toISOString();

  return value
    .map((item) => {
      const object = normalizeObject(item);
      const id = String(object.id ?? "").trim() || crypto.randomUUID();
      const name = String(object.name ?? "").trim();
      return {
        id,
        name,
        description: String(object.description ?? "").trim(),
        continueOnError: object.continueOnError !== false,
        items: normalizeBatchMemoryItems(object.items),
        createdAt: String(object.createdAt ?? now),
        updatedAt: String(object.updatedAt ?? now)
      };
    })
    .filter((preset) => preset.name);
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  const object = normalizeObject(value);
  return Object.fromEntries(
    Object.entries(object).map(([key, item]) => [key, item === undefined ? "" : String(item)])
  );
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT");
}

async function looksAuthenticated(page: Page): Promise<boolean> {
  const url = page.url().toLowerCase();
  // 若網址明顯為 SSO 登入頁，則直接視為未登入
  if (url.includes("sso.ebas.gov.tw") || url.includes("/login") || url.includes("account/login")) {
    return false;
  }

  for (const frame of page.frames()) {
    const hasLogout = await frame.locator("text=登出").first().isVisible({
      timeout: 800
    }).catch(() => false);
    if (hasLogout) return true;

    // 使用精確比對避免誤判登入頁上的「使用者帳號」等字眼
    const hasUser = await frame.locator("text=\"使用者\"").first().isVisible({
      timeout: 800
    }).catch(() => false);
    if (hasUser) return true;
  }

  return false;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function serveStaticFile(urlPath: string, response: http.ServerResponse): Promise<void> {
  const relativePath = urlPath === "/"
    ? "index.html"
    : `${urlPath.replace(/^\/+/, "")}${urlPath.endsWith("/") ? "index.html" : ""}`;
  const filePath = path.resolve(publicDir, relativePath);

  if (!filePath.startsWith(publicDir)) {
    sendText(response, 403, "Forbidden", "text/plain");
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    sendBuffer(response, 200, content, contentType(filePath));
  } catch {
    sendText(response, 404, "Not found", "text/plain");
  }
}

function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function normalizeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function sendJson(response: http.ServerResponse, status: number, value: unknown): void {
  sendText(response, status, JSON.stringify(value, null, 2), "application/json; charset=utf-8");
}

function sendText(
  response: http.ServerResponse,
  status: number,
  text: string,
  type: string
): void {
  response.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store"
  });
  response.end(text);
}

function sendBuffer(
  response: http.ServerResponse,
  status: number,
  buffer: Buffer,
  type: string
): void {
  response.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store"
  });
  response.end(buffer);
}

function contentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml"
  };
  return types[extension] ?? "application/octet-stream";
}

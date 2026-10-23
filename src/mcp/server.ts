import { FlowError } from "../domain/errors.ts";
import { EBAS_WORKER_IDS, loadConfig, resolveEbasWorkerStorageStatePath } from "../config.ts";
import type { ReportService } from "../services/reportService.ts";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export type McpToolCallResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

export class MinimalMcpServer {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly service: ReportService;

  constructor(service: ReportService) {
    this.service = service;
    this.registerTools();
  }

  async handle(request: JsonRpcRequest): Promise<unknown> {
    if (request.method === "initialize") {
      return {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "playwright-mcp-report-flow",
          version: "0.2.7"
        }
      };
    }

    if (request.method === "notifications/initialized") {
      return undefined;
    }

    if (request.method === "tools/list") {
      return {
        tools: [...this.tools.values()].map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema
        }))
      };
    }

    if (request.method === "tools/call") {
      const params = assertObject(request.params);
      const name = String(params.name ?? "");
      const args = params.arguments === undefined ? {} : assertObject(params.arguments);
      const tool = this.tools.get(name);

      if (!tool) {
        throw new FlowError("TOOL_NOT_FOUND", `Unknown tool: ${name}`);
      }

      const result = await tool.handler(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    }

    throw new FlowError("METHOD_NOT_FOUND", `Unsupported MCP method: ${request.method}`);
  }

  async listTools(): Promise<unknown> {
    return this.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {}
    });
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolCallResult> {
    return this.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args
      }
    }) as Promise<McpToolCallResult>;
  }

  private registerTools(): void {
    this.addTool({
      name: "list_available_reports",
      description: "List supported high-level report downloads.",
      inputSchema: objectSchema({}),
      handler: () => this.service.listReports()
    });

    this.addTool({
      name: "get_report_parameters",
      description: "Get required and optional parameters for a report.",
      inputSchema: objectSchema({
        reportId: { type: "string" }
      }, ["reportId"]),
      handler: ({ reportId }) => this.service.getReportParameters(String(reportId))
    });

    this.addTool({
      name: "create_download_task",
      description: "Create and start an asynchronous report download task.",
      inputSchema: objectSchema({
        reportId: { type: "string" },
        browserMode: { type: "string", enum: ["headed", "headless"], default: "headed", description: "下載模式：headed 顯示瀏覽器視窗（預設）；headless 無頭。Debug 不會強制切換模式。" },
        debug: {
          type: "boolean",
          description: "When true, record Playwright checkpoints, screenshots, HTML, frame HTML, and errors."
        },
        parameters: {
          type: "object",
          additionalProperties: { type: "string" }
        }
      }, ["reportId"]),
      handler: ({ reportId, parameters, debug, browserMode }) =>
        this.service.createDownloadTask(String(reportId), normalizeStringRecord(parameters), {
          browserMode: browserMode as "headed" | "headless" | undefined,
          debugEnabled: debug === true
        })
    });

    this.addTool({
      name: "create_batch_download_task",
      description: "Create and start an asynchronous batch task that downloads multiple reports sequentially.",
      inputSchema: objectSchema({
        browserMode: { type: "string", enum: ["headed", "headless"], default: "headed", description: "下載模式：headed 顯示瀏覽器視窗（預設）；headless 無頭。Debug 不會強制切換模式。" },
        debug: {
          type: "boolean",
          description: "When true, record Playwright debug artifacts for every batch item."
        },
        continueOnError: {
          type: "boolean",
          description: "When false, stop the batch after the first failed item. Defaults to true."
        },
        parallelism: {
          type: "number",
          description: "Number of EBAS worker sessions to use. Use 1 for safe sequential mode, or 2 for worker A/B parallel mode."
        },
        retryEnabled: {
          type: "boolean",
          description: "When true, retry retryable failed batch items. Defaults to true."
        },
        maxRetries: {
          type: "number",
          description: "Maximum retry attempts after the first failed attempt. Defaults to 3."
        },
        retryDelaySeconds: {
          type: "number",
          description: "Seconds to wait before retrying a retryable failure. Defaults to 5."
        },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              reportId: { type: "string" },
              parameters: {
                type: "object",
                additionalProperties: { type: "string" }
              }
            },
            required: ["reportId"],
            additionalProperties: false
          }
        }
      }, ["items"]),
      handler: ({ items, debug, browserMode, continueOnError, parallelism, retryEnabled, maxRetries, retryDelaySeconds }) => {
        const config = loadConfig();
        const workerStorageStatePaths = Object.fromEntries(
          EBAS_WORKER_IDS.map((workerId) => [workerId, resolveEbasWorkerStorageStatePath(config, workerId)])
        );
        return this.service.createBatchDownloadTask(normalizeBatchItems(items), {
          browserMode: browserMode as "headed" | "headless" | undefined,
          debugEnabled: debug === true,
          continueOnError: continueOnError !== false,
          parallelism: Number(parallelism ?? 1),
          retryEnabled: retryEnabled !== false,
          maxRetries: Number(maxRetries ?? 3),
          retryDelaySeconds: Number(retryDelaySeconds ?? 5),
          workerStorageStatePaths
        });
      }
    });

    this.addTool({
      name: "get_download_task",
      description: "Get current task status.",
      inputSchema: objectSchema({
        taskId: { type: "string" }
      }, ["taskId"]),
      handler: ({ taskId }) => this.service.getDownloadTask(String(taskId))
    });

    this.addTool({
      name: "get_batch_download_task",
      description: "Get current batch download task status.",
      inputSchema: objectSchema({
        taskId: { type: "string" }
      }, ["taskId"]),
      handler: ({ taskId }) => this.service.getBatchDownloadTask(String(taskId))
    });

    this.addTool({
      name: "get_download_result",
      description: "Get parsed rows for a completed download task.",
      inputSchema: objectSchema({
        taskId: { type: "string" }
      }, ["taskId"]),
      handler: ({ taskId }) => this.service.getDownloadResult(String(taskId))
    });

    this.addTool({
      name: "get_batch_download_result",
      description: "Get file paths and item errors for a finished batch download task.",
      inputSchema: objectSchema({
        taskId: { type: "string" }
      }, ["taskId"]),
      handler: ({ taskId }) => this.service.getBatchDownloadResult(String(taskId))
    });

    this.addTool({ name: "cancel_download_task", description: "中斷單筆下載，保留已完成檔案。", inputSchema: objectSchema({ taskId: { type: "string" } }, ["taskId"]), handler: ({ taskId }) => this.service.cancelDownloadTask(String(taskId)) });
    this.addTool({ name: "cancel_batch_download_task", description: "中斷批次下載，停止重試與未執行項目，保留已完成檔案。", inputSchema: objectSchema({ taskId: { type: "string" } }, ["taskId"]), handler: ({ taskId }) => this.service.cancelBatchDownloadTask(String(taskId)) });

    this.addTool({
      name: "parse_download_file",
      description: "Parse an existing CSV download file.",
      inputSchema: objectSchema({
        filePath: { type: "string" }
      }, ["filePath"]),
      handler: ({ filePath }) => this.service.parseDownloadFile(String(filePath))
    });
  }

  private addTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }
}

export async function startMcpServer(service: ReportService): Promise<void> {
  const server = new MinimalMcpServer(service);
  let buffer = "";

  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += chunk;

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");

      if (!line) continue;

      const response = await handleLine(server, line);
      if (response) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    }
  }
}

async function handleLine(server: MinimalMcpServer, line: string): Promise<unknown> {
  let request: JsonRpcRequest;

  try {
    request = JSON.parse(line) as JsonRpcRequest;
    const result = await server.handle(request);

    if (request.id === undefined || request.id === null) {
      return undefined;
    }

    return {
      jsonrpc: "2.0",
      id: request.id,
      result
    };
  } catch (error) {
    const id = tryReadId(line);
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
        data: formatToolError(error)
      }
    };
  }
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false
  };
}

function assertObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  const object = assertObject(value);
  return Object.fromEntries(
    Object.entries(object).map(([key, item]) => [key, item === undefined ? "" : String(item)])
  );
}

function normalizeBatchItems(value: unknown): Array<{ reportId: string; parameters: Record<string, string> }> {
  if (!Array.isArray(value)) return [];

  return value.map((item) => {
    const object = assertObject(item);
    return {
      reportId: String(object.reportId ?? ""),
      parameters: normalizeStringRecord(object.parameters)
    };
  });
}

function tryReadId(line: string): string | number | null {
  try {
    const parsed = JSON.parse(line) as { id?: string | number | null };
    return parsed.id ?? null;
  } catch {
    return null;
  }
}

export function formatToolError(error: unknown) {
  if (error instanceof FlowError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details
    };
  }

  return {
    code: "UNKNOWN_ERROR",
    message: error instanceof Error ? error.message : String(error)
  };
}

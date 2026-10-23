import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

class StdioMcpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private buffer = "";

  constructor(serverEntry: string) {
    this.child = spawn(process.execPath, ["--experimental-strip-types", serverEntry], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.handleStdout(String(chunk)));
    this.child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) process.stderr.write(`${text}\n`);
    });
    this.child.on("exit", (code) => {
      for (const request of this.pending.values()) {
        request.reject(new Error(`MCP server exited with code ${code}.`));
      }
      this.pending.clear();
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "local-mcp-tool",
        version: "0.2.7"
      }
    });

    this.notify("notifications/initialized", {});
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;

    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  }

  notify(method: string, params: unknown = {}): void {
    const payload = {
      jsonrpc: "2.0",
      method,
      params
    };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async listTools(): Promise<unknown> {
    return this.request("tools/list", {});
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.request("tools/call", {
      name,
      arguments: args
    });
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    if (this.child.exitCode === null) {
      this.child.kill();
      await once(this.child, "exit").catch(() => undefined);
    }
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;

    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      newlineIndex = this.buffer.indexOf("\n");

      if (!line) continue;
      this.handleResponseLine(line);
    }
  }

  private handleResponseLine(line: string): void {
    const response = JSON.parse(line) as JsonRpcResponse;
    const request = this.pending.get(response.id);
    if (!request) return;

    this.pending.delete(response.id);

    if (response.error) {
      request.reject(new Error(`${response.error.message}\n${JSON.stringify(response.error.data, null, 2)}`));
      return;
    }

    request.resolve(response.result);
  }
}

async function main(): Promise<void> {
  const [command, toolName, rawArgs] = process.argv.slice(2);
  const serverEntry = path.resolve("src/index.ts");
  const client = new StdioMcpClient(serverEntry);

  try {
    await client.initialize();

    if (!command || command === "help") {
      printUsage();
      return;
    }

    if (command === "list") {
      printJson(await client.listTools());
      return;
    }

    if (command === "call") {
      if (!toolName) {
        throw new Error("Missing tool name. Example: npm run mcp:call -- list_available_reports");
      }
      const args = rawArgs ? parseJsonObject(rawArgs) : {};
      printJson(await client.callTool(toolName, args));
      return;
    }

    if (command === "download-demo") {
      await runDownloadDemo(client);
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  } finally {
    await client.close();
  }
}

async function runDownloadDemo(client: StdioMcpClient): Promise<void> {
  console.log("1. List reports");
  printToolText(await client.callTool("list_available_reports"));

  console.log("\n2. Get parameters");
  printToolText(await client.callTool("get_report_parameters", {
    reportId: "sales-summary"
  }));

  console.log("\n3. Create download task");
  const created = await client.callTool("create_download_task", {
    reportId: "sales-summary",
    parameters: {
      startDate: "2026-06-01",
      endDate: "2026-06-15",
      channel: "online"
    }
  });
  printToolText(created);

  const task = parseToolText(created) as { id: string };
  let current: { status: string; id: string } = task as { status: string; id: string };

  console.log("\n4. Poll task status");
  while (current.status === "queued" || current.status === "running" || !current.status) {
    await delay(150);
    const statusResponse = await client.callTool("get_download_task", {
      taskId: task.id
    });
    current = parseToolText(statusResponse) as { status: string; id: string };
  }
  printJson(current);

  if (current.status !== "completed") {
    throw new Error(`Download task did not complete. Final status: ${current.status}`);
  }

  console.log("\n5. Get parsed result");
  printToolText(await client.callTool("get_download_result", {
    taskId: task.id
  }));
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Arguments must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function parseToolText(response: unknown): unknown {
  const text = getToolText(response);
  return JSON.parse(text);
}

function printToolText(response: unknown): void {
  console.log(getToolText(response));
}

function getToolText(response: unknown): string {
  const object = response as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = object.content?.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error(`Tool response does not contain text content: ${JSON.stringify(response)}`);
  }
  return text;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printUsage(): void {
  console.log([
    "Usage:",
    "  npm run mcp:list",
    "  npm run mcp:demo",
    "  npm run mcp:call -- <toolName> '<jsonArgs>'",
    "",
    "Examples:",
    "  npm run mcp:call -- list_available_reports",
    "  npm run mcp:call -- get_report_parameters '{\"reportId\":\"sales-summary\"}'"
  ].join("\n"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

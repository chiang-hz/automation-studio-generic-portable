import { createReportService } from "./container.ts";
import { startMcpServer } from "./mcp/server.ts";

const service = await createReportService();
await startMcpServer(service);

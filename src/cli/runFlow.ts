import { createReportService } from "../container.ts";

const service = await createReportService();

const reports = await service.listReports();
console.log("Available reports:");
console.log(JSON.stringify(reports, null, 2));

const reportId = "sales-summary";
const parameters = await service.getReportParameters(reportId);
console.log("\nParameters:");
console.log(JSON.stringify(parameters, null, 2));

const task = await service.createDownloadTask(reportId, {
  startDate: "2026-06-01",
  endDate: "2026-06-15",
  channel: "online"
});

console.log("\nCreated task:");
console.log(JSON.stringify(task, null, 2));

let current = service.getDownloadTask(task.id);
while (current.status === "queued" || current.status === "running") {
  await new Promise((resolve) => setTimeout(resolve, 100));
  current = service.getDownloadTask(task.id);
}

console.log("\nFinal task:");
console.log(JSON.stringify(current, null, 2));

if (current.status === "completed") {
  const result = await service.getDownloadResult(task.id);
  console.log("\nParsed result:");
  console.log(JSON.stringify(result, null, 2));
}

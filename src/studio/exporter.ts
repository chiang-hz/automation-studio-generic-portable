import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExportSelection, SelectorRule, WorkflowProject } from "./types.ts";
import { createZip, type ZipEntry } from "./zip.ts";

export class ExportService {
  private readonly exportDir = path.resolve("./exports");

  async create(project: WorkflowProject, selection: ExportSelection): Promise<{ filePath: string; fileName: string }> {
    if (!selection.portableWorkflow && !selection.typescript && !selection.skill) {
      throw new Error("請至少選擇一種成果格式。");
    }
    await fs.mkdir(this.exportDir, { recursive: true });
    const safeProject = removeSensitiveDefaults(project);
    const entries: ZipEntry[] = [];

    if (selection.portableWorkflow) entries.push(...portableEntries(safeProject, selection));
    if (selection.typescript) entries.push(...await typescriptEntries(safeProject, selection));
    if (selection.skill) entries.push(...skillEntries(safeProject, selection));

    entries.push({
      name: "EXPORT-MANIFEST.json",
      data: json({
        product: "Automation Studio",
        productVersion: "2.1.0",
        exportedAt: new Date().toISOString(),
        projectId: project.id,
        projectVersion: project.version,
        outputs: selection,
        security: "Secrets, cookies and browser session state are excluded."
      })
    });

    const fileName = `${project.id}-${project.version}-export.zip`;
    const filePath = path.join(this.exportDir, fileName);
    await fs.writeFile(filePath, createZip(entries));
    return { filePath, fileName };
  }
}

function portableEntries(project: WorkflowProject, selection: ExportSelection): ZipEntry[] {
  const base = "portable-workflow";
  const selectors = collectSelectors(project);
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: `${project.name} parameters`,
    type: "object",
    required: project.parameters.filter((item) => item.required).map((item) => item.name),
    properties: Object.fromEntries(project.parameters.map((item) => [item.name, {
      title: item.label,
      description: item.description ?? "",
      type: item.type === "boolean" ? "boolean" : item.type === "number" ? "number" : "string",
      enum: item.options,
      default: item.sensitive || item.type === "secret" ? undefined : item.defaultValue,
      "x-dependsOn": item.dependsOn,
      "x-dependentOptions": item.dependentOptions
    }]))
  };
  const entries: ZipEntry[] = [
    { name: `${base}/manifest.json`, data: json({ id: project.id, name: project.name, version: project.version, targetUrl: project.targetUrl, allowedDomains: project.allowedDomains, adapter: project.adapter }) },
    { name: `${base}/workflow.json`, data: json(project) },
    { name: `${base}/parameters.schema.json`, data: json(schema) },
    { name: `${base}/selectors.json`, data: json(selectors) },
    { name: `${base}/README.md`, data: portableReadme(project) },
    { name: `${base}/VERSION`, data: `${project.version}\n` }
  ];
  if (selection.includeExamples) {
    entries.push({ name: `${base}/examples/parameters.example.json`, data: json(exampleParameters(project)) });
  }
  if (selection.includeTests) {
    entries.push({ name: `${base}/tests/workflow.validation.json`, data: json({ checks: ["has-target-url", "has-enabled-step", "no-sensitive-defaults", "selectors-have-fallbacks"] }) });
  }
  return entries;
}

async function typescriptEntries(project: WorkflowProject, selection: ExportSelection): Promise<ZipEntry[]> {
  const base = "typescript-project";
  const templatePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "templates", "generated-runner.ts.txt");
  const runner = await fs.readFile(templatePath, "utf8");
  const stealthHelper = await fs.readFile(new URL("./stealth.ts", import.meta.url), "utf8");
  const entries: ZipEntry[] = [
    { name: `${base}/package.json`, data: json({ name: project.id, version: project.version, private: true, type: "module", scripts: { start: "node --experimental-strip-types src/run.ts", test: "node --experimental-strip-types --test tests/*.test.ts" }, dependencies: { playwright: "^1.60.0", ...(project.browser.stealth === true && project.browser.connectionMode !== "cdp" ? { "playwright-extra": "^4.3.6", "puppeteer-extra-plugin-stealth": "^2.11.2" } : {}) } }) },
    { name: `${base}/tsconfig.json`, data: json({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true }, include: ["src/**/*.ts", "tests/**/*.ts"] }) },
    { name: `${base}/src/workflow.json`, data: json(project) },
    { name: `${base}/src/run.ts`, data: runner },
    { name: `${base}/src/stealth.ts`, data: stealthHelper },
    { name: `${base}/src/parameters.ts`, data: generatedParameterTypes(project) },
    { name: `${base}/start.bat`, data: "@echo off\r\nsetlocal\r\nif \"%NODE_USE_SYSTEM_CA%\"==\"\" set \"NODE_USE_SYSTEM_CA=1\"\r\nnode --experimental-strip-types src\\run.ts\r\nif errorlevel 1 pause\r\n" },
    { name: `${base}/README.md`, data: typescriptReadme(project) }
  ];
  if (selection.includeExamples) entries.push({ name: `${base}/parameters.example.json`, data: json(exampleParameters(project)) });
  if (selection.includeTests) entries.push({ name: `${base}/tests/structure.test.ts`, data: generatedTest() });
  return entries;
}

function skillEntries(project: WorkflowProject, selection: ExportSelection): ZipEntry[] {
  const base = "automation-skill";
  const description = `${project.name} 網站自動化流程。用於需要依既定參數操作 ${project.allowedDomains.join("、") || "目標網站"} 並取得結果時。`;
  const entries: ZipEntry[] = [
    { name: `${base}/SKILL.md`, data: `---\nname: ${project.id}\ndescription: ${yamlText(description)}\n---\n\n# ${project.name}\n\n## 使用時機\n\n${description}\n\n## 執行原則\n\n1. 先確認目標網址與允許網域。\n2. 登入、MFA、驗證碼及憑證步驟必須由使用者人工完成。\n3. 讀取 \`workflow/workflow.json\` 與 \`references/parameters.md\`。\n4. 執行每一步後都要套用等待條件與成功驗證。\n5. 失敗時保存截圖、頁面 HTML、frame、popup、下載及錯誤資訊。\n6. 不得把帳號、密碼、Cookie 或 Token 寫回 Skill。\n\n## 限制\n\n- 不破解驗證碼或繞過 MFA。\n- 網站改版後必須重新驗證 selector。\n- 預設同一登入工作站同時只執行一個任務。\n` },
    { name: `${base}/workflow/workflow.json`, data: json(project) },
    { name: `${base}/references/parameters.md`, data: parameterMarkdown(project) },
    { name: `${base}/references/troubleshooting.md`, data: troubleshootingMarkdown() }
  ];
  if (selection.includeTests) entries.push({ name: `${base}/tests/checklist.md`, data: "# 發布檢查\n\n- [ ] 網域正確\n- [ ] 無敏感預設值\n- [ ] 單次測試通過\n- [ ] 下載檔案格式正確\n" });
  return entries;
}

function removeSensitiveDefaults(project: WorkflowProject): WorkflowProject {
  return {
    ...structuredClone(project),
    parameters: project.parameters.map((parameter) => ({
      ...parameter,
      defaultValue: parameter.sensitive || parameter.type === "secret" ? "" : parameter.defaultValue
    }))
  };
}

function collectSelectors(project: WorkflowProject): Record<string, SelectorRule[]> {
  const result: Record<string, SelectorRule[]> = {};
  const visit = (steps: WorkflowProject["steps"]): void => {
    for (const step of steps) {
      if (step.selectors?.length) result[step.id] = step.selectors;
      visit(step.thenSteps ?? []);
      visit(step.elseSteps ?? []);
      visit(step.steps ?? []);
    }
  };
  visit(project.steps);
  return result;
}

function exampleParameters(project: WorkflowProject): Record<string, string | boolean> {
  return Object.fromEntries(project.parameters.map((parameter) => [parameter.name, parameter.sensitive || parameter.type === "secret" ? "" : parameter.defaultValue ?? ""]));
}

function portableReadme(project: WorkflowProject): string {
  return `# ${project.name}\n\n版本：${project.version}\n\n此目錄可匯入 Automation Studio 繼續編輯與執行。匯出內容不含登入密碼、Cookie 或瀏覽器工作站資料。\n\n入口網址：${project.targetUrl}\n`;
}

function typescriptReadme(project: WorkflowProject): string {
  return `# ${project.name}\n\n這是由 Automation Studio 產生的 Playwright TypeScript 專案。\n\n1. 準備 Node.js，於此目錄執行 \`npm install\` 安裝 package.json 所列套件（啟用 Stealth 的管理模式會包含插件）。\n2. 將參數放入 \`parameters.json\`，或沿用預設值。\n3. 執行 \`start.bat\`。\n\nStealth 設定保存於 src/workflow.json 的 browser.stealth；僅管理模式生效，CDP 不套用。設定在瀏覽器啟動前載入。\n\n登入驗證、MFA 與驗證碼仍須人工完成。\n`;
}

function generatedRunner(project: WorkflowProject): string {
  return `import fs from "node:fs/promises";\nimport { chromium } from "playwright";\nimport workflow from "./workflow.json" with { type: "json" };\n\nconst input = await fs.readFile("./parameters.json", "utf8").then(JSON.parse).catch(() => ({}));\nconst params = Object.fromEntries(workflow.parameters.map((p) => [p.name, input[p.name] ?? p.defaultValue ?? ""]));\nconst browser = await chromium.launch({ headless: workflow.browser.headless, channel: workflow.browser.channel === "bundled" ? undefined : workflow.browser.channel });\nconst context = await browser.newContext({ acceptDownloads: true });\nconst page = await context.newPage();\nconst expand = (value) => String(value ?? "").replace(/{{\\s*([^}]+)\\s*}}/g, (_, name) => String(params[name.trim()] ?? ""));\nconst locate = (step) => {\n  const rule = step.selectors?.[0];\n  if (!rule) throw new Error(\`步驟 \${step.name} 沒有 selector\`);\n  if (rule.strategy === "role") return page.getByRole(rule.role || "button", { name: expand(rule.value), exact: rule.exact });\n  if (rule.strategy === "label") return page.getByLabel(expand(rule.value), { exact: rule.exact });\n  if (rule.strategy === "text") return page.getByText(expand(rule.value), { exact: rule.exact });\n  if (rule.strategy === "name") return page.locator(\`[name=\"\${CSS.escape(expand(rule.value))}\"]\`);\n  if (rule.strategy === "xpath") return page.locator(\`xpath=\${expand(rule.value)}\`);\n  return page.locator(expand(rule.value));\n};\ntry {\n  for (const step of workflow.steps.filter((item) => item.enabled)) {\n    console.log(\`[\${step.kind}] \${step.name}\`);\n    if (step.kind === "navigate") await page.goto(expand(step.url || workflow.targetUrl), { waitUntil: "domcontentloaded" });\n    else if (step.kind === "click") await locate(step).click();\n    else if (step.kind === "dblclick") await locate(step).dblclick();\n    else if (step.kind === "fill") await locate(step).fill(expand(step.value));\n    else if (step.kind === "select") await locate(step).selectOption(expand(step.value));\n    else if (step.kind === "upload") await locate(step).setInputFiles(expand(step.value));\n    else if (step.kind === "press") await locate(step).press(expand(step.value));\n    else if (step.kind === "hover") await locate(step).hover();\n    else if (step.kind === "check") await locate(step).check();\n    else if (step.kind === "uncheck") await locate(step).uncheck();\n    else if (step.kind === "wait") await page.waitForTimeout(Number(step.value || 1000));
    else if (step.kind === "waitNewFirst") { throw new Error("此精簡匯出器不支援 waitNewFirst，請使用 portable TypeScript runner"); }\n    else if (step.kind === "screenshot") await page.screenshot({ path: expand(String(step.value || "screenshot.png")), fullPage: true });\n  }\n} finally {\n  await context.close();\n  await browser.close();\n}\n`;
}

function generatedParameterTypes(project: WorkflowProject): string {
  return `export interface WorkflowParameters {\n${project.parameters.map((p) => `  ${JSON.stringify(p.name)}${p.required ? "" : "?"}: ${p.type === "boolean" ? "boolean" : p.type === "number" ? "number" : "string"};`).join("\n")}\n}\n`;
}

function generatedTest(): string {
  return `import test from "node:test";\nimport assert from "node:assert/strict";\nimport workflow from "../src/workflow.json" with { type: "json" };\n\ntest("workflow has an entry URL and enabled steps", () => {\n  assert.match(workflow.targetUrl, /^https?:\\/\\//);\n  assert.ok(workflow.steps.some((step) => step.enabled));\n});\n`;
}

function parameterMarkdown(project: WorkflowProject): string {
  const rows = project.parameters.map((p) => `| ${p.label} | \`${p.name}\` | ${p.type} | ${p.required ? "是" : "否"} | ${p.sensitive ? "敏感，不保存" : p.description ?? ""} |`).join("\n");
  return `# 參數\n\n| 名稱 | Key | 類型 | 必填 | 說明 |\n|---|---|---|---|---|\n${rows || "| 無 | - | - | - | - |"}\n`;
}

function troubleshootingMarkdown(): string {
  return "# Debug 指引\n\n1. 確認登入工作站仍有效。\n2. 比對可見欄位、hidden input 與元件內部值。\n3. 檢查 iframe、popup 與下載事件發生位置。\n4. 比對手動成功與自動失敗的請求、狀態與事件順序。\n5. 僅在確認網站結構改變後更新 selector。\n";
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function yamlText(value: string): string {
  return JSON.stringify(value);
}

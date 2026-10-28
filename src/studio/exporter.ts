import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExportSelection, SelectorRule, WorkflowProject } from "./types.ts";
import { createZip, type ZipEntry } from "./zip.ts";

export class ExportService {
  private readonly exportDir = path.resolve("./exports");

  async create(project: WorkflowProject, selection: ExportSelection): Promise<{ filePath: string; fileName: string }> {
    if (!selection.portableWorkflow && !selection.typescript && !selection.skill && !selection.pythonPlaywright && !selection.pythonSelenium) {
      throw new Error("請至少選擇一種成果格式。");
    }
    if (selection.pythonPlaywright) validatePythonCompatibility(project, "playwright");
    if (selection.pythonSelenium) validatePythonCompatibility(project, "selenium");
    await fs.mkdir(this.exportDir, { recursive: true });
    const safeProject = removeSensitiveDefaults(project);
    const entries: ZipEntry[] = [];

    if (selection.portableWorkflow) entries.push(...portableEntries(safeProject, selection));
    if (selection.typescript) entries.push(...await typescriptEntries(safeProject, selection));
    if (selection.skill) entries.push(...skillEntries(safeProject, selection));
    if (selection.pythonPlaywright) entries.push(...await pythonEntries(safeProject, selection, "playwright"));
    if (selection.pythonSelenium) entries.push(...await pythonEntries(safeProject, selection, "selenium"));

    entries.push({
      name: "EXPORT-MANIFEST.json",
      data: json({
        product: "Automation Studio",
        productVersion: "2.5.2",
        exportedAt: new Date().toISOString(),
        projectId: project.id,
        projectVersion: project.version,
        outputs: { ...selection, pythonBatchRows: undefined },
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
  const tsStarter = await fs.readFile(new URL("./templates/typescript-start.bat.txt", import.meta.url), "utf8");
  const stealthHelper = await fs.readFile(new URL("./stealth.ts", import.meta.url), "utf8");
  const webDataHelper = await fs.readFile(new URL("./webData.ts", import.meta.url), "utf8");
  const zipHelper = await fs.readFile(new URL("./zip.ts", import.meta.url), "utf8");
  const entries: ZipEntry[] = [
    { name: `${base}/src/webData.ts`, data: webDataHelper },
    { name: `${base}/src/zip.ts`, data: zipHelper },
    { name: `${base}/package.json`, data: json({ name: project.id, version: project.version, private: true, type: "module", scripts: { start: "node --experimental-strip-types src/run.ts", test: "node --experimental-strip-types --test tests/*.test.ts" }, dependencies: { playwright: "^1.60.0", ...(project.browser.stealth === true && project.browser.connectionMode !== "cdp" ? { "playwright-extra": "^4.3.6", "puppeteer-extra-plugin-stealth": "^2.11.2" } : {}) } }) },
    { name: `${base}/tsconfig.json`, data: json({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true }, include: ["src/**/*.ts", "tests/**/*.ts"] }) },
    { name: `${base}/src/workflow.json`, data: json(project) },
    { name: `${base}/src/run.ts`, data: runner },
    { name: `${base}/src/stealth.ts`, data: stealthHelper },
    { name: `${base}/src/authNavigation.ts`, data: await fs.readFile(path.join(path.dirname(templatePath), "authNavigation.ts.txt"), "utf8") },
    { name: `${base}/src/parameters.ts`, data: generatedParameterTypes(project) },
    { name: `${base}/start.bat`, data: tsStarter.replace(/\n/g, "\r\n") },
    { name: `${base}/README.md`, data: typescriptReadme(project) }
  ];
  if (selection.includeExamples) entries.push({ name: `${base}/parameters.example.json`, data: json(exampleParameters(project)) });
  if (selection.includeTests) entries.push({ name: `${base}/tests/structure.test.ts`, data: generatedTest() });
  return entries;
}


/** Conservative export-time validation: never generate a runner that silently skips steps. */
export function validatePythonCompatibility(project: WorkflowProject, backend: "playwright" | "selenium"): void {
  const problems: string[] = [];
  const supported = new Set(["navigate", "newTab", "switchTab", "click", "dblclick", "fill", "select", "upload", "press", "hover", "check", "uncheck", "wait", "assert", "manual", "screenshot", "savePagePdf", "download", "condition", "loop", "extractText", "extractPattern", "captureListSnapshot", "extractWebData", "saveDocument", "waitNewFirst", "waitNewListItem", "script", "clipboard"]);
  // Stealth is browser configuration, not a workflow action. Python uses standard Chrome; see export README.
  if (project.browser.authStateEnabled === true && (!project.browser.authVerifyUrl || !project.browser.authSuccessSelector)) problems.push("請先完成登入檢查網址與登入成功 CSS 設定。");
  const visit = (steps: WorkflowProject["steps"]): void => {
    for (const step of steps) {
      if (step.enabled === false) continue;
      if (!supported.has(step.kind)) problems.push(`${step.name}：尚不支援 ${step.kind}，請改用 TypeScript。`);
      if (step.periodicRefresh && (!Number.isInteger(step.refreshIntervalSeconds ?? 10) || (step.refreshIntervalSeconds ?? 10) < 5 || (step.refreshIntervalSeconds ?? 10) > 600)) problems.push(`${step.name}：定期重新整理間隔須為 5～600 秒。`);
      if (step.kind === "script" && /(?<![\w.])(?:require\s*\(|process\.|Buffer\.|__dirname\b|import\s*\(|fs\.|child_process\b)/.test(step.script ?? String(step.value ?? ""))) problems.push(`${step.name}：使用 Node.js 主機端 API 的腳本無法在網頁 JavaScript 執行環境中執行。`);
      // Selenium supports standard CSS (including Chrome's native :has()) plus
      // Playwright :has-text(), :text(), :text-is(), :text-matches(), :visible.
      // The same browser-side resolver handles element actions and web data fields.
      // Unsupported nested syntax fails explicitly at runtime, never silently skips.
      visit(step.thenSteps ?? []);
      visit(step.elseSteps ?? []);
      visit(step.steps ?? []);
    }
  };
  visit(project.steps);
  if (problems.length) throw new Error(`Python ${backend} 匯出前相容性檢查未通過：\n${problems.slice(0, 12).join("\n")}${problems.length > 12 ? `\n…另有 ${problems.length - 12} 項` : ""}`);
}

/** Export a source-only Python project. Neither Python nor Chrome is copied into this ZIP.
 * Browser profiles, encrypted auth vaults, cookies, tokens and local secrets never leave the machine.
 * Both backends use the same Python workflow semantics with fail-closed validation.
 */
async function pythonEntries(project: WorkflowProject, selection: ExportSelection, backend: "playwright" | "selenium"): Promise<ZipEntry[]> {
  const base = backend === "playwright" ? "python-playwright-project" : "python-selenium-project";
  const sourceDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "python-runtime");
  const runtime = await fs.readFile(path.join(sourceDir, "runner.py"), "utf8");
  const engine = await fs.readFile(path.join(sourceDir, "engine.py"), "utf8");
  const cdpBootstrap = await fs.readFile(path.join(sourceDir, "cdp_bootstrap.py"), "utf8");
  const dependencyBootstrap = await fs.readFile(path.join(sourceDir, "dependency_bootstrap.py"), "utf8");
  const formats = new Set<string>();
  const inspect = (steps: WorkflowProject["steps"]): void => {
    for (const step of steps) {
      if (step.enabled !== false && step.kind === "saveDocument") formats.add(step.documentFormat ?? "docx");
      inspect(step.thenSteps ?? []); inspect(step.elseSteps ?? []); inspect(step.steps ?? []);
    }
  };
  inspect(project.steps);
  const dependencies = backend === "playwright" ? ["playwright>=1.60,<2"] : ["selenium>=4.30,<5"];
  if (formats.has("xlsx")) dependencies.push("openpyxl>=3.1,<4");
  if (formats.has("docx")) dependencies.push("python-docx>=1.1,<2");
  if (selection.pythonBatch !== false && !dependencies.some(item => item.startsWith("openpyxl"))) dependencies.push("openpyxl>=3.1,<4");
  const pyRequirements = dependencies.join("\n") + "\n";
  const bat = pythonRunBat();
  const entries: ZipEntry[] = [
    { name: `${base}/workflow.json`, data: json(project) },
    { name: `${base}/runner.py`, data: runtime.replace('BACKEND = \'__BACKEND__\'', `BACKEND = \'${backend}\'`) },
    { name: `${base}/engine.py`, data: engine },
    { name: `${base}/selector_compat.js`, data: await fs.readFile(path.join(sourceDir, "selector_compat.js"), "utf8") },
    { name: `${base}/locator_compat.js`, data: await fs.readFile(path.join(sourceDir, "locator_compat.js"), "utf8") },
    { name: `${base}/option_compat.js`, data: await fs.readFile(path.join(sourceDir, "option_compat.js"), "utf8") },
    { name: `${base}/cdp_bootstrap.py`, data: cdpBootstrap },
    { name: `${base}/dependency_bootstrap.py`, data: dependencyBootstrap },
    { name: `${base}/launch-python.bat`, data: pythonLaunchBat() },
    { name: `${base}/run-cdp.bat`, data: cdpBat() },
    { name: `${base}/requirements.txt`, data: pyRequirements },
    { name: `${base}/requirements-optional.txt`, data: "openpyxl>=3.1,<4\npython-docx>=1.1,<2\n" },
    { name: `${base}/run.bat`, data: bat },
    { name: `${base}/check.bat`, data: "@echo off\r\ncd /d \"%~dp0\"\r\ncall \"%~dp0launch-python.bat\" runner.py --check-only\r\nif errorlevel 1 pause\r\n" },
    { name: `${base}/README.md`, data: pythonReadme(project, backend) },
    { name: `${base}/.local/README.md`, data: "Profiles and sessions are created locally at runtime. Never distribute .local, parameters.json, cookies or credentials.\n" }
  ];
  if (selection.pythonBatch !== false) entries.push(...await pythonBatchEntries(project, selection, base, sourceDir));
  if (selection.includeExamples) entries.push({ name: `${base}/parameters.example.json`, data: json(exampleParameters(project)) });
  if (selection.includeTests) entries.push({ name: `${base}/tests/README.md`, data: "First run: python runner.py --check-only\nThen test in visible Chrome with an authorized account and test data.\nDo not replay submitted forms blindly.\n" });
  return entries;
}


/** Batch rows only enter an exported ZIP following an explicit UI opt-in. */
function cleanBatchRows(project: WorkflowProject, selection: ExportSelection): Array<{enabled: boolean; parameters: Record<string, unknown>}> {
  if (!selection.pythonBatchIncludeCurrentRows || !Array.isArray(selection.pythonBatchRows)) return [];
  if (selection.pythonBatchRows.length > 10000) throw new Error("批次匯出資料最多 10,000 筆。");
  const safe = project.parameters.filter(p => p.sensitive !== true && p.type !== "secret");
  return selection.pythonBatchRows.map((row) => ({
    enabled: row.enabled === true,
    parameters: Object.fromEntries(safe.map(p => [p.name, row.parameters?.[p.name] ?? ""]))
  }));
}

function pythonBatchBat(cdp: boolean): string {
  return [
    "@echo off", "setlocal", 'cd /d "%~dp0"',
    `call "%~dp0launch-python.bat" batch_runner.py ${cdp ? "--cdp " : ""}%*`,
    'set "RESULT=%errorlevel%"',
    'if not "%RESULT%"=="0" (',
    '  echo [ERROR] Python batch failed with exit code %RESULT%.',
    '  pause',
    ')',
    'exit /b %RESULT%', ""
  ].join("\r\n");
}

async function pythonBatchEntries(project: WorkflowProject, selection: ExportSelection, base: string, sourceDir: string): Promise<ZipEntry[]> {
  const safeRows = cleanBatchRows(project, selection);
  const template = {format: "automation-studio-batch", version: 1,
    project: {id: project.id, name: project.name},
    parameters: project.parameters.map(p => ({name: p.name, label: p.label, type: p.type, redacted: !!p.sensitive || p.type === "secret"})),
    rows: safeRows.length ? safeRows : [{enabled: false, parameters: exampleParameters(project)}]};
  const keys = project.parameters.filter(p => !p.sensitive && p.type !== "secret").map(p => p.name);
  const csvExample = `\uFEFF${["__studio_enabled", ...keys].map(v => `"${v.replaceAll('"', '""')}"`).join(",")}\r\n` +
    ["false", ...keys.map(k => String(exampleParameters(project)[k] ?? ""))].map(v => `"${v.replaceAll('"', '""')}"`).join(",") + "\r\n";
  return [
    {name: `${base}/batch-settings.json`, data: json({onError: selection.pythonBatchOnError === "stop" ? "stop" : "continue"})},
    {name: `${base}/batch_runner.py`, data: await fs.readFile(path.join(sourceDir, "batch_runner.py"), "utf8")},
    {name: `${base}/run-batch.bat`, data: pythonBatchBat(false)},
    {name: `${base}/run-batch-cdp.bat`, data: pythonBatchBat(true)},
    {name: `${base}/batch.json`, data: json(template)},
    {name: `${base}/batch.example.csv`, data: csvExample}
  ];
}

function pythonLaunchBat(): string {
  // CMD branches are labels so exit codes are evaluated AFTER Python finishes.
  // Each runner calls the same dependency bootstrap, using its selected Python.
  return [
    "@echo off", "setlocal", 'cd /d "%~dp0"',
    'python -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>nul',
    'if not errorlevel 1 goto use_python',
    'py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>nul',
    'if not errorlevel 1 goto use_py',
    'echo [ERROR] Python 3.10 or newer was not found. Install Python and rerun.',
    'exit /b 1',
    ':use_python',
    'python "%~dp0dependency_bootstrap.py" %*',
    'exit /b %errorlevel%',
    ':use_py',
    'py -3 "%~dp0dependency_bootstrap.py" %*',
    'exit /b %errorlevel%',
    ""
  ].join("\r\n");
}

function pythonRunBat(): string {
  return [
    "@echo off", "setlocal", 'cd /d "%~dp0"',
    'call "%~dp0launch-python.bat" runner.py %*',
    'set "RESULT=%errorlevel%"',
    'if not "%RESULT%"=="0" (',
    '  echo [ERROR] Python workflow failed with exit code %RESULT%.',
    '  pause',
    ')',
    'exit /b %RESULT%',
    ""
  ].join("\r\n");
}

function cdpBat(): string {
  return [
    "@echo off", "setlocal", 'cd /d "%~dp0"',
    'call "%~dp0launch-python.bat" cdp_bootstrap.py %*',
    'set "RESULT=%errorlevel%"',
    'if not "%RESULT%"=="0" (',
    '  echo [ERROR] CDP workflow failed with exit code %RESULT%.',
    '  pause',
    ')',
    'exit /b %RESULT%',
    ""
  ].join("\r\n");
}

function pythonReadme(project: WorkflowProject, backend: "playwright" | "selenium"): string {
  const driver = backend === "selenium" ? `\nChromeDriver matching the installed Chrome is needed. Set CHROMEDRIVER_PATH to its local executable path to avoid Selenium Manager downloads.\nThis backend runs without a Node.js executable.\n` : `\nPlaywright Python does not need Node.js installed separately, but ships a Node-based driver. It MUST be permitted by corporate execution policy.\n`;
  return `# ${project.name} - Python ${backend} export\n\nThis ZIP contains source files only. It DOES NOT bundle Python, Chrome, browser drivers or credentials.\n\n## Prerequisites (Windows 64-bit)\n\n- Python 3.10+ and installed Google Chrome.\n- Double-click \`run.bat\` or \`run-cdp.bat\` to check dependencies automatically. Missing packages are installed into a private \`.local/python-env\` virtual environment, while existing compatible packages are reused.
- Approved offline wheels in a \`wheelhouse/\` directory are tried first; if incomplete, pip uses its configured HTTPS index. Set \`AUTOMATION_STUDIO_OFFLINE_ONLY=1\` to forbid network access or \`AUTOMATION_STUDIO_AUTO_INSTALL=0\` to disable setup.
- For corporate CA/proxy configure \`PIP_CERT\` / \`PIP_INDEX_URL\` (TLS verification remains enabled). Word/Excel requirements are included automatically when the workflow needs them.\n${driver}\n## Run\n\n1. Copy parameters.example.json to parameters.json and supply your values (not included in ZIP).\n2. \`run.bat --check-only\` validates the workflow without installing packages or starting Chrome.
3. Double-click \`run.bat\` for automatic setup and execution. Running \`python runner.py\` directly skips setup.\n4. Double-click \`run-cdp.bat\` for **one-click CDP login and execution**: use/reuse a dedicated local Chrome profile, confirm DevTools connection, complete manual login when needed, then run Python. No workflow.json edits. If a login-success check is configured it runs automatically; otherwise press Enter after signing in. Run \`run-cdp.bat --check-only\` to validate without Chrome.\n5. All authentication is confirmed on the target website; if expired, complete manual login/Cloudflare/MFA in a VISIBLE browser. No bypass is attempted.\n\n## Important compatibility and security\n\n- The exported runner implements all 29 defined action kinds, including browser-side scripts, clipboard, list comparison, frame targeting, periodic refresh and direct downloads. Some advanced website-specific behavior may still differ; run an end-to-end test.
- Stealth plugin is NOT transferred to Python. Python launches standard Chrome or joins an authorized local CDP browser; complete any human security challenge normally.
- Scripts execute in the browser JavaScript context, not in Node.js. Node-only filesystem, require(), Buffer or other host APIs are not supported; write data to the DOM and use built-in saveDocument for export.\n- Selenium supports Playwright :has-text(), :text(), :text-is(), :text-matches(), :visible alongside native Chrome CSS :has() using a bundled browser-side selector resolver. Unsupported advanced nesting fails explicitly instead of targeting an incorrect element.\n- No encrypted v2.2.4 Node.js auth vault or its in-process unlock cache is exported or decrypted. Python has its own local persistent Chrome profile; for existing login use an explicitly authorized local CDP browser.\n- Never open the SAME persistent profile concurrently in multiple programs. Concurrent workers need separate profiles or coordinated tab access.\n- CDP must be at localhost and enabled by the user. \`run-cdp.bat\` opens **a dedicated** Chrome profile with local debugging enabled; \`run.bat\` continues to use the original workflow browser mode. \`run-cdp.bat\` never opens ports on other interfaces or imports the Node.js authentication vault.\n- Authorization checking uses the project authVerifyUrl and authSuccessSelector. If either is missing, --check-only rejects an auth-enabled project.\n- Profiles are stored in .local/profiles; downloads/ and output/ are created on first use. They may contain personal data: do not share them.\n- For a site that redirects to another domain, add its exact host to allowedDomains in Automation Studio before exporting.\n- Check-only validates schema compatibility, not the actual website behavior. Confirm custom browser scripts and site-specific component selectors interact correctly before production use.\n\n## Batch execution (JSON / CSV / Excel)\n\n- Edit \`batch.json\` (each row has \`enabled\` and \`parameters\`); or use a CSV with header \`__studio_enabled,${project.parameters.filter(p=>!p.sensitive && p.type!=="secret").map(p=>p.name).join(",")}\`. XLSX uses the same header in row 1, with \`__studio_enabled\` in the first column.\n- \`run-batch.bat --input batch.json\` runs enabled rows **sequentially** in separate browser sessions.\n- \`run-batch-cdp.bat --input batch.json\` uses a **single authorized local Chrome profile**, connecting for each row; never launches concurrent Chrome instances. Login confirmation occurs once unless the website requires it again.\n- \`run-batch-cdp.bat --input batch.xlsx --on-error continue\` continues after errors (default); \`--on-error stop\` is the default.\n- \`run-batch.bat --input batch.example.csv --check-only\` validates without downloading packages or opening Chrome.\n- \`batch-settings.json\` records the export-time failure strategy (continue by default, stop optional). \`--on-error\` overrides it.
- Summaries and per-row logs are saved under \`.local/batch-runs/\` (not in export ZIP); row parameter files are deleted after each run. Summary files do not contain parameters.\n- \`batch.json\` may optionally contain the current Automation Studio batch rows if explicitly selected during export. **Secret/sensitive parameters are never exported**. Fill them in locally when required.\n- Downloads remain in \`downloads/\`. Include parameter placeholders in filenames to make files distinguishable.\n\nThis lightweight ZIP normally has a size in KB. Installed Python packages are stored under \`.local/python-env\`, not included in the exported ZIP. TLS certificate verification is NOT disabled; for corporate proxies configure pip's CA/index or use an approved wheelhouse.\n`;
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
  return `# ${project.name}\n\nAutomation Studio Playwright TypeScript 匯出專案。\n\n1. 直接雙擊 \`start.bat\`。此檔會自動檢查及安裝缺少的套件，無需手動 npm install。\n2. 執行依賴安裝時優先使用正常 TLS 驗證；只有偵測到憑證鏈錯誤才會為該次 npm 安裝暫時設定 strict-ssl=false，之後恢復。公司環境仍建議使用核准 CA 與 npm registry。\n3. Playwright 將使用已安裝的 Google Chrome；設定 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1，不另下載 Chromium。\n4. 參數可放在 parameters.json；網站登入驗證與 MFA 仍由使用者操作。\n5. npm 安裝紀錄可查看 .local/npm-install.log，暫存及快取位於本專案的 .local 資料夾，不需要管理員權限（但仍受公司端點保護政策限制）。\n\n**注意**：若系統沒有適用的 Node.js/npm，會下載固定 Node.js v24.13.0 Windows x64 官方 ZIP（內含 npm）至專案 runtime/node，強制比對固定 SHA-256。公司環境建議使用核准 CA；無法連網時可事先放入完整 runtime/node。\n`;
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

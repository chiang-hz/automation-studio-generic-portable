const state = {
  projects: [],
  project: null,
  runs: [],
  runHistorySummary: null,
  selectedRunIds: new Set(),
  dashboard: null,
  settings: null,
  selectedStepId: "",
  currentRunId: "",
  currentRun: null,
  currentRunDebug: { events: [], variables: {}, downloads: [], debugDir: "" },
  activeDebugTab: "log",
  selectedHistoryRunId: "",
  selectedHistoryRun: null,
  selectedHistoryDebug: { events: [], variables: {}, downloads: [], debugDir: "" },
  activeHistoryDebugTab: "log",
  releaseSaveTimer: null,
  pollTimer: null,
  runsPollTimer: null,
  recorderTimer: null,
  recorderRevision: 0,
  recorderWatchGeneration: 0,
  recorderWatchController: null,
  recorderEventSource: null,
  recorderSnapshot: null,
  recorderSnapshotProjectId: "",
  recorderSyncError: "",
  batchRows: [],
  profileStatus: null,
  cdpStatus: null,
  aiWorkflowDraft: null,
  aiWorkflowValidation: null,
  aiWorkflowMeta: null,
  aiWorkflowGenerating: false,
  aiWorkflowExploration: null,
  aiWorkflowExploring: false,
  aiWorkflowConversation: [],
  aiWorkflowPendingRevision: null,
  aiWorkflowHistory: [],
  aiWorkflowRevisionRunning: false,
  aiWorkflowDeferredRevision: "",
  aiWorkflowErrors: [],
  aiWorkflowMonitor: null,
  aiWorkflowMonitorEvents: [],
  aiWorkflowMonitorCompletedStages: [],
  aiWorkflowMonitorTimer: null,
  aiWorkflowMonitorPolling: false,
  aiWorkflowOperationController: null,
  aiWorkflowLastOperation: null,
  aiWorkflowStopRequested: false,
  debugAIAnalysis: null,
  debugAIAnalyzing: false,
  debugAIAnalysisRunId: "",
  debugCleanupTimer: null,
  runHistoryCleanupTimer: null,
  dirty: false,
  draggedStepId: ""
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const viewLabels = {
  dashboard: ["專案總覽", "工作空間"], workstation: ["網站與工作站", "工作空間"],
  aiWorkflow: ["AI 流程助理", "開發者功能"], designer: ["自動化設計器", "工作空間"], parameters: ["參數與資料", "工作空間"],
  test: ["測試與 Debug", "工作空間"], batch: ["批次任務", "執行與發布"],
  runs: ["執行紀錄", "執行與發布"], publish: ["發布與版本", "執行與發布"],
  settings: ["系統設定", "執行與發布"], help: ["使用說明", "說明與支援"],
  report: ["回報問題", "說明與支援"], developer: ["開發者功能", "原始資料"]
};

document.addEventListener("DOMContentLoaded", () => {
  bindNavigation();
  bindActions();
  window.addEventListener("focus", syncRecorderWhenVisible);
  document.addEventListener("visibilitychange", syncRecorderWhenVisible);
  void initialize();
});

function syncRecorderWhenVisible() {
  if (document.hidden || !state.project) return;
  void pollRecorder();
}

async function initialize() {
  try {
    const [health, projects, dashboard, runs, settings] = await Promise.all([
      api("/api/studio/health"), api("/api/studio/projects"), api("/api/studio/dashboard"), api("/api/studio/runs"), api("/api/studio/settings")
    ]);
    markRuntime(health);
    state.projects = projects.projects ?? [];
    state.dashboard = dashboard;
    state.runs = runs.runs ?? [];
    state.settings = settings.settings ?? {};
    applyTheme(state.settings.theme ?? "system");
    renderProjectSelect();
    const remembered = localStorage.getItem("automation-studio-project");
    const initialId = state.projects.some((p) => p.id === remembered) ? remembered : state.projects[0]?.id;
    if (initialId) await loadProject(initialId);
    renderDashboard();
    renderRuns();
    renderSettings();
    restoreAIWorkflowSession();
    renderAIWorkflowAssistant();
    window.studioStartup?.complete("data");
  } catch (error) {
    if (document.documentElement.dataset.studioBoot !== "ready") window.studioStartup?.fail("工作空間資料初始化失敗，請確認服務仍在執行後重新整理。");
    markRuntime({ ok: false, runtime: { playwright: false, message: error.message } });
    toast(error.message, true);
  }
}

function bindNavigation() {
  $$('[data-view]').forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
  $$('[data-go]').forEach((button) => button.addEventListener("click", () => showView(button.dataset.go)));
}

function bindActions() {
  $("#refreshButton").addEventListener("click", () => initialize());
  $("#projectSelect").addEventListener("change", (event) => loadProject(event.target.value));
  $("#newProjectButton").addEventListener("click", openProjectDialog);
  $("#importProjectButton").addEventListener("click", () => $("#importProjectFile").click());
  $("#importProjectFile").addEventListener("change", importProjectFile);
  $("#dashboardNewButton").addEventListener("click", openProjectDialog);
  $("#projectForm").addEventListener("submit", createProject);
  $$('[data-project-dialog-close]').forEach((button) => button.addEventListener("click", closeProjectDialog));
  $("#projectDialog").addEventListener("cancel", (event) => { event.preventDefault(); closeProjectDialog(); });
  $("#saveWorkstationButton").addEventListener("click", saveWorkstation);
  $("#browserConnectionMode").addEventListener("change", () => { renderBrowserConnectionSettings(); markDirty(); });
  $("#cdpInitialPageMode").addEventListener("change", () => { renderBrowserConnectionSettings(); markDirty(); });
  $("#cdpAutoLaunch").addEventListener("change", markDirty);
  $("#testCdpButton").addEventListener("click", testCdpConnection);
  $("#copyCdpCommandButton").addEventListener("click", copyCdpLaunchCommand);
  $("#addAllowedDomainButton").addEventListener("click", addAllowedDomain);
  $("#allowedDomainInput").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); addAllowedDomain(); } });
  $("#allowedDomains").addEventListener("input", () => { syncDomainsFromTextarea(); renderAllowedDomainChips(); });
  $("#startRecorderButton").addEventListener("click", startRecorder);
  $("#focusRecorderButton").addEventListener("click", focusRecorder);
  $("#pickRecorderAssertionButton").addEventListener("click", () => setRecorderAssertion(true));
  $("#cancelRecorderAssertionButton").addEventListener("click", () => setRecorderAssertion(false));
  $("#stopRecorderButton").addEventListener("click", stopRecorder);
  $("#clearProfileButton").addEventListener("click", clearBrowserProfile);
  $("#reuseProfile").addEventListener("change", () => {
    renderProfileStatus({ ...(state.profileStatus ?? {}), enabled: $("#reuseProfile").checked });
    markDirty();
  });
  $("#downloadPdfInsteadOfPreview").addEventListener("change", markDirty);
  $("#stealth").addEventListener("change", markDirty);
  $("#duplicateProjectButton").addEventListener("click", duplicateProject);
  $("#deleteProjectButton").addEventListener("click", deleteProject);
  $("#commitRecordingButton").addEventListener("click", commitRecording);
  $("#clearRecordingButton").addEventListener("click", clearRecording);
  $("#designerRunButton").addEventListener("click", () => runWorkflow("full"));
  $("#designerRecordButton").addEventListener("click", () => startRecorder().then(() => showView("workstation")));
  $("#designerSaveButton").addEventListener("click", saveProject);
  $("#quickRunButton").addEventListener("click", () => { showView("test"); void runWorkflow("full"); });
  $("#stepPalette").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-kind]");
    if (button) addStep(button.dataset.kind);
  });
  $("#addNavigateButton").addEventListener("click", () => addStep("click"));
  $("#enableAllStepsButton").addEventListener("click", () => setAllStepsEnabled(true));
  $("#disableAllStepsButton").addEventListener("click", () => setAllStepsEnabled(false));
  $("#workflowCanvas").addEventListener("click", handleCanvasClick);
  $("#stepProperties").addEventListener("input", markStepPropertiesPending);
  $("#stepProperties").addEventListener("change", markStepPropertiesPending);
  $("#workflowCanvas").addEventListener("dragstart", handleStepDragStart);
  $("#workflowCanvas").addEventListener("dragover", handleStepDragOver);
  $("#workflowCanvas").addEventListener("drop", handleStepDrop);
  $("#workflowCanvas").addEventListener("dragend", clearStepDragState);
  document.addEventListener("keydown", handleDesignerShortcut);
  $("#parameterForm").addEventListener("submit", saveParameter);
  $("#addParameterButton").addEventListener("click", resetParameterForm);
  $("#parameterTable").addEventListener("click", handleParameterTableClick);
  $("#runFullButton").addEventListener("click", () => runWorkflow("full"));
  $("#runStepButton").addEventListener("click", () => runWorkflow("single-step"));
  $("#runFromStepButton").addEventListener("click", () => runWorkflow("from-step"));
  $("#testParameters").addEventListener("change", handleTestParameterChange);
  $("#cancelRunButton").addEventListener("click", cancelCurrentRun);
  $("#continueRunButton").addEventListener("click", continueCurrentRun);
  $("#downloadResults").addEventListener("click", handleDownloadResultAction);
  $("#analyzeRunFailureButton").addEventListener("click", analyzeCurrentRunFailure);
  $("#downloadFailureDiagnosticsButton").addEventListener("click", downloadCurrentRunDiagnostics);
  $("#copyDebugAIAnalysisButton").addEventListener("click", copyDebugAIAnalysis);
  $("#applyDebugAIPatchButton").addEventListener("click", applyDebugAIPatch);
  $("#openFailedStepButton").addEventListener("click", openFailedStepInDesigner);
  $("#addBatchRowButton").addEventListener("click", addBatchRow);
  $("#runBatchButton").addEventListener("click", runBatch);
  $("#batchBody").addEventListener("input", readBatchRows);
  $("#batchBody").addEventListener("change", handleBatchParameterChange);
  $("#batchBody").addEventListener("click", handleBatchClick);
  $("#maxRetries").addEventListener("change", saveAdvancedSettings);
  $("#defaultConcurrency").addEventListener("change", saveAdvancedSettings);
  $("#safePlayback").addEventListener("change", saveAdvancedSettings);
  $("#humanizedPlayback").addEventListener("change", saveAdvancedSettings);
  $("#minStepDelayMs").addEventListener("change", saveAdvancedSettings);
  $("#screenshotMode").addEventListener("change", saveAdvancedSettings);
  $("#refreshRunsButton").addEventListener("click", refreshRuns);
  $("#runsTable").addEventListener("click", handleRunsTableClick);
  $("#runsTable").addEventListener("change", handleRunsTableChange);
  $("#runProjectFilter").addEventListener("change", renderRuns);
  $("#runStatusFilter").addEventListener("change", renderRuns);
  $("#selectFilteredRunsButton").addEventListener("click", selectFilteredRuns);
  $("#clearRunSelectionButton").addEventListener("click", clearRunSelection);
  $("#deleteSelectedRunsButton").addEventListener("click", deleteSelectedRuns);
  $("#deleteFilteredRunsButton").addEventListener("click", deleteFilteredRuns);
  $("#clearCompletedRunsButton").addEventListener("click", clearCompletedRuns);
  $("#projectVersion").addEventListener("input", scheduleReleaseAutoSave);
  $("#releaseNotes").addEventListener("input", scheduleReleaseAutoSave);
  $("#projectStatus").addEventListener("change", () => void saveReleaseFields(true));
  $("#exportButton").addEventListener("click", exportProject);
  $("#saveSettingsButton").addEventListener("click", saveSettings);
  $("#cleanupExpiredDebugButton").addEventListener("click", cleanupExpiredDebugNow);
  $("#cleanupExpiredRunsButton").addEventListener("click", cleanupExpiredRunHistoryNow);
  $("#saveAISettingsButton").addEventListener("click", saveSettings);
  $("#testActiveAIButton").addEventListener("click", testActiveAIProvider);
  $("#diagnoseAIButton").addEventListener("click", diagnoseActiveAIProvider);
  $("#aiProviderList").addEventListener("click", handleAIProviderListClick);
  $("#aiProviderList").addEventListener("change", handleAIProviderListChange);
  $("#aiEnabled").addEventListener("change", renderAISettingsBadge);
  $("#activeAIProvider").addEventListener("change", renderAISettingsBadge);
  $("#startAIWorkflowInspectionButton").addEventListener("click", startAIWorkflowInspection);
  $("#focusAIWorkflowInspectionButton").addEventListener("click", focusAIWorkflowInspection);
  $("#stopAIWorkflowInspectionButton").addEventListener("click", stopAIWorkflowInspection);
  $("#generateAIWorkflowButton").addEventListener("click", generateAIWorkflowDraft);
  $("#createAIWorkflowProjectButton").addEventListener("click", createAIWorkflowProject);
  $("#applyAIWorkflowProjectButton").addEventListener("click", applyAIWorkflowToCurrentProject);
  $("#copyAIWorkflowDraftButton").addEventListener("click", copyAIWorkflowDraft);
  $("#clearAIWorkflowDraftButton").addEventListener("click", clearAIWorkflowDraft);
  $("#sendAIWorkflowRevisionButton").addEventListener("click", sendAIWorkflowRevision);
  $("#undoAIWorkflowRevisionButton").addEventListener("click", undoAIWorkflowRevision);
  $("#aiWorkflowErrorPanel").addEventListener("click", handleAIWorkflowErrorPanelClick);
  $("#retryAIWorkflowMonitorButton").addEventListener("click", retryAIWorkflowMonitorStep);
  $("#stopAIWorkflowMonitorButton").addEventListener("click", stopAIWorkflowMonitoredOperation);
  $("#copyAIWorkflowDiagnosticButton").addEventListener("click", copyAIWorkflowDiagnostic);
  $("#acceptAndApplyAIWorkflowRevisionButton").addEventListener("click", acceptAndApplyAIWorkflowRevision);
  $("#acceptAIWorkflowRevisionButton").addEventListener("click", acceptAIWorkflowRevision);
  $("#discardAIWorkflowRevisionButton").addEventListener("click", discardAIWorkflowRevision);
  $("#sendIssueReportButton").addEventListener("click", sendIssueReport);
  $("#copyIssueReportButton").addEventListener("click", copyIssueReport);
  $("#clearIssueReportButton").addEventListener("click", clearIssueReport);
  $("#saveJsonButton").addEventListener("click", saveRawJson);
  $("#copyJsonButton").addEventListener("click", copyRawJson);
  $$('[data-debug-tab]').forEach((button) => button.addEventListener("click", () => {
    $$('[data-debug-tab]').forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.activeDebugTab = button.dataset.debugTab || "log";
    renderDesignerDebug();
  }));
}

function showView(view) {
  if (!viewLabels[view]) return;
  const workspaceViews = new Set(["dashboard", "workstation", "designer", "parameters", "test"]);
  const workspaceTopbarActions = $("#workspaceTopbarActions");
  if (workspaceTopbarActions) workspaceTopbarActions.hidden = !workspaceViews.has(view);
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  $$(".developer-menu [data-view]").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  const developerMenu = $(".developer-menu");
  if (developerMenu && ["aiWorkflow", "developer"].includes(view)) developerMenu.open = true;
  $$(".view").forEach((item) => item.classList.toggle("active", item.id === `${view}View`));
  $("#viewTitle").textContent = viewLabels[view][0];
  $("#viewEyebrow").textContent = viewLabels[view][1];
  if (view === "runs") {
    void refreshRuns();
    startRunsPolling();
  } else {
    stopRunsPolling();
  }
  if (view === "report") renderIssueReportContext();
  if (view === "aiWorkflow") renderAIWorkflowAssistant();
  if (view === "developer") renderRawJson();
  if (view === "dashboard") void refreshDashboard();
  if (view === "publish") renderPublishChecks();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function loadProject(id) {
  stopRecorderWatch();
  resetRecorderSnapshot(false);
  const response = await api(`/api/studio/projects/${encodeURIComponent(id)}`);
  clearTimeout(state.releaseSaveTimer);
  state.releaseSaveTimer = null;
  state.project = response.project;
  state.selectedStepId = state.project.steps[0]?.id ?? "";
  state.batchRows = [];
  localStorage.setItem("automation-studio-project", id);
  renderProjectSelect();
  renderProject();
}

function renderProject() {
  if (!state.project) return;
  $("#projectBreadcrumb").textContent = state.project.name;
  $("#projectName").value = state.project.name;
  $("#projectUrl").value = state.project.targetUrl;
  $("#allowedDomains").value = state.project.allowedDomains.join("\n");
  renderAllowedDomainChips();
  $("#browserConnectionMode").value = state.project.browser.connectionMode ?? "managed";
  $("#browserChannel").value = state.project.browser.channel;
  $("#cdpEndpoint").value = state.project.browser.cdpEndpoint ?? "http://127.0.0.1:9222";
  $("#cdpAutoLaunch").checked = state.project.browser.cdpAutoLaunch !== false;
  $("#cdpInitialPageMode").value = state.project.browser.cdpInitialPageMode ?? "first";
  $("#cdpInitialPageTarget").value = state.project.browser.cdpInitialPageTarget ?? "";
  $("#cdpInitialPageIndex").value = state.project.browser.cdpInitialPageIndex ?? 1;
  $("#projectAdapter").value = state.project.adapter;
  $("#reuseProfile").checked = state.project.browser.reuseProfile;
  $("#downloadPdfInsteadOfPreview").checked = state.project.browser.downloadPdfInsteadOfPreview === true;
  $("#stealth").checked = state.project.browser.stealth === true;
  $("#headless").checked = state.project.browser.headless;
  if ($("#aiWorkflowTargetUrl") && !$("#aiWorkflowTargetUrl").value.trim()) $("#aiWorkflowTargetUrl").value = state.project.targetUrl ?? "";
  renderBrowserConnectionSettings();
  renderCdpResult(null);
  $("#maxRetries").value = state.project.settings.maxRetries;
  renderBatchConcurrency();
  $("#safePlayback").checked = state.project.settings.safePlayback !== false;
  $("#humanizedPlayback").checked = state.project.settings.humanizedPlayback === true;
  $("#minStepDelayMs").value = state.project.settings.minStepDelayMs ?? 2000;
  $("#screenshotMode").value = state.project.settings.screenshotMode;
  $("#projectVersion").value = state.project.version;
  $("#projectStatus").value = state.project.status;
  renderReleaseNotes();
  renderDesigner();
  renderParameters();
  renderTestParameters();
  renderBatch();
  renderRawJson();
  renderPublishChecks();
  scheduleRecorderPoll();
  void refreshProfileStatus();
}

function renderProjectSelect() {
  const select = $("#projectSelect");
  select.innerHTML = state.projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join("");
  if (state.project) select.value = state.project.id;
  const filter = $("#runProjectFilter");
  filter.innerHTML = `<option value="">所有專案</option>${state.projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join("")}`;
}

async function saveProject(options = {}) {
  if (!state.project) return false;
  const quiet = options?.quiet === true;
  setSaveState("儲存中…");
  try {
    const response = await api(`/api/studio/projects/${encodeURIComponent(state.project.id)}`, {
      method: "PUT", body: JSON.stringify(state.project)
    });
    state.project = response.project;
    const index = state.projects.findIndex((p) => p.id === state.project.id);
    if (index >= 0) state.projects[index] = state.project;
    state.dirty = false;
    renderProjectSelect();
    renderRawJson();
    setSaveState("所有變更已儲存");
    if (!quiet) toast("專案已儲存");
    return true;
  } catch (error) {
    setSaveState("儲存失敗");
    toast(error.message, true);
    return false;
  }
}

function markDirty() {
  state.dirty = true;
  setSaveState("有尚未儲存的變更");
}

function setSaveState(text) { $("#saveState").textContent = text; }

function openProjectDialog() {
  $("#projectForm").reset();
  $("#projectDialog").showModal();
  setTimeout(() => $("#newProjectName")?.focus(), 0);
}

function closeProjectDialog() {
  const dialog = $("#projectDialog");
  if (dialog?.open) dialog.close("cancel");
  $("#projectForm")?.reset();
}

async function createProject(event) {
  event.preventDefault();
  const targetUrl = $("#newProjectUrl").value.trim();
  try {
    const url = new URL(targetUrl);
    const response = await api("/api/studio/projects", {
      method: "POST",
      body: JSON.stringify({
        name: $("#newProjectName").value.trim(),
        description: $("#newProjectDescription").value.trim(),
        targetUrl,
        allowedDomains: [url.hostname]
      })
    });
    state.projects.unshift(response.project);
    $("#projectDialog").close();
    await loadProject(response.project.id);
    showView("workstation");
    toast("新專案已建立");
  } catch (error) { toast(error.message, true); }
}

async function importProjectFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const project = file.name.toLowerCase().endsWith(".zip")
      ? JSON.parse(readStoredZipEntry(await file.arrayBuffer(), ["portable-workflow/workflow.json", "workflow.json"]))
      : JSON.parse(await file.text());
    const response = await api("/api/studio/projects/import", {
      method: "POST",
      body: JSON.stringify({ project })
    });
    state.projects.unshift(response.project);
    await loadProject(response.project.id);
    showView("designer");
    toast("可攜工作流程已匯入");
  } catch (error) {
    toast(`匯入失敗：${error.message}`, true);
  } finally {
    event.target.value = "";
  }
}

async function saveWorkstation() {
  if (!state.project) return false;
  try {
    new URL($("#projectUrl").value.trim());
    state.project.name = $("#projectName").value.trim();
    state.project.targetUrl = $("#projectUrl").value.trim();
    state.project.allowedDomains = parseAllowedDomains($("#allowedDomains").value);
    $("#allowedDomains").value = state.project.allowedDomains.join("\n");
    renderAllowedDomainChips();
    state.project.browser.connectionMode = $("#browserConnectionMode").value;
    state.project.browser.channel = $("#browserChannel").value;
    state.project.browser.cdpEndpoint = $("#cdpEndpoint").value.trim() || "http://127.0.0.1:9222";
    state.project.browser.cdpAutoLaunch = $("#cdpAutoLaunch").checked;
    state.project.browser.cdpInitialPageMode = $("#cdpInitialPageMode").value;
    state.project.browser.cdpInitialPageTarget = $("#cdpInitialPageTarget").value.trim();
    state.project.browser.cdpInitialPageIndex = Math.max(1, Number($("#cdpInitialPageIndex").value || 1));
    state.project.adapter = $("#projectAdapter").value;
    state.project.browser.stealth = $("#stealth").checked;
    state.project.browser.reuseProfile = $("#reuseProfile").checked;
    state.project.browser.downloadPdfInsteadOfPreview = $("#downloadPdfInsteadOfPreview").checked;
    state.project.browser.headless = $("#headless").checked;
    const saved = await saveProject();
    if (!saved) return false;
    await refreshProfileStatus();
    return true;
  } catch (error) { toast(error.message, true); return false; }
}

function renderBrowserConnectionSettings() {
  const cdp = $("#browserConnectionMode")?.value === "cdp";
  $("#cdpSettings").hidden = !cdp;
  $("#browserChannelField").hidden = cdp;
  $("#startRecorderButton").textContent = cdp ? "接管 Chrome 並錄製" : "啟動瀏覽器並錄製";
  $("#stealth").disabled = cdp;
  $("#reuseProfileField").hidden = cdp;
  $("#headlessField").hidden = cdp;
  const pageMode = $("#cdpInitialPageMode")?.value ?? "first";
  $("#cdpTargetField").hidden = pageMode !== "url";
  $("#cdpIndexField").hidden = pageMode !== "index";
  if (state.project) state.project.browser.connectionMode = cdp ? "cdp" : "managed";
  renderBatchConcurrency();
  renderProfileStatus(cdp ? { cdp: true } : (state.profileStatus ?? { enabled: $("#reuseProfile")?.checked, hasData: false }));
}

async function testCdpConnection() {
  if (!state.project) return;
  const button = $("#testCdpButton");
  button.disabled = true;
  $("#cdpStatusBadge").textContent = "連線中…";
  $("#cdpStatusBadge").className = "badge running";
  try {
    const browser = {
      ...state.project.browser,
      connectionMode: "cdp",
      cdpEndpoint: $("#cdpEndpoint").value.trim(),
      cdpAutoLaunch: true,
      cdpInitialPageMode: $("#cdpInitialPageMode").value,
      cdpInitialPageTarget: $("#cdpInitialPageTarget").value.trim(),
      cdpInitialPageIndex: Math.max(1, Number($("#cdpInitialPageIndex").value || 1))
    };
    const response = await api(`/api/studio/projects/${encodeURIComponent(state.project.id)}/cdp/test`, {
      method: "POST", body: JSON.stringify({ browser })
    });
    state.cdpStatus = response.cdp;
    renderCdpResult(response.cdp);
    toast(`${response.cdp.autoLaunched ? "已自動啟動並接管 Chrome" : "CDP 連線成功"}，目前有 ${response.cdp.tabs?.length ?? 0} 個可控制分頁`);
  } catch (error) {
    state.cdpStatus = null;
    renderCdpResult({ error: error.message });
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function renderCdpResult(result) {
  const badge = $("#cdpStatusBadge");
  const list = $("#cdpTabList");
  if (!badge || !list) return;
  if (!result) {
    badge.textContent = "尚未連線";
    badge.className = "badge neutral";
    list.textContent = "尚未讀取分頁。";
    return;
  }
  if (result.error) {
    badge.textContent = "連線失敗";
    badge.className = "badge failed";
    list.innerHTML = `<div class="cdp-tab-item">${escapeHtml(result.error)}</div>`;
    return;
  }
  badge.textContent = `已連線 ${result.version || "Chrome"}`;
  badge.className = "badge completed";
  const tabs = result.tabs ?? [];
  list.innerHTML = tabs.length ? tabs.map((tab) => `<div class="cdp-tab-item"><b>${tab.index === result.selectedIndex ? "✓ " : ""}${tab.index}. ${escapeHtml(tab.title || "（無標題）")}</b><code>${escapeHtml(tab.url || "about:blank")}</code></div>`).join("") : `<div class="cdp-tab-item">沒有可控制分頁。</div>`;
}

async function copyCdpLaunchCommand() {
  let port = "9222";
  try { port = new URL($("#cdpEndpoint").value.trim() || "http://127.0.0.1:9222").port || "9222"; } catch {}
  const command = `chrome.exe --remote-debugging-address=127.0.0.1 --remote-debugging-port=${port} --user-data-dir="%LOCALAPPDATA%\\AutomationStudio\\ChromeCDPProfile"`;
  try {
    await navigator.clipboard.writeText(command);
    toast("已複製 Chrome CDP 啟動指令");
  } catch {
    prompt("請複製以下 Chrome 啟動指令：", command);
  }
}

async function refreshProfileStatus() {
  if (!state.project) return;
  if ((state.project.browser.connectionMode ?? "managed") === "cdp") {
    renderProfileStatus({ cdp: true, enabled: false, hasData: false });
    return;
  }
  try {
    const response = await api(`/api/studio/projects/${encodeURIComponent(state.project.id)}/profile`);
    state.profileStatus = response.profile;
    renderProfileStatus(response.profile);
  } catch (error) {
    renderProfileStatus({ enabled: state.project.browser.reuseProfile, hasData: false, error: error.message });
  }
}

function renderProfileStatus(profile) {
  const enabled = profile?.enabled ?? $("#reuseProfile")?.checked ?? false;
  const hasData = profile?.hasData === true;
  const badge = $("#profileStatus");
  const detail = $("#profileStatusDetail");
  const clearButton = $("#clearProfileButton");
  if (!badge || !detail || !clearButton) return;
  if (profile?.cdp || $("#browserConnectionMode")?.value === "cdp") {
    badge.textContent = "登入狀態由 Chrome 管理";
    badge.className = "badge completed";
    detail.textContent = "CDP 模式直接使用你手動開啟的 Chrome Profile；Automation Studio 不建立或清除這份登入資料。";
    clearButton.disabled = true;
    return;
  }
  if (!enabled) {
    badge.textContent = "不保留登入狀態";
    badge.className = "badge neutral";
    detail.textContent = hasData ? "本機仍有舊 Profile 資料；若不再需要，可按「清除登入狀態」。" : "每次新開瀏覽器都使用全新工作階段。";
  } else if (hasData) {
    badge.textContent = "瀏覽器資料已保存";
    badge.className = "badge completed";
    detail.textContent = "流程結束後可關閉瀏覽器；下次執行同一專案會沿用本機 Profile。網站仍可能要求重新驗證。";
  } else {
    badge.textContent = "尚未建立登入資料";
    badge.className = "badge neutral";
    detail.textContent = "完成一次登入並正常關閉瀏覽器後，網站 Cookie／儲存資料會保存在此專案的本機 Profile。";
  }
  clearButton.disabled = !hasData;
}

async function clearBrowserProfile() {
  if (!state.project) return;
  if (!confirm("確定清除這個專案保存的瀏覽器登入狀態？目前錄製視窗會一併關閉；下次需重新登入網站。")) return;
  try {
    const response = await api(`/api/studio/projects/${encodeURIComponent(state.project.id)}/profile`, { method: "DELETE" });
    state.profileStatus = response.profile;
    renderProfileStatus(response.profile);
    await pollRecorder();
    toast("已清除此專案的瀏覽器登入狀態");
  } catch (error) {
    toast(`清除登入狀態失敗：${error.message}`, true);
  }
}

async function duplicateProject() {
  if (!state.project) return;
  try {
    const response = await api(`/api/studio/projects/${encodeURIComponent(state.project.id)}/duplicate`, { method: "POST" });
    state.projects.unshift(response.project);
    await loadProject(response.project.id);
    toast("專案已複製，可安全調整複本");
  } catch (error) { toast(error.message, true); }
}

async function deleteProject() {
  if (!state.project) return;
  if (!confirm(`確定刪除專案「${state.project.name}」？此操作不會刪除既有下載檔。`)) return;
  try {
    const deletingId = state.project.id;
    await api(`/api/studio/projects/${encodeURIComponent(deletingId)}`, { method: "DELETE" });
    state.projects = state.projects.filter((project) => project.id !== deletingId);
    state.project = null;
    renderProjectSelect();
    if (state.projects[0]) await loadProject(state.projects[0].id);
    showView("dashboard");
    await refreshDashboard();
    toast("專案已刪除；既有下載檔仍保留");
  } catch (error) { toast(error.message, true); }
}

async function startRecorder(options = {}) {
  if (!state.project) return;
  try {
    if (options.save !== false && !(await saveWorkstation())) return;
    const response = await api(`/api/studio/projects/${encodeURIComponent(state.project.id)}/recorder/start`, { method: "POST" });
    resetRecorderSnapshot(false);
    $("#workstationBadge").textContent = "錄製中";
    $("#workstationBadge").className = "badge running";
    scheduleRecorderPoll();
    if (response.navigationError) {
      toast(`錄製視窗已開啟，但目標網址未能自動載入。可按「顯示錄製視窗」後手動前往網址。${response.navigationError}`, true);
    } else {
      const attached = $("#browserConnectionMode").value === "cdp";
      toast(attached ? `已接管現有 Chrome 並開始錄製：${response.url ?? "目前分頁"}` : `錄製瀏覽器已開啟並進入 ${response.url ?? "目標網址"}（${response.browserSource ?? "已選擇瀏覽器"}）`);
    }
  } catch (error) { toast(error.message, true); }
}

async function setRecorderAssertion(pick) {
  if (!state.project) return;
  try {
    await api(`/api/studio/projects/${encodeURIComponent(state.project.id)}/recorder/assertion`, { method: "POST", body: JSON.stringify({ mode: pick ? $("#recorderAssertionKind").value : null }) });
    $("#recorderAssertionHint").textContent = pick ? "請在錄製視窗點選元素；本次點擊只建立驗證。可按 Esc 或取消選取。" : "已取消驗證選取，可繼續錄製操作。";
    if (pick) await focusRecorder();
  } catch (error) { toast(error.message, true); }
}

async function focusRecorder() {
  if (!state.project) return;
  try {
    const response = await api(`/api/studio/projects/${encodeURIComponent(state.project.id)}/recorder/focus`, { method: "POST" });
    applyRecorderStatus(response);
    toast(`已將錄製瀏覽器帶到前景：${response.url ?? "目前頁面"}`);
  } catch (error) { toast(error.message, true); }
}

async function stopRecorder() {
  if (!state.project) return;
  try {
    await api(`/api/studio/projects/${encodeURIComponent(state.project.id)}/recorder/stop`, { method: "POST" });
    stopRecorderWatch();
    const stopped = await pollRecorder();
    if (!stopped && state.recorderSnapshot) {
      applyRecorderStatus({ ...state.recorderSnapshot, active: false });
    }
    $("#workstationBadge").textContent = "已停止";
    $("#workstationBadge").className = "badge neutral";
    toast($("#browserConnectionMode").value === "cdp" ? "已停止錄製並解除 CDP 連線；Chrome 仍保持開啟" : "錄製已停止；未加入流程的事件仍會保留");
    await refreshProfileStatus();
  } catch (error) { toast(error.message, true); }
}

function resetRecorderSnapshot(render = true) {
  state.recorderSnapshot = null;
  state.recorderSnapshotProjectId = state.project?.id ?? "";
  state.recorderRevision = 0;
  state.recorderSyncError = "";
  if (render) renderRecorder({ active: false, revision: 0, events: [] });
}

function recorderStatusStartedAt(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function applyRecorderStatus(status, options = {}) {
  if (!status || typeof status !== "object") return false;
  const projectId = state.project?.id ?? "";
  const incoming = { ...status, events: Array.isArray(status.events) ? status.events : [] };
  const current = state.recorderSnapshotProjectId === projectId ? state.recorderSnapshot : null;
  const incomingRevision = Math.max(0, Number(incoming.revision ?? 0) || 0);
  const currentRevision = Math.max(0, Number(current?.revision ?? state.recorderRevision ?? 0) || 0);
  const incomingStartedAt = recorderStatusStartedAt(incoming.startedAt);
  const currentStartedAt = recorderStatusStartedAt(current?.startedAt);

  if (current && incomingStartedAt && currentStartedAt) {
    if (incomingStartedAt < currentStartedAt) return false;
    if (incomingStartedAt === currentStartedAt && incomingRevision < currentRevision) return false;
  }

  if (current && !incoming.startedAt && incoming.active === false && incoming.events.length === 0 && options.allowEmptyReset !== true) {
    const preserved = { ...current, active: false };
    state.recorderSnapshot = preserved;
    state.recorderSnapshotProjectId = projectId;
    state.recorderRevision = currentRevision;
    state.recorderSyncError = "";
    renderRecorder(preserved);
    return true;
  }

  state.recorderSnapshot = incoming;
  state.recorderSnapshotProjectId = projectId;
  state.recorderRevision = incomingRevision;
  state.recorderSyncError = "";
  renderRecorder(incoming);
  return true;
}

function markRecorderSyncError(message = "錄製狀態同步暫時中斷，已保留最近一次有效的錄製事件。") {
  state.recorderSyncError = message;
  renderRecorder(state.recorderSnapshot ?? { active: false, revision: state.recorderRevision ?? 0, events: [] });
}

async function pollRecorder(options = {}) {
  if (!state.project) return null;
  try {
    const response = await api(`/api/studio/projects/${encodeURIComponent(state.project.id)}/recorder`, { cache: "no-store" });
    applyRecorderStatus(response, options);
    return response;
  } catch {
    markRecorderSyncError();
    return null;
  }
}

function stopRecorderWatch() {
  state.recorderWatchGeneration += 1;
  state.recorderWatchController?.abort?.();
  state.recorderWatchController = null;
  state.recorderEventSource?.close?.();
  state.recorderEventSource = null;
  clearInterval(state.recorderTimer);
  state.recorderTimer = null;
}

function scheduleRecorderPoll() {
  stopRecorderWatch();
  if (!state.project) return;
  const projectId = state.project.id;
  const generation = state.recorderWatchGeneration;
  if (typeof EventSource === "function") {
    startRecorderEventStream(projectId, generation);
    return;
  }
  void watchRecorder(projectId, generation);
}

function startRecorderEventStream(projectId, generation) {
  const stream = new EventSource(`/api/studio/projects/${encodeURIComponent(projectId)}/recorder/stream?after=${encodeURIComponent(String(state.recorderRevision || 0))}`);
  state.recorderEventSource = stream;
  let receivedStatus = false;
  stream.onmessage = (message) => {
    if (generation !== state.recorderWatchGeneration || state.project?.id !== projectId) { stream.close(); return; }
    try {
      const status = JSON.parse(message.data);
      receivedStatus = true;
      applyRecorderStatus(status);
      if (!status.active) { stream.close(); if (state.recorderEventSource === stream) state.recorderEventSource = null; }
    } catch { markRecorderSyncError("錄製即時串流收到無法解析的資料；已保留最近一次有效錄製事件。"); }
  };
  stream.onerror = () => {
    if (generation !== state.recorderWatchGeneration || state.project?.id !== projectId) { stream.close(); return; }
    markRecorderSyncError("錄製即時串流暫時中斷，正在自動重新連線；既有錄製事件不會清除。");
    // EventSource normally reconnects automatically. If the connection was
    // permanently closed before any status arrived, fall back to long-poll.
    if (stream.readyState === EventSource.CLOSED && !receivedStatus) {
      if (state.recorderEventSource === stream) state.recorderEventSource = null;
      void watchRecorder(projectId, generation);
    }
  };
}

async function watchRecorder(projectId, generation) {
  let status;
  try {
    status = await api(`/api/studio/projects/${encodeURIComponent(projectId)}/recorder`, { cache: "no-store" });
  } catch {
    if (generation === state.recorderWatchGeneration && state.project?.id === projectId) markRecorderSyncError();
    return;
  }
  if (generation !== state.recorderWatchGeneration || state.project?.id !== projectId) return;
  applyRecorderStatus(status);
  while (status.active && generation === state.recorderWatchGeneration && state.project?.id === projectId) {
    const controller = new AbortController();
    state.recorderWatchController = controller;
    try {
      status = await api(`/api/studio/projects/${encodeURIComponent(projectId)}/recorder/watch?after=${encodeURIComponent(String(state.recorderRevision))}&timeout=25000`, {
        cache: "no-store", signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted || generation !== state.recorderWatchGeneration || state.project?.id !== projectId) return;
      // Keep a conservative fallback only for transient connection errors.
      await new Promise((resolve) => setTimeout(resolve, 750));
      continue;
    } finally {
      if (state.recorderWatchController === controller) state.recorderWatchController = null;
    }
    if (generation !== state.recorderWatchGeneration || state.project?.id !== projectId) return;
    applyRecorderStatus(status);
  }
}

function recorderSelectorList(event) {
  const value = event?.selector ?? event?.selectors;
  if (Array.isArray(value)) return value.flat(4).filter((item) => item && typeof item === "object");
  if (value && typeof value === "object") return [value];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.flat(4).filter((item) => item && typeof item === "object") : parsed && typeof parsed === "object" ? [parsed] : [];
    } catch { return []; }
  }
  return [];
}

function recorderFramePathList(value) {
  if (Array.isArray(value)) return value.flat(4).map((item) => String(item ?? "").trim()).filter(Boolean).slice(-12);
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      if (parsed !== value) return recorderFramePathList(parsed);
    } catch {}
    return [text];
  }
  if (value && typeof value === "object") {
    const candidate = value.path ?? value.framePath ?? value.url ?? value.frameUrl ?? value.name;
    return candidate == null ? [] : recorderFramePathList(candidate);
  }
  return [];
}

function renderRecorder(status) {
  $("#workstationBadge").textContent = status.active ? "錄製中" : "未啟動";
  $("#workstationBadge").className = `badge ${status.active ? "running" : "neutral"}`;
  $("#recordingCount").textContent = status.events?.length ?? 0;
  $("#recorderAssertionHint").textContent = status.assertionMode ? "請在錄製視窗點選元素；本次點擊只建立驗證。可按 Esc 或取消選取。" : "支援 Enter／Tab／快捷鍵與上傳錄製；上傳步驟需補完整路徑後啟用。";
  $("#pickRecorderAssertionButton").disabled = !status.active;
  $("#cancelRecorderAssertionButton").disabled = !status.active || !status.assertionMode;
  $("#recordingList").className = status.events?.length ? "recording-list" : "recording-list empty-state compact";
  $("#recordingList").innerHTML = status.events?.length ? status.events.map((event) => {
    const firstSelector = recorderSelectorList(event)[0];
    return `<article class="recording-event"><b>${escapeHtml(event.type.toUpperCase())} · ${escapeHtml(event.label)}</b><span>${escapeHtml(firstSelector?.strategy ?? "-")}：${escapeHtml(firstSelector?.value ?? "-")}${event.frameUrl ? ` · Frame: ${escapeHtml(event.frameUrl)}` : ""}${event.type === "press" ? ` · ${escapeHtml(event.value ?? "")}` : ""}${event.type === "upload" ? " · 待補完整路徑，步驟預設停用" : ""}${event.type === "assert" ? ` · ${escapeHtml(event.verification?.kind ?? "")}` : ""}</span></article>`;
  }).join("") : "尚未錄製任何操作。";
  const location = $("#recordingLocation");
  const health = status.frameHealth;
  const healthText = status.active && health?.frames
    ? ` · Frame 錄製器 ${health.healthyFrames ?? 0}/${health.frames} · Binding ${health.bindingFrames ?? 0}/${health.frames}${(health.bindingFrames ?? 0) < health.frames ? " · 備援通道啟用" : ""}${health.repairedFrames ? ` · 已自動修復 ${health.repairedFrames} 次` : ""}`
    : "";
  const transport = status.transportHealth;
  const transportText = status.active && transport?.lastTransport
    ? ` · 最近錄製通道：${transport.lastTransport === "binding" ? "Binding" : transport.lastTransport === "bridge" ? "Frame Bridge" : "Console Beacon"}`
    : "";
  const syncText = state.recorderSyncError ? ` · ${state.recorderSyncError}` : "";
  location.textContent = status.active
    ? `錄製視窗：${status.browserSource ?? "已啟動"} · ${status.url ?? "正在開啟目標網址"}${status.navigationError ? "（目標網址載入失敗，可手動前往）" : ""}${healthText}${transportText}${syncText}`
    : status.events?.length
      ? `錄製已停止 · 尚有 ${status.events.length} 筆未加入流程的錄製事件會暫時保留${syncText}`
      : syncText.replace(/^ · /, "");
  const diagnostic = $("#recordingDiagnostic");
  if (diagnostic) {
    const item = status.lastDiagnostic;
    const diagnosticFramePath = recorderFramePathList(item?.framePath);
    diagnostic.textContent = item
      ? `最近操作：${String(item.eventType || "-").toUpperCase()} · ${item.tag || "-"}${item.role ? ` [role=${item.role}]` : ""} · ${item.result === "recorded" ? "已錄製" : "未錄製"} · ${item.reason || ""}${item.frameUrl ? ` · Frame: ${item.frameUrl}` : ""}${diagnosticFramePath.length ? ` · 路徑: ${diagnosticFramePath.join(" → ")}` : ""}`
      : "最近操作診斷：尚無資料";
    diagnostic.className = `recording-diagnostic ${item?.result === "ignored" ? "warning" : ""}`;
  }
}

async function commitRecording() {
  if (!state.project) return;
  try {
    const response = await api(`/api/studio/projects/${encodeURIComponent(state.project.id)}/recorder/commit`, { method: "POST" });
    state.project = response.project;
    state.selectedStepId = state.project.steps.at(-1)?.id ?? "";
    resetRecorderSnapshot(false);
    renderRecorder({ active: false, revision: 0, events: [] });
    renderProject();
    toast("錄製事件已加入流程，可在設計器繼續調整");
  } catch (error) { toast(error.message, true); }
}

async function clearRecording() {
  if (!state.project) return;
  await api(`/api/studio/projects/${encodeURIComponent(state.project.id)}/recorder/clear`, { method: "POST" });
  resetRecorderSnapshot(false);
  await pollRecorder({ allowEmptyReset: true });
}

function renderDesigner() {
  if (!state.project) return;
  $("#designerStepCount").textContent = `${countSteps(state.project.steps)} 個步驟`;
  const canvas = $("#workflowCanvas");
  canvas.innerHTML = `<div class="workflow-start">開始</div>${renderStepCards(state.project.steps)}<div class="workflow-end">完成</div>`;
  renderStepProperties();
  renderTestStepSelectionInfo();
}

function renderStepCards(steps, depth = 0) {
  return steps.map((step, index) => `
    <article class="workflow-step ${step.id === state.selectedStepId ? "selected" : ""} ${step.enabled ? "" : "disabled"}" data-step-id="${escapeHtml(step.id)}" style="--depth:${depth}">
      <span class="drag-handle" draggable="true" title="拖曳調整同層步驟順序" aria-label="拖曳調整步驟順序">⋮⋮</span>
      <span class="step-index">${String(index + 1).padStart(2, "0")}</span>
      <div class="step-copy"><b>${escapeHtml(step.name)}</b><small>${escapeHtml(stepKindWrite(step.kind))}${step.adapter && step.adapter !== "generic" ? ` · ${escapeHtml(step.adapter)}` : ""}</small><div class="step-quick-run-actions"><button type="button" data-step-action="run-single" ${step.enabled ? "" : "disabled"} title="只執行這一個步驟，不執行前後步驟">只執行此步驟</button><button type="button" data-step-action="run-from" ${step.enabled ? "" : "disabled"} title="從這個步驟開始執行，並繼續後續流程">從此步驟執行</button></div></div>
      <div class="step-actions"><button data-step-action="up" title="上移" aria-label="上移步驟">↑</button><button data-step-action="down" title="下移" aria-label="下移步驟">↓</button><button data-step-action="duplicate" title="複製步驟" aria-label="複製步驟">⧉</button><button data-step-action="toggle" title="啟用或停用" aria-label="啟用或停用步驟">${step.enabled ? "✓" : "–"}</button><button class="delete-step-action" data-step-action="delete" title="刪除此步驟" aria-label="刪除此步驟">×</button></div>
    </article>
    ${step.kind === "condition" ? `<div class="branch-group"><b>條件成立</b>${renderStepCards(step.thenSteps ?? [], depth + 1)}<b>條件不成立</b>${renderStepCards(step.elseSteps ?? [], depth + 1)}</div>` : ""}
    ${step.kind === "loop" ? `<div class="branch-group"><b>每次迴圈</b>${renderStepCards(step.steps ?? [], depth + 1)}</div>` : ""}
  `).join("");
}

function handleCanvasClick(event) {
  const card = event.target.closest("[data-step-id]");
  if (!card) return;
  const id = card.dataset.stepId;
  const action = event.target.closest("[data-step-action]")?.dataset.stepAction;
  if (!applyPendingStepProperties()) return;
  if (!action) {
    state.selectedStepId = id;
    renderDesigner();
    return;
  }
  const location = findStepLocation(state.project.steps, id);
  if (!location) return;
  if (action === "run-single" || action === "run-from") {
    state.selectedStepId = id;
    renderDesigner();
    void runWorkflow(action === "run-single" ? "single-step" : "from-step");
    return;
  }
  const { list, index } = location;
  if (action === "up") moveStepByOffset(id, -1);
  if (action === "down") moveStepByOffset(id, 1);
  if (action === "duplicate") duplicateStep(id);
  if (action === "toggle") { list[index].enabled = !list[index].enabled; markDirty(); renderDesigner(); }
  if (action === "delete") deleteStep(id);
}

function moveStepByOffset(id, offset) {
  const location = findStepLocation(state.project?.steps ?? [], id);
  if (!location) return false;
  const { list, index } = location;
  const nextIndex = index + offset;
  if (nextIndex < 0 || nextIndex >= list.length) return false;
  [list[index], list[nextIndex]] = [list[nextIndex], list[index]];
  state.selectedStepId = id;
  markDirty();
  renderDesigner();
  return true;
}

function duplicateStep(id = state.selectedStepId) {
  const location = findStepLocation(state.project?.steps ?? [], id);
  if (!location) return;
  const source = location.list[location.index];
  const copy = cloneStepWithFreshIds(source, true);
  location.list.splice(location.index + 1, 0, copy);
  state.selectedStepId = copy.id;
  markDirty();
  renderDesigner();
  toast("步驟已複製並插入原步驟下方");
}

function cloneStepWithFreshIds(step, isRoot = false) {
  const copy = JSON.parse(JSON.stringify(step));
  const renew = (item, root = false) => {
    item.id = `step-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    if (root) item.name = `${item.name}（複製）`;
    for (const list of [item.thenSteps ?? [], item.elseSteps ?? [], item.steps ?? []]) list.forEach((child) => renew(child, false));
  };
  renew(copy, isRoot);
  return copy;
}

function handleStepDragStart(event) {
  const handle = event.target.closest(".drag-handle");
  const card = handle?.closest("[data-step-id]");
  if (!handle || !card) { event.preventDefault(); return; }
  state.draggedStepId = card.dataset.stepId;
  card.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", state.draggedStepId);
}

function handleStepDragOver(event) {
  const target = event.target.closest("[data-step-id]");
  if (!target || !state.draggedStepId || target.dataset.stepId === state.draggedStepId) return;
  const sourceLocation = findStepLocation(state.project?.steps ?? [], state.draggedStepId);
  const targetLocation = findStepLocation(state.project?.steps ?? [], target.dataset.stepId);
  clearStepDropIndicators();
  if (!sourceLocation || !targetLocation || sourceLocation.list !== targetLocation.list) {
    target.classList.add("drop-invalid");
    return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const before = event.clientY < target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2;
  target.classList.add(before ? "drop-before" : "drop-after");
}

function handleStepDrop(event) {
  const target = event.target.closest("[data-step-id]");
  const sourceId = state.draggedStepId || event.dataTransfer.getData("text/plain");
  if (!target || !sourceId || target.dataset.stepId === sourceId) return clearStepDragState();
  const sourceLocation = findStepLocation(state.project?.steps ?? [], sourceId);
  const targetLocation = findStepLocation(state.project?.steps ?? [], target.dataset.stepId);
  if (!sourceLocation || !targetLocation || sourceLocation.list !== targetLocation.list) {
    toast("目前拖曳僅支援同一層級；條件分支與迴圈內可各自排序。", true);
    return clearStepDragState();
  }
  event.preventDefault();
  const list = sourceLocation.list;
  const moving = list[sourceLocation.index];
  const before = event.clientY < target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2;
  list.splice(sourceLocation.index, 1);
  let targetIndex = list.findIndex((step) => step.id === target.dataset.stepId);
  if (!before) targetIndex += 1;
  list.splice(targetIndex, 0, moving);
  state.selectedStepId = sourceId;
  markDirty();
  clearStepDragState();
  renderDesigner();
}

function clearStepDropIndicators() {
  $$(".workflow-step.drop-before,.workflow-step.drop-after,.workflow-step.drop-invalid").forEach((card) => card.classList.remove("drop-before", "drop-after", "drop-invalid"));
}

function clearStepDragState(resetId = true) {
  $$(".workflow-step.dragging").forEach((card) => card.classList.remove("dragging"));
  clearStepDropIndicators();
  if (resetId) state.draggedStepId = "";
}

function setAllStepsEnabled(enabled) {
  if (!state.project) return;
  const visit = (steps) => {
    steps.forEach((step) => {
      step.enabled = enabled;
      visit(step.thenSteps ?? []);
      visit(step.elseSteps ?? []);
      visit(step.steps ?? []);
    });
  };
  visit(state.project.steps);
  markDirty();
  renderDesigner();
  toast(enabled ? "已啟用全部流程步驟" : "已停用全部流程步驟");
}

function handleDesignerShortcut(event) {
  const active = document.activeElement;
  if (active?.matches?.("input,textarea,select,[contenteditable='true']")) return;
  if (!state.project || !state.selectedStepId || !$("#designerView")?.classList.contains("active")) return;
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "d") {
    event.preventDefault();
    duplicateStep();
    return;
  }
  if (event.altKey && event.key === "ArrowUp") { event.preventDefault(); moveStepByOffset(state.selectedStepId, -1); return; }
  if (event.altKey && event.key === "ArrowDown") { event.preventDefault(); moveStepByOffset(state.selectedStepId, 1); return; }
  if (event.key === "Delete") { event.preventDefault(); deleteSelectedStep(); }
}

function addStep(kind) {
  if (!state.project) return;
  const id = `step-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const names = { navigate: "開啟網址", newTab: "開新分頁", switchTab: "切換至指定分頁", manual: "人工操作", click: "點擊元件", dblclick: "雙擊元件", extractText: "擷取文字", extractPattern: "擷取樣式", clipboard: "複製至剪貼簿", fill: "填入欄位", select: "選擇選項", upload: "上傳檔案", press: "鍵盤按鍵", hover: "移至元件", check: "勾選項目", wait: "等待頁面", waitNewFirst: "等待第一筆新資料", captureListSnapshot: "擷取清單快照", waitNewListItem: "等待清單新資料", assert: "驗證結果", download: "下載檔案", savePagePdf: "保存頁面 PDF", condition: "條件分支", loop: "迴圈處理" };
  const step = {
    id, name: names[kind] ?? "新步驟", kind, enabled: true, adapter: "generic", retryCount: 1,
    selectors: ["navigate", "newTab", "switchTab", "manual", "wait", "condition", "loop", "extractPattern", "clipboard", "savePagePdf"].includes(kind) ? [] : [{ strategy: "role", role: kind === "fill" ? "textbox" : "button", value: "" }]
  };
  if (kind === "navigate") step.url = state.project.targetUrl;
  if (kind === "newTab") { step.url = "https://"; step.tabName = "new-tab"; }
  if (kind === "switchTab") { step.tabTargetMode = "name"; step.tabTarget = "new-tab"; }
  if (kind === "manual") { step.value = "請在開啟的瀏覽器中完成人工操作。"; step.manualCompletionMode = "button"; step.retryCount = 0; }
  if (kind === "extractText") { step.outputVariable = "mailBody"; step.extractMode = "text"; }
  if (kind === "extractPattern") { step.sourceVariable = "mailBody"; step.regexPattern = "\\b\\d{6}\\b"; step.regexFlags = ""; step.regexGroup = 0; step.outputVariable = "verificationCode"; }
  if (kind === "clipboard") { step.value = "{{mailBody}}"; }
  if (kind === "wait") { step.value = "1000"; step.waitAfter = { kind: "timeout", timeoutMs: 1000 }; }
  if (kind === "waitNewFirst") { step.sourceVariable = "mailBaseline"; step.regexPattern = ""; step.regexFlags = "i"; step.outputVariable = "latestItem"; step.matchMode = "first"; step.timeoutMs = 120000; step.periodicRefresh = false; step.refreshIntervalSeconds = 10; }
  if (kind === "captureListSnapshot") { step.outputVariable = "mailBaselineSet"; step.listLimit = 20; step.matchMode = "first"; step.timeoutMs = 30000; }
  if (kind === "waitNewListItem") { step.sourceVariable = "mailBaselineSet"; step.outputVariable = "latestNewItem"; step.regexPattern = ""; step.regexFlags = "i"; step.listLimit = 20; step.clickOnMatch = true; step.timeoutMs = 180000; step.periodicRefresh = false; step.refreshIntervalSeconds = 10; }
  if (kind === "assert") step.verification = { kind: "visible" };
  if (kind === "savePagePdf") Object.assign(step, { pdfFileName: "", pdfPageSize: "A4", pdfOrientation: "portrait", pdfPrintBackground: false, pdfMarginTopMm: 10, pdfMarginRightMm: 10, pdfMarginBottomMm: 10, pdfMarginLeftMm: 10, pdfDisplayHeaderFooter: false, pdfHeaderTemplate: "", pdfFooterTemplate: "", pdfScale: 1, pdfFullPage: true, pdfUseLocalTime: true });
  if (kind === "condition") { step.condition = { source: "parameter", operator: "equals", name: "", value: "" }; step.thenSteps = []; step.elseSteps = []; }
  if (kind === "loop") { step.loopVariable = "item"; step.loopValues = [""]; step.steps = []; }
  state.project.steps.push(step);
  state.selectedStepId = id;
  markDirty();
  renderDesigner();
}

function renderStepProperties() {
  const container = $("#stepProperties");
  const step = findStepById(state.project?.steps ?? [], state.selectedStepId);
  if (!step) {
    container.className = "empty-state compact";
    container.textContent = "請從中間選取一個流程步驟。";
    return;
  }
  container.className = "properties-form";
  container.dataset.pendingEdits = "false";
  $("#selectedStepHint").textContent = `${step.id} · ${stepKindWrite(step.kind)}`;
  container.innerHTML = `
    <label class="field"><span>步驟名稱</span><input id="stepName" value="${escapeHtml(step.name)}" /></label>
    <div class="inline-grid">
      <label class="field"><span>動作</span><select id="stepKind">${stepOptions(step.kind)}</select></label>
      ${step.kind === "savePagePdf" ? "" : `<label class="field"><span>Adapter</span><select id="stepAdapter">${adapterOptions(step.adapter ?? state.project.adapter)}</select></label>`}
    </div>
    ${step.kind === "savePagePdf" ? "" : step.kind === "upload" ? `<label class="field"><span>上傳檔案完整路徑（一行一個）</span><textarea id="stepValue" placeholder="例如完整本機路徑">${escapeHtml(String(step.value ?? ""))}</textarea><small>${escapeHtml(step.description ?? "支援多檔，每行填入一個完整路徑；可使用參數。")}</small></label>` : step.kind === "switchTab" ? "" : `<label class="field"><span>${step.kind === "manual" ? "人工操作說明" : step.kind === "clipboard" ? "要複製的文字／變數" : "網址／輸入值"}</span><input id="stepValue" value="${escapeHtml(step.url ?? String(step.value ?? ""))}" placeholder="可使用 {{參數Key}}" /></label>`}
    ${kindSpecificFields(step)}
    ${["navigate","newTab"].includes(step.kind) ? navigateDomainStatus(step) : ""}
    ${step.kind === "savePagePdf" ? "" : `${selectorMatchFields(step)}
    <label class="field"><span>定位方式（依序備援）</span><textarea id="stepSelectors" spellcheck="false">${escapeHtml(JSONTape(step.selectors ?? []))}</textarea><small>JSON 陣列；role、label、name、text、css、xpath、component。</small></label>
    <label class="field"><span>元件物件路徑</span><input id="componentPath" value="${escapeHtml(step.componentPath ?? "")}" placeholder="例如 q.q_year 或 mst1.code_level" /></label>
    <div class="inline-grid">
      <label class="field"><span>Frame URL 包含</span><input id="frameUrl" value="${escapeHtml(step.frame?.urlIncludes ?? "")}" /></label>
      <label class="field"><span>逾時（ms）</span><input id="stepTimeout" type="number" value="${step.timeoutMs ?? state.project.browser.defaultTimeoutMs}" /></label>
    </div>
    <label class="switch-field"><input id="autoFrameSearch" type="checkbox" ${step.autoFrameSearch ? "checked" : ""} /><span><b>自動搜尋主頁與所有 Frame</b><small>適合 OWA／舊式內網；找不到主頁元素時也會搜尋 iframe/frame。</small></span></label>
    <div class="inline-grid">
      <label class="field"><span>完成後等待</span><select id="waitKind">${waitOptions(step.waitAfter?.kind ?? "timeout")}</select></label>
      <label class="field"><span>等待值／毫秒</span><input id="waitValue" value="${escapeHtml(step.waitAfter?.value ?? String(step.waitAfter?.timeoutMs ?? ""))}" /></label>
    </div>
    ${step.kind === "manual" ? "" : `<div class="inline-grid"><label class="field"><span>完成驗證</span><select id="verifyKind"><option value="">不驗證</option>${verifyOptions(step.verification?.kind)}</select></label><label class="field"><span>預期值</span><input id="verifyExpected" value="${escapeHtml(String(step.verification?.expected ?? ""))}" /></label></div>`}`}
    <label class="switch-field"><input id="stepEnabled" type="checkbox" ${step.enabled ? "checked" : ""} /><span><b>啟用此步驟</b></span></label>
    <div class="action-row"><button class="button primary small" id="saveStepButton" type="button">套用步驟</button><button class="button secondary small" id="duplicateStepButton" type="button">複製步驟</button><button class="button danger-subtle small" id="deleteStepButton" type="button">刪除</button></div><small class="shortcut-hint">快捷鍵：Ctrl+Shift+D 複製 · Alt+↑/↓ 移動 · Delete 刪除</small>
  `;
  $("#saveStepButton").addEventListener("click", saveStepProperties);
  $("#duplicateStepButton").addEventListener("click", () => duplicateStep());
  $("#deleteStepButton").addEventListener("click", deleteSelectedStep);
  $("#stepKind").addEventListener("change", changeSelectedStepKind);
  $("#addStepDomainButton")?.addEventListener("click", () => { const host = $("#addStepDomainButton")?.dataset.host; if (host) { addDomainValue(host); renderStepProperties(); } });
  $("#periodicRefresh")?.addEventListener("change", (event) => {
    const interval = $("#refreshIntervalSeconds");
    if (interval) interval.disabled = event.target.checked !== true;
  });
  $("#stepMatchMode")?.addEventListener("change", updateMatchIndexState);
  updateMatchIndexState();
  $("#manualCompletionMode")?.addEventListener("change", updateManualCompletionFields);
  $("#tabTargetMode")?.addEventListener("change", updateTabTargetFields);
  updateTabTargetFields();
  updateManualCompletionFields();
  $("#extractMode")?.addEventListener("change", (event) => {
    const input = $("#extractAttribute");
    if (input) input.disabled = event.target.value !== "attribute";
  });
  $("#downloadNameMode")?.addEventListener("change", (event) => {
    $("#downloadFileName").disabled = event.target.value !== "custom";
  });
  $("#pdfDisplayHeaderFooter")?.addEventListener("change", (event) => {
    const disabled = event.target.checked !== true;
    $("#pdfHeaderTemplate").disabled = disabled;
    $("#pdfFooterTemplate").disabled = disabled;
  });
  $$('[data-add-child]', container).forEach((button) => button.addEventListener("click", () => addNestedStep(step, button.dataset.addChild)));
}

function changeSelectedStepKind(event) {
  const step = findStepById(state.project.steps, state.selectedStepId);
  if (!step) return;
  const previousKind = step.kind;
  const nextKind = event.target.value;
  if (previousKind === nextKind) return;

  // Preserve common fields already edited in the form before rebuilding the
  // kind-specific controls. Invalid selector JSON remains unchanged so merely
  // switching an action never destroys the stored selector list.
  step.name = $("#stepName")?.value.trim() || step.name;
  step.adapter = $("#stepAdapter")?.value || step.adapter;
  const formValue = $("#stepValue")?.value ?? String(step.value ?? step.url ?? "");
  step.componentPath = $("#componentPath")?.value.trim() || undefined;
  step.frame = $("#frameUrl")?.value.trim() ? { urlIncludes: $("#frameUrl").value.trim() } : undefined;
  step.timeoutMs = Number($("#stepTimeout")?.value) || undefined;
  step.enabled = $("#stepEnabled")?.checked !== false;
  try { step.selectors = JSON.parse($("#stepSelectors")?.value || "[]"); } catch { /* keep the last valid selectors */ }
  step.matchMode = $("#stepMatchMode")?.value || step.matchMode || "unique";
  step.matchIndex = step.matchMode === "nth" ? Math.max(1, Number($("#stepMatchIndex")?.value) || 1) : undefined;
  const waitKind = $("#waitKind")?.value;
  const waitValue = $("#waitValue")?.value.trim() ?? "";
  step.waitAfter = waitValue
    ? (waitKind === "timeout" ? { kind: "timeout", timeoutMs: Number(waitValue) || 1000 } : { kind: waitKind, value: waitValue, ...(step.waitAfter?.autoFrameSearch ? { autoFrameSearch: true } : {}) })
    : undefined;
  const verifyKind = $("#verifyKind")?.value;
  step.verification = verifyKind
    ? { kind: verifyKind, expected: $("#verifyExpected")?.value ?? "", selector: step.selectors }
    : undefined;
  if (previousKind === "manual") {
    step.manualCompletionMode = $("#manualCompletionMode")?.value || step.manualCompletionMode || "button";
    step.manualExpected = $("#manualExpected")?.value.trim() || undefined;
  }
  if (previousKind === "newTab") step.tabName = $("#tabName")?.value.trim() || step.tabName || undefined;
  if (previousKind === "switchTab") {
    step.tabTargetMode = $("#tabTargetMode")?.value || step.tabTargetMode || "name";
    step.tabTarget = $("#tabTarget")?.value.trim() || step.tabTarget || undefined;
    step.tabIndex = step.tabTargetMode === "index" ? Math.max(1, Number($("#tabIndex")?.value) || step.tabIndex || 1) : undefined;
  }
  if (previousKind === "download") {
    step.downloadMode = $("#downloadMode")?.value || step.downloadMode || "auto";
    step.downloadFileNameMode = $("#downloadNameMode")?.value === "custom" ? "custom" : "original";
    step.downloadFileName = $("#downloadFileName")?.value.trim() || undefined;
  }
  if (previousKind === "condition") {
    step.condition = {
      source: $("#conditionSource")?.value ?? "parameter",
      name: $("#conditionName")?.value.trim() || undefined,
      operator: $("#conditionOperator")?.value ?? "equals",
      value: $("#conditionValue")?.value ?? ""
    };
  }
  if (previousKind === "loop") {
    step.loopVariable = $("#loopVariable")?.value.trim() || "item";
    step.loopParameter = $("#loopParameter")?.value.trim() || undefined;
    step.loopValues = ($("#loopValues")?.value ?? "").split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean);
  }

  step.kind = nextKind;
  if (!["waitNewListItem", "waitNewFirst"].includes(nextKind)) {
    delete step.periodicRefresh;
    delete step.refreshIntervalSeconds;
  }
  if (["waitNewListItem", "waitNewFirst"].includes(nextKind) && !["waitNewListItem", "waitNewFirst"].includes(previousKind)) {
    step.periodicRefresh = false;
    step.refreshIntervalSeconds = 10;
  }
  if (nextKind === "navigate" || nextKind === "newTab") {
    step.url = formValue || (nextKind === "navigate" ? state.project.targetUrl : "https://");
    delete step.value;
  } else if (nextKind === "savePagePdf") {
    delete step.value;
    delete step.url;
  } else {
    step.value = previousKind === "navigate" ? "" : formValue;
    delete step.url;
  }
  if (nextKind === "newTab") step.tabName ??= "new-tab";
  if (nextKind === "switchTab") { step.tabTargetMode ??= "name"; step.tabTarget ??= "new-tab"; }
  if (nextKind === "manual") {
    step.value ||= "請在開啟的瀏覽器中完成人工操作。";
    step.manualCompletionMode ??= "button";
    step.retryCount = 0;
  } else if (previousKind === "manual" && step.retryCount === 0) step.retryCount = 1;
  if (nextKind === "wait") {
    step.value ||= "1000";
    step.waitAfter ??= { kind: "timeout", timeoutMs: 1000 };
  }
  if (nextKind === "assert") step.verification ??= { kind: "visible" };
  if (nextKind === "download") { step.downloadMode ??= "auto"; step.downloadFileNameMode ??= "original"; }
  if (nextKind === "savePagePdf") Object.assign(step, { pdfFileName: step.pdfFileName ?? "", pdfPageSize: step.pdfPageSize ?? "A4", pdfOrientation: step.pdfOrientation ?? "portrait", pdfPrintBackground: step.pdfPrintBackground ?? false, pdfMarginTopMm: step.pdfMarginTopMm ?? 10, pdfMarginRightMm: step.pdfMarginRightMm ?? 10, pdfMarginBottomMm: step.pdfMarginBottomMm ?? 10, pdfMarginLeftMm: step.pdfMarginLeftMm ?? 10, pdfDisplayHeaderFooter: step.pdfDisplayHeaderFooter ?? false, pdfHeaderTemplate: step.pdfHeaderTemplate ?? "", pdfFooterTemplate: step.pdfFooterTemplate ?? "", pdfScale: step.pdfScale ?? 1, pdfFullPage: step.pdfFullPage ?? true, pdfUseLocalTime: step.pdfUseLocalTime ?? true });
  if (nextKind === "condition") {
    step.condition ??= { source: "parameter", operator: "equals", name: "", value: "" };
    step.thenSteps ??= [];
    step.elseSteps ??= [];
  }
  if (nextKind === "loop") {
    step.loopVariable ??= "item";
    step.loopValues ??= [""];
    step.steps ??= [];
  }
  markDirty();
  renderDesigner();
}

function markStepPropertiesPending() {
  const container = $("#stepProperties");
  if (container?.querySelector("#stepKind")) container.dataset.pendingEdits = "true";
}

function applyPendingStepProperties() {
  const container = $("#stepProperties");
  if (container?.dataset.pendingEdits !== "true") return true;
  return saveStepProperties() !== false;
}

function saveStepProperties() {
  const step = findStepById(state.project.steps, state.selectedStepId);
  if (!step) return false;
  try {
    step.name = $("#stepName").value.trim() || "未命名步驟";
    step.kind = $("#stepKind").value;
    step.adapter = $("#stepAdapter")?.value || step.adapter || "generic";
    const value = $("#stepValue")?.value ?? String(step.value ?? step.url ?? "");
    if (step.kind === "navigate" || step.kind === "newTab") { step.url = value; delete step.value; } else if (step.kind === "savePagePdf") { delete step.value; delete step.url; } else { step.value = value; delete step.url; }
    step.selectors = JSON.parse($("#stepSelectors")?.value || "[]");
    step.matchMode = $("#stepMatchMode")?.value || "unique";
    step.matchIndex = step.matchMode === "nth" ? Math.max(1, Number($("#stepMatchIndex")?.value) || 1) : undefined;
    step.componentPath = $("#componentPath")?.value.trim() || undefined;
    step.frame = $("#frameUrl")?.value.trim() ? { urlIncludes: $("#frameUrl").value.trim() } : undefined;
    step.autoFrameSearch = $("#autoFrameSearch")?.checked === true;
    step.timeoutMs = Number($("#stepTimeout")?.value) || undefined;
    const waitKind = $("#waitKind")?.value;
    const waitValue = $("#waitValue")?.value.trim() ?? "";
    step.waitAfter = waitValue ? (waitKind === "timeout" ? { kind: "timeout", timeoutMs: Number(waitValue) || 1000 } : { kind: waitKind, value: waitValue, ...(step.waitAfter?.autoFrameSearch ? { autoFrameSearch: true } : {}) }) : undefined;
    const verifyKind = $("#verifyKind")?.value;
    step.verification = verifyKind ? { kind: verifyKind, expected: $("#verifyExpected")?.value ?? "", selector: step.selectors } : undefined;
    step.enabled = $("#stepEnabled").checked;
    if (step.kind === "manual") {
      step.manualCompletionMode = $("#manualCompletionMode")?.value || "button";
      step.manualExpected = $("#manualExpected")?.value.trim() || undefined;
      if (step.manualCompletionMode === "element" && !step.selectors.length) throw new Error("指定元素出現需要至少一個定位方式 selector。");
      if (step.manualCompletionMode === "url" && !step.manualExpected) throw new Error("網址符合需要填入登入後網址包含的文字。");
      step.verification = step.manualCompletionMode === "element"
        ? { kind: "visible", selector: step.selectors }
        : step.manualCompletionMode === "url"
          ? { kind: "url", expected: step.manualExpected }
          : undefined;
    }
    if (step.kind === "extractText") {
      step.outputVariable = $("#outputVariable")?.value.trim() || undefined;
      step.extractMode = $("#extractMode")?.value || "text";
      step.extractAttribute = step.extractMode === "attribute" ? ($("#extractAttribute")?.value.trim() || undefined) : undefined;
      if (!step.outputVariable) throw new Error("請填入擷取結果要保存的流程變數名稱。");
      if (step.extractMode === "attribute" && !step.extractAttribute) throw new Error("擷取屬性模式需要填入屬性名稱。");
    }
    if (step.kind === "waitNewFirst") {
      step.sourceVariable = $("#sourceVariable")?.value.trim() || undefined;
      step.regexPattern = $("#regexPattern")?.value || "";
      step.regexFlags = $("#regexFlags")?.value.trim() || "";
      step.outputVariable = $("#outputVariable")?.value.trim() || undefined;
      if (!step.sourceVariable) throw new Error("請填入目前第一筆資料的基準變數名稱。");
      if (!step.selectors.length) throw new Error("等待第一筆新資料需要至少一個清單項目 selector。");
      if (step.regexPattern) { try { new RegExp(step.regexPattern, step.regexFlags); } catch (error) { throw new Error(`正規表示式無效：${error.message}`); } }
      readPeriodicRefreshSettings(step);
    }
    if (step.kind === "captureListSnapshot") {
      step.outputVariable = $("#outputVariable")?.value.trim() || undefined;
      step.listLimit = Math.min(100, Math.max(1, Number($("#listLimit")?.value) || 20));
      if (!step.outputVariable) throw new Error("請填入清單快照要保存的流程變數名稱。");
      if (!step.selectors.length) throw new Error("擷取清單快照需要至少一個清單項目 selector。");
    }
    if (step.kind === "waitNewListItem") {
      step.sourceVariable = $("#sourceVariable")?.value.trim() || undefined;
      step.outputVariable = $("#outputVariable")?.value.trim() || undefined;
      step.regexPattern = $("#regexPattern")?.value || "";
      step.regexFlags = $("#regexFlags")?.value.trim() || "";
      step.listLimit = Math.min(100, Math.max(1, Number($("#listLimit")?.value) || 20));
      step.clickOnMatch = $("#clickOnMatch")?.checked === true;
      readPeriodicRefreshSettings(step);
      if (!step.sourceVariable) throw new Error("請填入基準清單快照變數名稱。");
      if (!step.selectors.length) throw new Error("等待清單新資料需要至少一個清單項目 selector。");
      if (step.regexPattern) { try { new RegExp(step.regexPattern, step.regexFlags); } catch (error) { throw new Error(`正規表示式無效：${error.message}`); } }
    }
    if (step.kind === "extractPattern") {
      step.sourceVariable = $("#sourceVariable")?.value.trim() || undefined;
      step.regexPattern = $("#regexPattern")?.value || "";
      step.regexFlags = $("#regexFlags")?.value.trim() || "";
      step.regexGroup = Math.max(0, Number($("#regexGroup")?.value) || 0);
      step.outputVariable = $("#outputVariable")?.value.trim() || undefined;
      if (!step.sourceVariable) throw new Error("請填入來源變數名稱。");
      if (!step.regexPattern) throw new Error("請填入要尋找的文字樣式（正規表示式）。");
      if (!step.outputVariable) throw new Error("請填入擷取結果要保存的流程變數名稱。");
      try { new RegExp(step.regexPattern, step.regexFlags); } catch (error) { throw new Error(`正規表示式無效：${error.message}`); }
    }
    if (step.kind === "newTab") {
      step.tabName = $("#tabName")?.value.trim() || undefined;
      if (!step.url || !/^https?:\/\//i.test(step.url)) throw new Error("開新分頁請填入有效的 http/https 網址。");
    }
    if (step.kind === "switchTab") {
      step.tabTargetMode = $("#tabTargetMode")?.value || "name";
      step.tabTarget = $("#tabTarget")?.value.trim() || undefined;
      step.tabIndex = step.tabTargetMode === "index" ? Math.max(1, Number($("#tabIndex")?.value) || 1) : undefined;
      if (step.tabTargetMode !== "index" && !step.tabTarget) throw new Error("切換分頁請填入分頁名稱、網址片段或標題片段。");
    }
    if (step.kind === "download") {
      step.downloadMode = $("#downloadMode")?.value || "auto";
      step.downloadFileNameMode = $("#downloadNameMode")?.value === "custom" ? "custom" : "original";
      const downloadName = $("#downloadFileName")?.value.trim() ?? "";
      if (step.downloadFileNameMode === "custom" && !downloadName) throw new Error("請填入自訂下載檔名。");
      step.downloadFileName = step.downloadFileNameMode === "custom" ? downloadName : undefined;
    }
    if (step.kind === "savePagePdf") {
      const margin = (id) => {
        const raw = $(id)?.value?.trim() ?? "";
        const value = raw === "" ? 10 : Number(raw);
        if (!Number.isFinite(value)) throw new Error("PDF 邊界請輸入 0 至 50 mm 的數值。");
        return Math.round(Math.min(50, Math.max(0, value)) * 10) / 10;
      };
      step.pdfFileName = $("#pdfFileName")?.value.trim() || undefined;
      step.pdfPageSize = $("#pdfPageSize")?.value === "Letter" ? "Letter" : "A4";
      step.pdfOrientation = $("#pdfOrientation")?.value === "landscape" ? "landscape" : "portrait";
      step.pdfPrintBackground = $("#pdfPrintBackground")?.checked === true;
      step.pdfMarginTopMm = margin("#pdfMarginTopMm");
      step.pdfMarginRightMm = margin("#pdfMarginRightMm");
      step.pdfMarginBottomMm = margin("#pdfMarginBottomMm");
      step.pdfMarginLeftMm = margin("#pdfMarginLeftMm");
      const rawScale = $("#pdfScale")?.value?.trim() ?? "";
      const scalePercent = rawScale === "" ? 100 : Number(rawScale);
      if (!Number.isFinite(scalePercent)) throw new Error("PDF 縮放比例請輸入 10% 至 200% 的數值。");
      step.pdfDisplayHeaderFooter = $("#pdfDisplayHeaderFooter")?.checked === true;
      step.pdfHeaderTemplate = ($("#pdfHeaderTemplate")?.value ?? "").slice(0, 10_000);
      step.pdfFooterTemplate = ($("#pdfFooterTemplate")?.value ?? "").slice(0, 10_000);
      step.pdfScale = Math.round(Math.min(200, Math.max(10, scalePercent)) * 10) / 1000;
      step.pdfFullPage = $("#pdfFullPage")?.checked === true;
      step.pdfUseLocalTime = $("#pdfUseLocalTime")?.checked === true;
    }
    if (step.kind === "condition") {
      step.condition = {
        source: $("#conditionSource")?.value ?? "parameter",
        name: $("#conditionName")?.value.trim() || undefined,
        operator: $("#conditionOperator")?.value ?? "equals",
        value: $("#conditionValue")?.value ?? ""
      };
      step.thenSteps ??= [];
      step.elseSteps ??= [];
    }
    if (step.kind === "loop") {
      step.loopVariable = $("#loopVariable")?.value.trim() || "item";
      step.loopParameter = $("#loopParameter")?.value.trim() || undefined;
      step.loopValues = ($("#loopValues")?.value ?? "").split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean);
      step.steps ??= [];
    }
    $("#stepProperties").dataset.pendingEdits = "false";
    markDirty();
    renderDesigner();
    toast("步驟設定已套用");
    return true;
  } catch (error) { toast(error.message, true); return false; }
}

function deleteStep(id = state.selectedStepId) {
  const location = findStepLocation(state.project?.steps ?? [], id);
  if (!location) return;
  location.list.splice(location.index, 1);
  state.selectedStepId = location.list[Math.min(location.index, location.list.length - 1)]?.id ?? state.project?.steps?.[0]?.id ?? "";
  markDirty();
  renderDesigner();
  toast("步驟已刪除");
}

function deleteSelectedStep() {
  deleteStep(state.selectedStepId);
}

function selectorMatchFields(step) {
  if (["navigate", "newTab", "switchTab", "manual", "wait", "screenshot", "script", "condition", "loop", "extractPattern", "clipboard"].includes(step.kind)) return "";
  const mode = step.matchMode ?? "unique";
  const index = Math.max(1, Number(step.matchIndex) || 1);
  return `<div class="kind-box"><b>多筆資料選取</b><div class="inline-grid"><label class="field"><span>符合多個元件時</span><select id="stepMatchMode">${optionList([["unique","必須唯一（預設）"],["first","第一筆"],["last","最後一筆"],["nth","第 N 筆"]], mode)}</select></label><label class="field"><span>第 N 筆</span><input id="stepMatchIndex" type="number" min="1" step="1" value="${index}" ${mode === "nth" ? "" : "disabled"} /></label></div><small>「第一筆」適合收件匣由新到舊排列時點擊最新郵件；只會在目前 selector 同時找到多個可見桌面元件時套用。</small></div>`;
}

function updateMatchIndexState() {
  const index = $("#stepMatchIndex");
  if (index) index.disabled = $("#stepMatchMode")?.value !== "nth";
}


function updateTabTargetFields() {
  const mode = $("#tabTargetMode")?.value;
  const target = $("#tabTarget");
  const index = $("#tabIndex");
  if (!mode) return;
  if (target) target.disabled = mode === "index";
  if (index) index.disabled = mode !== "index";
}

function updateManualCompletionFields() {
  const mode = $("#manualCompletionMode")?.value;
  const field = $("#manualExpectedField");
  const help = $("#manualCompletionHelp");
  if (!mode) return;
  if (field) field.style.display = mode === "url" ? "grid" : "none";
  if (help) help.textContent = mode === "button"
    ? "流程會暫停，請完成登入、OTP 或憑證操作後，回到執行監控按『人工操作完成，繼續執行』。"
    : mode === "element"
      ? "請在下方『定位方式』填入登入後才會出現的元素 selector；偵測到元素可見後自動繼續。"
      : "登入後只要目前網址包含指定文字，就會自動繼續。";
}

function periodicRefreshFields(step) {
  const checked = step.periodicRefresh === true;
  const seconds = Number(step.refreshIntervalSeconds ?? 10);
  return `<div class="kind-box"><b>定期重新整理</b><label class="switch-field"><input id="periodicRefresh" type="checkbox" ${checked ? "checked" : ""} /><span><b>等待新資料時定期重新整理目前分頁</b><small>先檢查是否已有新資料；尚未找到時才依間隔重新載入同一分頁，不會更新或清除原有基準快照。</small></span></label><label class="field"><span>重新整理間隔（秒）</span><input id="refreshIntervalSeconds" type="number" min="5" max="600" step="1" value="${Number.isFinite(seconds) ? seconds : 10}" ${checked ? "" : "disabled"} /><small>預設 10 秒，可設定 5～600 秒；一旦找到符合條件的新資料就停止重新整理。總等待時間由步驟「逾時（ms）」控制。</small></label></div>`;
}
function readPeriodicRefreshSettings(step) {
  step.periodicRefresh = $("#periodicRefresh")?.checked === true;
  if (!step.periodicRefresh) { step.refreshIntervalSeconds = 10; return; }
  const raw = $("#refreshIntervalSeconds")?.value.trim() ?? "";
  const seconds = Number(raw);
  if (!raw || !Number.isInteger(seconds) || seconds < 5 || seconds > 600) throw new Error("定期重新整理間隔必須設定為 5～600 秒的整數。");
  step.refreshIntervalSeconds = seconds;
}

function kindSpecificFields(step) {
  if (step.kind === "savePagePdf") {
    const pageSize = step.pdfPageSize === "Letter" ? "Letter" : "A4";
    const orientation = step.pdfOrientation === "landscape" ? "landscape" : "portrait";
    const marginValue = (value) => Math.min(50, Math.max(0, Number(value ?? 10)));
    const headerFooterEnabled = step.pdfDisplayHeaderFooter === true;
    const configuredScale = Number(step.pdfScale ?? 1);
    const scalePercent = Math.round((Number.isFinite(configuredScale) ? Math.min(2, Math.max(0.1, configuredScale)) : 1) * 100);
    return `<div class="kind-box pdf-page-settings"><b>頁面 PDF 設定</b><label class="field"><span>檔名</span><input id="pdfFileName" value="${escapeHtml(step.pdfFileName ?? "")}" placeholder="台灣銀行決算_品質檢測結果.pdf" /><small>可使用 {{參數Key}}；系統會自動補上 .pdf 副檔名。</small></label><label class="switch-field"><input id="pdfUseLocalTime" type="checkbox" ${step.pdfUseLocalTime !== false ? "checked" : ""} /><span><b>自動使用本機時間命名</b><small>檔名後附加 YYYYMMDD_HHmmss，例如 _20261007_103000。</small></span></label><div class="inline-grid"><label class="field"><span>紙張大小</span><select id="pdfPageSize">${optionList([["A4","A4"],["Letter","Letter"]], pageSize)}</select></label><label class="field"><span>方向</span><select id="pdfOrientation">${optionList([["portrait","直向"],["landscape","橫向"]], orientation)}</select></label></div><label class="switch-field"><input id="pdfPrintBackground" type="checkbox" ${step.pdfPrintBackground === true ? "checked" : ""} /><span><b>包含背景色與背景圖片</b></span></label><div class="field"><span>邊界（mm）</span><div class="inline-grid pdf-margin-grid"><label class="field"><span>上</span><input id="pdfMarginTopMm" type="number" min="0" max="50" step="0.5" value="${marginValue(step.pdfMarginTopMm)}" /></label><label class="field"><span>右</span><input id="pdfMarginRightMm" type="number" min="0" max="50" step="0.5" value="${marginValue(step.pdfMarginRightMm)}" /></label><label class="field"><span>下</span><input id="pdfMarginBottomMm" type="number" min="0" max="50" step="0.5" value="${marginValue(step.pdfMarginBottomMm)}" /></label><label class="field"><span>左</span><input id="pdfMarginLeftMm" type="number" min="0" max="50" step="0.5" value="${marginValue(step.pdfMarginLeftMm)}" /></label></div></div><label class="switch-field"><input id="pdfDisplayHeaderFooter" type="checkbox" ${headerFooterEnabled ? "checked" : ""} /><span><b>輸出頁首與頁尾</b><small>勾選後套用下方範本；預設不輸出。</small></span></label><label class="field"><span>頁首範本（HTML）</span><textarea id="pdfHeaderTemplate" rows="3" maxlength="10000" spellcheck="false" ${headerFooterEnabled ? "" : "disabled"}>${escapeHtml(step.pdfHeaderTemplate ?? "")}</textarea><small>可用 class：date、title、url、pageNumber、totalPages；空白時頁首留白。需要時請增加上邊界。</small></label><label class="field"><span>頁尾範本（HTML）</span><textarea id="pdfFooterTemplate" rows="3" maxlength="10000" spellcheck="false" ${headerFooterEnabled ? "" : "disabled"}>${escapeHtml(step.pdfFooterTemplate ?? "")}</textarea><small>範本使用獨立列印樣式，不會套用網頁 CSS；可使用 {{參數Key}}。需要時請增加下邊界。</small></label><label class="field"><span>縮放比例（%）</span><input id="pdfScale" type="number" min="10" max="200" step="1" value="${scalePercent}" /><small>可設定 10% 至 200%；預設 100%。</small></label><label class="switch-field"><input id="pdfFullPage" type="checkbox" ${step.pdfFullPage !== false ? "checked" : ""} /><span><b>完整頁面</b><small>勾選時輸出整份文件；取消時僅輸出目前可視範圍。</small></span></label><small>輸出會存至「系統設定」的預設下載資料夾；同名檔案會自動加上序號，不會覆寫。</small></div>`;
  }
  if (step.kind === "newTab") {
    return `<div class="kind-box"><b>開新分頁</b><label class="field"><span>分頁名稱</span><input id="tabName" value="${escapeHtml(step.tabName ?? "new-tab")}" placeholder="例如 chatgpt-login、webmail" /></label><small>分頁名稱只在目前這次流程執行中使用，之後可用「切換至指定分頁」依名稱切回。</small></div>`;
  }
  if (step.kind === "switchTab") {
    const mode = step.tabTargetMode ?? "name";
    const target = step.tabTarget ?? String(step.value ?? "");
    const index = Math.max(1, Number(step.tabIndex) || 1);
    return `<div class="kind-box"><b>切換至指定分頁</b><div class="inline-grid"><label class="field"><span>尋找方式</span><select id="tabTargetMode">${optionList([["name","分頁名稱"],["url","網址包含"],["title","標題包含"],["index","第 N 個分頁"]], mode)}</select></label><label class="field"><span>第 N 個分頁</span><input id="tabIndex" type="number" min="1" value="${index}" ${mode === "index" ? "" : "disabled"} /></label></div><label class="field"><span>名稱／網址／標題條件</span><input id="tabTarget" value="${escapeHtml(target)}" placeholder="例如 chatgpt-login 或 auth.openai.com" ${mode === "index" ? "disabled" : ""} /></label><small>建議優先使用「分頁名稱」；網址與標題適合切換到網站自行開出的既有分頁。</small></div>`;
  }
  if (step.kind === "manual") {
    const inferredMode = step.manualCompletionMode ?? (step.verification?.kind === "url" ? "url" : step.verification ? "element" : "button");
    const expected = step.manualExpected ?? (step.verification?.kind === "url" ? String(step.verification.expected ?? "") : "");
    return `<div class="kind-box"><b>人工操作等待</b><label class="field"><span>完成方式</span><select id="manualCompletionMode">${optionList([["button","手動按『繼續執行』"],["element","指定元素出現後自動繼續"],["url","網址符合後自動繼續"]], inferredMode)}</select></label><label class="field" id="manualExpectedField"><span>登入後網址包含</span><input id="manualExpected" value="${escapeHtml(expected)}" placeholder="例如 /owa/ 或 inbox" /></label><small id="manualCompletionHelp"></small></div>`;
  }
  if (step.kind === "extractText") {
    const mode = step.extractMode ?? "text";
    return `<div class="kind-box"><b>擷取文字</b><div class="inline-grid"><label class="field"><span>擷取內容</span><select id="extractMode">${optionList([["text","純文字"],["html","HTML"],["attribute","指定屬性"]], mode)}</select></label><label class="field"><span>保存至流程變數</span><input id="outputVariable" value="${escapeHtml(step.outputVariable ?? "mailBody")}" placeholder="例如 mailBody" /></label></div><label class="field"><span>屬性名稱（指定屬性時）</span><input id="extractAttribute" value="${escapeHtml(step.extractAttribute ?? "")}" placeholder="例如 href、datetime" ${mode === "attribute" ? "" : "disabled"} /></label><small>擷取後可在後續步驟使用 {{${escapeHtml(step.outputVariable ?? "mailBody")}}}。搭配「第一筆」可取得最新郵件列的文字；若要取得郵件本文，請定位信件內容區。</small></div>`;
  }
  if (step.kind === "waitNewFirst") {
    return `<div class="kind-box"><b>等待第一筆新資料</b><div class="inline-grid"><label class="field"><span>基準變數</span><input id="sourceVariable" value="${escapeHtml(step.sourceVariable ?? "mailBaseline")}" placeholder="mailBaseline" /></label><label class="field"><span>新第一筆保存至</span><input id="outputVariable" value="${escapeHtml(step.outputVariable ?? "latestItem")}" placeholder="latestItem" /></label></div><label class="field"><span>新資料文字需符合（Regex，可留空）</span><input id="regexPattern" value="${escapeHtml(step.regexPattern ?? "")}" placeholder="例如 ChatGPT|OpenAI|驗證碼|登入代碼" /></label><label class="field"><span>Regex Flags</span><input id="regexFlags" value="${escapeHtml(step.regexFlags ?? "i")}" placeholder="i" /></label><small>持續讀取清單第一個可見項目；只有第一筆與基準變數不同，且符合指定文字樣式時才繼續。適合等待新郵件、新公告或最新資料真正出現。</small></div>${periodicRefreshFields(step)}`;
  }
  if (step.kind === "captureListSnapshot") {
    return `<div class="kind-box"><b>擷取清單快照</b><div class="inline-grid"><label class="field"><span>保存至流程變數</span><input id="outputVariable" value="${escapeHtml(step.outputVariable ?? "mailBaselineSet")}" placeholder="mailBaselineSet" /></label><label class="field"><span>最多記錄筆數</span><input id="listLimit" type="number" min="1" max="100" value="${Math.min(100, Math.max(1, Number(step.listLimit) || 20))}" /></label></div><small>記錄目前清單前 N 個可見項目的文字與識別指紋，後續可精確判斷哪些項目是新出現的。適合郵件、公告、案件清單。</small></div>`;
  }
  if (step.kind === "waitNewListItem") {
    return `<div class="kind-box"><b>等待清單新資料</b><div class="inline-grid"><label class="field"><span>基準快照變數</span><input id="sourceVariable" value="${escapeHtml(step.sourceVariable ?? "mailBaselineSet")}" placeholder="mailBaselineSet" /></label><label class="field"><span>符合的新資料保存至</span><input id="outputVariable" value="${escapeHtml(step.outputVariable ?? "latestNewItem")}" placeholder="latestNewItem" /></label></div><div class="inline-grid"><label class="field"><span>最多掃描筆數</span><input id="listLimit" type="number" min="1" max="100" value="${Math.min(100, Math.max(1, Number(step.listLimit) || 20))}" /></label><label class="field checkbox-field"><input id="clickOnMatch" type="checkbox" ${step.clickOnMatch !== false ? "checked" : ""} /><span>找到符合的新資料後立即點擊</span></label></div><label class="field"><span>新資料文字需符合（Regex，可留空）</span><input id="regexPattern" value="${escapeHtml(step.regexPattern ?? "")}" placeholder="例如 ChatGPT|OpenAI|驗證碼|登入代碼" /></label><label class="field"><span>Regex Flags</span><input id="regexFlags" value="${escapeHtml(step.regexFlags ?? "i")}" placeholder="i" /></label><small>掃描目前清單，忽略基準快照中已存在的項目；即使新資料不是第一筆，也能找到。可用 Regex 限定只接受特定郵件/公告。</small></div>${periodicRefreshFields(step)}`;
  }
  if (step.kind === "extractPattern") {
    return `<div class="kind-box"><b>從文字中擷取樣式</b><div class="inline-grid"><label class="field"><span>來源變數</span><input id="sourceVariable" value="${escapeHtml(step.sourceVariable ?? "mailBody")}" placeholder="mailBody" /></label><label class="field"><span>保存至流程變數</span><input id="outputVariable" value="${escapeHtml(step.outputVariable ?? "verificationCode")}" placeholder="verificationCode" /></label></div><label class="field"><span>尋找樣式（正規表示式）</span><input id="regexPattern" value="${escapeHtml(step.regexPattern ?? "\\b\\d{6}\\b")}" placeholder="例如 \\b\\d{6}\\b" /></label><div class="inline-grid"><label class="field"><span>Flags</span><input id="regexFlags" value="${escapeHtml(step.regexFlags ?? "")}" placeholder="例如 i" /></label><label class="field"><span>取第幾個群組（0=完整結果）</span><input id="regexGroup" type="number" min="0" value="${Math.max(0, Number(step.regexGroup) || 0)}" /></label></div><small>預設樣式會取得第一個獨立的 6 位數字。若沒有符合內容，流程會明確失敗，不會填入空白值。</small></div>`;
  }
  if (step.kind === "clipboard") {
    return `<div class="kind-box"><b>複製至剪貼簿</b><small>在上方「要複製的文字／變數」填入內容，例如 {{mailBody}} 或 {{verificationCode}}。執行時會寫入目前系統剪貼簿。</small></div>`;
  }
  if (step.kind === "download") {
    const mode = step.downloadFileNameMode ?? "original";
    const custom = step.downloadFileName ?? "";
    const downloadMode = step.downloadMode ?? "auto";
    return `<div class="kind-box"><b>下載設定</b><label class="field"><span>下載方式</span><select id="downloadMode"><option value="auto" ${downloadMode === "auto" ? "selected" : ""}>自動判斷（優先直接下載）</option><option value="direct" ${downloadMode === "direct" ? "selected" : ""}>直接下載連結（不開新分頁）</option><option value="click" ${downloadMode === "click" ? "selected" : ""}>點擊並等待瀏覽器下載</option></select></label><div class="inline-grid"><label class="field"><span>命名方式</span><select id="downloadNameMode"><option value="original" ${mode === "original" ? "selected" : ""}>保留原檔案名稱</option><option value="custom" ${mode === "custom" ? "selected" : ""}>使用自訂名稱</option></select></label><label class="field"><span>自訂名稱</span><input id="downloadFileName" value="${escapeHtml(custom)}" placeholder="例如 114年度作業手冊-{{年度}}" ${mode === "custom" ? "" : "disabled"} /></label></div><small>「直接下載連結」會讀取目標 &lt;a&gt; 的 href，以目前瀏覽器登入狀態直接取得檔案，不會開啟 PDF 預覽分頁。自動模式若無法直接取得才退回點擊下載。</small></div>`;
  }
  if (step.kind === "condition") {
    const condition = step.condition ?? { source: "parameter", operator: "equals", name: "", value: "" };
    return `<div class="kind-box"><b>條件設定</b><div class="inline-grid"><label class="field"><span>資料來源</span><select id="conditionSource">${optionList([["parameter","參數"],["variable","變數"],["url","網址"],["element","元件"]], condition.source)}</select></label><label class="field"><span>運算方式</span><select id="conditionOperator">${optionList([["equals","等於"],["notEquals","不等於"],["contains","包含"],["exists","存在"],["notExists","不存在"]], condition.operator)}</select></label></div><label class="field"><span>參數／變數名稱</span><input id="conditionName" value="${escapeHtml(condition.name ?? "")}" /></label><label class="field"><span>比較值</span><input id="conditionValue" value="${escapeHtml(condition.value ?? "")}" /></label><div class="child-actions"><button class="button secondary small" data-add-child="then" type="button">＋ 成立時步驟</button><button class="button secondary small" data-add-child="else" type="button">＋ 不成立時步驟</button></div><small>成立 ${step.thenSteps?.length ?? 0} 步；不成立 ${step.elseSteps?.length ?? 0} 步。新增後可在流程圖選取子步驟。</small></div>`;
  }
  if (step.kind === "loop") {
    return `<div class="kind-box"><b>迴圈設定</b><div class="inline-grid"><label class="field"><span>迴圈變數</span><input id="loopVariable" value="${escapeHtml(step.loopVariable ?? "item")}" /></label><label class="field"><span>取自參數 Key</span><input id="loopParameter" value="${escapeHtml(step.loopParameter ?? "")}" /></label></div><label class="field"><span>固定值（逗號或換行）</span><textarea id="loopValues">${escapeHtml((step.loopValues ?? []).join("\n"))}</textarea></label><div class="child-actions"><button class="button secondary small" data-add-child="loop" type="button">＋ 加入迴圈步驟</button></div><small>目前 ${step.steps?.length ?? 0} 個子步驟；若填入參數 Key，執行時優先使用該參數。</small></div>`;
  }
  return "";
}

function addNestedStep(parent, branch) {
  const child = {
    id: `step-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: "新的子步驟",
    kind: "click",
    enabled: true,
    adapter: "generic",
    retryCount: 1,
    selectors: [{ strategy: "role", role: "button", value: "" }]
  };
  if (branch === "then") (parent.thenSteps ??= []).push(child);
  else if (branch === "else") (parent.elseSteps ??= []).push(child);
  else (parent.steps ??= []).push(child);
  state.selectedStepId = child.id;
  markDirty();
  renderDesigner();
}

function findStepById(steps, id) {
  const found = findStepLocation(steps, id);
  return found ? found.list[found.index] : undefined;
}

function findStepLocation(steps, id) {
  for (let index = 0; index < steps.length; index += 1) {
    if (steps[index].id === id) return { list: steps, index };
    for (const childList of [steps[index].thenSteps ?? [], steps[index].elseSteps ?? [], steps[index].steps ?? []]) {
      const found = findStepLocation(childList, id);
      if (found) return found;
    }
  }
  return null;
}

function countSteps(steps) {
  return steps.reduce((total, step) => total + 1 + countSteps(step.thenSteps ?? []) + countSteps(step.elseSteps ?? []) + countSteps(step.steps ?? []), 0);
}

function optionList(options, selected) {
  return options.map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`).join("");
}


function normalizeDomainEntry(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("*.")) return `*.${raw.slice(2).replace(/^\.+|\.+$/g, "")}`;
  try { return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase(); } catch { return raw.replace(/^\.+|\.+$/g, ""); }
}

function parseAllowedDomains(value) { return [...new Set(String(value ?? "").split(/\r?\n|,/).map(normalizeDomainEntry).filter(Boolean))]; }
function syncDomainsFromTextarea() { if (state.project) state.project.allowedDomains = parseAllowedDomains($("#allowedDomains").value); }
function domainEntryAllows(host, entry) {
  const domain = normalizeDomainEntry(entry);
  return domain.startsWith("*.") ? host !== domain.slice(2) && host.endsWith(`.${domain.slice(2)}`) : host === domain;
}
function isHostAllowed(host) { return !state.project?.allowedDomains?.length || state.project.allowedDomains.some((entry) => domainEntryAllows(host.toLowerCase(), entry)); }
function addDomainValue(value) {
  if (!state.project) return;
  const domain = normalizeDomainEntry(value);
  if (!domain) return toast("請輸入有效網域。", true);
  state.project.allowedDomains = [...new Set([...(state.project.allowedDomains ?? []), domain])];
  $("#allowedDomains").value = state.project.allowedDomains.join("\n");
  renderAllowedDomainChips(); markDirty();
}
function addAllowedDomain() { const input = $("#allowedDomainInput"); addDomainValue(input.value); input.value = ""; }
function removeAllowedDomain(value) {
  state.project.allowedDomains = state.project.allowedDomains.filter((item) => item !== value);
  $("#allowedDomains").value = state.project.allowedDomains.join("\n"); renderAllowedDomainChips(); markDirty();
}
function renderAllowedDomainChips() {
  const box = $("#allowedDomainChips"); if (!box || !state.project) return;
  box.innerHTML = state.project.allowedDomains.length ? state.project.allowedDomains.map((domain) => `<span class="domain-chip"><b>${escapeHtml(domain)}</b><button type="button" data-remove-domain="${escapeHtml(domain)}" title="移除">×</button></span>`).join("") : `<small>尚未設定允許網域</small>`;
  $$('[data-remove-domain]', box).forEach((button) => button.addEventListener("click", () => removeAllowedDomain(button.dataset.removeDomain)));
}
function extractNavigateHosts(steps, parameters, result = []) {
  const expand = (value) => String(value ?? "").replace(/{{\s*([^}]+)\s*}}/g, (_m, name) => String(parameters[name.trim()] ?? ""));
  for (const step of steps) {
    if (!step.enabled) continue;
    if (step.kind === "navigate" || step.kind === "newTab") { try { const url = new URL(expand(step.url || step.value || (step.kind === "navigate" ? state.project.targetUrl : ""))); if (/^https?:$/.test(url.protocol)) result.push(url.hostname.toLowerCase()); } catch {} }
    extractNavigateHosts(step.thenSteps ?? [], parameters, result); extractNavigateHosts(step.elseSteps ?? [], parameters, result); extractNavigateHosts(step.steps ?? [], parameters, result);
  }
  return result;
}
function preflightDomains(steps, parameters = {}) {
  const required = [...new Set(extractNavigateHosts(steps, parameters))];
  return { required, missing: required.filter((host) => !isHostAllowed(host)) };
}
function navigateDomainStatus(step) {
  const raw = step.url ?? String(step.value ?? "");
  try {
    const host = new URL(raw).hostname.toLowerCase();
    if (isHostAllowed(host)) return `<div class="domain-warning ok">安全檢查：${escapeHtml(host)} 已在允許網域。</div>`;
    return `<div class="domain-warning">${escapeHtml(host)} 尚未加入允許網域。<button class="button secondary small" id="addStepDomainButton" data-host="${escapeHtml(host)}" type="button">加入允許網域</button></div>`;
  } catch { return `<div class="domain-warning">請輸入有效的 http/https 網址，系統才能檢查允許網域。</div>`; }
}

function ensureParameterIds() {
  const used = new Set();
  state.project.parameters = (state.project.parameters ?? []).map((parameter, index) => {
    const raw = String(parameter.id ?? "").trim();
    const name = String(parameter.name ?? `parameter_${index + 1}`);
    const clean = (raw || `p-${name}`).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || `p-parameter-${index + 1}`;
    let id = clean, suffix = 2;
    while (used.has(id)) id = `${clean}-${suffix++}`;
    used.add(id);
    return { ...parameter, id };
  });
}

function parseDependentOptions(value) {
  const result = {};
  String(value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach((line) => {
    const index = line.indexOf("=");
    if (index < 1) return;
    const parentValue = line.slice(0, index).trim();
    const options = line.slice(index + 1).split("|").map((item) => item.trim()).filter(Boolean);
    if (parentValue && options.length) result[parentValue] = options;
  });
  return result;
}

function serializeDependentOptions(mapping) {
  return Object.entries(mapping ?? {}).map(([parentValue, options]) => `${parentValue}=${(options ?? []).join("|")}`).join("\n");
}

function renderParameterDependencyChoices(selected = "", currentId = "") {
  const select = $("#parameterDependsOn");
  if (!select) return;
  const choices = (state.project.parameters ?? []).filter((item) => item.id !== currentId && item.type === "select");
  select.innerHTML = `<option value="">無</option>${choices.map((item) => `<option value="${escapeHtml(item.name)}" ${item.name === selected ? "selected" : ""}>${escapeHtml(item.label)} (${escapeHtml(item.name)})</option>`).join("")}`;
}

function parameterValuesWithDefaults(overrides = {}) {
  return Object.fromEntries((state.project.parameters ?? []).map((parameter) => [parameter.name,
    Object.prototype.hasOwnProperty.call(overrides, parameter.name) ? overrides[parameter.name] : batchParameterDefault(parameter)
  ]));
}

function parameterAllowedOptions(parameter, values) {
  const allOptions = [...(parameter.options ?? [])];
  if (parameter.type !== "select" || !parameter.dependsOn) return allOptions;
  const parentValue = String(values?.[parameter.dependsOn] ?? "");
  const mapped = parameter.dependentOptions?.[parentValue];
  return Array.isArray(mapped) && mapped.length ? [...mapped] : allOptions;
}

function normalizeDependentValue(parameter, value, values) {
  if (parameter.type !== "select") return value;
  const options = parameterAllowedOptions(parameter, values);
  if (!options.length) return value ?? "";
  const current = value ?? parameter.defaultValue ?? "";
  if (options.some((option) => String(option) === String(current))) return current;
  if (options.some((option) => String(option) === String(parameter.defaultValue ?? ""))) return parameter.defaultValue;
  return options[0];
}

function renderParameters() {
  ensureParameterIds();
  const body = $("#parameterTable");
  body.innerHTML = state.project.parameters.length ? state.project.parameters.map((parameter) => `
    <tr data-parameter-id="${escapeHtml(parameter.id)}"><td><b>${escapeHtml(parameter.label)}</b>${parameter.sensitive ? "<small>敏感資料</small>" : ""}</td><td><code>${escapeHtml(parameter.name)}</code></td><td>${escapeHtml(parameter.type)}</td><td>${parameter.sensitive ? "••••••" : escapeHtml(String(parameter.defaultValue ?? ""))}</td><td>${parameter.required ? "是" : "否"}</td><td class="row-actions"><button data-action="edit">編輯</button><button class="delete" data-action="delete">刪除</button></td></tr>
  `).join("") : `<tr><td colspan="6"><div class="empty-state compact">尚未建立參數。</div></td></tr>`;
}

function resetParameterForm() {
  $("#parameterForm").reset();
  $("#parameterId").value = "";
  $("#parameterDependentOptions").value = "";
  renderParameterDependencyChoices();
  $("#parameterFormTitle").textContent = "新增參數";
}

function handleParameterTableClick(event) {
  const row = event.target.closest("[data-parameter-id]");
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!row || !action) return;
  const parameter = state.project.parameters.find((item) => item.id === row.dataset.parameterId);
  if (!parameter) return;
  if (action === "delete") {
    state.project.parameters = state.project.parameters.filter((item) => item.id !== parameter.id);
    markDirty(); renderParameters(); renderTestParameters(); renderBatch();
    return;
  }
  $("#parameterId").value = parameter.id;
  $("#parameterLabel").value = parameter.label;
  $("#parameterName").value = parameter.name;
  $("#parameterType").value = parameter.type;
  $("#parameterDefault").value = parameter.sensitive ? "" : String(parameter.defaultValue ?? "");
  $("#parameterOptions").value = (parameter.options ?? []).join(", ");
  renderParameterDependencyChoices(parameter.dependsOn ?? "", parameter.id);
  $("#parameterDependentOptions").value = serializeDependentOptions(parameter.dependentOptions);
  $("#parameterRequired").checked = parameter.required;
  $("#parameterSensitive").checked = parameter.sensitive;
  $("#parameterFormTitle").textContent = "編輯參數";
}

function saveParameter(event) {
  event.preventDefault();
  const id = $("#parameterId").value || `p-${Date.now().toString(36)}`;
  const parameter = {
    id,
    label: $("#parameterLabel").value.trim(),
    name: $("#parameterName").value.trim(),
    type: $("#parameterType").value,
    defaultValue: $("#parameterSensitive").checked ? "" : $("#parameterDefault").value,
    options: $("#parameterOptions").value.split(",").map((v) => v.trim()).filter(Boolean),
    dependsOn: $("#parameterDependsOn").value || undefined,
    dependentOptions: parseDependentOptions($("#parameterDependentOptions").value),
    required: $("#parameterRequired").checked,
    sensitive: $("#parameterSensitive").checked || $("#parameterType").value === "secret"
  };
  if (!Object.keys(parameter.dependentOptions ?? {}).length) parameter.dependentOptions = undefined;
  if (!parameter.dependsOn) parameter.dependentOptions = undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameter.name)) return toast("參數 Key 格式不正確。", true);
  if (state.project.parameters.some((item) => item.name === parameter.name && item.id !== id)) return toast("參數 Key 不可重複。", true);
  const index = state.project.parameters.findIndex((item) => item.id === id);
  if (index >= 0) state.project.parameters[index] = parameter; else state.project.parameters.push(parameter);
  resetParameterForm();
  markDirty(); renderParameters(); renderTestParameters(); renderBatch();
  toast("參數已加入專案");
}

function renderTestParameters(overrides = {}) {
  const container = $("#testParameters");
  const values = parameterValuesWithDefaults(overrides);
  for (const parameter of state.project.parameters ?? []) {
    values[parameter.name] = normalizeDependentValue(parameter, values[parameter.name], values);
  }
  container.innerHTML = state.project.parameters.length ? state.project.parameters.map((parameter) => {
    const type = parameter.type === "secret" ? "password" : parameter.type === "number" ? "number" : parameter.type === "date" ? "date" : "text";
    const current = values[parameter.name];
    const input = parameter.type === "select"
      ? `<select data-test-param="${escapeHtml(parameter.name)}">${parameterAllowedOptions(parameter, values).map((option) => `<option value="${escapeHtml(String(option))}" ${String(option) === String(current) ? "selected" : ""}>${escapeHtml(String(option))}</option>`).join("")}</select>`
      : parameter.type === "boolean"
        ? `<select data-test-param="${escapeHtml(parameter.name)}"><option value="true" ${current === true || String(current).toLowerCase() === "true" ? "selected" : ""}>true</option><option value="false" ${!(current === true || String(current).toLowerCase() === "true") ? "selected" : ""}>false</option></select>`
        : `<input data-test-param="${escapeHtml(parameter.name)}" type="${type}" value="${parameter.sensitive ? "" : escapeHtml(String(current ?? ""))}" />`;
    const dependency = parameter.dependsOn ? ` · 依 ${escapeHtml(parameter.dependsOn)} 動態篩選` : "";
    return `<label class="field"><span>${escapeHtml(parameter.label)}${parameter.required ? " *" : ""}</span>${input}<small>${parameter.sensitive ? "不保存敏感值" : escapeHtml(parameter.description ?? parameter.name)}${dependency}</small></label>`;
  }).join("") : `<div class="empty-state compact">此流程沒有參數，可直接執行。</div>`;
}

function handleTestParameterChange(event) {
  const key = event.target?.dataset?.testParam;
  if (!key) return;
  const hasDependent = (state.project.parameters ?? []).some((parameter) => parameter.dependsOn === key);
  if (!hasDependent) return;
  const values = readTestParameters();
  renderTestParameters(values);
}

function readTestParameters() {
  return Object.fromEntries($$("[data-test-param]").map((input) => [input.dataset.testParam, input.value === "true" ? true : input.value === "false" ? false : input.value]));
}

function workflowStepsFromSelectedId(steps, stepId) {
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step.id === stepId) return steps.slice(index);
    for (const childList of [step.thenSteps ?? [], step.elseSteps ?? [], step.steps ?? []]) {
      const nested = workflowStepsFromSelectedId(childList, stepId);
      if (nested) return [...nested, ...steps.slice(index + 1)];
    }
  }
  return null;
}

function selectedTestSteps(runMode) {
  if (!state.project || runMode === "full") return state.project?.steps ?? [];
  const step = findStepById(state.project.steps, state.selectedStepId);
  if (runMode === "single-step") return step ? [step] : [];
  if (runMode === "from-step") return workflowStepsFromSelectedId(state.project.steps, state.selectedStepId) ?? [];
  return state.project.steps;
}

function renderTestStepSelectionInfo() {
  const info = $("#testStepSelectionInfo");
  const singleButton = $("#runStepButton");
  const fromButton = $("#runFromStepButton");
  if (!info || !singleButton || !fromButton) return;
  const step = state.project && state.selectedStepId ? findStepById(state.project.steps, state.selectedStepId) : null;
  singleButton.disabled = !step;
  fromButton.disabled = !step;
  if (!step) {
    info.textContent = "尚未選取流程步驟。若要做局部測試，請先到「自動化設計器」點選步驟。";
    return;
  }
  info.innerHTML = `<b>目前選取：</b>${escapeHtml(step.name)} <span>(${escapeHtml(stepKindWrite(step.kind))})</span> · 可只測此步驟，或從此步驟一路執行到流程結束。`;
}

async function runWorkflow(runMode = "full") {
  if (!state.project) return;
  if (!applyPendingStepProperties()) return;
  const partialRun = runMode === "single-step" || runMode === "from-step";
  if (partialRun && !state.selectedStepId) return toast("請先在流程設計器選取步驟。", true);
  const selectedSteps = selectedTestSteps(runMode);
  if (partialRun && !selectedSteps.length) return toast("找不到目前選取的流程步驟，請重新選取後再試。", true);
  const preflight = preflightDomains(selectedSteps, readTestParameters());
  if (preflight.missing.length) {
    showView("workstation");
    return toast(`執行前檢查：請先加入允許網域 ${preflight.missing.join(", ")}`, true);
  }
  if (state.dirty && !(await saveProject())) return;
  try {
    const recorderStatus = await api(`/api/studio/projects/${encodeURIComponent(state.project.id)}/recorder`).catch(() => ({ active: false }));
    const response = await api(`/api/studio/projects/${encodeURIComponent(state.project.id)}/runs`, {
      method: "POST",
      body: JSON.stringify({
        parameters: readTestParameters(),
        stepId: partialRun ? state.selectedStepId : undefined,
        runMode
      })
    });
    state.currentRunId = response.run.id;
    state.currentRunDebug = { events: [], variables: {}, downloads: [], debugDir: response.run.debugDir ?? "" };
    showView("test");
    renderRun(response.run);
    scheduleRunPoll();
    const label = runMode === "single-step"
      ? "單一步驟測試已建立"
      : runMode === "from-step"
        ? "從選取步驟開始的測試已建立"
        : "完整流程測試已建立";
    toast(recorderStatus.active ? `${label}，沿用錄製中的瀏覽器工作階段` : `${label}；安全驗證網站建議先啟動錄製瀏覽器`);
  } catch (error) { toast(error.message, true); }
}


async function continueCurrentRun() {
  if (!state.currentRunId) return toast("目前沒有可繼續的執行流程。", true);
  try {
    const response = await api(`/api/studio/runs/${encodeURIComponent(state.currentRunId)}/continue`, { method: "POST" });
    renderRun(response.run);
    toast("已送出繼續執行指令。");
  } catch (error) { toast(error.message, true); }
}

async function cancelCurrentRun() {
  if (!state.currentRunId) return toast("目前沒有可停止的執行流程。", true);
  try {
    const response = await api(`/api/studio/runs/${encodeURIComponent(state.currentRunId)}/cancel`, { method: "POST" });
    renderRun(response.run);
    clearInterval(state.pollTimer);
    state.pollTimer = null;
    await refreshRuns();
    toast("已送出停止要求；目前正在進行的頁面動作會在下一個安全檢查點結束。", false);
  } catch (error) { toast(error.message, true); }
}

function scheduleRunPoll() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => void pollRun(), 1000);
  void pollRun();
}

async function pollRun() {
  if (!state.currentRunId) return;
  try {
    const response = await api(`/api/studio/runs/${encodeURIComponent(state.currentRunId)}`);
    renderRun(response.run);
    if (["completed", "failed", "cancelled"].includes(response.run.status)) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      await refreshRuns();
    }
  } catch (error) { clearInterval(state.pollTimer); toast(error.message, true); }
}

function renderRun(run) {
  const canCancel = ["queued", "running", "paused"].includes(run.status);
  $("#cancelRunButton").disabled = !canCancel;
  $("#continueRunButton").hidden = run.status !== "paused";
  $("#continueRunButton").disabled = run.status !== "paused";
  const statusBadge = $("#runStatusBadge");
  statusBadge.className = `monitor-status ${run.status}`;
  statusBadge.innerHTML = `${runStatusIconMarkup(run.status)}<b>${escapeHtml(statusLabel(run.status))}</b>`;
  $("#runMonitorSubtitle").textContent = `${formatDate(run.startedAt)} · ${runModeLabel(run.mode, run.batchWorker)}`;
  const progress = run.totalSteps ? Math.round(run.completedSteps / run.totalSteps * 100) : 0;
  $("#runProgress").style.width = `${progress}%`;
  $("#runProgressPercent").textContent = `${progress}%`;
  $("#runStepProgress").textContent = `${run.completedSteps} / ${run.totalSteps}`;
  $("#runDownloadCount").textContent = run.downloads.length;
  $("#runDownloadLabel").textContent = `${run.downloads.length} 個`;
  $("#runStepCount").textContent = `${run.steps.length} 筆`;
  const currentStep = [...run.steps].reverse().find((step) => step.status === "running") ?? [...run.steps].reverse().find((step) => step.status === "paused") ?? run.steps.at(-1);
  $("#runCurrentStep").textContent = currentStep?.name ?? "—";
  const errorBox = $("#runMonitorError");
  errorBox.hidden = !run.errorMessage;
  errorBox.innerHTML = run.errorMessage ? `<b>執行錯誤</b><span>${escapeHtml(run.errorMessage)}</span>` : "";
  $("#downloadResults").innerHTML = run.downloads.length ? run.downloads.map((download, index) => `
    <article class="download-result"><div><b title="${escapeHtml(download)}">${escapeHtml(fileNameFromPath(download))}</b><small>已完成下載</small></div><div class="download-actions"><button class="button secondary small" type="button" data-download-action="open-file" data-download-index="${index}">開啟檔案</button><button class="button secondary small" type="button" data-download-action="open-folder" data-download-index="${index}">開啟資料夾</button></div></article>
  `).join("") : `<div class="empty-state compact">尚無下載檔案。</div>`;
  $("#stepResults").innerHTML = run.steps.length ? run.steps.map((step) => `
    <article class="step-result ${step.status}">${runStatusIconMarkup(step.status)}<div><b>${escapeHtml(step.name)}</b><small>${escapeHtml(step.message ?? step.kind)}</small></div><time>${step.durationMs ? `${step.durationMs} ms` : step.status === "running" ? "執行中" : step.status === "paused" ? "等待人工操作" : "—"}</time></article>
  `).join("") : `<div class="empty-state compact">等待工作站開始執行…</div>`;
  const latest = [...run.steps].reverse().find((step) => step.state || step.status === "failed");
  const stateItems = latest?.state ? Object.entries(latest.state) : [];
  $("#stateComparison").innerHTML = stateItems.length ? stateItems.map(([key, value]) => `<div class="state-item"><span>${escapeHtml(key)}</span><b>${escapeHtml(JSON.stringify(value))}</b></div>`).join("") : `<div class="empty-state compact">${escapeHtml(run.errorMessage ?? "執行步驟後顯示狀態快照。")}</div>`;
  state.currentRun = run;
  renderDebugFailureTools(run);
  renderDesignerDebug();
  void refreshRunDebug(run.id);
}

function renderDebugFailureTools(run) {
  const panel = $("#debugFailureTools");
  if (!panel) return;
  const failed = run?.status === "failed";
  panel.hidden = !failed;
  if (!failed) return;
  const failedAttempt = [...(run.steps ?? [])].reverse().find((step) => step.status === "failed");
  const stepId = failedAttempt?.stepId ?? run.currentStepId ?? "";
  const step = stepId ? findStepById(state.project?.steps ?? [], stepId) : null;
  $("#debugFailureStepBadge").textContent = step ? `失敗：${step.name}` : failedAttempt?.name ? `失敗：${failedAttempt.name}` : "執行失敗";
  const analyzeButton = $("#analyzeRunFailureButton");
  analyzeButton.disabled = state.debugAIAnalyzing;
  analyzeButton.textContent = state.debugAIAnalyzing ? "AI 分析中…" : "AI 分析失敗原因";
  $("#downloadFailureDiagnosticsButton").disabled = false;
  if (state.debugAIAnalysisRunId !== run.id) {
    state.debugAIAnalysis = null;
    state.debugAIAnalysisRunId = "";
    $("#debugAIStatus").textContent = "尚未進行 AI 分析。";
  }
  renderDebugAIAnalysis();
}

async function analyzeCurrentRunFailure() {
  const run = state.currentRun;
  if (!run || run.status !== "failed") return toast("目前沒有可分析的失敗執行。", true);
  state.debugAIAnalyzing = true;
  state.debugAIAnalysis = null;
  state.debugAIAnalysisRunId = run.id;
  $("#debugAIStatus").textContent = "正在整理失敗步驟、頁面與 Debug 證據，並交由目前 AI Provider 分析…";
  renderDebugFailureTools(run);
  try {
    const response = await api(`/api/studio/runs/${encodeURIComponent(run.id)}/ai-analyze`, { method: "POST", body: "{}" });
    state.debugAIAnalysis = response.analysis ?? null;
    state.debugAIAnalysisRunId = run.id;
    $("#debugAIStatus").textContent = state.debugAIAnalysis ? "AI 分析完成。請先檢查根因、證據與候選設定，再決定是否套用。" : "AI 未回傳可用分析。";
    renderDebugAIAnalysis();
  } catch (error) {
    $("#debugAIStatus").textContent = `AI 分析失敗：${error.message}`;
    toast(`AI Debug 分析失敗：${error.message}`, true);
  } finally {
    state.debugAIAnalyzing = false;
    renderDebugFailureTools(run);
  }
}

function renderDebugAIAnalysis() {
  const result = $("#debugAIResult");
  const patchPanel = $("#debugAIPatchPanel");
  const copyButton = $("#copyDebugAIAnalysisButton");
  const applyButton = $("#applyDebugAIPatchButton");
  const analysis = state.debugAIAnalysis;
  result.hidden = !analysis;
  patchPanel.hidden = !analysis;
  copyButton.disabled = !analysis;
  if (!analysis) {
    result.innerHTML = "";
    $("#debugAIPatchPreview").textContent = "";
    applyButton.disabled = true;
    return;
  }
  const list = (items) => (items ?? []).length ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : `<div class="empty-state compact">無</div>`;
  result.innerHTML = `
    <div class="debug-ai-summary-grid">
      <article><span>判定摘要</span><b>${escapeHtml(analysis.summary ?? "—")}</b></article>
      <article><span>信心程度</span><b>${escapeHtml(({ high:"高", medium:"中", low:"低" })[analysis.confidence] ?? analysis.confidence ?? "—")}</b></article>
    </div>
    <section><div class="mini-heading"><b>可能根因</b></div><p>${escapeHtml(analysis.rootCause ?? "—")}</p></section>
    <section><div class="mini-heading"><b>判斷證據</b></div>${list(analysis.evidence)}</section>
    <section><div class="mini-heading"><b>建議處理</b></div>${list(analysis.suggestions)}</section>
    ${(analysis.warnings ?? []).length ? `<section class="debug-ai-warning"><div class="mini-heading"><b>注意事項</b></div>${list(analysis.warnings)}</section>` : ""}
  `;
  const patch = analysis.proposedPatch ?? {};
  $("#debugAIPatchPreview").textContent = JSON.stringify(patch, null, 2);
  const hasPatch = Object.keys(patch).length > 0;
  applyButton.disabled = !hasPatch;
  applyButton.title = hasPatch ? "只修改目前失敗步驟的候選設定；step.id、kind 與流程結構不會改變。" : "AI 沒有提出可安全套用的步驟設定修正。";
}

async function applyDebugAIPatch() {
  const analysis = state.debugAIAnalysis;
  const run = state.currentRun;
  if (!analysis || !run || run.status !== "failed") return toast("目前沒有可套用的 AI Debug 候選修正。", true);
  if (state.project?.id !== run.projectId) await loadProject(run.projectId);
  const stepId = analysis.failedStepId || [...(run.steps ?? [])].reverse().find((step) => step.status === "failed")?.stepId || run.currentStepId;
  const step = stepId ? findStepById(state.project?.steps ?? [], stepId) : null;
  if (!step) return toast("找不到原失敗步驟，無法套用候選修正。", true);
  const patch = structuredClone(analysis.proposedPatch ?? {});
  if (!Object.keys(patch).length) return toast("AI 沒有提出可安全套用的設定修正。", true);
  const protectedFields = { id: step.id, kind: step.kind, enabled: step.enabled, thenSteps: step.thenSteps, elseSteps: step.elseSteps, steps: step.steps, condition: step.condition, script: step.script, loopVariable: step.loopVariable, loopValues: step.loopValues, loopParameter: step.loopParameter };
  Object.assign(step, patch, protectedFields);
  state.selectedStepId = step.id;
  markDirty();
  await saveProject({ quiet: true });
  renderProject();
  renderTestParameters();
  toast(`已套用 AI 候選設定至「${step.name}」。建議先使用「只執行此步驟」重新測試。`);
}

async function downloadCurrentRunDiagnostics() {
  const run = state.currentRun;
  if (!run || run.status !== "failed") return toast("目前沒有可下載診斷包的失敗執行。", true);
  const button = $("#downloadFailureDiagnosticsButton");
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "正在建立診斷包…";
  try {
    await downloadRunDiagnosticBundle(run.id);
    toast("失敗診斷包 ZIP 已產生。提供外部 AI 前請先人工檢查內容。 ");
  } catch (error) {
    toast(`診斷包建立失敗：${error.message}`, true);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function downloadRunDiagnosticBundle(runId) {
  const response = await fetch(`/api/studio/runs/${encodeURIComponent(runId)}/diagnostics`);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.error?.message ?? "失敗診斷包建立失敗");
  }
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const fileName = match?.[1] ? decodeURIComponent(match[1]) : `automation-studio-debug-${runId}.zip`;
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
  return fileName;
}

async function copyDebugAIAnalysis() {
  const analysis = state.debugAIAnalysis;
  if (!analysis) return;
  const text = [
    `Automation Studio Debug AI 分析`,
    `摘要：${analysis.summary ?? ""}`,
    `根因：${analysis.rootCause ?? ""}`,
    `信心：${analysis.confidence ?? ""}`,
    `證據：\n${(analysis.evidence ?? []).map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
    `建議：\n${(analysis.suggestions ?? []).map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
    `候選修正：\n${JSON.stringify(analysis.proposedPatch ?? {}, null, 2)}`,
    `警告：\n${(analysis.warnings ?? []).join("\n")}`
  ].join("\n\n");
  await navigator.clipboard.writeText(text);
  toast("AI Debug 分析結果已複製。 ");
}

function openFailedStepInDesigner() {
  const run = state.currentRun;
  if (!run) return;
  const stepId = state.debugAIAnalysis?.failedStepId || [...(run.steps ?? [])].reverse().find((step) => step.status === "failed")?.stepId || run.currentStepId;
  if (!stepId) return toast("找不到失敗步驟。", true);
  state.selectedStepId = stepId;
  showView("designer");
  renderDesigner();
  setTimeout(() => document.querySelector(`[data-step-id="${CSS.escape(stepId)}"]`)?.scrollIntoView({ block:"center", behavior:"smooth" }), 50);
}

async function refreshRunDebug(runId) {
  if (!runId || runId !== state.currentRunId) return;
  try {
    const response = await api(`/api/studio/runs/${encodeURIComponent(runId)}/debug`);
    if (runId !== state.currentRunId) return;
    state.currentRunDebug = response.debug ?? { events: [], variables: {}, downloads: [], debugDir: "" };
    renderDesignerDebug();
  } catch {
    // The regular run monitor remains usable even if a debug artifact was already cleaned up.
  }
}

function renderDesignerDebug() {
  const target = $("#designerDebug");
  if (!target) return;
  const run = state.currentRun;
  if (!run) {
    target.textContent = "尚未執行。執行結果與錯誤摘要會顯示在這裡。";
    return;
  }
  target.textContent = buildRunDebugText(run, state.currentRunDebug ?? { events: [], variables: {}, downloads: [], debugDir: "" }, state.activeDebugTab);
}

function buildRunDebugText(run, debug, tab = "log") {
  const events = Array.isArray(debug?.events) ? debug.events : [];
  if (tab === "console") {
    const items = events.filter((event) => event.type === "console");
    return items.length ? items.map((event) => `[${formatDebugTime(event.at)}] ${String(event.level ?? "log").toUpperCase()} ${event.text ?? ""}${event.url ? `\n  ${event.url}` : ""}`).join("\n") : "本次執行沒有 Console 訊息。";
  }
  if (tab === "network") {
    const items = events.filter((event) => ["request_failed", "http_error"].includes(event.type));
    return items.length ? items.map((event) => event.type === "http_error"
      ? `[${formatDebugTime(event.at)}] HTTP ${event.status ?? "?"} ${event.url ?? ""}`
      : `[${formatDebugTime(event.at)}] ${event.method ?? "REQUEST"} FAILED ${event.url ?? ""}${event.failure ? ` — ${event.failure}` : ""}`).join("\n") : "本次執行沒有失敗的網路請求或 HTTP 4xx/5xx 回應。";
  }
  if (tab === "popup") {
    const items = events.filter((event) => ["page_opened", "dialog", "download_completed"].includes(event.type));
    const lines = items.map((event) => {
      if (event.type === "download_completed") return `[${formatDebugTime(event.at)}] DOWNLOAD ${event.name ?? event.stepId ?? ""}\n  ${event.filePath ?? ""}`;
      if (event.type === "dialog") return `[${formatDebugTime(event.at)}] DIALOG ${event.dialogType ?? ""} ${event.message ?? ""}`;
      return `[${formatDebugTime(event.at)}] POPUP / PAGE ${event.url ?? ""}`;
    });
    if (!lines.length && (debug?.downloads ?? []).length) lines.push(...debug.downloads.map((file) => `DOWNLOAD\n  ${file}`));
    return lines.length ? lines.join("\n") : "本次執行沒有 Popup、Dialog 或下載事件。";
  }
  if (tab === "variables") {
    const entries = Object.entries(debug?.variables ?? {});
    return entries.length ? entries.map(([key, value]) => `${key} = ${formatDebugValue(value)}`).join("\n") : "本次執行尚未產生流程變數。";
  }
  const eventLines = events.filter((event) => [
    "run_started", "browser_session_reused", "browser_cdp_attached", "step_started", "step_completed", "step_failed",
    "manual_action_required", "manual_action_completed", "download_completed", "run_completed", "run_failed", "batch_session_preserved"
  ].includes(event.type)).map(formatRunEventLine);
  if (eventLines.length) return eventLines.join("\n");
  if (run.errorMessage) return `[${run.errorCode ?? "ERROR"}] ${run.errorMessage}\nDebug: ${debug?.debugDir || run.debugDir || "—"}`;
  return run.steps?.map((step) => `${String(step.status).padEnd(9)} ${step.name}${step.message ? ` — ${step.message}` : ""}`).join("\n") || "流程已加入執行佇列。";
}

function formatRunEventLine(event) {
  const time = `[${formatDebugTime(event.at)}]`;
  switch (event.type) {
    case "run_started": return `${time} RUN STARTED${event.projectId ? ` project=${event.projectId}` : ""}`;
    case "browser_session_reused": return `${time} BROWSER SESSION REUSED${event.source ? ` · ${event.source}` : ""}`;
    case "browser_cdp_attached": return `${time} CDP ATTACHED${event.endpoint ? ` · ${event.endpoint}` : ""}`;
    case "step_started": return `${time} STEP START · ${event.name ?? event.stepId ?? ""}${event.attempt ? ` · attempt ${event.attempt}` : ""}`;
    case "step_completed": return `${time} STEP OK · ${event.stepId ?? ""}${event.durationMs ? ` · ${event.durationMs} ms` : ""}`;
    case "step_failed": return `${time} STEP FAILED · ${event.stepId ?? ""}${event.message ? ` · ${event.message}` : ""}`;
    case "manual_action_required": return `${time} MANUAL ACTION REQUIRED${event.stepId ? ` · ${event.stepId}` : ""}`;
    case "manual_action_completed": return `${time} MANUAL ACTION COMPLETED${event.stepId ? ` · ${event.stepId}` : ""}`;
    case "download_completed": return `${time} DOWNLOAD · ${event.name ?? event.stepId ?? ""}${event.filePath ? `\n  ${event.filePath}` : ""}`;
    case "run_completed": return `${time} RUN COMPLETED`;
    case "run_failed": return `${time} RUN FAILED${event.code ? ` [${event.code}]` : ""}${event.message ? ` · ${event.message}` : ""}`;
    case "batch_session_preserved": return `${time} BATCH SESSION PRESERVED`;
    default: return `${time} ${String(event.type ?? "event").toUpperCase()}`;
  }
}

function formatDebugTime(value) {
  if (!value) return "--:--:--";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString("zh-TW", { hour12: false });
}

function formatDebugValue(value) {
  if (typeof value === "string") return value.length > 1200 ? `${value.slice(0, 1200)}…` : value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

async function handleDownloadResultAction(event) {
  const button = event.target.closest("button[data-download-action]");
  if (!button || !state.currentRunId) return;
  const index = Number(button.dataset.downloadIndex);
  if (!Number.isSafeInteger(index) || index < 0) return;
  const action = button.dataset.downloadAction;
  button.disabled = true;
  try {
    const result = await api(`/api/studio/runs/${encodeURIComponent(state.currentRunId)}/downloads/${index}/${action}`, { method: "POST" });
    toast(action === "open-file" ? `已開啟檔案：${fileNameFromPath(result.filePath)}` : `已開啟資料夾：${result.directory}`);
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
}

function fileNameFromPath(value) { return String(value ?? "").split(/[\\/]/).pop() || "下載檔案"; }

function batchParameterDefault(parameter) {
  if (parameter.sensitive || parameter.type === "secret") return "";
  if (parameter.type === "boolean") return parameter.defaultValue === true || String(parameter.defaultValue).toLowerCase() === "true";
  return parameter.defaultValue ?? "";
}

function createBatchRow() {
  return {
    id: `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,5)}`,
    enabled: true,
    parameters: Object.fromEntries(state.project.parameters.map((p) => [p.name, batchParameterDefault(p)]))
  };
}

function syncBatchRowsWithParameters() {
  const parameters = state.project.parameters ?? [];
  state.batchRows.forEach((row) => {
    row.parameters ??= {};
    parameters.forEach((parameter) => {
      if (!Object.prototype.hasOwnProperty.call(row.parameters, parameter.name)) {
        row.parameters[parameter.name] = batchParameterDefault(parameter);
      }
      row.parameters[parameter.name] = normalizeDependentValue(parameter, row.parameters[parameter.name], row.parameters);
    });
  });
}

function renderBatchParameterControl(parameter, value, rowParameters) {
  const key = escapeHtml(parameter.name);
  const current = normalizeDependentValue(parameter, value ?? batchParameterDefault(parameter), rowParameters);
  if (parameter.type === "select") {
    const options = parameterAllowedOptions(parameter, rowParameters);
    if (current !== "" && !options.some((option) => String(option) === String(current))) options.unshift(current);
    return `<select data-batch-param="${key}">${options.map((option) => `<option value="${escapeHtml(String(option))}" ${String(option) === String(current) ? "selected" : ""}>${escapeHtml(String(option))}</option>`).join("")}</select>`;
  }
  if (parameter.type === "boolean") {
    const truthy = current === true || String(current).toLowerCase() === "true";
    return `<select data-batch-param="${key}"><option value="true" ${truthy ? "selected" : ""}>true</option><option value="false" ${!truthy ? "selected" : ""}>false</option></select>`;
  }
  const type = parameter.sensitive || parameter.type === "secret" ? "password" : parameter.type === "number" ? "number" : parameter.type === "date" ? "date" : "text";
  return `<input data-batch-param="${key}" type="${type}" value="${escapeHtml(String(current ?? ""))}">`;
}

function renderBatchConcurrency() {
  if (!state.project) return;
  const cdp = state.project.browser.connectionMode === "cdp";
  $("#defaultConcurrency").disabled = cdp;
  $("#defaultConcurrency").value = cdp ? 1 : Math.max(1, Math.min(3, Math.floor(Number(state.project.settings.defaultConcurrency) || 1)));
  $("#batchConcurrencyHint").textContent = cdp
    ? "CDP 接管共用現有瀏覽器，固定依序執行。切換為管理瀏覽器後可選擇 1–3。"
    : "上限 3；並行使用獨立工作站，首次可能需要分別登入。";
}

function renderBatch() {
  renderBatchConcurrency();
  syncBatchRowsWithParameters();
  const parameters = state.project.parameters;
  const empty = state.batchRows.length === 0;
  $("#batchTableWrap").hidden = empty;
  $("#batchEmptyState").hidden = !empty;
  if (empty) {
    $("#batchHead").innerHTML = "";
    $("#batchBody").innerHTML = "";
    return;
  }
  $("#batchHead").innerHTML = `<tr><th>執行</th>${parameters.map((p) => `<th>${escapeHtml(p.label)}</th>`).join("")}<th></th></tr>`;
  $("#batchBody").innerHTML = state.batchRows.map((row) => `<tr data-batch-id="${row.id}"><td><input data-batch-enabled type="checkbox" ${row.enabled ? "checked" : ""}></td>${parameters.map((p) => `<td>${renderBatchParameterControl(p, row.parameters[p.name], row.parameters)}</td>`).join("")}<td class="row-actions"><button class="delete" data-batch-delete>刪除</button></td></tr>`).join("");
}

function readBatchRows() {
  $$("[data-batch-id]").forEach((row) => {
    const item = state.batchRows.find((value) => value.id === row.dataset.batchId);
    if (!item) return;
    item.enabled = $("[data-batch-enabled]", row).checked;
    $$("[data-batch-param]", row).forEach((input) => {
      item.parameters[input.dataset.batchParam] = input.value === "true" ? true : input.value === "false" ? false : input.value;
    });
  });
}

function handleBatchParameterChange(event) {
  readBatchRows();
  const key = event.target?.dataset?.batchParam;
  if (key && (state.project.parameters ?? []).some((parameter) => parameter.dependsOn === key)) renderBatch();
}

function addBatchRow() { readBatchRows(); state.batchRows.push(createBatchRow()); renderBatch(); }
function handleBatchClick(event) {
  const button = event.target.closest("[data-batch-delete]");
  if (!button) return;
  const id = button.closest("[data-batch-id]").dataset.batchId;
  state.batchRows = state.batchRows.filter((row) => row.id !== id);
  renderBatch();
}

async function runBatch() {
  readBatchRows();
  const activeRows = state.batchRows.filter((row) => row.enabled);
  if (!activeRows.length) return toast(state.batchRows.length ? "請至少啟用一筆批次資料。" : "請先新增至少一筆批次資料。", true);
  if (state.dirty) await saveProject();
  try {
    const response = await api(`/api/studio/projects/${encodeURIComponent(state.project.id)}/batch`, { method: "POST", body: JSON.stringify({ rows: activeRows }) });
    const concurrency = response.concurrency ?? 1;
    toast(`已建立 ${response.runs.length} 筆任務，${concurrency > 1 ? `最多同時執行 ${concurrency} 筆` : "將依序執行"}`);
    showView("runs");
  } catch (error) { toast(error.message, true); }
}

async function saveAdvancedSettings() {
  state.project.settings.maxRetries = Number($("#maxRetries").value) || 0;
  if (state.project.browser.connectionMode !== "cdp") state.project.settings.defaultConcurrency = Math.max(1, Math.min(3, Math.floor(Number($("#defaultConcurrency").value) || 1)));
  state.project.settings.safePlayback = $("#safePlayback").checked;
  state.project.settings.humanizedPlayback = $("#humanizedPlayback").checked;
  state.project.settings.minStepDelayMs = Math.max(500, Math.min(10_000, Number($("#minStepDelayMs").value) || 2_000));
  state.project.settings.screenshotMode = $("#screenshotMode").value;
  await saveProject();
}

function captureRunHistoryScrollState() {
  const detail = state.selectedHistoryRunId
    ? document.querySelector(`[data-run-detail="${CSS.escape(state.selectedHistoryRunId)}"]`)
    : null;
  const runsWrap = document.querySelector(".runs-table-wrap");
  const read = (selector) => {
    const element = detail?.querySelector(selector);
    return element ? { top: element.scrollTop, left: element.scrollLeft } : null;
  };
  return {
    pageX: window.scrollX,
    pageY: window.scrollY,
    runsWrap: runsWrap ? { top: runsWrap.scrollTop, left: runsWrap.scrollLeft } : null,
    steps: read(".run-history-steps"),
    downloads: read(".run-history-downloads"),
    debug: read(".run-history-debug pre")
  };
}

function restoreRunHistoryScrollState(snapshot) {
  if (!snapshot) return;
  const detail = state.selectedHistoryRunId
    ? document.querySelector(`[data-run-detail="${CSS.escape(state.selectedHistoryRunId)}"]`)
    : null;
  const restore = (selector, position) => {
    if (!position) return;
    const element = detail?.querySelector(selector);
    if (!element) return;
    element.scrollTop = position.top;
    element.scrollLeft = position.left;
  };
  const runsWrap = document.querySelector(".runs-table-wrap");
  if (runsWrap && snapshot.runsWrap) {
    runsWrap.scrollTop = snapshot.runsWrap.top;
    runsWrap.scrollLeft = snapshot.runsWrap.left;
  }
  restore(".run-history-steps", snapshot.steps);
  restore(".run-history-downloads", snapshot.downloads);
  restore(".run-history-debug pre", snapshot.debug);
  window.scrollTo(snapshot.pageX, snapshot.pageY);
}

async function refreshRuns(options = {}) {
  const response = await api("/api/studio/runs");
  state.runs = response.runs ?? [];
  const existingRunIds = new Set(state.runs.map((run) => run.id));
  for (const runId of state.selectedRunIds) if (!existingRunIds.has(runId)) state.selectedRunIds.delete(runId);
  if (state.selectedHistoryRunId && !existingRunIds.has(state.selectedHistoryRunId)) {
    state.selectedHistoryRunId = "";
    state.selectedHistoryRun = null;
    state.selectedHistoryDebug = { events: [], variables: {}, downloads: [], debugDir: "" };
  }
  const selectedRunId = state.selectedHistoryRunId;
  if (selectedRunId) {
    try {
      const [runResponse, debugResponse] = await Promise.all([
        api(`/api/studio/runs/${encodeURIComponent(selectedRunId)}`),
        api(`/api/studio/runs/${encodeURIComponent(selectedRunId)}/debug`).catch(() => ({ debug: { events: [], variables: {}, downloads: [], debugDir: "" } }))
      ]);
      if (state.selectedHistoryRunId === selectedRunId) {
        state.selectedHistoryRun = runResponse.run;
        state.selectedHistoryDebug = debugResponse.debug ?? { events: [], variables: {}, downloads: [], debugDir: "" };
      }
    } catch {
      // Keep the existing expanded detail visible even if a polling refresh briefly fails.
    }
  }
  const scrollState = captureRunHistoryScrollState();
  renderRuns();
  restoreRunHistoryScrollState(scrollState);
  if (options.refreshSummary !== false) await refreshRunHistorySummary();
}

function startRunsPolling() {
  clearInterval(state.runsPollTimer);
  state.runsPollTimer = setInterval(() => {
    if ($("#runsView")?.classList.contains("active")) void refreshRuns({ refreshSummary: false });
  }, 1000);
}

function stopRunsPolling() {
  clearInterval(state.runsPollTimer);
  state.runsPollTimer = null;
}

async function handleRunsTableClick(event) {
  if (event.target.closest("input[data-run-select]")) {
    event.stopPropagation();
    return;
  }
  const debugTab = event.target.closest("button[data-history-debug-tab]");
  if (debugTab) {
    event.stopPropagation();
    state.activeHistoryDebugTab = debugTab.dataset.historyDebugTab || "log";
    renderRunHistoryDetails();
    return;
  }
  const closeButton = event.target.closest("button[data-run-detail-close]");
  if (closeButton) {
    event.stopPropagation();
    closeRunHistoryDetails();
    return;
  }
  const button = event.target.closest("button[data-run-action]");
  if (button) {
    event.stopPropagation();
    const runId = button.dataset.runId;
    if (!runId) return;
    button.disabled = true;
    try {
      if (button.dataset.runAction === "continue") {
        await api(`/api/studio/runs/${encodeURIComponent(runId)}/continue`, { method: "POST" });
        toast("已送出繼續執行指令。後續批次會沿用本次人工登入工作階段。");
      } else if (button.dataset.runAction === "diagnostics") {
        button.textContent = "正在建立診斷包…";
        await downloadRunDiagnosticBundle(runId);
        toast("失敗診斷包 ZIP 已下載。提供外部 AI 前請先人工檢查內容。");
      } else if (button.dataset.runAction === "delete") {
        button.disabled = false;
        await deleteRunHistoryRecords([runId], "確定刪除此筆執行紀錄嗎？");
        return;
      } else if (button.dataset.runAction === "open-file" || button.dataset.runAction === "open-folder") {
        const index = Number(button.dataset.downloadIndex);
        if (!Number.isSafeInteger(index) || index < 0) throw new Error("下載檔案索引無效。");
        const result = await api(`/api/studio/runs/${encodeURIComponent(runId)}/downloads/${index}/${button.dataset.runAction}`, { method: "POST" });
        toast(button.dataset.runAction === "open-file" ? `已開啟檔案：${fileNameFromPath(result.filePath)}` : `已開啟資料夾：${result.directory}`);
      }
      await refreshRuns();
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.disabled = false;
    }
    return;
  }
  const row = event.target.closest("tr[data-run-row]");
  if (!row?.dataset.runRow) return;
  if (state.selectedHistoryRunId === row.dataset.runRow) closeRunHistoryDetails();
  else await openRunHistoryDetails(row.dataset.runRow);
}

function runStatusIconMarkup(status) {
  const icon = ({
    completed: '<path d="M5.4 10.2 8.5 13.1 14.7 6.9" />',
    failed: '<path d="M10 5.4v5.8" /><circle cx="10" cy="14.2" r="1.05" fill="currentColor" stroke="none" />',
    running: '<path d="M14.7 7.7A5 5 0 1 0 15 12.2" /><path d="M14.7 5.3v2.4h-2.4" />',
    paused: '<path d="M7.4 6.1v7.8M12.6 6.1v7.8" />',
    queued: '<circle cx="6" cy="10" r="1.05" fill="currentColor" stroke="none" /><circle cx="10" cy="10" r="1.05" fill="currentColor" stroke="none" /><circle cx="14" cy="10" r="1.05" fill="currentColor" stroke="none" />',
    cancelled: '<path d="m6.5 6.5 7 7M13.5 6.5l-7 7" />'
  })[status] ?? '<circle cx="10" cy="10" r="1.2" fill="currentColor" stroke="none" />';
  return `<span class="status-icon ${status}" aria-hidden="true"><svg viewBox="0 0 20 20" focusable="false">${icon}</svg></span>`;
}

function buildRunHistoryDetailsMarkup(run, debug) {
  if (!run) return `<div class="run-history-loading">${runStatusIconMarkup("running")}<span>正在載入執行詳情…</span></div>`;
  const events = debug ?? { events: [], variables: {}, downloads: [], debugDir: "" };
  const downloads = run.downloads ?? events.downloads ?? [];
  const steps = run.steps?.length ? run.steps.map((step) => `
    <article class="step-result ${step.status}">${runStatusIconMarkup(step.status)}<div><b>${escapeHtml(step.name)}</b><small>${escapeHtml(step.message ?? step.kind)}${step.attempt && step.attempt > 1 ? ` · 第 ${step.attempt} 次嘗試` : ""}</small></div><time>${step.durationMs ? `${step.durationMs} ms` : step.status === "running" ? "執行中" : "—"}</time></article>
  `).join("") : `<div class="empty-state compact">本次執行尚無步驟結果。</div>`;
  const downloadMarkup = downloads.length ? downloads.map((download, index) => `
    <article class="download-result"><div><b title="${escapeHtml(download)}">${escapeHtml(fileNameFromPath(download))}</b><small title="${escapeHtml(download)}">${escapeHtml(download)}</small></div><div class="download-actions"><button class="button secondary small" type="button" data-run-action="open-file" data-run-id="${escapeHtml(run.id)}" data-download-index="${index}">開啟檔案</button><button class="button secondary small" type="button" data-run-action="open-folder" data-run-id="${escapeHtml(run.id)}" data-download-index="${index}">開啟資料夾</button></div></article>
  `).join("") : `<div class="empty-state compact">本次執行沒有下載成果。</div>`;
  const tabs = [
    ["log", "執行日誌"], ["console", "Console"], ["network", "Network"], ["popup", "Popup / Download"], ["variables", "變數"]
  ].map(([key, label]) => `<button class="${state.activeHistoryDebugTab === key ? "active" : ""}" type="button" data-history-debug-tab="${key}">${label}</button>`).join("");
  return `
    <section class="run-history-details" data-run-detail="${escapeHtml(run.id)}">
      <div class="section-heading run-history-heading"><div><h3>${escapeHtml(run.projectName)} · 執行詳情</h3><p>${escapeHtml(run.id)} · 開始 ${formatDate(run.startedAt, true)}${run.endedAt ? ` · 結束 ${formatDate(run.endedAt, true)}` : ""}</p></div><button class="icon-button run-detail-close" data-run-detail-close type="button" aria-label="收合執行詳情">⌃</button></div>
      <div class="run-detail-grid">
        <div class="run-detail-item"><span>狀態</span><div class="run-detail-status ${run.status}">${runStatusIconMarkup(run.status)}<b>${statusLabel(run.status)}</b></div></div>
        <div class="run-detail-item"><span>執行模式</span><b>${escapeHtml(runModeLabel(run.mode, run.batchWorker))}</b></div>
        <div class="run-detail-item"><span>完成進度</span><b>${run.completedSteps} / ${run.totalSteps}</b></div>
        <div class="run-detail-item"><span>執行時間</span><b>${formatRunDuration(run.startedAt, run.endedAt ?? run.updatedAt)}</b></div>
      </div>
      <div class="run-history-columns">
        <section><div class="mini-heading"><b>步驟執行結果</b><small>${run.steps?.length ?? 0} 筆</small></div><div class="step-results run-history-steps">${steps}</div></section>
        <section><div class="mini-heading"><b>下載成果</b><small>${downloads.length} 個</small></div><div class="download-results run-history-downloads">${downloadMarkup}</div></section>
      </div>
      <div class="debug-drawer run-history-debug">
        <div class="debug-tabs">${tabs}</div>
        <pre>${escapeHtml(buildRunDebugText(run, events, state.activeHistoryDebugTab))}</pre>
      </div>
    </section>`;
}

function renderRuns() {
  const runs = getFilteredRuns();
  $("#runsTable").innerHTML = runs.length ? runs.map((run) => {
    const actions = [];
    if (run.status === "paused") actions.push(`<button class="button primary small" type="button" data-run-action="continue" data-run-id="${escapeHtml(run.id)}">人工操作完成，繼續執行</button>`);
    if (run.status === "failed") actions.push(`<button class="button secondary small" type="button" data-run-action="diagnostics" data-run-id="${escapeHtml(run.id)}" title="下載這筆失敗執行的診斷包 ZIP">下載失敗診斷包 ZIP</button>`);
    (run.downloads ?? []).forEach((download, index) => {
      actions.push(`<div class="run-download-action"><small title="${escapeHtml(download)}">${escapeHtml(fileNameFromPath(download))}</small><div><button class="button secondary small" type="button" data-run-action="open-file" data-run-id="${escapeHtml(run.id)}" data-download-index="${index}">開啟檔案</button><button class="button secondary small" type="button" data-run-action="open-folder" data-run-id="${escapeHtml(run.id)}" data-download-index="${index}">開啟資料夾</button></div></div>`);
    });
    if (isRunHistoryDeletable(run.status)) actions.push(`<button class="button danger-subtle small" type="button" data-run-action="delete" data-run-id="${escapeHtml(run.id)}">刪除此紀錄</button>`);
    const action = actions.length ? `<div class="run-actions">${actions.join("")}</div>` : "—";
    const errorMessage = run.errorMessage ?? "—";
    const selected = state.selectedHistoryRunId === run.id ? " selected" : "";
    const canDelete = isRunHistoryDeletable(run.status);
    const checked = state.selectedRunIds.has(run.id) ? " checked" : "";
    const disabled = canDelete ? "" : " disabled title=\"執行中、等待中或等待人工操作的紀錄受保護\"";
    const recordRow = `<tr class="run-record-row${selected}" data-run-row="${escapeHtml(run.id)}" title="點選${selected ? "收合" : "展開"}本次執行詳細資訊"><td class="run-select-cell"><input type="checkbox" data-run-select="${escapeHtml(run.id)}" aria-label="選取 ${escapeHtml(run.projectName)} 的執行紀錄"${checked}${disabled}></td><td class="run-time-cell">${formatDate(run.startedAt)}</td><td class="run-project-cell"><b>${escapeHtml(run.projectName)}</b><small title="${escapeHtml(run.id)}">${escapeHtml(run.id)}</small></td><td class="run-mode-cell">${escapeHtml(runModeLabel(run.mode, run.batchWorker))}</td><td class="run-progress-cell">${run.completedSteps} / ${run.totalSteps}</td><td class="run-status-cell"><span class="badge ${run.status}">${statusLabel(run.status)}</span></td><td class="run-error-cell"><div class="run-error-message" title="${escapeHtml(errorMessage)}">${escapeHtml(errorMessage)}</div></td><td class="run-actions-cell">${action}</td></tr>`;
    if (!selected) return recordRow;
    const detail = state.selectedHistoryRun?.id === run.id ? buildRunHistoryDetailsMarkup(state.selectedHistoryRun, state.selectedHistoryDebug) : buildRunHistoryDetailsMarkup(null, null);
    return `${recordRow}<tr class="run-detail-row" data-run-detail-row="${escapeHtml(run.id)}"><td colspan="8">${detail}</td></tr>`;
  }).join("") : `<tr><td colspan="8"><div class="empty-state compact">尚無符合條件的執行紀錄。</div></td></tr>`;
  renderRunSelectionToolbar();
}

function getFilteredRuns() {
  const projectFilter = $("#runProjectFilter")?.value ?? "";
  const statusFilter = $("#runStatusFilter")?.value ?? "";
  return state.runs.filter((run) => (!projectFilter || run.projectId === projectFilter) && (!statusFilter || run.status === statusFilter));
}

function isRunHistoryDeletable(status) {
  return ["completed", "failed", "cancelled"].includes(status);
}

function renderRunSelectionToolbar() {
  const visible = getFilteredRuns();
  const selected = state.selectedRunIds.size;
  const selectableVisible = visible.filter((run) => isRunHistoryDeletable(run.status)).length;
  const selectedButton = $("#deleteSelectedRunsButton");
  const selectButton = $("#selectFilteredRunsButton");
  const filteredButton = $("#deleteFilteredRunsButton");
  const completedButton = $("#clearCompletedRunsButton");
  const summary = $("#runSelectionSummary");
  if (summary) summary.textContent = selected ? `已選取 ${selected} 筆紀錄` : `目前篩選結果 ${visible.length} 筆，可刪除 ${selectableVisible} 筆`;
  if (selectedButton) selectedButton.disabled = selected === 0;
  if (selectButton) selectButton.disabled = selectableVisible === 0;
  if (filteredButton) filteredButton.disabled = selectableVisible === 0;
  if (completedButton) completedButton.disabled = !state.runs.some((run) => run.status === "completed");
}

function handleRunsTableChange(event) {
  const checkbox = event.target.closest("input[data-run-select]");
  if (!checkbox) return;
  const runId = checkbox.dataset.runSelect;
  if (!runId) return;
  if (checkbox.checked) state.selectedRunIds.add(runId);
  else state.selectedRunIds.delete(runId);
  renderRunSelectionToolbar();
}

function selectFilteredRuns() {
  for (const run of getFilteredRuns()) if (isRunHistoryDeletable(run.status)) state.selectedRunIds.add(run.id);
  renderRuns();
}

function clearRunSelection() {
  state.selectedRunIds.clear();
  renderRuns();
}

async function deleteSelectedRuns() {
  await deleteRunHistoryRecords([...state.selectedRunIds], "確定刪除已選取的執行紀錄嗎？");
}

async function deleteFilteredRuns() {
  const ids = getFilteredRuns().filter((run) => isRunHistoryDeletable(run.status)).map((run) => run.id);
  await deleteRunHistoryRecords(ids, `確定刪除目前篩選結果中的 ${ids.length} 筆可刪除紀錄嗎？`);
}

async function clearCompletedRuns() {
  const count = state.runs.filter((run) => run.status === "completed").length;
  if (!count || !window.confirm(`確定清除全部 ${count} 筆已完成紀錄嗎？失敗與執行中紀錄不會受到影響。`)) return;
  try {
    const response = await api("/api/studio/runs/clear-completed", { method: "POST", body: "{}" });
    applyRunDeleteResult(response.result);
    await refreshRuns();
    toast(formatRunDeleteResult(response.result));
  } catch (error) {
    toast(`清除完成紀錄失敗：${error.message}`, true);
  }
}

async function deleteRunHistoryRecords(runIds, confirmation) {
  const uniqueIds = [...new Set(runIds)].filter((id) => state.runs.some((run) => run.id === id && isRunHistoryDeletable(run.status)));
  if (!uniqueIds.length) return toast("目前沒有可刪除的執行紀錄。", true);
  if (!window.confirm(`${confirmation}\n已下載的成果檔案會保留；執行中及等待中的紀錄受到保護。`)) return;
  try {
    const response = await api("/api/studio/runs/delete", { method: "POST", body: JSON.stringify({ runIds: uniqueIds }) });
    applyRunDeleteResult(response.result);
    await refreshRuns();
    toast(formatRunDeleteResult(response.result));
  } catch (error) {
    toast(`刪除執行紀錄失敗：${error.message}`, true);
  }
}

function applyRunDeleteResult() {
  state.selectedRunIds.clear();
}

function formatRunDeleteResult(result = {}) {
  return `已刪除 ${Number(result.deletedRuns ?? 0)} 筆；保護中 ${Number(result.protectedRuns ?? 0)} 筆；未找到 ${Number(result.missingRuns ?? 0)} 筆，釋放 ${formatByteSize(Number(result.reclaimedBytes ?? 0))}。已下載檔案保留。`;
}

async function refreshRunHistorySummary() {
  try {
    const response = await api("/api/studio/runs/summary");
    state.runHistorySummary = response.summary ?? null;
    state.settings = { ...(state.settings ?? {}), runHistoryCleanupStatus: response.cleanupStatus ?? state.settings?.runHistoryCleanupStatus };
    renderRunHistorySummary();
    renderRunHistoryCleanupStatus();
  } catch (error) {
    const target = $("#runHistorySummary");
    if (target) target.textContent = `無法取得執行紀錄用量：${error.message}`;
  }
}

function renderRunHistorySummary() {
  const target = $("#runHistorySummary");
  if (!target) return;
  const summary = state.runHistorySummary;
  if (!summary) { target.textContent = "執行紀錄用量尚未載入。"; return; }
  const counts = summary.statusCounts ?? {};
  target.textContent = `共 ${Number(summary.runCount ?? 0)} 筆：完成 ${Number(counts.completed ?? 0)}、失敗 ${Number(counts.failed ?? 0)}、取消 ${Number(counts.cancelled ?? 0)}、執行／等待 ${Number(counts.running ?? 0) + Number(counts.queued ?? 0) + Number(counts.paused ?? 0)}；紀錄 ${formatByteSize(Number(summary.runRecordBytes ?? 0))} + Debug ${formatByteSize(Number(summary.debugBytes ?? 0))} = 共 ${formatByteSize(Number(summary.totalBytes ?? 0))}。不含已下載成果檔案。`;
}

async function openRunHistoryDetails(runId, scrollIntoView = true) {
  if (!runId) return;
  const changingSelection = state.selectedHistoryRunId !== runId;
  state.selectedHistoryRunId = runId;
  if (changingSelection || !state.selectedHistoryRun) {
    state.selectedHistoryRun = null;
    state.selectedHistoryDebug = { events: [], variables: {}, downloads: [], debugDir: "" };
    renderRuns();
  }
  try {
    const [runResponse, debugResponse] = await Promise.all([
      api(`/api/studio/runs/${encodeURIComponent(runId)}`),
      api(`/api/studio/runs/${encodeURIComponent(runId)}/debug`).catch(() => ({ debug: { events: [], variables: {}, downloads: [], debugDir: "" } }))
    ]);
    if (state.selectedHistoryRunId !== runId) return;
    state.selectedHistoryRun = runResponse.run;
    state.selectedHistoryDebug = debugResponse.debug ?? { events: [], variables: {}, downloads: [], debugDir: "" };
    renderRuns();
    if (scrollIntoView) document.querySelector(`[data-run-detail-row="${CSS.escape(runId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    toast(`無法讀取執行詳情：${error.message}`, true);
  }
}

function closeRunHistoryDetails() {
  state.selectedHistoryRunId = "";
  state.selectedHistoryRun = null;
  state.selectedHistoryDebug = { events: [], variables: {}, downloads: [], debugDir: "" };
  renderRuns();
}

function renderRunHistoryDetails() {
  const scrollState = captureRunHistoryScrollState();
  renderRuns();
  restoreRunHistoryScrollState(scrollState);
}

function runModeLabel(mode, batchWorker) {
  if (mode === "batch" && batchWorker) return `批次 · 工作站 ${batchWorker}`;
  return ({ full: "完整流程", "single-step": "只執行此步驟", "from-step": "從此步驟執行", batch: "批次" })[mode] ?? mode ?? "—";
}

function formatRunDuration(startValue, endValue) {
  const start = new Date(startValue).getTime();
  const end = new Date(endValue).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "—";
  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes} 分 ${seconds} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小時 ${minutes % 60} 分`;
}

async function refreshDashboard() {
  state.dashboard = await api("/api/studio/dashboard");
  renderDashboard();
}

function projectHasEnabledStep(steps = []) {
  return steps.some((step) => step.enabled);
}

function quickRunDefaultParameters(project) {
  const values = Object.fromEntries((project.parameters ?? []).map((parameter) => [parameter.name, batchParameterDefault(parameter)]));
  for (const parameter of project.parameters ?? []) {
    if (parameter.type !== "select") continue;
    const parentValue = parameter.dependsOn ? String(values[parameter.dependsOn] ?? "") : "";
    const mapped = parameter.dependsOn ? parameter.dependentOptions?.[parentValue] : undefined;
    const options = Array.isArray(mapped) && mapped.length ? mapped : (parameter.options ?? []);
    const current = values[parameter.name];
    if (!options.some((option) => String(option) === String(current))) values[parameter.name] = options[0] ?? current ?? "";
  }
  return values;
}

function projectIsQuickRunnable(project) {
  if (!project || project.status === "archived" || !projectHasEnabledStep(project.steps ?? [])) return false;
  const parameters = quickRunDefaultParameters(project);
  for (const parameter of project.parameters ?? []) {
    if (!parameter.required) continue;
    const value = parameters[parameter.name];
    if (value === undefined || value === null || String(value).trim() === "") return false;
  }
  const expand = (value) => String(value ?? "").replace(/{{\s*([^}]+)\s*}}/g, (_match, name) => String(parameters[name.trim()] ?? ""));
  const allowed = project.allowedDomains ?? [];
  const hostAllowed = (host) => !allowed.length || allowed.some((entry) => domainEntryAllows(host.toLowerCase(), entry));
  let runnable = true;
  const visit = (steps = []) => {
    for (const step of steps) {
      if (!step.enabled) continue;
      if (step.kind === "navigate" || step.kind === "newTab") {
        const raw = expand(step.url || step.value || (step.kind === "navigate" ? project.targetUrl : ""));
        if (!/^https?:/i.test(raw)) { runnable = false; return; }
        try { if (!hostAllowed(new URL(raw).hostname)) { runnable = false; return; } }
        catch { runnable = false; return; }
      }
      visit(step.thenSteps ?? []); if (!runnable) return;
      visit(step.elseSteps ?? []); if (!runnable) return;
      visit(step.steps ?? []); if (!runnable) return;
    }
  };
  visit(project.steps ?? []);
  return runnable;
}

async function runDashboardProject(projectId, button) {
  if (!projectId) return;
  if (button) button.disabled = true;
  try {
    await loadProject(projectId);
    showView("test");
    await runWorkflow("full");
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}

function renderDashboard() {
  if (document.documentElement.classList.contains("react-dashboard-active")) return;
  const dashboard = state.dashboard ?? {};
  $("#metricProjects").textContent = dashboard.projectCount ?? 0;
  $("#metricReady").textContent = dashboard.readyCount ?? 0;
  $("#metricRuns").textContent = dashboard.runCount ?? 0;
  $("#metricSuccess").textContent = `${dashboard.successRate ?? 0}%`;
  $("#recentProjects").innerHTML = dashboard.recentProjects?.length ? dashboard.recentProjects.map((project) => {
    const runButton = projectIsQuickRunnable(project) ? `<button class="button primary small dashboard-run-button" type="button" data-dashboard-run="${escapeHtml(project.id)}">執行流程</button>` : "";
    return `<article class="project-row" data-dashboard-project="${escapeHtml(project.id)}"><span class="project-icon">${escapeHtml(project.name.slice(0,1))}</span><div class="project-row-main"><b>${escapeHtml(project.name)}</b><small>${escapeHtml(project.description || project.targetUrl)}</small></div><div class="project-row-actions"><time>${formatDate(project.updatedAt, true)}</time>${runButton}</div></article>`;
  }).join("") : `<div class="empty-state compact">尚無專案。</div>`;
  $$('[data-dashboard-project]').forEach((item) => item.addEventListener("click", async (event) => {
    if (event.target.closest("[data-dashboard-run]")) return;
    await loadProject(item.dataset.dashboardProject);
    showView("designer");
  }));
  $$('[data-dashboard-run]').forEach((button) => button.addEventListener("click", async (event) => {
    event.stopPropagation();
    await runDashboardProject(button.dataset.dashboardRun, button);
  }));
  $("#recentRuns").innerHTML = dashboard.recentRuns?.length ? dashboard.recentRuns.map((run) => `<div class="timeline-item"><i class="${run.status}"></i><div><b>${escapeHtml(run.projectName)}</b><span>${statusLabel(run.status)} · ${run.completedSteps}/${run.totalSteps} 步驟</span></div><time>${formatDate(run.startedAt, true)}</time></div>`).join("") : `<div class="empty-state compact">尚無執行紀錄。</div>`;
}

function renderReleaseNotes() {
  const field = $("#releaseNotes");
  if (!field || !state.project) return;
  if (field.dataset.projectId !== state.project.id) {
    field.value = state.project.releaseNotes ?? state.project.description ?? "";
    field.dataset.projectId = state.project.id;
  }
}

function scheduleReleaseAutoSave() {
  if (!state.project) return;
  state.project.version = $("#projectVersion").value.trim() || "1.0.0";
  state.project.releaseNotes = $("#releaseNotes").value;
  state.project.status = $("#projectStatus").value;
  markDirty();
  clearTimeout(state.releaseSaveTimer);
  const projectId = state.project.id;
  state.releaseSaveTimer = setTimeout(() => {
    if (state.project?.id === projectId) void saveReleaseFields(true);
  }, 650);
}

async function saveReleaseFields(quiet = true) {
  if (!state.project) return;
  state.project.version = $("#projectVersion").value.trim() || "1.0.0";
  state.project.releaseNotes = $("#releaseNotes").value;
  state.project.status = $("#projectStatus").value;
  await saveProject({ quiet });
  renderPublishChecks();
}

function renderPublishChecks() {
  if (!state.project) return;
  const checks = [
    [isValidUrl(state.project.targetUrl), "入口網址格式正確"],
    [state.project.allowedDomains.length > 0, "允許網域已設定"],
    [state.project.steps.some((step) => step.enabled), "流程至少有一個啟用步驟"],
    [true, "密碼、Cookie 與工作站不會匯出"]
  ];
  $("#publishChecks").innerHTML = checks.map(([ok, label]) => `<li class="${ok ? "ok" : ""}">${escapeHtml(label)}</li>`).join("");
}

async function exportProject() {
  if (!state.project) return;
  if (state.dirty) await saveProject();
  const selection = {
    portableWorkflow: $("#exportPortable").checked,
    typescript: $("#exportTypescript").checked,
    skill: $("#exportSkill").checked,
    includeTests: $("#includeTests").checked,
    includeExamples: $("#includeExamples").checked
  };
  if (!selection.portableWorkflow && !selection.typescript && !selection.skill) return toast("請至少選擇一種成果格式。", true);
  try {
    const response = await fetch(`/api/studio/projects/${encodeURIComponent(state.project.id)}/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(selection) });
    if (!response.ok) throw new Error((await response.json()).error?.message ?? "成果產生失敗");
    const blob = await response.blob();
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${state.project.id}-${state.project.version}-export.zip`;
    anchor.click();
    URL.revokeObjectURL(href);
    toast("成果 ZIP 已產生並開始下載");
  } catch (error) { toast(error.message, true); }
}

function renderSettings() {
  const settings = state.settings ?? {};
  $("#themeSetting").value = settings.theme ?? "system";
  $("#retentionDays").value = settings.retentionDays ?? 30;
  $("#runHistoryRetentionDays").value = settings.runHistoryRetentionDays ?? 30;
  $("#downloadDirectory").value = settings.defaultDownloadDir ?? "./downloads";
  $("#debugRetention").value = settings.debugRetention ?? "failures";
  $("#issueReportEmail").value = settings.issueReportEmail ?? "";
  renderDebugCleanupStatus();
  renderRunHistoryCleanupStatus();
  renderAISettings();
  renderIssueReportContext();
}

function renderDebugCleanupStatus() {
  const status = state.settings?.debugCleanupStatus ?? {};
  const last = $("#debugCleanupLastAt");
  const summary = $("#debugCleanupSummary");
  const next = $("#debugCleanupNextAt");
  const error = $("#debugCleanupError");
  const button = $("#cleanupExpiredDebugButton");
  if (!last || !summary || !next || !error || !button) return;
  last.textContent = `上次清理：${status.lastCompletedAt ? formatDate(status.lastCompletedAt) : "尚未執行"}`;
  summary.textContent = `最近清除：${Number(status.deletedRuns ?? 0)} 筆 / ${formatByteSize(Number(status.reclaimedBytes ?? 0))}`;
  next.textContent = status.nextEligibleAt
    ? `下次自動清理：${formatDate(status.nextEligibleAt)} 之後遇到啟動或流程完成事件時`
    : "下次自動清理：首次符合事件時執行";
  error.hidden = !status.lastError;
  error.textContent = status.lastError ? `最近清理錯誤：${status.lastError}` : "";
  button.disabled = status.running === true;
  button.textContent = status.running === true ? "清理中…" : "立即清理過期 Debug";
  if (state.debugCleanupTimer) { clearTimeout(state.debugCleanupTimer); state.debugCleanupTimer = null; }
  if (status.running === true) {
    state.debugCleanupTimer = setTimeout(() => void refreshDebugCleanupStatus(), 1500);
  }
}

async function refreshDebugCleanupStatus() {
  try {
    const response = await api("/api/studio/settings");
    state.settings = response.settings ?? state.settings;
    renderDebugCleanupStatus();
  } catch {
    if (state.debugCleanupTimer) clearTimeout(state.debugCleanupTimer);
    state.debugCleanupTimer = null;
  }
}

async function cleanupExpiredDebugNow() {
  const button = $("#cleanupExpiredDebugButton");
  if (button) { button.disabled = true; button.textContent = "清理中…"; }
  try {
    // Apply the retention days/mode currently visible in the form first, so
    // "立即清理" never runs with stale settings.
    if (!(await saveSettings({ quiet: true }))) return;
    const response = await api("/api/studio/settings/debug-cleanup", { method: "POST" });
    state.settings = response.settings ?? state.settings;
    renderSettings();
    const result = response.result ?? {};
    toast(`Debug 清理完成：刪除 ${Number(result.deletedRuns ?? 0)} 筆，釋放 ${formatByteSize(Number(result.reclaimedBytes ?? 0))}`);
  } catch (error) {
    toast(error.message, true);
    if (button) { button.disabled = false; button.textContent = "立即清理過期 Debug"; }
  }
}

function renderRunHistoryCleanupStatus() {
  const status = state.settings?.runHistoryCleanupStatus ?? {};
  const last = $("#runHistoryCleanupLastAt");
  const summary = $("#runHistoryCleanupSummary");
  const next = $("#runHistoryCleanupNextAt");
  const error = $("#runHistoryCleanupError");
  const button = $("#cleanupExpiredRunsButton");
  if (!last || !summary || !next || !error || !button) return;
  last.textContent = `上次清理：${status.lastCompletedAt ? formatDate(status.lastCompletedAt) : "尚未執行"}`;
  summary.textContent = `最近清除：${Number(status.deletedRuns ?? 0)} 筆 / ${formatByteSize(Number(status.reclaimedBytes ?? 0))}`;
  next.textContent = status.nextEligibleAt
    ? `下次自動清理：${formatDate(status.nextEligibleAt)} 之後遇到啟動或流程完成事件時`
    : "下次自動清理：首次符合事件時執行";
  error.hidden = !status.lastError;
  error.textContent = status.lastError ? `最近清理錯誤：${status.lastError}` : "";
  button.disabled = status.running === true;
  button.textContent = status.running === true ? "清理中…" : "立即清理過期紀錄";
  if (state.runHistoryCleanupTimer) { clearTimeout(state.runHistoryCleanupTimer); state.runHistoryCleanupTimer = null; }
  if (status.running === true) state.runHistoryCleanupTimer = setTimeout(() => void refreshRunHistoryCleanupStatus(), 1500);
}

async function refreshRunHistoryCleanupStatus() {
  try {
    const response = await api("/api/studio/settings");
    state.settings = response.settings ?? state.settings;
    renderRunHistoryCleanupStatus();
  } catch {
    if (state.runHistoryCleanupTimer) clearTimeout(state.runHistoryCleanupTimer);
    state.runHistoryCleanupTimer = null;
  }
}

async function cleanupExpiredRunHistoryNow() {
  const button = $("#cleanupExpiredRunsButton");
  if (button) { button.disabled = true; button.textContent = "清理中…"; }
  try {
    if (!(await saveSettings({ quiet: true }))) return;
    const response = await api("/api/studio/settings/run-history-cleanup", { method: "POST" });
    state.settings = response.settings ?? state.settings;
    renderSettings();
    await refreshRuns();
    const result = response.result ?? {};
    toast(`執行紀錄清理完成：刪除 ${Number(result.deletedRuns ?? 0)} 筆，釋放 ${formatByteSize(Number(result.reclaimedBytes ?? 0))}`);
  } catch (error) {
    toast(error.message, true);
    if (button) { button.disabled = false; button.textContent = "立即清理過期紀錄"; }
  }
}

const AI_PROVIDER_META = {
  openai: ["OpenAI", "OpenAI API"],
  gemini: ["Gemini", "Google Gemini API；V1.0.7 使用 x-goog-api-key Header"],
  ollama: ["Ollama / Local", "本機或內網模型，可不使用 API Key"],
  openai_compatible: ["OpenAI-compatible", "vLLM、LM Studio 或相容 API"],
  custom_gateway: ["Company AI Gateway", "公司內部自訂 HTTP Gateway"]
};

function renderAISettings() {
  const ai = state.settings?.ai ?? { enabled: false, providers: [] };
  $("#aiEnabled").checked = ai.enabled === true;
  const providers = Array.isArray(ai.providers) ? ai.providers : [];
  const openProviderIds = new Set($$("#aiProviderList details[open][data-ai-provider]").map((item) => item.dataset.aiProvider));
  $("#activeAIProvider").innerHTML = providers.map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === ai.activeProviderId ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("");
  $("#aiProviderList").innerHTML = providers.map(renderAIProviderCard).join("");
  providers.forEach((p) => {
    updateAIProviderAuthFields(p.id);
    const card = [...document.querySelectorAll("[data-ai-provider]")].find((item) => item.dataset.aiProvider === p.id);
    if (card && openProviderIds.has(p.id)) card.open = true;
  });
  renderAISettingsBadge();
  renderAIWorkflowAssistant();
}

function renderAIProviderCard(provider) {
  const meta = AI_PROVIDER_META[provider.kind] ?? [provider.name, provider.kind];
  const secret = provider.secret ?? { source: "env" };
  const gemini = provider.kind === "gemini";
  const enabledLabel = provider.enabled ? "已啟用" : "未啟用";
  const enabledClass = provider.enabled ? "completed" : "neutral";
  return `<details class="ai-provider-card" data-ai-provider="${escapeHtml(provider.id)}">
    <summary class="ai-provider-summary">
      <div><span class="ai-provider-kind">${escapeHtml(provider.kind)}</span><h3>${escapeHtml(meta[0])}</h3><p>${escapeHtml(meta[1])}</p></div>
      <span class="badge ${enabledClass}">${enabledLabel}</span>
    </summary>
    <div class="ai-provider-body">
      <label class="switch-field compact ai-provider-enable"><input type="checkbox" data-ai-field="enabled" ${provider.enabled ? "checked" : ""}/><span><b>啟用此 Provider</b><small>只有啟用的 Provider 才能被選為目前 AI 來源。</small></span></label>
      <div class="form-grid two">
        <label class="field full"><span>Endpoint</span><input data-ai-field="endpoint" value="${escapeHtml(provider.endpoint ?? "")}" /></label>
        <label class="field"><span>Model</span><input data-ai-field="model" value="${escapeHtml(provider.model ?? "")}" placeholder="${gemini ? "gemini-3.5-flash-lite" : "模型名稱"}" /></label>
        <label class="field"><span>Timeout（毫秒）</span><input data-ai-field="timeoutMs" type="number" min="1000" max="300000" value="${Number(provider.timeoutMs) || 180000}" /></label>
        <label class="field"><span>驗證方式</span><select data-ai-field="authMode">${aiAuthOptions(provider.authMode)}</select></label>
        <label class="field ai-secret-source"><span>密鑰來源</span><select data-ai-field="secretSource"><option value="env" ${secret.source !== "inline" ? "selected" : ""}>環境變數</option><option value="inline" ${secret.source === "inline" ? "selected" : ""}>本機設定檔</option></select></label>
        <label class="field ai-env-name"><span>環境變數名稱</span><input data-ai-field="envName" value="${escapeHtml(secret.envName ?? "")}" placeholder="GEMINI_API_KEY" /></label>
        <label class="field ai-inline-secret"><span>本機密鑰</span><input data-ai-field="secretValue" type="password" value="" autocomplete="new-password" placeholder="${provider.credentialConfigured && secret.source === "inline" ? "已儲存；留白維持原值" : "輸入 API Key / Token"}" /></label>
        <label class="field ai-api-key-header"><span>API Key Header</span><input data-ai-field="apiKeyHeader" value="${escapeHtml(gemini ? "x-goog-api-key" : (provider.apiKeyHeader ?? "x-api-key"))}" ${gemini ? "readonly" : ""}/><small>${gemini ? "Gemini 固定使用 x-goog-api-key。" : "API Key 模式使用的 Header 名稱。"}</small></label>
        <label class="field ai-custom-header"><span>自訂 Header 名稱</span><input data-ai-field="customHeaderName" value="${escapeHtml(provider.customHeaderName ?? "")}" /></label>
      </div>
      <div class="ai-provider-footer"><span class="ai-credential-state ${provider.credentialConfigured ? "configured" : ""}">${provider.authMode === "none" ? "不需要憑證" : provider.credentialConfigured ? "憑證來源可用" : "尚未確認憑證"}</span><button class="button secondary small" data-ai-action="test" type="button">測試連線</button><span class="ai-test-result" id="ai-test-${escapeHtml(provider.id)}"></span></div>
    </div>
  </details>`;
}

function aiAuthOptions(selected) { return [["none","無驗證"],["bearer_token","Bearer Token"],["api_key","API Key"],["custom_header","自訂 Header"]].map(([v,l]) => `<option value="${v}" ${v === selected ? "selected" : ""}>${l}</option>`).join(""); }
function updateAIProviderAuthFields(id) { const card = [...document.querySelectorAll("[data-ai-provider]")].find((x) => x.dataset.aiProvider === id); if (!card) return; const auth = card.querySelector('[data-ai-field="authMode"]')?.value ?? "none"; const source = card.querySelector('[data-ai-field="secretSource"]')?.value ?? "env"; card.querySelectorAll(".ai-secret-source").forEach((x) => x.hidden = auth === "none"); card.querySelectorAll(".ai-env-name").forEach((x) => x.hidden = auth === "none" || source !== "env"); card.querySelectorAll(".ai-inline-secret").forEach((x) => x.hidden = auth === "none" || source !== "inline"); card.querySelectorAll(".ai-api-key-header").forEach((x) => x.hidden = auth !== "api_key"); card.querySelectorAll(".ai-custom-header").forEach((x) => x.hidden = auth !== "custom_header"); }
function updateAIProviderSummaryState(card) {
  if (!card) return;
  const enabled = card.querySelector('[data-ai-field="enabled"]')?.checked === true;
  const badge = card.querySelector('.ai-provider-summary .badge');
  if (badge) { badge.textContent = enabled ? "已啟用" : "未啟用"; badge.className = `badge ${enabled ? "completed" : "neutral"}`; }
}
function handleAIProviderListChange(event) { const card = event.target.closest("[data-ai-provider]"); if (card) { updateAIProviderAuthFields(card.dataset.aiProvider); updateAIProviderSummaryState(card); } renderAISettingsBadge(); }
function handleAIProviderListClick(event) { const button = event.target.closest('[data-ai-action="test"]'); if (!button) return; const card = button.closest("[data-ai-provider]"); if (card) void testAIProvider(card.dataset.aiProvider); }

function readAISettingsFromForm() {
  const existing = state.settings?.ai ?? { providers: [] };
  const previous = new Map((existing.providers ?? []).map((p) => [p.id, p]));
  const providers = [...document.querySelectorAll("[data-ai-provider]")].map((card) => {
    const id = card.dataset.aiProvider, prior = previous.get(id) ?? {};
    const read = (field) => card.querySelector(`[data-ai-field="${field}"]`);
    const source = read("secretSource")?.value ?? prior.secret?.source ?? "env";
    const value = read("secretValue")?.value.trim();
    return { id, name: prior.name, kind: prior.kind, enabled: read("enabled")?.checked === true, endpoint: read("endpoint")?.value.trim() ?? "", model: read("model")?.value.trim() || undefined, timeoutMs: Number(read("timeoutMs")?.value) || 180000, authMode: read("authMode")?.value ?? "none", secret: source === "inline" ? { source: "inline", ...(value ? { value } : {}) } : { source: "env", envName: read("envName")?.value.trim() || "" }, apiKeyHeader: prior.kind === "gemini" ? "x-goog-api-key" : (read("apiKeyHeader")?.value.trim() || "x-api-key"), customHeaderName: read("customHeaderName")?.value.trim() || undefined };
  });
  return { enabled: $("#aiEnabled").checked, activeProviderId: $("#activeAIProvider").value || providers[0]?.id, providers };
}

function renderAISettingsBadge() { const aiEnabled = $("#aiEnabled")?.checked === true; const id = $("#activeAIProvider")?.value; const card = [...document.querySelectorAll("[data-ai-provider]")].find((x) => x.dataset.aiProvider === id); const ready = aiEnabled && card?.querySelector('[data-ai-field="enabled"]')?.checked === true; $("#aiSettingsBadge").textContent = ready ? "AI 已啟用" : aiEnabled ? "目前 Provider 未啟用" : "AI 未啟用"; $("#aiSettingsBadge").className = `badge ${ready ? "completed" : "neutral"}`; }

async function saveSettings(options = {}) {
  const settings = { theme: $("#themeSetting").value, retentionDays: Number($("#retentionDays").value) || 30, runHistoryRetentionDays: Number($("#runHistoryRetentionDays").value) || 30, defaultDownloadDir: $("#downloadDirectory").value.trim() || "./downloads", debugRetention: $("#debugRetention").value, issueReportEmail: $("#issueReportEmail").value.trim(), ai: readAISettingsFromForm() };
  try { const response = await api("/api/studio/settings", { method: "PUT", body: JSON.stringify(settings) }); state.settings = response.settings; applyTheme(response.settings.theme ?? "system"); renderAISettings(); if (!options.quiet) toast("系統設定已儲存"); return true; } catch (error) { toast(error.message, true); return false; }
}

async function testActiveAIProvider() { const id = $("#activeAIProvider").value; if (!id) return toast("沒有可測試的 AI Provider。", true); await testAIProvider(id); }
async function testAIProvider(id) { if (!(await saveSettings({ quiet: true }))) return; const target = $(`#ai-test-${id}`); if (target) target.textContent = "測試中…"; try { const response = await api("/api/studio/ai/providers/test", { method: "POST", body: JSON.stringify({ providerId: id }) }); if (target) { target.textContent = `成功 · ${response.result.latencyMs} ms · ${response.result.model ?? ""}`; target.className = "ai-test-result success"; } toast("AI Provider 連線測試成功"); } catch (error) { if (target) { target.textContent = error.message; target.className = "ai-test-result failed"; } toast(error.message, true); } }

async function diagnoseActiveAIProvider() {
  const id = $("#activeAIProvider").value; if (!id) return toast("沒有可診斷的 AI Provider。", true);
  if (!(await saveSettings({ quiet: true }))) return;
  const box = $("#aiNetworkDiagnostic"); box.textContent = "診斷中…";
  try { const { result } = await api("/api/studio/ai/providers/diagnose", { method: "POST", body: JSON.stringify({ providerId: id }) }); const lines = [`Endpoint: ${result.endpoint}`, `Node: ${result.nodeVersion}`, `HTTP/TLS: ${result.ok ? `已取得 HTTP 回應 (${result.httpStatus})` : "失敗"}`, `耗時: ${result.latencyMs} ms`, `NODE_USE_SYSTEM_CA: ${result.tls.systemCARequested ? "1" : "未啟用"}`, `NODE_EXTRA_CA_CERTS: ${result.tls.extraCAConfigured ? result.tls.extraCAPath : "未設定"}`, `TLS 驗證: ${result.tls.verificationDisabled ? "已關閉（僅供診斷，不建議）" : "正常啟用"}`]; if (result.error) lines.push(`錯誤代碼: ${result.error.code ?? "—"}`, `錯誤: ${result.error.message}`); if (result.guidance?.length) lines.push("", "建議：", ...result.guidance.map((x) => `- ${x}`)); box.textContent = lines.join("\n"); box.className = `ai-network-result ${result.ok ? "success" : "failed"}`; } catch (error) { box.textContent = error.message; box.className = "ai-network-result failed"; }
}

const AI_WORKFLOW_SESSION_KEY = "automation-studio-ai-workflow-session-v1.0.12";
const AI_WORKFLOW_SESSION_LEGACY_KEY = "automation-studio-ai-workflow-session-v1.0.9";

function renderAIWorkflowAssistant() {
  if (!$("#aiWorkflowProviderBadge")) return;
  const ai = state.settings?.ai ?? { enabled:false, providers:[] };
  const active = (ai.providers ?? []).find((p) => p.id === ai.activeProviderId);
  const ready = ai.enabled === true && active?.enabled === true;
  $("#aiWorkflowProviderBadge").textContent = ready ? `使用 ${active.name}` : "AI 未就緒";
  $("#aiWorkflowProviderBadge").className = `badge ${ready ? "completed" : "neutral"}`;
  $("#aiWorkflowProviderNote").textContent = ready ? `目前 Provider：${active.name}${active.model ? ` · ${active.model}` : ""}` : "請先到系統設定啟用 AI Provider。";
  $("#generateAIWorkflowButton").disabled = !ready || state.aiWorkflowGenerating || state.aiWorkflowExploring || state.aiWorkflowRevisionRunning;
  $("#startAIWorkflowInspectionButton").disabled = state.aiWorkflowExploring || state.aiWorkflowGenerating || state.aiWorkflowRevisionRunning;
  const revise = $("#sendAIWorkflowRevisionButton"), undo = $("#undoAIWorkflowRevisionButton"), version = $("#aiWorkflowVersionBadge");
  if (revise) {
    revise.disabled = !ready || !state.aiWorkflowDraft || state.aiWorkflowGenerating || state.aiWorkflowExploring || state.aiWorkflowRevisionRunning;
    revise.textContent = state.aiWorkflowDeferredRevision ? "💬 繼續修改" : (state.aiWorkflowRevisionRunning ? "AI 正在修改…" : "💬 送出修改");
  }
  if (undo) undo.disabled = !state.aiWorkflowHistory.length || Boolean(state.aiWorkflowPendingRevision) || state.aiWorkflowGenerating || state.aiWorkflowRevisionRunning;
  if (version) {
    version.textContent = state.aiWorkflowDraft ? `草稿 V${state.aiWorkflowHistory.length + 1}` : "尚無版本";
    version.className = `badge ${state.aiWorkflowDraft ? "completed" : "neutral"}`;
  }
  renderAIWorkflowExploration();
  renderAIWorkflowMonitor();
  renderAIWorkflowErrors();
  renderAIWorkflowConversation();
  renderAIWorkflowPreview();
}


const AI_WORKFLOW_MONITOR_STAGES = [
  ["prepare","準備 AI 工作"],
  ["browser","啟動／接管瀏覽器"],
  ["scan","掃描目前頁面"],
  ["planning","等待 AI 決定下一步"],
  ["selector","驗證 selector"],
  ["action","執行網站操作／等待頁面反應"],
  ["evidence","收集網站證據"],
  ["workflowAI","等待 AI 產生 Workflow"],
  ["validation","驗證 Workflow"],
  ["candidate","建立候選流程"]
];

function activeAIProviderSummary() {
  const ai = state.settings?.ai ?? {};
  const provider = (ai.providers ?? []).find((item) => item.id === ai.activeProviderId);
  return provider ? { id:provider.id, name:provider.name, kind:provider.kind, model:provider.model, timeoutMs:provider.timeoutMs } : null;
}

function beginAIWorkflowOperation(kind, label, instruction = "") {
  if (state.aiWorkflowOperationController) { try { state.aiWorkflowOperationController.abort(); } catch {} }
  state.aiWorkflowOperationController = new AbortController();
  state.aiWorkflowStopRequested = false;
  state.aiWorkflowMonitorCompletedStages = [];
  const now = new Date().toISOString();
  state.aiWorkflowMonitor = {
    kind, label, instruction, stageKey:"prepare", stageLabel:"準備 AI 工作", status:"running",
    startedAt:now, phaseStartedAt:now, updatedAt:now, currentAction:label, waitingFor:"建立執行內容",
    currentUrl:state.aiWorkflowExploration?.currentUrl || $("#aiWorkflowTargetUrl")?.value?.trim() || "",
    provider:activeAIProviderSummary(), lastSuccess:"", lastSuccessAt:"", warning:""
  };
  state.aiWorkflowLastOperation = { kind, instruction, targetUrl:$("#aiWorkflowTargetUrl")?.value?.trim() || state.aiWorkflowDraft?.targetUrl || "", startedAt:now };
  appendAIWorkflowMonitorEvent("開始", label);
  ensureAIWorkflowMonitorTimer();
  renderAIWorkflowMonitor();
  persistAIWorkflowSession();
  return state.aiWorkflowOperationController.signal;
}

function setAIWorkflowMonitorStage(stageKey, stageLabel, options = {}) {
  const now = new Date().toISOString();
  const previous = state.aiWorkflowMonitor;
  if (!previous) {
    state.aiWorkflowMonitor = { kind:"unknown", label:stageLabel, instruction:"", stageKey, stageLabel, status:options.status || "running", startedAt:now, phaseStartedAt:now, updatedAt:now };
  } else {
    if (previous.stageKey !== stageKey && previous.stageKey && !["failed","stopped"].includes(previous.status)) {
      if (!state.aiWorkflowMonitorCompletedStages.includes(previous.stageKey)) state.aiWorkflowMonitorCompletedStages.push(previous.stageKey);
    }
    state.aiWorkflowMonitor = {
      ...previous,
      stageKey,
      stageLabel:stageLabel || previous.stageLabel,
      status:options.status || previous.status || "running",
      phaseStartedAt:previous.stageKey !== stageKey ? now : previous.phaseStartedAt,
      updatedAt:now,
      ...(options.detail !== undefined ? { detail:options.detail } : {}),
      ...(options.currentAction !== undefined ? { currentAction:options.currentAction } : {}),
      ...(options.waitingFor !== undefined ? { waitingFor:options.waitingFor } : {}),
      ...(options.currentUrl !== undefined ? { currentUrl:options.currentUrl } : {}),
      ...(options.currentElementRef !== undefined ? { currentElementRef:options.currentElementRef } : {}),
      ...(options.currentSelector !== undefined ? { currentSelector:options.currentSelector } : {}),
      ...(options.lastSuccess !== undefined ? { lastSuccess:options.lastSuccess, lastSuccessAt:options.lastSuccessAt || now } : {}),
      ...(options.warning !== undefined ? { warning:options.warning } : {})
    };
  }
  if (options.event !== false) appendAIWorkflowMonitorEvent(stageLabel || stageKey, options.detail || options.currentAction || options.waitingFor || "");
  renderAIWorkflowMonitor();
}

function completeAIWorkflowMonitor(message = "AI 流程處理完成") {
  if (!state.aiWorkflowMonitor) return;
  const previousStage = state.aiWorkflowMonitor.stageKey;
  if (previousStage && !state.aiWorkflowMonitorCompletedStages.includes(previousStage)) state.aiWorkflowMonitorCompletedStages.push(previousStage);
  state.aiWorkflowMonitor = { ...state.aiWorkflowMonitor, status:"completed", stageKey:"candidate", stageLabel:"建立候選流程", currentAction:message, waitingFor:"", lastSuccess:message, lastSuccessAt:new Date().toISOString(), updatedAt:new Date().toISOString(), warning:"" };
  if (!state.aiWorkflowMonitorCompletedStages.includes("candidate")) state.aiWorkflowMonitorCompletedStages.push("candidate");
  appendAIWorkflowMonitorEvent("完成", message);
  persistAIWorkflowSession();
  renderAIWorkflowMonitor();
}

function failAIWorkflowMonitor(error, stageLabel) {
  if (!state.aiWorkflowMonitor) beginAIWorkflowOperation("unknown", stageLabel || "AI 流程失敗");
  const message = String(error?.message ?? error ?? "未知錯誤");
  state.aiWorkflowMonitor = { ...state.aiWorkflowMonitor, status:"failed", stageLabel:stageLabel || state.aiWorkflowMonitor.stageLabel, detail:message, waitingFor:"", warning:message, updatedAt:new Date().toISOString() };
  appendAIWorkflowMonitorEvent("失敗", message);
  persistAIWorkflowSession();
  renderAIWorkflowMonitor();
}

function appendAIWorkflowMonitorEvent(stage, message, meta = {}) {
  const entry = { at:new Date().toISOString(), stage:String(stage || ""), message:String(message || ""), ...meta };
  state.aiWorkflowMonitorEvents = [...(state.aiWorkflowMonitorEvents ?? []), entry].slice(-50);
}

function ensureAIWorkflowMonitorTimer() {
  if (state.aiWorkflowMonitorTimer) return;
  state.aiWorkflowMonitorTimer = setInterval(() => {
    renderAIWorkflowMonitor();
    void pollAIWorkflowExplorationMonitor();
  }, 1000);
}

function stopAIWorkflowMonitorTimerIfIdle() {
  const active = state.aiWorkflowGenerating || state.aiWorkflowExploring || state.aiWorkflowRevisionRunning;
  if (!active && state.aiWorkflowMonitor?.status !== "running" && state.aiWorkflowMonitor?.status !== "waiting" && state.aiWorkflowMonitorTimer) {
    clearInterval(state.aiWorkflowMonitorTimer);
    state.aiWorkflowMonitorTimer = null;
  }
}

async function pollAIWorkflowExplorationMonitor() {
  const monitor = state.aiWorkflowMonitor;
  const sessionId = state.aiWorkflowExploration?.sessionId;
  if (!monitor || !sessionId || state.aiWorkflowMonitorPolling) return;
  if (!["browser","scan","planning","action","selector","evidence"].includes(monitor.stageKey)) return;
  state.aiWorkflowMonitorPolling = true;
  try {
    const response = await api(`/api/studio/ai/workflows/exploration/status?sessionId=${encodeURIComponent(sessionId)}`);
    if (response?.exploration) {
      state.aiWorkflowExploration = response.exploration;
      mergeBackendAIWorkflowMonitor(response.exploration.monitor);
      renderAIWorkflowExploration();
    }
  } catch (error) {
    if (!/找不到 AI 網站檢視工作階段|瀏覽器已關閉/.test(String(error?.message ?? ""))) appendAIWorkflowMonitorEvent("監控", `讀取網站探索狀態失敗：${error.message}`);
  } finally { state.aiWorkflowMonitorPolling = false; }
}

function mergeBackendAIWorkflowMonitor(remote) {
  if (!remote || !state.aiWorkflowMonitor) return;
  const map = { page_scan:"scan", ai_planning:"planning", selector_probe:"selector", browser_action:"action", page_wait:"action", manual:"action", complete:"evidence", failed:state.aiWorkflowMonitor.stageKey };
  const stageKey = map[remote.phase] || state.aiWorkflowMonitor.stageKey;
  const stageLabel = remote.label || state.aiWorkflowMonitor.stageLabel;
  const lastRemoteUpdate = state.aiWorkflowMonitor.backendUpdatedAt;
  const changed = lastRemoteUpdate !== remote.updatedAt || state.aiWorkflowMonitor.stageKey !== stageKey;
  setAIWorkflowMonitorStage(stageKey, stageLabel, {
    status:remote.status === "waiting" ? "waiting" : remote.status === "failed" ? "failed" : remote.status === "manual" ? "manual" : "running",
    detail:remote.detail,
    currentAction:remote.currentAction,
    waitingFor:remote.waitingFor,
    currentUrl:remote.currentUrl,
    currentElementRef:remote.currentElementRef,
    currentSelector:remote.currentSelector,
    lastSuccess:remote.lastSuccess,
    lastSuccessAt:remote.lastSuccessAt,
    warning:remote.warning,
    event:false
  });
  state.aiWorkflowMonitor.backendUpdatedAt = remote.updatedAt;
  state.aiWorkflowMonitor.backendPhaseStartedAt = remote.phaseStartedAt;
  state.aiWorkflowMonitor.repeatCount = remote.repeatCount;
  if (changed) appendAIWorkflowMonitorEvent(stageLabel, remote.detail || remote.waitingFor || remote.currentAction || "");
}

function renderAIWorkflowMonitor() {
  const panel = $("#aiWorkflowMonitorPanel"), badge = $("#aiWorkflowMonitorBadge"), current = $("#aiWorkflowMonitorCurrent"), warning = $("#aiWorkflowMonitorWarning"), stages = $("#aiWorkflowMonitorStages"), events = $("#aiWorkflowMonitorEvents");
  if (!panel || !badge || !current || !warning || !stages || !events) return;
  const m = state.aiWorkflowMonitor;
  const now = Date.now();
  const elapsed = m?.startedAt ? Math.max(0, now - new Date(m.startedAt).getTime()) : 0;
  const phaseStart = m?.backendPhaseStartedAt || m?.phaseStartedAt;
  const phaseElapsed = phaseStart ? Math.max(0, now - new Date(phaseStart).getTime()) : 0;
  const statusLabel = !m ? "待命" : m.status === "completed" ? "完成" : m.status === "failed" ? "失敗" : m.status === "stopped" ? "已停止" : m.status === "manual" ? "等待人工" : m.status === "waiting" ? "等待中" : "執行中";
  badge.textContent = statusLabel;
  badge.className = `badge ${m?.status === "completed" ? "completed" : m?.status === "failed" ? "failed" : m?.status === "waiting" ? "warning" : "neutral"}`;
  current.innerHTML = `<div><span>目前階段</span><b>${escapeHtml(m?.stageLabel || "尚未執行")}</b></div><div><span>已執行</span><b>${formatMonitorDuration(elapsed)}</b></div><div class="wide"><span>目前動作</span><b>${escapeHtml(m?.currentAction || m?.detail || "—")}</b></div><div class="wide"><span>正在等待</span><b>${escapeHtml(m?.waitingFor || "—")}${m && ["running","waiting"].includes(m.status) ? ` · ${formatMonitorDuration(phaseElapsed)}` : ""}</b></div>${m?.currentUrl ? `<div class="wide"><span>目前頁面</span><b>${escapeHtml(m.currentUrl)}</b></div>` : ""}${m?.currentSelector ? `<div class="wide"><span>目前 selector</span><b>${escapeHtml(m.currentSelector)}</b></div>` : ""}${m?.lastSuccess ? `<div class="wide"><span>最後成功</span><b>${escapeHtml(m.lastSuccess)}</b></div>` : ""}`;
  const derivedWarning = deriveAIWorkflowMonitorWarning(m, phaseElapsed, now);
  const warningText = m?.warning || derivedWarning;
  warning.hidden = !warningText;
  warning.textContent = warningText || "";
  const completed = new Set(state.aiWorkflowMonitorCompletedStages ?? []);
  const currentIndex = AI_WORKFLOW_MONITOR_STAGES.findIndex(([key]) => key === m?.stageKey);
  stages.innerHTML = AI_WORKFLOW_MONITOR_STAGES.map(([key,label], index) => {
    const done = completed.has(key) || (m?.status === "completed" && m?.stageKey === key) || (currentIndex >= 0 && index < currentIndex);
    const isCurrent = m?.stageKey === key && !["completed"].includes(m?.status);
    const failed = isCurrent && m?.status === "failed";
    const cls = failed ? "failed" : isCurrent ? "current" : done ? "done" : "";
    const dot = failed ? "!" : done ? "✓" : isCurrent ? "●" : "○";
    return `<div class="ai-monitor-stage ${cls}"><span class="dot">${dot}</span><span>${escapeHtml(label)}</span><time>${isCurrent && m ? formatMonitorDuration(phaseElapsed) : ""}</time></div>`;
  }).join("");
  const recent = (state.aiWorkflowMonitorEvents ?? []).slice(-20).reverse();
  events.innerHTML = recent.length ? recent.map((item) => `<div class="ai-monitor-event"><time>${escapeHtml(formatMonitorClock(item.at))}</time><span>${escapeHtml(item.stage)}</span><b>${escapeHtml(item.message || "—")}</b></div>`).join("") : "尚無執行事件。";
  const busy = state.aiWorkflowGenerating || state.aiWorkflowExploring || state.aiWorkflowRevisionRunning;
  const retry = $("#retryAIWorkflowMonitorButton"), stop = $("#stopAIWorkflowMonitorButton");
  if (retry) retry.disabled = busy || !state.aiWorkflowLastOperation || !m || !["failed","stopped"].includes(m.status);
  if (stop) stop.disabled = !busy;
  if (!busy) stopAIWorkflowMonitorTimerIfIdle();
}

function deriveAIWorkflowMonitorWarning(m, phaseElapsed, now) {
  if (!m || !["running","waiting"].includes(m.status)) return "";
  if (m.repeatCount >= 3) return "相同網站操作已連續出現 3 次以上，可能進入重複探索。";
  if (m.stageKey === "planning" && phaseElapsed >= 30000) return `AI Provider 已等待 ${Math.floor(phaseElapsed/1000)} 秒，回覆時間較長；若超過 Provider Timeout 將停止本次請求。`;
  if (m.stageKey === "selector" && phaseElapsed >= 10000) return `selector 驗證已等待 ${Math.floor(phaseElapsed/1000)} 秒，元素可能已改變、位於其他 iframe 或目前不可操作。`;
  if (m.stageKey === "action" && phaseElapsed >= 15000) return `網站操作／頁面反應已等待 ${Math.floor(phaseElapsed/1000)} 秒，頁面可能沒有產生預期變化。`;
  if (m.stageKey === "workflowAI" && phaseElapsed >= 30000) return `Workflow AI 已等待 ${Math.floor(phaseElapsed/1000)} 秒，目前仍在等 Provider 回覆。`;
  const updated = m.backendUpdatedAt || m.updatedAt;
  if (updated && now - new Date(updated).getTime() >= 30000) return "執行狀態超過 30 秒沒有更新，可能停滯；可複製診斷資訊或停止後重試。";
  return "";
}

function formatMonitorDuration(ms) {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2,"0")}:${String(seconds).padStart(2,"0")}`;
}
function formatMonitorClock(value) { try { return new Date(value).toLocaleTimeString("zh-TW", { hour12:false, hour:"2-digit", minute:"2-digit", second:"2-digit" }); } catch { return "—"; } }

async function stopAIWorkflowMonitoredOperation() {
  if (!(state.aiWorkflowGenerating || state.aiWorkflowExploring || state.aiWorkflowRevisionRunning)) return;
  state.aiWorkflowStopRequested = true;
  if (state.aiWorkflowOperationController) { try { state.aiWorkflowOperationController.abort(); } catch {} }
  const sessionId = state.aiWorkflowExploration?.sessionId;
  const stopBrowserSession = ["browser","scan","planning","selector","action","evidence"].includes(state.aiWorkflowMonitor?.stageKey);
  if (sessionId && stopBrowserSession) {
    try { await api("/api/studio/ai/workflows/exploration/stop", { method:"POST", body:JSON.stringify({ sessionId }) }); } catch {}
    state.aiWorkflowExploration = null;
  }
  state.aiWorkflowGenerating = false;
  state.aiWorkflowExploring = false;
  state.aiWorkflowRevisionRunning = false;
  if (state.aiWorkflowMonitor) state.aiWorkflowMonitor = { ...state.aiWorkflowMonitor, status:"stopped", stageLabel:`${state.aiWorkflowMonitor.stageLabel}（已停止）`, waitingFor:"", warning:"已由使用者停止目前 AI 探索／等待。", updatedAt:new Date().toISOString() };
  appendAIWorkflowMonitorEvent("停止", "使用者停止目前 AI 探索／等待");
  persistAIWorkflowSession();
  renderAIWorkflowAssistant();
  toast("已停止目前 AI 探索／等待。 ");
}

async function retryAIWorkflowMonitorStep() {
  const last = state.aiWorkflowLastOperation;
  if (!last || state.aiWorkflowGenerating || state.aiWorkflowExploring || state.aiWorkflowRevisionRunning) return;
  appendAIWorkflowMonitorEvent("重試", `重新嘗試：${last.kind}`);
  if (last.kind === "revision") {
    state.aiWorkflowDeferredRevision = last.instruction || state.aiWorkflowDeferredRevision;
    if ($("#aiWorkflowRevisionInstruction") && last.instruction) $("#aiWorkflowRevisionInstruction").value = last.instruction;
    await sendAIWorkflowRevision();
    return;
  }
  if (last.kind === "inspection") { await startAIWorkflowInspection(); return; }
  if (last.kind === "generation") {
    const canReuseEvidence = Boolean(state.aiWorkflowExploration?.readyForDraft && ["workflowAI","validation","candidate"].includes(state.aiWorkflowMonitor?.stageKey));
    await generateAIWorkflowDraft({ skipExploration:canReuseEvidence, retry:true });
  }
}

async function copyAIWorkflowDiagnostic() {
  const m = state.aiWorkflowMonitor;
  const e = state.aiWorkflowExploration;
  const provider = activeAIProviderSummary();
  const lines = [
    `Automation Studio: 2.1.0`,
    `時間: ${new Date().toISOString()}`,
    `目前階段: ${m?.stageLabel || "—"}`,
    `狀態: ${m?.status || "idle"}`,
    `已執行: ${m?.startedAt ? formatMonitorDuration(Date.now()-new Date(m.startedAt).getTime()) : "00:00"}`,
    `Provider: ${provider ? `${provider.name} / ${provider.model || provider.kind || ""}` : "—"}`,
    `Provider Timeout: ${provider?.timeoutMs ?? "—"} ms`,
    `目前 URL: ${m?.currentUrl || e?.currentUrl || "—"}`,
    `目前動作: ${m?.currentAction || "—"}`,
    `正在等待: ${m?.waitingFor || "—"}`,
    `元素: ${m?.currentElementRef || "—"}`,
    `Selector: ${m?.currentSelector || "—"}`,
    `最後成功: ${m?.lastSuccess || "—"}`,
    `警告: ${m?.warning || deriveAIWorkflowMonitorWarning(m, m?.phaseStartedAt ? Date.now()-new Date(m.phaseStartedAt).getTime() : 0, Date.now()) || "—"}`,
    `探索頁面數: ${e?.pages?.length ?? 0}`,
    `探索操作數: ${e?.trace?.length ?? 0}`,
    "",
    "最近執行事件:",
    ...(state.aiWorkflowMonitorEvents ?? []).slice(-20).map((item) => `- ${item.at} [${item.stage}] ${item.message}`),
    "",
    "最近錯誤:",
    ...(state.aiWorkflowErrors ?? []).slice(0,10).map((item) => `- ${item.at} [${aiWorkflowErrorStageLabel(item.stage)}] ${item.message}`)
  ];
  await navigator.clipboard.writeText(lines.join("\n"));
  toast("AI 診斷資訊已複製");
}

function isAbortLikeError(error) {
  return error?.name === "AbortError" || /aborted|aborterror/i.test(String(error?.message ?? ""));
}

function aiWorkflowRequestSignal() { return state.aiWorkflowOperationController?.signal; }


function aiWorkflowErrorStageLabel(stage) {
  return ({
    inspectionStart:"開啟網站檢視",
    inspectionFocus:"顯示檢視瀏覽器",
    inspectionStop:"關閉網站檢視",
    generation:"探索／產生流程",
    revision:"對話式修改",
    applyRevision:"套用候選修改",
    createProject:"建立 AI 專案",
    applyProject:"套用 AI 草稿"
  })[stage] ?? stage ?? "AI 流程助理";
}

function formatAIWorkflowErrorTime(value) {
  try {
    return new Intl.DateTimeFormat("zh-TW", { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false }).format(new Date(value));
  } catch { return String(value ?? ""); }
}

function recordAIWorkflowError(stage, error, options = {}) {
  const message = String(error?.message ?? error ?? "未知錯誤").trim() || "未知錯誤";
  const entry = {
    id:`ai-error-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`,
    at:new Date().toISOString(),
    stage:String(stage || "AI 流程助理"),
    message
  };
  state.aiWorkflowErrors = [entry, ...(state.aiWorkflowErrors ?? [])].slice(0,20);
  persistAIWorkflowSession();
  renderAIWorkflowErrors();
  if (options.toast !== false) toast(message, true);
  return entry;
}

function renderAIWorkflowErrors() {
  const panel = $("#aiWorkflowErrorPanel");
  if (!panel) return;
  const errors = state.aiWorkflowErrors ?? [];
  panel.hidden = errors.length === 0;
  if (!errors.length) { panel.innerHTML = ""; return; }
  panel.innerHTML = `<div class="ai-error-heading"><div><b>AI 錯誤紀錄</b><span>錯誤會保留，直到你手動清除；重新整理頁面後仍可查看。</span></div><button class="button ghost compact" type="button" data-ai-error-clear-all>全部清除</button></div><div class="ai-error-list">${errors.map((item) => `<article class="ai-error-item"><div class="ai-error-meta"><strong>${escapeHtml(aiWorkflowErrorStageLabel(item.stage))}</strong><time>${escapeHtml(formatAIWorkflowErrorTime(item.at))}</time></div><p>${escapeHtml(item.message)}</p><button class="button ghost compact" type="button" data-ai-error-dismiss="${escapeHtml(item.id)}">關閉</button></article>`).join("")}</div>`;
}

function handleAIWorkflowErrorPanelClick(event) {
  const dismiss = event.target.closest("[data-ai-error-dismiss]");
  if (dismiss) {
    state.aiWorkflowErrors = (state.aiWorkflowErrors ?? []).filter((item) => item.id !== dismiss.dataset.aiErrorDismiss);
    persistAIWorkflowSession();
    renderAIWorkflowErrors();
    return;
  }
  if (event.target.closest("[data-ai-error-clear-all]")) {
    state.aiWorkflowErrors = [];
    persistAIWorkflowSession();
    renderAIWorkflowErrors();
  }
}

function renderAIWorkflowConversation() {
  const box = $("#aiWorkflowConversation");
  if (!box) return;
  const turns = state.aiWorkflowConversation ?? [];
  if (!turns.length) {
    box.className = "ai-chat-log empty-state compact";
    box.textContent = state.aiWorkflowDraft ? "草稿已建立，可以在下方輸入修改需求。" : "先產生一份流程草稿後即可開始對話修改。";
    return;
  }
  box.className = "ai-chat-log";
  box.innerHTML = turns.slice(-20).map((turn) => `<div class="ai-chat-message ${turn.role === "user" ? "user" : "assistant"}"><span>${turn.role === "user" ? "你" : "AI"}</span><p>${escapeHtml(turn.content)}</p></div>`).join("");
  box.scrollTop = box.scrollHeight;
}

function renderAIWorkflowExploration() {
  const box = $("#aiWorkflowExplorationStatus"), focus = $("#focusAIWorkflowInspectionButton"), stop = $("#stopAIWorkflowInspectionButton");
  if (!box || !focus || !stop) return;
  const e = state.aiWorkflowExploration;
  focus.hidden = !e?.sessionId; stop.hidden = !e?.sessionId;
  if (!e) { box.className = "ai-exploration-status"; box.innerHTML = `<b>網站檢視：尚未開始</b><span>先開啟目標網站；可先人工登入，再讓 AI 繼續探索。</span>`; return; }
  const pageCount = e.pages?.length ?? 0, traceCount = e.trace?.length ?? 0;
  if (e.requiresManual) { box.className = "ai-exploration-status manual"; box.innerHTML = `<b>網站檢視：等待人工操作</b><span>${escapeHtml(e.manualReason || "請在已開啟的瀏覽器完成目前步驟，再繼續。") }<br>目前頁面：${escapeHtml(e.currentUrl || "—")} · 已觀察 ${pageCount} 個頁面狀態／${traceCount} 個操作。</span>`; return; }
  if (e.readyForDraft) { box.className = "ai-exploration-status ready"; box.innerHTML = `<b>網站檢視：探索完成</b><span>目前頁面：${escapeHtml(e.currentUrl || "—")} · 已觀察 ${pageCount} 個頁面狀態／${traceCount} 個實際操作，可依已驗證 selector 產生或修改流程。</span>`; return; }
  box.className = "ai-exploration-status"; box.innerHTML = `<b>網站檢視：已開啟</b><span>${escapeHtml(e.browserSource || "瀏覽器已啟動")} · 目前頁面：${escapeHtml(e.currentUrl || "—")}。可先人工登入或移動到起始頁，再執行 AI 探索。</span>`;
}

async function startAIWorkflowInspection() {
  const targetUrl = $("#aiWorkflowTargetUrl").value.trim();
  if (!targetUrl || !isValidUrl(targetUrl)) return toast("請先輸入有效的 HTTP(S) 目標網址。", true);
  if (state.aiWorkflowExploration?.sessionId) await stopAIWorkflowInspection(true);
  const signal = beginAIWorkflowOperation("inspection", "開啟網站檢視", targetUrl);
  setAIWorkflowMonitorStage("browser", "啟動／接管瀏覽器", { detail:"正在建立可見瀏覽器並開啟目標網址", waitingFor:"瀏覽器啟動" });
  state.aiWorkflowExploring = true; renderAIWorkflowAssistant();
  try {
    const response = await api("/api/studio/ai/workflows/exploration/start", { method:"POST", body:JSON.stringify({ targetUrl, browserProjectId: state.project?.id }), signal });
    state.aiWorkflowExploration = response.exploration;
    setAIWorkflowMonitorStage("scan", "網站檢視已就緒", { status:"completed", detail:"瀏覽器已開啟，可先人工登入或直接執行 AI 探索", waitingFor:"", currentUrl:response.exploration?.currentUrl, lastSuccess:"網站檢視瀏覽器已就緒" });
    if (state.aiWorkflowMonitor) state.aiWorkflowMonitor.status = "completed";
    appendAIWorkflowMonitorEvent("完成", "網站檢視瀏覽器已就緒");
    toast("已開啟真實網站檢視瀏覽器；需要登入時可先人工完成。 ");
  } catch (error) {
    if (state.aiWorkflowStopRequested || isAbortLikeError(error)) {
      if (state.aiWorkflowMonitor) state.aiWorkflowMonitor.status = "stopped";
    } else { failAIWorkflowMonitor(error, "啟動網站檢視失敗"); recordAIWorkflowError("inspectionStart", error); }
  } finally {
    state.aiWorkflowExploring = false;
    state.aiWorkflowOperationController = null;
    renderAIWorkflowAssistant();
  }
}
async function focusAIWorkflowInspection() {
  const sessionId = state.aiWorkflowExploration?.sessionId; if (!sessionId) return;
  try { const response = await api("/api/studio/ai/workflows/exploration/focus", { method:"POST", body:JSON.stringify({ sessionId }) }); state.aiWorkflowExploration = response.exploration; renderAIWorkflowExploration(); } catch (error) { recordAIWorkflowError("inspectionFocus", error); }
}

async function stopAIWorkflowInspection(silent = false) {
  const sessionId = state.aiWorkflowExploration?.sessionId;
  if (sessionId) { try { await api("/api/studio/ai/workflows/exploration/stop", { method:"POST", body:JSON.stringify({ sessionId }) }); } catch (error) { if (!silent) recordAIWorkflowError("inspectionStop", error); } }
  state.aiWorkflowExploration = null; renderAIWorkflowAssistant(); if (!silent) toast("已關閉 AI 網站檢視瀏覽器");
}

async function generateAIWorkflowDraft(options = {}) {
  const instruction = $("#aiWorkflowInstruction").value.trim(), targetUrl = $("#aiWorkflowTargetUrl").value.trim();
  if (!instruction) return toast("請先輸入自動化需求。", true);
  if (!targetUrl || !isValidUrl(targetUrl)) return toast("目標網址必須是有效 HTTP(S) URL。", true);
  const includeCurrentProject = $("#aiWorkflowIncludeCurrent").checked === true;
  const signal = beginAIWorkflowOperation("generation", options.retry ? "重新嘗試 AI 流程產生" : "AI 探索並產生流程", instruction);
  state.aiWorkflowGenerating = true; state.aiWorkflowPendingRevision = null; state.aiWorkflowDeferredRevision = "";
  $("#generateAIWorkflowButton").disabled = true; $("#generateAIWorkflowButton").textContent = "AI 正在實際探索網站…"; $("#aiWorkflowPreview").textContent = "AI 正在讀取真實頁面、操作低風險控制項並取得可重播 selector…";
  try {
    const skipExploration = options.skipExploration === true && state.aiWorkflowExploration?.readyForDraft;
    if (!skipExploration) {
      if (!state.aiWorkflowExploration?.sessionId || normalizeHttpUrlForCompare(state.aiWorkflowExploration.targetUrl) !== normalizeHttpUrlForCompare(targetUrl)) {
        setAIWorkflowMonitorStage("browser", "啟動／接管瀏覽器", { detail:"正在開啟目標網站並建立探索工作階段", waitingFor:"瀏覽器啟動" });
        if (state.aiWorkflowExploration?.sessionId) await stopAIWorkflowInspection(true);
        const started = await api("/api/studio/ai/workflows/exploration/start", { method:"POST", body:JSON.stringify({ targetUrl, browserProjectId: state.project?.id }), signal });
        state.aiWorkflowExploration = started.exploration;
      }
      setAIWorkflowMonitorStage("scan", "掃描目前頁面", { detail:"正在讀取網站元素，後端狀態會即時更新", waitingFor:"網站探索", currentUrl:state.aiWorkflowExploration?.currentUrl });
      const explored = await api("/api/studio/ai/workflows/exploration/explore", { method:"POST", body:JSON.stringify({ sessionId: state.aiWorkflowExploration.sessionId, instruction, includeCurrentProject, projectId: state.project?.id }), signal });
      state.aiWorkflowExploration = explored.exploration;
      mergeBackendAIWorkflowMonitor(explored.exploration?.monitor);
      renderAIWorkflowExploration();
      if (explored.exploration.requiresManual) {
        state.aiWorkflowDraft = null; state.aiWorkflowValidation = null;
        $("#aiWorkflowPreview").className = "empty-state ai-workflow-empty";
        $("#aiWorkflowPreview").textContent = `網站探索已暫停：${explored.exploration.manualReason || "請先在瀏覽器完成人工操作。"} 完成後再按「AI 探索並產生流程」。`;
        if (state.aiWorkflowMonitor) state.aiWorkflowMonitor.status = "manual";
        appendAIWorkflowMonitorEvent("等待人工", explored.exploration.manualReason || "請先完成人工操作");
        toast("AI 已暫停探索，請在瀏覽器完成人工操作後再繼續。 ");
        return;
      }
      setAIWorkflowMonitorStage("evidence", "收集網站證據", { detail:`已觀察 ${explored.exploration.pages?.length ?? 0} 個頁面狀態／${explored.exploration.trace?.length ?? 0} 個操作`, waitingFor:"整理 selector 證據", lastSuccess:"網站探索完成" });
    } else {
      setAIWorkflowMonitorStage("evidence", "沿用既有網站證據", { detail:"本次重試直接使用已完成的網站探索，不重新操作網站", waitingFor:"準備 Workflow 產生", currentUrl:state.aiWorkflowExploration?.currentUrl });
    }
    $("#generateAIWorkflowButton").textContent = "正在依已驗證 selector 產生草稿…";
    const provider = activeAIProviderSummary();
    setAIWorkflowMonitorStage("workflowAI", "等待 AI 產生 Workflow", { status:"waiting", detail:`正在將需求與已驗證網站證據交給 ${provider?.name || "AI Provider"}`, waitingFor:"AI Provider 回覆", currentAction:"產生完整 Workflow JSON" });
    const response = await api("/api/studio/ai/workflows/draft", { method:"POST", body:JSON.stringify({ instruction, targetUrl, includeCurrentProject, projectId:state.project?.id, explorationSessionId:state.aiWorkflowExploration?.sessionId || "" }), signal });
    setAIWorkflowMonitorStage("validation", "驗證 Workflow", { detail:"檢查步驟、selector、網域、參數與安全規則", waitingFor:"Workflow 驗證" });
    state.aiWorkflowDraft = response.draft; state.aiWorkflowValidation = response.validation; state.aiWorkflowMeta = response.ai;
    state.aiWorkflowHistory = [];
    state.aiWorkflowConversation = [
      { role:"user", content:instruction },
      { role:"assistant", content:response.validation.valid ? "已依實際網站探索結果產生初版流程。你可以繼續描述要修改的地方。" : "初版草稿已產生，但仍有驗證錯誤，請先處理錯誤或重新探索網站。" }
    ];
    setAIWorkflowMonitorStage("candidate", "建立候選流程", { detail:response.validation.valid ? "流程草稿已通過驗證，可檢查後套用" : "流程草稿已建立，但仍有驗證錯誤", waitingFor:"", lastSuccess:"Workflow 草稿已產生" });
    if (response.validation.valid) completeAIWorkflowMonitor("Workflow 草稿已產生並通過驗證");
    else {
      if (state.aiWorkflowMonitor) state.aiWorkflowMonitor.status = "failed";
      state.aiWorkflowMonitor.warning = (response.validation.errors ?? []).join("；") || "Workflow 驗證未通過";
      appendAIWorkflowMonitorEvent("驗證", state.aiWorkflowMonitor.warning);
    }
    persistAIWorkflowSession();
    toast(response.validation.valid ? "AI 草稿已依實際網站探索結果產生。" : "草稿仍有未驗證 selector 或其他錯誤。", !response.validation.valid);
  } catch (error) {
    if (state.aiWorkflowStopRequested || isAbortLikeError(error)) {
      if (state.aiWorkflowMonitor) state.aiWorkflowMonitor = { ...state.aiWorkflowMonitor, status:"stopped", warning:"本次 AI 探索／產生已停止。", waitingFor:"" };
      appendAIWorkflowMonitorEvent("停止", "AI 流程產生已停止");
    } else {
      state.aiWorkflowDraft = null; state.aiWorkflowValidation = null;
      failAIWorkflowMonitor(error, state.aiWorkflowMonitor?.stageLabel || "探索／產生流程失敗");
      recordAIWorkflowError("generation", error);
    }
  } finally {
    state.aiWorkflowGenerating = false;
    state.aiWorkflowOperationController = null;
    $("#generateAIWorkflowButton").textContent = state.aiWorkflowExploration?.requiresManual ? "✨ 繼續探索並產生流程" : "✨ AI 探索並產生流程";
    renderAIWorkflowAssistant();
  }
}
async function sendAIWorkflowRevision() {
  if (!state.aiWorkflowDraft) return toast("請先產生流程草稿。", true);
  const typed = $("#aiWorkflowRevisionInstruction").value.trim();
  const instruction = state.aiWorkflowDeferredRevision || typed;
  if (!instruction) return toast("請輸入要修改流程的內容。", true);
  const ready = state.settings?.ai?.enabled === true;
  if (!ready) return toast("請先啟用 AI Provider。", true);
  const isResume = Boolean(state.aiWorkflowDeferredRevision);
  if (!isResume) state.aiWorkflowConversation.push({ role:"user", content:instruction });
  beginAIWorkflowOperation("revision", isResume ? "繼續對話式修改" : "對話式修改流程", instruction);
  state.aiWorkflowRevisionRunning = true;
  state.aiWorkflowPendingRevision = null;
  renderAIWorkflowAssistant();
  try {
    setAIWorkflowMonitorStage("workflowAI", "等待 AI 分析修改需求", { status:"waiting", detail:"AI 正在比較目前草稿與本輪修改需求", waitingFor:"AI Provider 回覆", currentAction:"判斷是否需要重新探索網站" });
    let response = await requestAIWorkflowRevision(instruction);
    if (response.revision?.requiresExploration) {
      state.aiWorkflowConversation.push({ role:"assistant", content:`這項修改需要重新檢視網站：${response.revision.reason || "需要取得新的實際 selector。"}` });
      renderAIWorkflowConversation();
      setAIWorkflowMonitorStage("scan", "重新探索修改所需網站元素", { detail:response.revision.reason || "需要取得新的實際 selector", waitingFor:"網站探索" });
      const explored = await exploreAIWorkflowForRevision(instruction);
      if (explored.requiresManual) {
        state.aiWorkflowDeferredRevision = instruction;
        state.aiWorkflowConversation.push({ role:"assistant", content:`網站探索已暫停，請先完成人工操作：${explored.manualReason || "完成目前頁面的登入或確認步驟。"} 完成後按「繼續修改」。` });
        if (state.aiWorkflowMonitor) state.aiWorkflowMonitor.status = "manual";
        appendAIWorkflowMonitorEvent("等待人工", explored.manualReason || "完成目前頁面的登入或確認步驟");
        persistAIWorkflowSession();
        toast("請先在網站檢視瀏覽器完成人工操作，再按「繼續修改」。");
        return;
      }
      setAIWorkflowMonitorStage("workflowAI", "重新等待 AI 產生候選修改", { status:"waiting", detail:"已取得新的網站 selector，正在重新產生候選修改", waitingFor:"AI Provider 回覆" });
      response = await requestAIWorkflowRevision(instruction);
      if (response.revision?.requiresExploration) throw new Error(response.revision.reason || "重新探索後仍缺少修改所需的 selector，請在網站檢視中操作到目標頁面後再試。 ");
    }
    setAIWorkflowMonitorStage("validation", "驗證候選修改", { detail:"檢查候選流程差異、selector 與流程規則", waitingFor:"候選流程驗證" });
    state.aiWorkflowDeferredRevision = "";
    state.aiWorkflowPendingRevision = response;
    const summary = response.revision?.changeSummary?.length ? response.revision.changeSummary.join("；") : (response.diff?.summary?.join("；") || "已產生候選修改");
    state.aiWorkflowConversation.push({ role:"assistant", content:`已準備候選修改：${summary}。請先查看右側差異，再決定是否套用。` });
    $("#aiWorkflowRevisionInstruction").value = "";
    setAIWorkflowMonitorStage("candidate", "建立候選修改", { detail:summary, waitingFor:"", lastSuccess:"候選修改已建立" });
    if (response.validation?.valid) completeAIWorkflowMonitor("候選修改已建立並通過驗證");
    else {
      if (state.aiWorkflowMonitor) state.aiWorkflowMonitor.status = "failed";
      state.aiWorkflowMonitor.warning = (response.validation?.errors ?? []).join("；") || "候選修改驗證未通過";
      appendAIWorkflowMonitorEvent("驗證", state.aiWorkflowMonitor.warning);
    }
    persistAIWorkflowSession();
    toast(response.validation?.valid ? "候選修改已產生，請確認差異後套用。" : "候選修改有驗證錯誤，請查看差異與錯誤訊息。", !response.validation?.valid);
  } catch (error) {
    if (state.aiWorkflowStopRequested || isAbortLikeError(error)) {
      if (state.aiWorkflowMonitor) state.aiWorkflowMonitor = { ...state.aiWorkflowMonitor, status:"stopped", waitingFor:"", warning:"本次對話式修改已停止。" };
      appendAIWorkflowMonitorEvent("停止", "對話式修改已停止");
    } else {
      state.aiWorkflowConversation.push({ role:"assistant", content:`本次修改失敗：${error.message}` });
      failAIWorkflowMonitor(error, state.aiWorkflowMonitor?.stageLabel || "對話式修改失敗");
      recordAIWorkflowError("revision", error);
    }
  } finally {
    state.aiWorkflowRevisionRunning = false;
    state.aiWorkflowOperationController = null;
    renderAIWorkflowAssistant();
  }
}
async function requestAIWorkflowRevision(instruction) {
  const conversation = cloneJson(state.aiWorkflowConversation ?? []);
  for (let i = conversation.length - 1; i >= 0; i -= 1) {
    if (conversation[i]?.role === "user" && conversation[i]?.content === instruction) { conversation.splice(i, 1); break; }
  }
  return api("/api/studio/ai/workflows/revise", { method:"POST", signal:aiWorkflowRequestSignal(), body:JSON.stringify({
    instruction,
    targetUrl:state.aiWorkflowDraft?.targetUrl || $("#aiWorkflowTargetUrl").value.trim(),
    currentDraft:state.aiWorkflowDraft,
    conversation,
    includeCurrentProject:$("#aiWorkflowIncludeCurrent").checked === true,
    projectId:state.project?.id,
    explorationSessionId:state.aiWorkflowExploration?.sessionId || ""
  }) });
}

async function exploreAIWorkflowForRevision(instruction) {
  const targetUrl = state.aiWorkflowDraft?.targetUrl || $("#aiWorkflowTargetUrl").value.trim();
  if (!state.aiWorkflowExploration?.sessionId || normalizeHttpUrlForCompare(state.aiWorkflowExploration.targetUrl) !== normalizeHttpUrlForCompare(targetUrl)) {
    setAIWorkflowMonitorStage("browser", "啟動／接管瀏覽器", { detail:"修改需要新的網站元素，正在建立檢視瀏覽器", waitingFor:"瀏覽器啟動" });
    if (state.aiWorkflowExploration?.sessionId) await stopAIWorkflowInspection(true);
    const started = await api("/api/studio/ai/workflows/exploration/start", { method:"POST", signal:aiWorkflowRequestSignal(), body:JSON.stringify({ targetUrl, browserProjectId:state.project?.id }) });
    state.aiWorkflowExploration = started.exploration;
  }
  setAIWorkflowMonitorStage("scan", "掃描修改所需網站元素", { detail:"網站探索執行中；將即時顯示 AI 決策、selector 與瀏覽器動作", waitingFor:"網站探索", currentUrl:state.aiWorkflowExploration?.currentUrl });
  const explored = await api("/api/studio/ai/workflows/exploration/explore", { method:"POST", signal:aiWorkflowRequestSignal(), body:JSON.stringify({ sessionId:state.aiWorkflowExploration.sessionId, instruction:`修改現有流程：${instruction}`, includeCurrentProject:true, projectId:state.project?.id }) });
  state.aiWorkflowExploration = explored.exploration;
  mergeBackendAIWorkflowMonitor(explored.exploration?.monitor);
  renderAIWorkflowExploration();
  return explored.exploration;
}

async function acceptAndApplyAIWorkflowRevision() {
  const pending = state.aiWorkflowPendingRevision;
  if (!pending?.draft) return;
  if (!pending.validation?.valid) return toast("候選修改仍有驗證錯誤，不能套用。", true);
  if (!state.project) return toast("目前沒有已開啟的專案；請改用「僅套用至 AI 草稿」或先建立／開啟專案。", true);
  const changed = pending.diff?.changed !== false;
  if (!changed) return toast("候選修改與目前版本沒有可辨識差異，未執行套用。", true);
  const summary = pending.revision?.changeSummary?.length ? `\n\n${pending.revision.changeSummary.join("\n")}` : "";
  if (!confirm(`確認將這次候選修改直接套用至目前專案「${state.project.name}」？${summary}\n\n系統會先保存上一版，可用「復原上一版」回復；此確認與復原都不會呼叫 AI。`)) return;
  try {
    const d = pending.draft;
    const next = { ...state.project, description:d.description || state.project.description, targetUrl:d.targetUrl, allowedDomains:d.allowedDomains, adapter:d.adapter, parameters:d.parameters, steps:d.steps };
    const response = await api(`/api/studio/projects/${encodeURIComponent(state.project.id)}`, { method:"PUT", body:JSON.stringify(next) });
    state.aiWorkflowHistory.push({ draft:cloneJson(state.aiWorkflowDraft), validation:cloneJson(state.aiWorkflowValidation), project:cloneJson(state.project), appliedToProject:true, savedAt:new Date().toISOString() });
    if (state.aiWorkflowHistory.length > 20) state.aiWorkflowHistory.shift();
    state.aiWorkflowDraft = d;
    state.aiWorkflowValidation = pending.validation;
    state.aiWorkflowMeta = pending.ai;
    state.aiWorkflowPendingRevision = null;
    state.project = response.project;
    const i = state.projects.findIndex((p) => p.id === response.project.id);
    if (i >= 0) state.projects[i] = response.project;
    state.aiWorkflowConversation.push({ role:"assistant", content:"已確認候選修改並直接套用至目前專案，同時保存上一版；可使用「復原上一版」回復，本次確認不會額外呼叫 AI。" });
    persistAIWorkflowSession();
    renderProject();
    renderAIWorkflowAssistant();
    toast("候選修改已套用至目前專案，上一版已保存。 ");
  } catch (error) { recordAIWorkflowError("applyRevision", error); }
}

function acceptAIWorkflowRevision() {
  const pending = state.aiWorkflowPendingRevision;
  if (!pending?.draft) return;
  if (!pending.validation?.valid) return toast("候選修改仍有驗證錯誤，不能套用。", true);
  state.aiWorkflowHistory.push({ draft:cloneJson(state.aiWorkflowDraft), validation:cloneJson(state.aiWorkflowValidation), project:cloneJson(state.project), appliedToProject:false, savedAt:new Date().toISOString() });
  if (state.aiWorkflowHistory.length > 20) state.aiWorkflowHistory.shift();
  state.aiWorkflowDraft = pending.draft;
  state.aiWorkflowValidation = pending.validation;
  state.aiWorkflowMeta = pending.ai;
  state.aiWorkflowPendingRevision = null;
  state.aiWorkflowConversation.push({ role:"assistant", content:"已套用此次修改並建立本機版本快照；可使用「復原上一版」直接回復，不會呼叫 AI。" });
  persistAIWorkflowSession();
  renderAIWorkflowAssistant();
  toast("已套用此次修改並保存上一版。 ");
}

function discardAIWorkflowRevision() {
  if (!state.aiWorkflowPendingRevision) return;
  state.aiWorkflowPendingRevision = null;
  state.aiWorkflowConversation.push({ role:"assistant", content:"已放棄此次候選修改，現有流程未變更。" });
  persistAIWorkflowSession();
  renderAIWorkflowAssistant();
  toast("已放棄此次修改。 ");
}

async function undoAIWorkflowRevision() {
  if (state.aiWorkflowPendingRevision) return toast("請先套用或放棄目前候選修改。", true);
  const previous = state.aiWorkflowHistory[state.aiWorkflowHistory.length - 1];
  if (!previous) return toast("沒有可復原的上一版。", true);
  try {
    if (previous.appliedToProject && previous.project && state.project?.id === previous.project.id) {
      const response = await api(`/api/studio/projects/${encodeURIComponent(previous.project.id)}`, { method:"PUT", body:JSON.stringify(previous.project) });
      state.project = response.project;
      const i = state.projects.findIndex((p) => p.id === response.project.id);
      if (i >= 0) state.projects[i] = response.project;
      renderProject();
    }
    state.aiWorkflowHistory.pop();
    state.aiWorkflowDraft = previous.draft;
    state.aiWorkflowValidation = previous.validation;
    state.aiWorkflowDeferredRevision = "";
    state.aiWorkflowConversation.push({ role:"assistant", content:previous.appliedToProject ? "已由本機程式將 AI 草稿與目前專案一併復原上一版（未呼叫 AI）。" : "已由本機程式復原上一版 AI 草稿（未呼叫 AI）。後續修改將以目前已復原的流程為準。" });
    persistAIWorkflowSession();
    renderAIWorkflowAssistant();
    toast(previous.appliedToProject ? "AI 草稿與目前專案已復原上一版；本次操作未使用 AI。 " : "已復原上一版；本次操作未使用 AI。 ");
  } catch (error) { toast(`復原失敗：${error.message}`, true); }
}

function renderAIWorkflowPreview() {
  const preview = $("#aiWorkflowPreview"), actions = $("#aiWorkflowPreviewActions"), revisionActions = $("#aiWorkflowRevisionActions"), badge = $("#aiWorkflowValidationBadge"), actionHint = $("#aiWorkflowActionHint");
  if (!preview || !actions || !revisionActions || !badge || state.aiWorkflowGenerating) return;
  const pending = state.aiWorkflowPendingRevision;
  const d = pending?.draft ?? state.aiWorkflowDraft;
  const v = pending?.validation ?? state.aiWorkflowValidation;
  if (!d || !v) {
    preview.className = "empty-state ai-workflow-empty";
    preview.textContent = state.aiWorkflowExploration?.requiresManual ? `網站探索已暫停：${state.aiWorkflowExploration.manualReason || "請先在瀏覽器完成人工操作。"} 完成後再繼續。` : "尚未產生 AI Workflow 草稿。";
    actions.hidden = true; revisionActions.hidden = true;
    if (actionHint) actionHint.hidden = true;
    badge.textContent = state.aiWorkflowExploration?.requiresManual ? "等待人工操作" : "尚未產生"; badge.className = "badge neutral";
    return;
  }
  badge.textContent = pending ? (v.valid ? "待確認修改" : `候選版有 ${v.errors?.length ?? 0} 個錯誤`) : (v.valid ? "驗證通過" : `有 ${v.errors?.length ?? 0} 個錯誤`);
  badge.className = `badge ${v.valid ? (pending ? "neutral" : "completed") : "failed"}`;
  const alerts = [...(v.errors ?? []).map((x) => `<li class="error">${escapeHtml(x)}</li>`), ...(v.warnings ?? []).map((x) => `<li>${escapeHtml(x)}</li>`)].join("");
  const diff = pending ? renderAIWorkflowDiff(pending.diff, pending.revision?.changeSummary) : "";
  preview.className = "ai-workflow-preview";
  const diffLegend = pending ? renderAIWorkflowDiffLegend() : "";
  const stepDiff = pending?.diff?.steps ?? [];
  preview.innerHTML = `${diff}<div class="ai-draft-summary"><h3>${escapeHtml(d.name)}</h3><p>${escapeHtml(d.summary || d.description)}</p></div><div class="ai-draft-facts"><div><span>目標網址</span><b>${escapeHtml(d.targetUrl || "—")}</b></div><div><span>Adapter</span><b>${escapeHtml(d.adapter)}</b></div><div><span>步驟</span><b>${countAIWorkflowSteps(d.steps)}</b></div><div><span>參數</span><b>${d.parameters?.length ?? 0}</b></div></div>${alerts ? `<ul class="ai-draft-alert-list">${alerts}</ul>` : ""}<div class="ai-draft-block"><h3>允許網域</h3><p>${(d.allowedDomains ?? []).map(escapeHtml).join("、") || "—"}</p></div><div class="ai-draft-block"><div class="ai-draft-step-heading"><h3>流程步驟</h3>${diffLegend}</div>${renderAIWorkflowStepList(d.steps ?? [], 0, stepDiff)}${pending ? renderAIWorkflowRemovedSteps(stepDiff) : ""}</div><details class="ai-draft-json"><summary>檢視 JSON</summary><pre>${escapeHtml(JSON.stringify(d, null, 2))}</pre></details>`;
  revisionActions.hidden = !pending;
  actions.hidden = Boolean(pending);
  const validationReason = !v.valid ? `尚有 ${v.errors?.length ?? 0} 個驗證錯誤：${(v.errors ?? []).slice(0, 2).join("；")}` : "";
  const revisionApply = $("#acceptAndApplyAIWorkflowRevisionButton");
  const revisionDraft = $("#acceptAIWorkflowRevisionButton");
  revisionApply.disabled = Boolean(pending && (!v.valid || !state.project || pending.diff?.changed === false));
  revisionDraft.disabled = Boolean(pending && (!v.valid || pending.diff?.changed === false));
  revisionApply.title = validationReason || (!state.project ? "目前沒有已開啟專案；可先僅套用至 AI 草稿，再建立為新專案。" : (pending?.diff?.changed === false ? "候選修改與目前版本沒有差異。" : ""));
  revisionDraft.title = validationReason || (pending?.diff?.changed === false ? "候選修改與目前版本沒有差異。" : "");
  if (!pending) {
    const createButton = $("#createAIWorkflowProjectButton");
    const applyButton = $("#applyAIWorkflowProjectButton");
    createButton.disabled = !v.valid;
    applyButton.disabled = !v.valid || !state.project;
    createButton.title = validationReason;
    applyButton.title = validationReason || (!state.project ? "目前沒有已開啟專案；請先建立為新專案或開啟既有專案。" : "");
  }
  if (actionHint) {
    let hint = "";
    if (validationReason) hint = `目前無法套用：${validationReason}`;
    else if (pending && !state.project) hint = "目前沒有已開啟專案；可先「僅套用至 AI 草稿」，再按「建立為新專案」。";
    else if (!pending && !state.project) hint = "草稿已通過驗證，可建立為新專案；「套用至目前專案」需先開啟既有專案。";
    else if (pending) hint = "候選修改已通過驗證，可確認後直接套用至目前專案。";
    else hint = "草稿已通過驗證，可建立為新專案或套用至目前專案。";
    actionHint.textContent = hint;
    actionHint.hidden = !hint;
  }
}

function renderAIWorkflowDiff(diff, changeSummary = []) {
  if (!diff) return "";
  const labels = { added:"新增", removed:"刪除", modified:"修改", moved:"移動" };
  const summary = [...(changeSummary ?? []), ...(diff.summary ?? [])].filter(Boolean);
  const stepItems = (diff.steps ?? []).slice(0,30).map((item) => `<li><b>${labels[item.type] || item.type}</b> ${escapeHtml(item.afterName || item.beforeName || item.id)}${item.beforePath || item.afterPath ? `<small>${escapeHtml(item.beforePath || "—")} → ${escapeHtml(item.afterPath || "—")}</small>` : ""}</li>`).join("");
  const params = [];
  if (diff.parameters?.added?.length) params.push(`新增參數：${diff.parameters.added.join("、")}`);
  if (diff.parameters?.removed?.length) params.push(`刪除參數：${diff.parameters.removed.join("、")}`);
  if (diff.parameters?.modified?.length) params.push(`修改參數：${diff.parameters.modified.join("、")}`);
  return `<div class="ai-diff-panel"><div class="ai-diff-title"><h3>此次修改差異</h3><span>尚未套用</span></div>${summary.length ? `<ul class="ai-diff-summary">${summary.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : `<p>AI 回傳內容與目前版本沒有可辨識差異。</p>`}${stepItems ? `<div class="ai-diff-steps"><b>步驟差異</b><ul>${stepItems}</ul></div>` : ""}${params.length ? `<p>${params.map(escapeHtml).join("<br>")}</p>` : ""}</div>`;
}

function renderAIWorkflowDiffLegend() {
  return `<div class="ai-step-diff-legend" aria-label="候選修改標示"><span class="added">新增</span><span class="modified">修改</span><span class="removed">刪除</span><span class="moved">↔ 移動</span></div>`;
}

function aiWorkflowStepDiffState(stepId, diffItems = []) {
  const items = diffItems.filter((item) => item?.id === stepId);
  const types = new Set(items.map((item) => item.type));
  const move = items.find((item) => item.type === "moved");
  return { items, types, move };
}

function renderAIWorkflowStepList(steps, depth = 0, diffItems = []) {
  return steps.map((s,i) => {
    const change = aiWorkflowStepDiffState(s.id, diffItems);
    const classes = ["ai-draft-step"];
    if (change.types.has("added")) classes.push("change-added");
    else if (change.types.has("modified")) classes.push("change-modified");
    if (change.types.has("moved")) classes.push("change-moved");
    const badges = [];
    if (change.types.has("added")) badges.push(`<strong class="ai-step-change-badge added">新增</strong>`);
    else if (change.types.has("modified")) badges.push(`<strong class="ai-step-change-badge modified">修改</strong>`);
    if (change.types.has("moved")) badges.push(`<strong class="ai-step-change-badge moved">↔ 移動 ${escapeHtml(change.move?.beforePath || "—")} → ${escapeHtml(change.move?.afterPath || "—")}</strong>`);
    return `<div class="${classes.join(" ")}" style="--depth:${Math.min(depth,4)}"><span>${i+1}</span><div><div class="ai-draft-step-title"><b>${escapeHtml(s.name)}</b><div class="ai-step-change-badges">${badges.join("")}</div></div><em>${escapeHtml(stepKindWrite(s.kind))}</em>${s.url ? `<small>${escapeHtml(s.url)}</small>` : ""}${s.thenSteps?.length ? renderAIWorkflowStepList(s.thenSteps,depth+1,diffItems) : ""}${s.elseSteps?.length ? renderAIWorkflowStepList(s.elseSteps,depth+1,diffItems) : ""}${s.steps?.length ? renderAIWorkflowStepList(s.steps,depth+1,diffItems) : ""}</div></div>`;
  }).join("");
}

function renderAIWorkflowRemovedSteps(diffItems = []) {
  const removed = diffItems.filter((item) => item?.type === "removed");
  if (!removed.length) return "";
  return `<div class="ai-draft-removed-group"><b>已刪除步驟</b>${removed.map((item) => `<div class="ai-draft-step change-removed" style="--depth:0"><span>−</span><div><div class="ai-draft-step-title"><b>${escapeHtml(item.beforeName || item.id)}</b><div class="ai-step-change-badges"><strong class="ai-step-change-badge removed">刪除</strong></div></div><small>原位置：${escapeHtml(item.beforePath || "—")}</small></div></div>`).join("")}</div>`;
}
function countAIWorkflowSteps(steps) { return Array.isArray(steps) ? steps.reduce((n,s) => n + 1 + countAIWorkflowSteps(s.thenSteps) + countAIWorkflowSteps(s.elseSteps) + countAIWorkflowSteps(s.steps), 0) : 0; }
async function createAIWorkflowProject() { const d = state.aiWorkflowDraft; if (!d || !state.aiWorkflowValidation?.valid || state.aiWorkflowPendingRevision) return; try { const response = await api("/api/studio/projects", { method:"POST", body:JSON.stringify({ ...d, id:`ai-${Date.now().toString(36)}`, status:"draft", version:"1.0.0", releaseNotes:d.description }) }); state.projects = [response.project, ...state.projects.filter((p) => p.id !== response.project.id)]; await loadProject(response.project.id); showView("designer"); toast("已建立 AI 草稿專案；互動 selector 已經網站探索驗證，仍建議先執行測試。 "); } catch (error) { recordAIWorkflowError("createProject", error); } }
async function applyAIWorkflowToCurrentProject() { const d = state.aiWorkflowDraft; if (!d || !state.aiWorkflowValidation?.valid || !state.project || state.aiWorkflowPendingRevision) return; if (!confirm(`將 AI 草稿套用至「${state.project.name}」？會取代網址、網域、Adapter、參數與步驟。`)) return; try { const projectBeforeApply = cloneJson(state.project); const next = { ...state.project, description:d.description || state.project.description, targetUrl:d.targetUrl, allowedDomains:d.allowedDomains, adapter:d.adapter, parameters:d.parameters, steps:d.steps }; const response = await api(`/api/studio/projects/${encodeURIComponent(state.project.id)}`, { method:"PUT", body:JSON.stringify(next) }); const lastHistory = state.aiWorkflowHistory[state.aiWorkflowHistory.length - 1]; if (lastHistory && lastHistory.appliedToProject !== true) { lastHistory.project = lastHistory.project || projectBeforeApply; lastHistory.appliedToProject = true; } state.project=response.project; const i=state.projects.findIndex((p) => p.id===response.project.id); if(i>=0) state.projects[i]=response.project; persistAIWorkflowSession(); renderProject(); showView("designer"); toast("AI 草稿已套用；互動 selector 已經網站探索驗證，尚未自動正式執行。 "); } catch(error) { recordAIWorkflowError("applyProject", error); } }
async function copyAIWorkflowDraft() { if (!state.aiWorkflowDraft) return; await navigator.clipboard.writeText(JSON.stringify(state.aiWorkflowDraft,null,2)); toast("AI 草稿 JSON 已複製"); }
function clearAIWorkflowDraft() { state.aiWorkflowDraft=null; state.aiWorkflowValidation=null; state.aiWorkflowMeta=null; state.aiWorkflowPendingRevision=null; state.aiWorkflowHistory=[]; state.aiWorkflowConversation=[]; state.aiWorkflowDeferredRevision=""; persistAIWorkflowSession(); renderAIWorkflowAssistant(); }

function persistAIWorkflowSession() {
  try {
    localStorage.setItem(AI_WORKFLOW_SESSION_KEY, JSON.stringify({
      draft:state.aiWorkflowDraft,
      validation:state.aiWorkflowValidation,
      conversation:(state.aiWorkflowConversation ?? []).slice(-30),
      history:(state.aiWorkflowHistory ?? []).slice(-20),
      deferredRevision:state.aiWorkflowDeferredRevision || "",
      errors:(state.aiWorkflowErrors ?? []).slice(0,20),
      monitor:state.aiWorkflowMonitor,
      monitorEvents:(state.aiWorkflowMonitorEvents ?? []).slice(-50),
      monitorCompletedStages:(state.aiWorkflowMonitorCompletedStages ?? []).slice(-20),
      lastOperation:state.aiWorkflowLastOperation,
      targetUrl:$("#aiWorkflowTargetUrl")?.value || state.aiWorkflowDraft?.targetUrl || "",
      instruction:$("#aiWorkflowInstruction")?.value || ""
    }));
  } catch {}
}

function restoreAIWorkflowSession() {
  if (state.aiWorkflowDraft) return;
  try {
    const raw = localStorage.getItem(AI_WORKFLOW_SESSION_KEY) || localStorage.getItem(AI_WORKFLOW_SESSION_LEGACY_KEY); if (!raw) return;
    const saved = JSON.parse(raw);
    state.aiWorkflowErrors = Array.isArray(saved?.errors) ? saved.errors.slice(0,20) : [];
    state.aiWorkflowMonitor = saved?.monitor && typeof saved.monitor === "object" ? saved.monitor : null;
    state.aiWorkflowMonitorEvents = Array.isArray(saved?.monitorEvents) ? saved.monitorEvents.slice(-50) : [];
    state.aiWorkflowMonitorCompletedStages = Array.isArray(saved?.monitorCompletedStages) ? saved.monitorCompletedStages.slice(-20) : [];
    state.aiWorkflowLastOperation = saved?.lastOperation && typeof saved.lastOperation === "object" ? saved.lastOperation : null;
    if (state.aiWorkflowMonitor && ["running","waiting"].includes(state.aiWorkflowMonitor.status)) {
      state.aiWorkflowMonitor = { ...state.aiWorkflowMonitor, status:"stopped", warning:"頁面曾重新整理；前一次 AI 執行監控已中斷。若後端工作仍在執行，可重新開始或複製診斷資訊。", waitingFor:"" };
      appendAIWorkflowMonitorEvent("監控", "頁面重新整理，前一次 AI 執行監控已中斷");
    }
    if (saved?.draft && saved?.validation) {
      state.aiWorkflowDraft = saved.draft;
      state.aiWorkflowValidation = saved.validation;
      state.aiWorkflowConversation = Array.isArray(saved.conversation) ? saved.conversation : [];
      state.aiWorkflowHistory = Array.isArray(saved.history) ? saved.history : [];
      state.aiWorkflowDeferredRevision = typeof saved.deferredRevision === "string" ? saved.deferredRevision : "";
    }
    if ($("#aiWorkflowTargetUrl") && saved.targetUrl) $("#aiWorkflowTargetUrl").value = saved.targetUrl;
    if ($("#aiWorkflowInstruction") && saved.instruction) $("#aiWorkflowInstruction").value = saved.instruction;
    if ($("#aiWorkflowRevisionInstruction") && state.aiWorkflowDeferredRevision) $("#aiWorkflowRevisionInstruction").value = state.aiWorkflowDeferredRevision;
  } catch { localStorage.removeItem(AI_WORKFLOW_SESSION_KEY); }
}

function cloneJson(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }


function issueReportEmail() {
  return String(state.settings?.issueReportEmail ?? "").trim();
}

function reportSeverityLabel(value) {
  return ({ normal: "一般問題", important: "影響工作", blocking: "無法繼續使用" })[value] ?? value;
}

function renderIssueReportContext() {
  const email = issueReportEmail();
  const badge = $("#reportEmailBadge");
  if (badge) {
    badge.textContent = email ? `收件：${email}` : "尚未設定收件信箱";
    badge.className = `badge ${email ? "completed" : "neutral"}`;
  }
  if ($("#reportProjectName")) $("#reportProjectName").textContent = state.project?.name ?? "尚未開啟專案";
  if ($("#reportProjectId")) $("#reportProjectId").textContent = state.project?.id ?? "—";
  if ($("#reportBrowserMode")) {
    const mode = state.project?.browser?.connectionMode ?? "managed";
    $("#reportBrowserMode").textContent = mode === "cdp" ? "Chrome CDP 接管" : "Automation Studio 管理瀏覽器";
  }
  if ($("#reportCreatedAt")) $("#reportCreatedAt").textContent = formatDate(new Date().toISOString());
}

function buildIssueReportText() {
  const category = $("#reportCategory")?.value ?? "其他";
  const severity = reportSeverityLabel($("#reportSeverity")?.value ?? "normal");
  const description = $("#reportDescription")?.value.trim() || "（未填寫）";
  const steps = $("#reportSteps")?.value.trim() || "（未填寫）";
  const expected = $("#reportExpected")?.value.trim() || "（未填寫）";
  const actual = $("#reportActual")?.value.trim() || "（未填寫）";
  const contact = $("#reportContact")?.value.trim() || "（未提供）";
  const projectName = state.project?.name ?? "尚未開啟專案";
  const projectId = state.project?.id ?? "—";
  const browserMode = (state.project?.browser?.connectionMode ?? "managed") === "cdp" ? "Chrome CDP 接管" : "Automation Studio 管理瀏覽器";
  return [
    "Automation Studio 問題回報",
    "",
    `問題類別：${category}`,
    `影響程度：${severity}`,
    `系統版本：V2.1.0`,
    `目前專案：${projectName}`,
    `專案 ID：${projectId}`,
    `瀏覽器模式：${browserMode}`,
    `回報時間：${formatDate(new Date().toISOString())}`,
    `聯絡方式：${contact}`,
    "",
    "【問題描述】",
    description,
    "",
    "【重現步驟】",
    steps,
    "",
    "【預期結果】",
    expected,
    "",
    "【實際結果】",
    actual,
    "",
    "【隱私提醒】",
    "本回報內容未由系統自動附帶密碼、Cookie、MFA、驗證碼或流程參數實際值。"
  ].join("\n");
}

function issueReportSubject() {
  const custom = $("#reportSubject")?.value.trim();
  const category = $("#reportCategory")?.value ?? "其他";
  return custom || `[Automation Studio V2.1.0][${category}] 問題回報`;
}

async function copyIssueReport() {
  const text = `主旨：${issueReportSubject()}\n收件者：${issueReportEmail() || "（尚未設定）"}\n\n${buildIssueReportText()}`;
  try {
    await navigator.clipboard.writeText(text);
    toast("問題回報內容已複製");
  } catch {
    toast("無法存取剪貼簿，請手動複製內容。", true);
  }
}

function sendIssueReport() {
  const email = issueReportEmail();
  if (!email) {
    toast("尚未設定問題回報收件信箱，請先到系統設定填寫。", true);
    showView("settings");
    $("#issueReportEmail")?.focus();
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    toast("問題回報收件信箱格式不正確，請先到系統設定修正。", true);
    showView("settings");
    $("#issueReportEmail")?.focus();
    return;
  }
  const subject = issueReportSubject();
  const body = buildIssueReportText();
  const href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  if (href.length > 7500) toast("回報內容較長；若郵件程式未完整帶入內容，可改用「複製回報內容」。");
  window.location.href = href;
}

function clearIssueReport() {
  ["reportSubject", "reportDescription", "reportSteps", "reportExpected", "reportActual", "reportContact"].forEach((id) => { const el = $(`#${id}`); if (el) el.value = ""; });
  if ($("#reportCategory")) $("#reportCategory").selectedIndex = 0;
  if ($("#reportSeverity")) $("#reportSeverity").value = "normal";
  renderIssueReportContext();
  toast("問題回報表單已清除");
}

function applyTheme(theme) {
  const resolved = theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme;
  document.documentElement.dataset.theme = resolved;
  try { localStorage.setItem("studio-startup-theme", theme); localStorage.removeItem("studio-ui-theme"); } catch { /* Theme still applies if browser storage is unavailable. */ }
}

function renderRawJson() {
  if (state.project) $("#workflowJson").value = JSON.stringify(state.project, null, 2);
}

async function saveRawJson() {
  try {
    const value = JSON.parse($("#workflowJson").value);
    if (!value.id || !value.name || !Array.isArray(value.steps) || !Array.isArray(value.parameters)) throw new Error("JSON 缺少 id、name、steps 或 parameters。");
    if (value.id !== state.project.id) throw new Error("不可透過 JSON 修改專案 ID。");
    state.project = value;
    await saveProject();
    renderProject();
    toast("工作流程 JSON 已套用");
  } catch (error) { toast(error.message, true); }
}

async function copyRawJson() {
  await navigator.clipboard.writeText($("#workflowJson").value);
  toast("JSON 已複製");
}

function markRuntime(health) {
  $("#serverDot").className = health.ok ? (health.runtime?.playwright ? "ok" : "error") : "error";
  $("#serverStatus").textContent = health.ok ? "本機服務已連線" : "本機服務未連線";
  $("#runtimeStatus").textContent = health.runtime?.playwright ? "Playwright 執行核心可用" : "設計介面可用 · 執行核心未安裝";
}

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { "content-type": "application/json", ...(options.headers ?? {}) }, ...options });
  const contentType = response.headers.get("content-type") ?? "";
  const value = contentType.includes("json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(value?.error?.message ?? value?.message ?? String(value));
  return value;
}

function stepOptions(selected) {
  return ["navigate","newTab","switchTab","manual","click","dblclick","extractText","extractPattern","clipboard","fill","select","upload","press","hover","check","uncheck","wait","waitNewFirst","captureListSnapshot","waitNewListItem","assert","download","savePagePdf","screenshot","script","condition","loop"].map((value) => `<option value="${value}" ${value === selected ? "selected" : ""}>${stepKindWrite(value)}</option>`).join("");
}

function adapterOptions(selected) {
  return [["generic","通用 HTML"],["extjs","ExtJS"],["ksi","Ksi"],["ebas","EBAS"]].map(([value,label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`).join("");
}

function waitOptions(selected) {
  return [["timeout","固定時間"],["visible","等待顯示"],["hidden","等待消失"],["attached","等待出現"],["networkIdle","網路閒置"],["url","網址符合"]].map(([value,label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`).join("");
}

function verifyOptions(selected) {
  return [["visible","可見"],["hidden","隱藏"],["exists","存在"],["value","欄位值"],["text","文字內容"],["url","網址"],["checked","勾選狀態"]].map(([value,label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`).join("");
}

function stepKindWrite(kind) {
  return ({ navigate:"前往網址", newTab:"開新分頁", switchTab:"切換分頁", manual:"人工操作", click:"點擊", dblclick:"雙擊", extractText:"擷取文字", extractPattern:"擷取樣式", clipboard:"複製剪貼簿", fill:"填入", select:"選擇", upload:"上傳檔案", press:"鍵盤按鍵", hover:"移至元件", check:"勾選", uncheck:"取消勾選", wait:"等待", waitNewFirst:"等待新第一筆", captureListSnapshot:"擷取清單快照", waitNewListItem:"等待清單新資料", assert:"驗證", download:"下載", savePagePdf:"保存頁面 PDF", screenshot:"截圖", script:"頁面腳本", condition:"條件", loop:"迴圈" })[kind] ?? kind;
}

function JSONTape(value) { return JSON.stringify(value, null, 2); }

function statusLabel(status) {
  return ({ queued:"等待中", running:"執行中", paused:"等待人工操作", completed:"完成", failed:"失敗", cancelled:"已取消" })[status] ?? status;
}

function formatDate(value, short = false) {
  if (!value) return "—";
  const date = new Date(value);
  return new Intl.DateTimeFormat("zh-TW", short ? { month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit" } : { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit" }).format(date);
}

function formatByteSize(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[index]}`;
}

function isValidUrl(value) { try { return /^https?:$/.test(new URL(value).protocol); } catch { return false; } }
function normalizeHttpUrlForCompare(value) { try { return new URL(value).href; } catch { return String(value ?? "").trim(); } }

function readStoredZipEntry(arrayBuffer, expectedNames) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  const decoder = new TextDecoder("utf-8");
  let offset = 0;
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));
    if (expectedNames.includes(name)) {
      if (method !== 0) throw new Error("目前僅支援由本程式產生的未壓縮可攜 ZIP。");
      return decoder.decode(bytes.slice(dataStart, dataStart + compressedSize));
    }
    offset = dataStart + compressedSize;
  }
  throw new Error("ZIP 內找不到 portable-workflow/workflow.json。");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[character]);
}

let toastTimer;
function toast(message, isError = false) {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast visible${isError ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.className = "toast"; }, 3600);
}

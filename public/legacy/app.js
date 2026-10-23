const storageKeys = {
  legacyBatchItems: "mcp-report-console:batch-items",
  theme: "mcp-report-console:theme"
};

const state = {
  tools: [],
  reports: [],
  definitions: [],
  selectedReportId: "",
  parameters: [],
  batchItems: [],
  batchPresets: [],
  selectedPresetId: "",
  newPresetMode: false,
  currentTaskType: "single",
  currentResult: null,
  authStatus: null,
  workerStatuses: [],
  cancelRequestedId: null,
  pollTimer: null
};

const elements = {
  serverDot: document.querySelector("#serverDot"),
  serverStatus: document.querySelector("#serverStatus"),
  refreshButton: document.querySelector("#refreshButton"),
  reportSelect: document.querySelector("#reportSelect"),
  parameterFields: document.querySelector("#parameterFields"),
  debugToggle: document.querySelector("#debugToggle"),
  browserModeSelect: document.querySelector("#browserModeSelect"),
  browserModeWarning: document.querySelector("#browserModeWarning"),
  createTaskButton: document.querySelector("#createTaskButton"),
  addBatchItemButton: document.querySelector("#addBatchItemButton"),
  clearBatchButton: document.querySelector("#clearBatchButton"),
  createBatchTaskButton: document.querySelector("#createBatchTaskButton"),
  goToBatchOrganizerButton: document.querySelector("#goToBatchOrganizerButton"),
  continueOnErrorToggle: document.querySelector("#continueOnErrorToggle"),
  parallelismSelect: document.querySelector("#parallelismSelect"),
  retryEnabledToggle: document.querySelector("#retryEnabledToggle"),
  maxRetriesInput: document.querySelector("#maxRetriesInput"),
  retryDelayInput: document.querySelector("#retryDelayInput"),
  batchList: document.querySelector("#batchList"),
  presetBatchList: document.querySelector("#presetBatchList"),
  presetBatchCount: document.querySelector("#presetBatchCount"),
  clearBatchButtonFromPreset: document.querySelector("#clearBatchButtonFromPreset"),
  presetSelect: document.querySelector("#presetSelect"),
  presetName: document.querySelector("#presetName"),
  presetDescription: document.querySelector("#presetDescription"),
  newPresetButton: document.querySelector("#newPresetButton"),
  savePresetButton: document.querySelector("#savePresetButton"),
  deletePresetButton: document.querySelector("#deletePresetButton"),
  loadPresetReplaceButton: document.querySelector("#loadPresetReplaceButton"),
  loadPresetAppendButton: document.querySelector("#loadPresetAppendButton"),
  movePresetUpButton: document.querySelector("#movePresetUpButton"),
  movePresetDownButton: document.querySelector("#movePresetDownButton"),
  exportPresetsButton: document.querySelector("#exportPresetsButton"),
  importPresetsButton: document.querySelector("#importPresetsButton"),
  importPresetsFile: document.querySelector("#importPresetsFile"),
  batchYearInput: document.querySelector("#batchYearInput"),
  batchStageSelect: document.querySelector("#batchStageSelect"),
  batchOutputFormatSelect: document.querySelector("#batchOutputFormatSelect"),
  applyBatchYearButton: document.querySelector("#applyBatchYearButton"),
  applyBatchStageButton: document.querySelector("#applyBatchStageButton"),
  applyBatchOutputFormatButton: document.querySelector("#applyBatchOutputFormatButton"),
  manageAuthButton: document.querySelector("#manageAuthButton"),
  topbarAuthDot: document.querySelector("#topbarAuthDot"),
  authModal: document.querySelector("#authModal"),
  closeAuthModalButton: document.querySelector("#closeAuthModalButton"),
  authStatusBadge: document.querySelector("#authStatusBadge"),
  authDetail: document.querySelector("#authDetail"),
  workerGrid: document.querySelector("#workerGrid"),
  openDownloadDirButton: document.querySelector("#openDownloadDirButton"),
  taskSummary: document.querySelector("#taskSummary"),
  resultTable: document.querySelector("#resultTable"),
  resultJson: document.querySelector("#resultJson"),
  toolsList: document.querySelector("#toolsList"),
  toolSelect: document.querySelector("#toolSelect"),
  toolArgs: document.querySelector("#toolArgs"),
  callToolButton: document.querySelector("#callToolButton"),
  definitionList: document.querySelector("#definitionList"),
  definitionId: document.querySelector("#definitionId"),
  definitionName: document.querySelector("#definitionName"),
  definitionDescription: document.querySelector("#definitionDescription"),
  definitionMenuPath: document.querySelector("#definitionMenuPath"),
  definitionBusinessType: document.querySelector("#definitionBusinessType"),
  definitionFundType: document.querySelector("#definitionFundType"),
  definitionYear: document.querySelector("#definitionYear"),
  definitionStage: document.querySelector("#definitionStage"),
  definitionOutputFormat: document.querySelector("#definitionOutputFormat"),
  definitionKind: document.querySelector("#definitionKind"),
  definitionKindOptions: document.querySelector("#definitionKindOptions"),
  definitionPrintLevel: document.querySelector("#definitionPrintLevel"),
  definitionUsagePrintStopLevel: document.querySelector("#definitionUsagePrintStopLevel"),
  definitionAccountLevel: document.querySelector("#definitionAccountLevel"),
  definitionAccountCode: document.querySelector("#definitionAccountCode"),
  definitionAccountPrintLevel: document.querySelector("#definitionAccountPrintLevel"),
  newDefinitionButton: document.querySelector("#newDefinitionButton"),
  loadSampleDefinitionButton: document.querySelector("#loadSampleDefinitionButton"),
  saveDefinitionButton: document.querySelector("#saveDefinitionButton"),
  exportDefinitionsButton: document.querySelector("#exportDefinitionsButton"),
  importDefinitionsButton: document.querySelector("#importDefinitionsButton"),
  importDefinitionsFile: document.querySelector("#importDefinitionsFile"),
  rawResponse: document.querySelector("#rawResponse"),
  toast: document.querySelector("#toast"),
  viewTitle: document.querySelector("#viewTitle"),
  themeToggleButton: document.querySelector("#themeToggleButton")
};

document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  restoreUiMemory();
  bindNavigation();
  bindResultTabs();
  bindActions();
  renderBatchItems();
  void initialize();
});

async function initialize() {
  try {
    await checkHealth();
    await loadBatchMemory();
    await loadBatchPresets();
    await loadAuthStatus();
    await loadTools();
    await loadDefinitions();
    await loadReports();
    showToast("UI 已連線到 MCP server");
  } catch (error) {
    markServer(false, error.message);
    showToast(error.message);
  }
}

function restoreUiMemory() {
  state.authCollapsed = localStorage.getItem(storageKeys.authCollapsed) === "true";
}

async function loadBatchMemory() {
  try {
    const memory = await fetchJson("/api/batch-memory");
    state.batchItems = normalizeBatchItems(memory.items);

    if (state.batchItems.length === 0) {
      const legacyItems = readLegacyBatchItems();
      if (legacyItems.length > 0) {
        state.batchItems = legacyItems;
        await saveBatchItems();
        localStorage.removeItem(storageKeys.legacyBatchItems);
      }
    }

    renderBatchItems();
  } catch (error) {
    state.batchItems = readLegacyBatchItems();
    renderBatchItems();
    showToast(`批次清單讀取失敗：${error.message}`);
  }
}

async function saveBatchItems() {
  try {
    await fetchJson("/api/batch-memory", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        items: state.batchItems
      })
    });
  } catch (error) {
    showToast(`批次清單保存失敗：${error.message}`);
  }
}

async function loadBatchPresets() {
  try {
    const response = await fetchJson("/api/batch-presets");
    state.batchPresets = normalizeBatchPresets(response.presets);
    renderBatchPresets();
  } catch (error) {
    state.batchPresets = [];
    renderBatchPresets();
    showToast(`批次範本讀取失敗：${error.message}`);
  }
}

async function saveCurrentBatchPreset() {
  const name = elements.presetName.value.trim();
  if (!name) {
    showToast("請輸入範本名稱");
    return;
  }
  if (state.batchItems.length === 0) {
    showToast("請先加入至少一個報表");
    return;
  }

  const selected = selectedPreset();
  const duplicate = state.batchPresets.find((preset) =>
    normalizeText(preset.name) === normalizeText(name) && preset.id !== selected?.id
  );
  const target = selected?.name === name ? selected : duplicate;
  if (target && !window.confirm(`範本「${target.name}」已存在，是否覆蓋？`)) {
    return;
  }

  try {
    const response = await fetchJson("/api/batch-presets", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        id: target?.id ?? selected?.id ?? "",
        name,
        description: elements.presetDescription.value.trim(),
        continueOnError: elements.continueOnErrorToggle.checked,
        items: state.batchItems
      })
    });
    state.batchPresets = normalizeBatchPresets(response.presets);
    state.selectedPresetId = response.preset?.id ?? target?.id ?? state.selectedPresetId;
    state.newPresetMode = false;
    renderBatchPresets();
    showToast("批次範本已儲存");
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteSelectedBatchPreset() {
  const preset = selectedPreset();
  if (!preset) {
    showToast("請先選擇範本");
    return;
  }
  if (!window.confirm(`確定刪除範本「${preset.name}」？`)) return;

  try {
    const response = await fetchJson(`/api/batch-presets?id=${encodeURIComponent(preset.id)}`, {
      method: "DELETE"
    });
    state.batchPresets = normalizeBatchPresets(response.presets);
    state.selectedPresetId = state.batchPresets[0]?.id ?? "";
    renderBatchPresets();
    showToast("批次範本已刪除");
  } catch (error) {
    showToast(error.message);
  }
}

function loadSelectedPreset(mode) {
  const preset = selectedPreset();
  if (!preset) {
    showToast("請先選擇範本");
    return;
  }

  const items = cloneBatchItems(preset.items);
  state.batchItems = mode === "append" ? [...state.batchItems, ...items] : items;
  elements.continueOnErrorToggle.checked = preset.continueOnError !== false;
  void saveBatchItems();
  renderBatchItems();
  const total = state.batchItems.length;
  showToast(mode === "append"
    ? `已附加 ${items.length} 筆到目前批次，目前共 ${total} 筆。`
    : `已用「${preset.name}」取代目前批次，共 ${total} 筆。`);
}

async function moveSelectedPreset(direction) {
  const index = state.batchPresets.findIndex((preset) => preset.id === state.selectedPresetId);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= state.batchPresets.length) return;

  const presets = [...state.batchPresets];
  const [preset] = presets.splice(index, 1);
  presets.splice(nextIndex, 0, preset);
  state.batchPresets = presets;
  renderBatchPresets();

  try {
    const response = await fetchJson("/api/batch-presets/reorder", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ids: state.batchPresets.map((item) => item.id)
      })
    });
    state.batchPresets = normalizeBatchPresets(response.presets);
    renderBatchPresets();
  } catch (error) {
    showToast(error.message);
  }
}

function exportBatchPresets() {
  const blob = new Blob([`${JSON.stringify(state.batchPresets, null, 2)}\n`], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `batch-presets-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function importBatchPresets() {
  const file = elements.importPresetsFile.files?.[0];
  elements.importPresetsFile.value = "";
  if (!file) return;

  try {
    const text = await file.text();
    const imported = normalizeBatchPresets(JSON.parse(text));
    if (imported.length === 0) {
      showToast("匯入檔案沒有可用範本");
      return;
    }

    const duplicateNames = imported
      .filter((preset) => state.batchPresets.some((item) => item.id === preset.id || normalizeText(item.name) === normalizeText(preset.name)))
      .map((preset) => preset.name);
    if (duplicateNames.length > 0 && !window.confirm(`以下範本已存在，是否覆蓋？\n${duplicateNames.join("\n")}`)) {
      return;
    }

    const response = await fetchJson("/api/batch-presets/import", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ presets: imported })
    });
    state.batchPresets = normalizeBatchPresets(response.presets);
    state.selectedPresetId = imported[0]?.id ?? state.selectedPresetId;
    renderBatchPresets();
    showToast("批次範本已匯入");
  } catch (error) {
    showToast(`匯入失敗：${error.message}`);
  }
}


function bindNavigation() {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });
}

function switchView(view) {
  const button = document.querySelector(`.nav-item[data-view="${view}"]`);
  const panel = document.querySelector(`#${view}View`);
  if (!button || !panel) return;

  document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  document.querySelectorAll(".view-panel").forEach((item) => item.classList.remove("active"));
  panel.classList.add("active");
  elements.viewTitle.textContent = button.textContent.trim();
}

function bindResultTabs() {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.resultTab;
      document.querySelectorAll(".tab-button").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      document.querySelectorAll(".result-panel").forEach((panel) => panel.classList.remove("active"));
      document.querySelector(`#${tab}Result`).classList.add("active");
    });
  });
}

function bindActions() {
  elements.refreshButton.addEventListener("click", () => initialize());
  elements.reportSelect.addEventListener("change", () => selectReport(elements.reportSelect.value));
  elements.createTaskButton.addEventListener("click", () => createDownloadTask());
  elements.addBatchItemButton.addEventListener("click", () => addBatchItem());
  elements.clearBatchButton.addEventListener("click", () => clearBatchItems());
  elements.clearBatchButtonFromPreset.addEventListener("click", () => clearBatchItems());
  elements.createBatchTaskButton.addEventListener("click", () => createBatchDownloadTask());
  elements.goToBatchOrganizerButton.addEventListener("click", () => switchView("presets"));
  elements.presetSelect.addEventListener("change", () => selectBatchPreset(elements.presetSelect.value));
  elements.newPresetButton.addEventListener("click", () => startNewBatchPreset());
  elements.savePresetButton.addEventListener("click", () => saveCurrentBatchPreset());
  elements.deletePresetButton.addEventListener("click", () => deleteSelectedBatchPreset());
  elements.loadPresetReplaceButton.addEventListener("click", () => loadSelectedPreset("replace"));
  elements.loadPresetAppendButton.addEventListener("click", () => loadSelectedPreset("append"));
  elements.movePresetUpButton.addEventListener("click", () => moveSelectedPreset(-1));
  elements.movePresetDownButton.addEventListener("click", () => moveSelectedPreset(1));
  elements.exportPresetsButton.addEventListener("click", () => exportBatchPresets());
  elements.importPresetsButton.addEventListener("click", () => elements.importPresetsFile.click());
  elements.importPresetsFile.addEventListener("change", () => importBatchPresets());
  elements.applyBatchYearButton.addEventListener("click", () => applyBatchYear());
  elements.taskSummary.addEventListener("click", event => {
    if (event.target.closest("[data-cancel-task]")) void cancelCurrentTask();
  });
  elements.browserModeSelect.addEventListener("change", updateBrowserModeWarning);
  elements.debugToggle.addEventListener("change", updateBrowserModeWarning);
  updateBrowserModeWarning();
  elements.applyBatchStageButton.addEventListener("click", () => applyBatchParameter("stage", elements.batchStageSelect.value, "階段"));
  elements.applyBatchOutputFormatButton.addEventListener("click", () => applyBatchParameter("outputFormat", elements.batchOutputFormatSelect.value, "輸出格式"));
  elements.manageAuthButton.addEventListener("click", () => elements.authModal.showModal());
  elements.closeAuthModalButton.addEventListener("click", () => elements.authModal.close());
  elements.authModal.addEventListener("click", (event) => {
    if (event.target === elements.authModal) {
      elements.authModal.close();
    }
  });
  elements.workerGrid.addEventListener("click", (event) => handleWorkerAction(event));
  elements.openDownloadDirButton.addEventListener("click", () => openDownloadDirectory());
  elements.callToolButton.addEventListener("click", () => callManualTool());
  elements.toolSelect.addEventListener("change", () => seedToolArgs(elements.toolSelect.value));
  elements.newDefinitionButton.addEventListener("click", () => fillDefinitionForm(defaultDefinitionForm(), false));
  elements.loadSampleDefinitionButton.addEventListener("click", () => loadSampleDefinition());
  elements.saveDefinitionButton.addEventListener("click", () => saveDefinition());
  elements.exportDefinitionsButton.addEventListener("click", () => exportDefinitions());
  elements.importDefinitionsButton.addEventListener("click", () => elements.importDefinitionsFile.click());
  elements.importDefinitionsFile.addEventListener("change", () => importDefinitions());
  if (elements.themeToggleButton) {
    elements.themeToggleButton.addEventListener("click", () => toggleTheme());
  }
}

async function checkHealth() {
  const health = await fetchJson("/api/health");
  markServer(Boolean(health.ok), health.ok ? "已連線" : "連線失敗");
}

async function loadAuthStatus() {
  const response = await fetchJson("/api/ebas/workers/status");
  state.workerStatuses = response.workers ?? [];
  state.authStatus = summarizeWorkers(state.workerStatuses);
  renderAuthStatus();
  return state.authStatus;
}

async function handleWorkerAction(event) {
  const button = event.target.closest("[data-worker-action]");
  if (!button) return;
  const workerId = button.getAttribute("data-worker-id");
  const action = button.getAttribute("data-worker-action");
  const endpointMap = {
    start: "/api/ebas/workers/start",
    complete: "/api/ebas/workers/complete",
    cancel: "/api/ebas/workers/cancel",
    check: "/api/ebas/workers/check"
  };
  const endpoint = endpointMap[action];
  if (!endpoint || !workerId) return;

  try {
    if (action === "check") {
      button.textContent = "檢查中...";
    }
    button.disabled = true;
    const status = await fetchJson(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId })
    });
    await loadAuthStatus();
    showToast(status.message || `工作站 ${workerId} 狀態已更新`);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}


function summarizeWorkers(workers) {
  const usable = workers.filter((worker) => worker.storageStateExists).length;
  const active = workers.filter((worker) => worker.active).length;
  return { usable, active, total: workers.length };
}

function renderAuthStatus() {
  const workers = state.workerStatuses;
  const summary = state.authStatus;
  if (!workers.length) {
    elements.authStatusBadge.textContent = "未檢查";
    elements.authStatusBadge.className = "status-pill pending";
    elements.workerGrid.innerHTML = `<span class="muted">尚未取得工作站狀態</span>`;
    return;
  }

  elements.authStatusBadge.textContent = `可用工作站 ${summary.usable}/${summary.total}`;
  elements.authStatusBadge.className = `status-pill ${summary.usable > 0 ? "completed" : summary.active > 0 ? "running" : "pending"}`;
  
  if (elements.topbarAuthDot) {
    if (summary.usable > 0) {
      elements.topbarAuthDot.style.background = "var(--success)"; // 綠色
    } else if (summary.active > 0) {
      elements.topbarAuthDot.style.background = "var(--warning)"; // 橘色
    } else {
      elements.topbarAuthDot.style.background = "var(--muted)"; // 灰色
    }
  }

  elements.workerGrid.innerHTML = workers.map((worker) => {
    const statusText = worker.active
      ? worker.authenticated ? "登入中" : "登入視窗開啟"
      : worker.storageStateExists ? "已儲存 session" : "尚未登入";
    const statusClass = worker.authenticated || worker.storageStateExists ? "completed" : worker.active ? "running" : "pending";
    return `
      <article class="worker-card">
        <div class="worker-card-header">
          <span class="worker-card-title">工作站 ${escapeHtml(worker.workerId)}</span>
          <span class="status-pill ${statusClass}">${statusText}</span>
        </div>
        <div class="worker-actions">
          <button class="primary-button compact-button" type="button" data-worker-action="start" data-worker-id="${escapeHtml(worker.workerId)}">啟動/切回</button>
          <button class="ghost-button compact-button" type="button" data-worker-action="complete" data-worker-id="${escapeHtml(worker.workerId)}" ${worker.active ? "" : "disabled"}>儲存 session</button>
          ${worker.active
            ? `<button class="ghost-button compact-button danger-button" type="button" data-worker-action="cancel" data-worker-id="${escapeHtml(worker.workerId)}">關閉視窗</button>`
            : `<button class="ghost-button compact-button" type="button" data-worker-action="check" data-worker-id="${escapeHtml(worker.workerId)}" ${worker.storageStateExists ? "" : "disabled"}>檢查狀態</button>`
          }
        </div>
        <div class="worker-meta">
          <span>目前 URL：${escapeHtml(worker.url || "-")}</span>
          <span>Storage：${escapeHtml(worker.storageStatePath || "-")}</span>
        </div>
      </article>
    `;
  }).join("");

  elements.authDetail.innerHTML = `<span class="muted">平行模式需要工作站 A/B 都已儲存 session。可用工作站：${summary.usable}。</span>`;
}

async function openDownloadDirectory() {
  elements.openDownloadDirButton.disabled = true;
  try {
    const result = await fetchJson("/api/downloads/open", {
      method: "POST"
    });
    showToast(result.opened ? `已確認開啟下載資料夾：${result.downloadDir}` : `已送出開啟命令：${result.downloadDir}`);
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.openDownloadDirButton.disabled = false;
  }
}

async function loadTools() {
  const response = await fetchJson("/api/mcp/tools");
  state.tools = response.tools ?? [];
  renderTools();
}

async function loadReports() {
  const response = await callMcpTool("list_available_reports");
  state.reports = parseToolResponse(response);
  refreshBatchReportNames();
  renderReports();
  renderBatchItems();

  if (state.reports.length > 0) {
    await selectReport(state.reports[0].id);
  }
}

async function loadDefinitions() {
  const response = await fetchJson("/api/ebas/report-definitions");
  state.definitions = response.definitions ?? [];
  renderDefinitions();
}

async function selectReport(reportId) {
  state.selectedReportId = reportId;
  const response = await callMcpTool("get_report_parameters", { reportId });
  state.parameters = parseToolResponse(response);
  renderParameterFields();
}

function renderTools() {
  elements.toolsList.innerHTML = state.tools.map((tool) => `
    <article class="tool-row">
      <div>
        <strong>${escapeHtml(tool.name)}</strong>
        <p>${escapeHtml(tool.description)}</p>
      </div>
      <pre>${escapeHtml(JSON.stringify(tool.inputSchema, null, 2))}</pre>
    </article>
  `).join("");

  elements.toolSelect.innerHTML = state.tools.map((tool) =>
    `<option value="${escapeHtml(tool.name)}">${escapeHtml(tool.name)}</option>`
  ).join("");

  if (state.tools[0]) {
    seedToolArgs(state.tools[0].name);
  }
}

function renderReports() {
  elements.reportSelect.innerHTML = state.reports.map((report) =>
    `<option value="${escapeHtml(report.id)}">${escapeHtml(report.name)} (${escapeHtml(report.id)})</option>`
  ).join("");
}

function renderDefinitions() {
  if (!state.definitions.length) {
    elements.definitionList.innerHTML = `<span class="muted">尚未建立 EBAS 報表定義</span>`;
    return;
  }

  elements.definitionList.innerHTML = state.definitions.map((definition) => `
    <article class="definition-row">
      <div>
        <strong>${escapeHtml(definition.name)}</strong>
        <p>${escapeHtml(definition.id)}</p>
        <p>${escapeHtml(definition.description)}</p>
      </div>
      <div class="definition-path">${escapeHtml(definition.menuPath.join(" > "))}</div>
      <div class="inline-actions">
        <button class="ghost-button compact-button" type="button" data-edit-definition="${escapeHtml(definition.id)}">編輯</button>
        <button class="ghost-button compact-button" type="button" data-copy-definition="${escapeHtml(definition.id)}">複製</button>
        <button class="ghost-button compact-button danger-button" type="button" data-delete-definition="${escapeHtml(definition.id)}">刪除</button>
      </div>
    </article>
  `).join("");

  elements.definitionList.querySelectorAll("[data-edit-definition]").forEach((button) => {
    button.addEventListener("click", () => {
      const definition = state.definitions.find((item) => item.id === button.dataset.editDefinition);
      if (definition) fillDefinitionForm(definition, false);
    });
  });

  elements.definitionList.querySelectorAll("[data-copy-definition]").forEach((button) => {
    button.addEventListener("click", () => {
      const definition = state.definitions.find((item) => item.id === button.dataset.copyDefinition);
      if (definition) fillDefinitionForm(definition, true);
    });
  });

  elements.definitionList.querySelectorAll("[data-delete-definition]").forEach((button) => {
    button.addEventListener("click", () => {
      void deleteDefinition(String(button.dataset.deleteDefinition ?? ""));
    });
  });
}

function renderParameterFields() {
  elements.parameterFields.innerHTML = state.parameters.map((parameter) => {
    const value = defaultValueFor(parameter);
    const fieldLabel = parameter.label || parameter.name;
    const input = parameter.type === "enum"
      ? `<select data-param="${escapeHtml(parameter.name)}">${parameter.options.map((option) =>
          `<option value="${escapeHtml(option)}" ${option === value ? "selected" : ""}>${escapeHtml(formatOptionLabel(parameter.name, option))}</option>`
        ).join("")}</select>`
      : `<input data-param="${escapeHtml(parameter.name)}" value="${escapeHtml(value)}" placeholder="${escapeHtml(fieldLabel)}" />`;

    return `
      <label class="field">
        <span>${escapeHtml(fieldLabel)}${parameter.required ? " *" : ""}</span>
        ${input}
        <small class="help-text">${escapeHtml(parameter.description)}</small>
      </label>
    `;
  }).join("");
}

function fillDefinitionForm(definition, duplicate) {
  elements.definitionId.value = duplicate ? `${definition.id}-copy` : definition.id;
  elements.definitionName.value = duplicate ? `${definition.name} 複本` : definition.name;
  elements.definitionDescription.value = definition.description;
  elements.definitionMenuPath.value = definition.menuPath.join("\n");
  elements.definitionBusinessType.value = definition.businessType;
  elements.definitionFundType.value = definition.fundType;
  elements.definitionYear.value = definition.year;
  elements.definitionStage.value = definition.stage;
  elements.definitionOutputFormat.value = definition.outputFormat;
  elements.definitionKind.value = definition.kind || definition.kindOptions?.[0] || "";
  elements.definitionKindOptions.value = (definition.kindOptions ?? []).join("\n");
  elements.definitionPrintLevel.value = definition.printLevel || "不適用";
  elements.definitionUsagePrintStopLevel.value = definition.usagePrintStopLevel || "不適用";
  elements.definitionAccountLevel.value = definition.accountLevel || "不適用";
  elements.definitionAccountCode.value = definition.accountCode || "不適用";
  elements.definitionAccountPrintLevel.value = definition.accountPrintLevel || "不適用";
}

async function loadSampleDefinition() {
  if (!window.confirm("載入範例會新增或覆蓋 EBAS 1103 損益表範例定義，是否繼續？")) return;

  try {
    elements.loadSampleDefinitionButton.disabled = true;
    const response = await fetchJson("/api/ebas/report-definitions/sample", { method: "POST" });
    state.definitions = response.definitions ?? [];
    renderDefinitions();
    await loadReports();
    if (response.definition) fillDefinitionForm(response.definition, false);
    showToast("範例已載入；若要加入下載任務，請先複製範例並另存為自訂報表 ID。");
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.loadSampleDefinitionButton.disabled = false;
  }
}

async function saveDefinition() {
  try {
    elements.saveDefinitionButton.disabled = true;
    const definition = readDefinitionForm();
    await fetchJson("/api/ebas/report-definitions", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(definition)
    });
    await loadDefinitions();
    await loadReports();
    elements.reportSelect.value = definition.id;
    await selectReport(definition.id);
    showToast("報表定義已儲存");
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.saveDefinitionButton.disabled = false;
  }
}

async function deleteDefinition(reportId) {
  const definition = state.definitions.find((item) => item.id === reportId);
  if (!definition) return;
  if (!window.confirm(`確定刪除 EBAS 定義「${definition.name}」？`)) {
    return;
  }

  try {
    const response = await fetchJson(`/api/ebas/report-definitions?id=${encodeURIComponent(reportId)}`, {
      method: "DELETE"
    });
    state.definitions = response.definitions ?? [];
    renderDefinitions();
    await loadReports();
    showToast("報表定義已刪除");
  } catch (error) {
    showToast(error.message);
  }
}

function exportDefinitions() {
  const blob = new Blob([`${JSON.stringify(state.definitions, null, 2)}\n`], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `ebas-report-definitions-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function importDefinitions() {
  const file = elements.importDefinitionsFile.files?.[0];
  elements.importDefinitionsFile.value = "";
  if (!file) return;

  try {
    const text = await file.text();
    const definitions = normalizeDefinitions(JSON.parse(text));
    if (definitions.length === 0) {
      showToast("匯入檔案沒有可用 EBAS 定義");
      return;
    }

    const duplicateNames = definitions
      .filter((definition) => state.definitions.some((item) => item.id === definition.id))
      .map((definition) => `${definition.name} (${definition.id})`);
    if (duplicateNames.length > 0 && !window.confirm(`以下定義已存在，是否覆蓋？\n${duplicateNames.join("\n")}`)) {
      return;
    }

    const response = await fetchJson("/api/ebas/report-definitions/import", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ definitions })
    });
    state.definitions = response.definitions ?? [];
    renderDefinitions();
    await loadReports();
    showToast("EBAS 定義已匯入");
  } catch (error) {
    showToast(`匯入失敗：${error.message}`);
  }
}

function readDefinitionForm() {
  return {
    id: elements.definitionId.value.trim(),
    name: elements.definitionName.value.trim(),
    description: elements.definitionDescription.value.trim(),
    menuPath: elements.definitionMenuPath.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
    businessType: elements.definitionBusinessType.value.trim(),
    fundType: elements.definitionFundType.value.trim(),
    year: elements.definitionYear.value.trim(),
    stage: elements.definitionStage.value.trim(),
    outputFormat: elements.definitionOutputFormat.value.trim(),
    kind: elements.definitionKind.value.trim(),
    kindOptions: elements.definitionKindOptions.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
    printLevel: elements.definitionPrintLevel.value.trim(),
    usagePrintStopLevel: elements.definitionUsagePrintStopLevel.value.trim(),
    accountLevel: elements.definitionAccountLevel.value.trim(),
    accountCode: elements.definitionAccountCode.value.trim(),
    accountPrintLevel: elements.definitionAccountPrintLevel.value.trim()
  };
}

function defaultDefinitionForm() {
  return {
    id: "ebas-1103-balance-sheet",
    name: "EBAS 1103 資產負債表",
    description: "營業基金決(結)算編製，Excel 下載。",
    menuPath: ["營業基金", "決(結)算", "決算書表", "書表列印", "決算主要表", "資產負債表"],
    businessType: "單位",
    fundType: "決(結)算編製",
    year: "114",
    stage: "院編決算",
    outputFormat: "excel",
    kind: "",
    kindOptions: [],
    printLevel: "不適用",
    usagePrintStopLevel: "不適用",
    accountLevel: "不適用",
    accountCode: "不適用",
    accountPrintLevel: "不適用"
  };
}

async function createDownloadTask() {
  try {
    elements.createTaskButton.disabled = true;
    const parameters = readParameters();
    const response = await callMcpTool("create_download_task", {
      reportId: state.selectedReportId,
      debug: elements.debugToggle.checked,
      browserMode: elements.browserModeSelect.value,
      parameters
    });

    state.currentTask = parseToolResponse(response);
    state.currentTaskType = "single";
    state.currentResult = null;
    renderTask();
    renderResult(null);
    showToast("下載任務已建立");
    startPolling();
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.createTaskButton.disabled = false;
  }
}

function addBatchItem() {
  if (!state.selectedReportId) {
    showToast("請先選擇報表");
    return;
  }

  const report = state.reports.find((item) => item.id === state.selectedReportId);
  state.batchItems.push({
    reportId: state.selectedReportId,
    reportName: report?.name ?? state.selectedReportId,
    parameters: readParameters()
  });
  void saveBatchItems();
  renderBatchItems();
  showToast("已加入批次清單");
}

function removeBatchItem(index) {
  state.batchItems.splice(index, 1);
  void saveBatchItems();
  renderBatchItems();
}

function clearBatchItems() {
  state.batchItems = [];
  void saveBatchItems();
  renderBatchItems();
  showToast("已清空目前批次清單");
}

function applyBatchYear() {
  const year = elements.batchYearInput.value.trim();
  if (!year) {
    showToast("請輸入年度");
    return;
  }
  applyBatchParameter("year", year, "年度");
}

function applyBatchParameter(name, value, label) {
  const nextValue = String(value ?? "").trim();
  if (!nextValue) {
    showToast(`請輸入${label}`);
    return;
  }
  if (state.batchItems.length === 0) {
    showToast("批次清單目前沒有報表");
    return;
  }

  const count = state.batchItems.length;
  state.batchItems = state.batchItems.map((item) => ({
    ...item,
    parameters: {
      ...item.parameters,
      [name]: nextValue
    }
  }));
  void saveBatchItems();
  renderBatchItems();
  showToast(`已將目前批次 ${count} 筆${label}改為 ${formatBatchParameterValue(name, nextValue)}。`);
}

async function createBatchDownloadTask() {
  if (state.batchItems.length === 0) {
    showToast("請先加入至少一個報表");
    return;
  }

  try {
    const parallelism = Number(elements.parallelismSelect?.value || "1");
    const usableWorkers = state.workerStatuses.filter((worker) => worker.storageStateExists).length;
    if (parallelism > usableWorkers) {
      showToast(`目前只有 ${usableWorkers} 個已儲存 session 的工作站，無法以平行執行數 ${parallelism} 建立任務。`);
      return;
    }

    elements.createBatchTaskButton.disabled = true;
    const response = await callMcpTool("create_batch_download_task", {
      debug: elements.debugToggle.checked,
      browserMode: elements.browserModeSelect.value,
      continueOnError: elements.continueOnErrorToggle.checked,
      parallelism,
      retryEnabled: elements.retryEnabledToggle.checked,
      maxRetries: Number(elements.maxRetriesInput.value || "3"),
      retryDelaySeconds: Number(elements.retryDelayInput.value || "5"),
      items: state.batchItems.map((item) => ({
        reportId: item.reportId,
        parameters: item.parameters
      }))
    });

    state.currentTask = parseToolResponse(response);
    state.currentTaskType = "batch";
    state.currentResult = null;
    renderTask();
    renderResult(null);
    showToast("批次下載任務已建立");
    startPolling();
  } catch (error) {
    showToast(error.message);
  } finally {
    renderBatchItems();
  }
}

function renderBatchItems() {
  elements.createBatchTaskButton.disabled = state.batchItems.length === 0;
  if (elements.presetBatchCount) {
    elements.presetBatchCount.textContent = `共 ${state.batchItems.length} 筆`;
  }

  renderBatchList(elements.batchList, { removable: true, removePrefix: "main" });
  renderBatchList(elements.presetBatchList, { removable: true, removePrefix: "preset" });
}

function renderBatchList(container, options = {}) {
  if (!container) return;
  const { removable = true, removePrefix = "batch" } = options;

  if (!state.batchItems.length) {
    container.innerHTML = `<span class="muted">尚未加入報表</span>`;
    return;
  }

  container.innerHTML = state.batchItems.map((item, index) => `
    <article class="batch-item">
      <div>
        <strong>${escapeHtml(item.reportName)}</strong>
        <p>${escapeHtml(item.reportId)}</p>
        <small>${escapeHtml(formatParameters(item.parameters))}</small>
      </div>
      ${removable ? `<button class="ghost-button compact-button" type="button" data-remove-batch="${index}" data-remove-source="${escapeHtml(removePrefix)}">移除</button>` : ""}
    </article>
  `).join("");

  container.querySelectorAll("[data-remove-batch]").forEach((button) => {
    button.addEventListener("click", () => removeBatchItem(Number(button.dataset.removeBatch)));
  });
}

function renderBatchPresets() {
  if (!state.newPresetMode && !state.selectedPresetId && state.batchPresets[0]) {
    state.selectedPresetId = state.batchPresets[0].id;
  }

  elements.presetSelect.innerHTML = state.batchPresets.length
    ? `${state.newPresetMode ? `<option value="" selected>新範本</option>` : ""}${state.batchPresets.map((preset) =>
        `<option value="${escapeHtml(preset.id)}" ${preset.id === state.selectedPresetId ? "selected" : ""}>${escapeHtml(preset.name)}</option>`
      ).join("")}`
    : `<option value="">尚未建立範本</option>`;

  const preset = selectedPreset();
  elements.presetName.value = preset?.name ?? "";
  elements.presetDescription.value = preset?.description ?? "";
  elements.continueOnErrorToggle.checked = preset?.continueOnError ?? elements.continueOnErrorToggle.checked;

  const hasPreset = Boolean(preset);
  elements.loadPresetReplaceButton.disabled = !hasPreset;
  elements.loadPresetAppendButton.disabled = !hasPreset;
  elements.deletePresetButton.disabled = !hasPreset;
  elements.movePresetUpButton.disabled = !hasPreset || state.batchPresets.findIndex((item) => item.id === state.selectedPresetId) <= 0;
  elements.movePresetDownButton.disabled = !hasPreset ||
    state.batchPresets.findIndex((item) => item.id === state.selectedPresetId) >= state.batchPresets.length - 1;
}

function selectBatchPreset(presetId) {
  state.selectedPresetId = presetId;
  state.newPresetMode = false;
  renderBatchPresets();
}

function startNewBatchPreset() {
  state.selectedPresetId = "";
  state.newPresetMode = true;
  elements.presetSelect.value = "";
  elements.presetName.value = "";
  elements.presetDescription.value = "";
  renderBatchPresets();
  elements.presetName.focus();
}

function selectedPreset() {
  return state.batchPresets.find((preset) => preset.id === state.selectedPresetId);
}

function refreshBatchReportNames() {
  if (!state.batchItems.length) return;

  state.batchItems = state.batchItems.map((item) => {
    const report = state.reports.find((candidate) => candidate.id === item.reportId);
    return {
      ...item,
      reportName: report?.name ?? item.reportName ?? item.reportId
    };
  });
  void saveBatchItems();
}

function startPolling() {
  stopPolling();
  state.pollTimer = window.setInterval(() => pollTask(), 500);
  void pollTask();
}

function stopPolling() {
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function cancelCurrentTask() {
  const taskId = state.currentTask?.id;
  const type = state.currentTaskType;
  if (!taskId || !["queued", "running"].includes(state.currentTask.status) || state.cancelRequestedId === taskId) return;
  state.cancelRequestedId = taskId;
  renderTask();
  try {
    const response = await callMcpTool(type === "batch" ? "cancel_batch_download_task" : "cancel_download_task", { taskId });
    if (state.currentTask?.id !== taskId || state.currentTaskType !== type) return;
    state.currentTask = parseToolResponse(response);
    renderTask();
    await pollTask();
  } catch (error) {
    if (state.currentTask?.id === taskId) { state.cancelRequestedId = null; renderTask(); }
    showToast(error.message);
  }
}

async function pollTask() {
  if (!state.currentTask?.id) return;

  const taskId = state.currentTask.id;
  const type = state.currentTaskType;
  const response = await callMcpTool(type === "batch" ? "get_batch_download_task" : "get_download_task", { taskId });
  if (state.currentTask?.id !== taskId || state.currentTaskType !== type) return;
  const next = parseToolResponse(response);
  if (["completed", "failed", "partial_failed", "cancelled"].includes(state.currentTask.status) && ["queued", "running", "cancelling"].includes(next.status)) return;
  if (next.updatedAt && state.currentTask.updatedAt && next.updatedAt < state.currentTask.updatedAt) return;
  state.currentTask = next;
  if (!["queued", "running", "cancelling"].includes(next.status)) state.cancelRequestedId = null;
  renderTask();

  if (["completed", "partial_failed"].includes(state.currentTask.status)) {
    stopPolling();
    await loadResult();
  }

  if (state.currentTask.status === "cancelled") {
    stopPolling();
    showToast("任務已中斷，已完成的下載檔案仍保留。");
  }
  if (state.currentTask.status === "failed") {
    stopPolling();
    showToast(state.currentTask.errorMessage || "下載任務失敗");
  }
}

async function loadResult() {
  const response = await callMcpTool(state.currentTaskType === "batch" ? "get_batch_download_result" : "get_download_result", {
    taskId: state.currentTask.id
  });
  state.currentResult = parseToolResponse(response);
  renderResult(state.currentResult);
  showToast("結果已載入");
}

function computeBatchDashboard(task) {
  const items = task.items ?? [];
  const total = items.length || Number(task.totalCount ?? 0) || 0;
  const counts = items.reduce((acc, item) => {
    const status = item.status || "pending";
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});
  const completed = Number(task.completedCount ?? counts.completed ?? 0);
  const failed = Number(task.failedCount ?? counts.failed ?? 0);
  const skipped = Number(task.skippedCount ?? counts.skipped ?? 0);
  const cancelled = Number(task.cancelledCount ?? counts.cancelled ?? 0);
  const retrying = Number(counts.retrying ?? 0);
  const running = Number((counts.running ?? 0) + (counts.downloading ?? 0) + (counts.cancelling ?? 0));
  const queued = Math.max(0, total - completed - failed - skipped - cancelled - retrying - running);
  const done = completed + failed + skipped + cancelled;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  return { total, completed, failed, skipped, cancelled, retrying, running, queued, percent };
}

function renderDashboardMetric(label, value, className = "") {
  return `
    <div class="dashboard-card ${escapeHtml(className)}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(String(value))}</strong>
    </div>
  `;
}

function updateBrowserModeWarning() {
  elements.browserModeWarning.hidden = !(elements.debugToggle.checked && elements.browserModeSelect.value === "headless");
}

function formatBrowserMode(mode) {
  return mode === "headless" ? "無頭模式" : mode === "headed" ? "顯示瀏覽器視窗" : "未記錄（舊任務）";
}

function formatTaskStatus(status) {
  const labels = {
    queued: "排隊中",
    cancelling: "正在中斷",
    cancelled: "已中斷",
    running: "執行中",
    retrying: "重試中",
    completed: "已完成",
    failed: "失敗",
    skipped: "已略過",
    partial_failed: "部分失敗"
  };
  return labels[String(status)] ?? String(status ?? "-");
}

function renderBatchDashboard(task) {
  const dashboard = computeBatchDashboard(task);
  return `
    <div class="task-dashboard">
      ${renderDashboardMetric("總筆數", dashboard.total)}
      ${renderDashboardMetric("成功", dashboard.completed, "success")}
      ${renderDashboardMetric("執行中", dashboard.running, "running")}
      ${renderDashboardMetric("重試中", dashboard.retrying, "retrying")}
      ${renderDashboardMetric("失敗", dashboard.failed, "failed")}
      ${renderDashboardMetric("略過", dashboard.skipped, "skipped")}
      ${renderDashboardMetric("中斷", dashboard.cancelled, "cancelled")}
    </div>
    <div class="progress-block">
      <div class="progress-heading">
        <strong>完成率</strong>
        <span>${dashboard.percent}%</span>
      </div>
      <div class="progress-track" aria-label="完成率 ${dashboard.percent}%">
        <div class="progress-bar" style="width: ${dashboard.percent}%"></div>
      </div>
    </div>
  `;
}

function renderSingleTaskDashboard(task) {
  const isDone = ["completed", "failed", "cancelled"].includes(task.status);
  const percent = isDone ? 100 : 0;
  return `
    <div class="task-dashboard single-dashboard">
      ${renderDashboardMetric("狀態", formatTaskStatus(task.status))}
      ${renderDashboardMetric("資料列", task.rowCount ?? "-")}
      ${renderDashboardMetric("Debug", task.debugEnabled ? "on" : "off")}
    </div>
    <div class="progress-block">
      <div class="progress-heading">
        <strong>${isDone ? "任務已結束" : "任務進行中"}</strong>
        <span>${percent}%</span>
      </div>
      <div class="progress-track" aria-label="任務進度 ${percent}%">
        <div class="progress-bar" style="width: ${percent}%"></div>
      </div>
    </div>
  `;
}

function formatBatchStatusDetail(item) {
  const detail = item.filePath ?? (item.status === "cancelled" ? "已中斷，未完成下載" : item.errorMessage ?? item.lastErrorMessage ?? "-");
  const parts = [];
  if (item.attempt) {
    parts.push(`第 ${item.attempt} 次執行`);
  }
  if (item.status === "retrying") {
    const maxRetries = item.maxRetries ?? 3;
    const retryCount = item.retryCount ?? 0;
    parts.push(`重試中 ${retryCount}/${maxRetries}`);
    if (item.nextRetryAt) {
      parts.push(`下次重試：${new Date(item.nextRetryAt).toLocaleTimeString()}`);
    }
  }
  return parts.length ? `${parts.join("；")}｜${detail}` : detail;
}

function renderCancelTaskButton(task) {
  if (!["queued", "running", "cancelling"].includes(task.status)) return "";
  const pending = task.status === "cancelling" || state.cancelRequestedId === task.id;
  return `<button type="button" class="ghost-button compact-button danger-button" data-cancel-task ${pending ? "disabled" : ""}>${pending ? "正在中斷…" : "中斷任務"}</button>`;
}

function renderTask() {
  const task = state.currentTask;
  if (!task) {
    elements.taskSummary.innerHTML = `<span class="muted">尚未建立任務</span>`;
    return;
  }

  if (state.currentTaskType === "batch") {
    elements.taskSummary.innerHTML = `
      <div class="task-summary-header">
        <span class="status-pill ${escapeHtml(task.status)}">${escapeHtml(formatTaskStatus(task.status))}</span>
        <span class="task-id">Batch Task ID：${escapeHtml(task.id)}</span>
        ${renderCancelTaskButton(task)}
      </div>
      ${renderBatchDashboard(task)}
      <div class="task-options-summary">
        <div class="summary-row"><strong>瀏覽器模式</strong><span>${escapeHtml(formatBrowserMode(task.browserMode))}</span></div>
        <div class="summary-row"><strong>平行執行數</strong><span>${escapeHtml(String(task.parallelism ?? 1))}</span></div>
        <div class="summary-row"><strong>失敗自動重試</strong><span>${task.retryEnabled === false ? "off" : "on"}</span></div>
        <div class="summary-row"><strong>重試設定</strong><span>${escapeHtml(String(task.maxRetries ?? 3))} 次 / ${escapeHtml(String(task.retryDelaySeconds ?? 5))} 秒</span></div>
        <div class="summary-row"><strong>Debug</strong><span>${task.debugEnabled ? "on" : "off"}</span></div>
      </div>
      <div class="batch-status-list">
        ${(task.items ?? []).map((item, index) => `
          <article class="batch-status-item">
            <span class="status-pill ${escapeHtml(item.status)}">${escapeHtml(formatTaskStatus(item.status))}</span>
            <div>
              <strong>${escapeHtml(String(index + 1))}. ${escapeHtml(item.reportId)} ${item.workerId ? `(工作站 ${escapeHtml(item.workerId)})` : ""}</strong>
              <p>${escapeHtml(formatBatchStatusDetail(item))}</p>
            </div>
          </article>
        `).join("")}
      </div>
      ${task.errorMessage ? `<div class="error-box">${escapeHtml(task.errorMessage)}</div>` : ""}
    `;
    return;
  }

  elements.taskSummary.innerHTML = `
    <div class="task-summary-header">
      <span class="status-pill ${escapeHtml(task.status)}">${escapeHtml(formatTaskStatus(task.status))}</span>
      <span class="task-id">Task ID：${escapeHtml(task.id)}</span>
      ${renderCancelTaskButton(task)}
    </div>
    ${renderSingleTaskDashboard(task)}
    <div class="task-options-summary">
      <div class="summary-row"><strong>瀏覽器模式</strong><span>${escapeHtml(formatBrowserMode(task.browserMode))}</span></div>
      <div class="summary-row"><strong>Report</strong><span>${escapeHtml(task.reportId)}</span></div>
      <div class="summary-row"><strong>File</strong><span>${escapeHtml(task.filePath ?? "-")}</span></div>
      ${task.debugDir ? `<div class="summary-row"><strong>Debug Dir</strong><span>${escapeHtml(task.debugDir)}</span></div>` : ""}
      ${task.errorCode ? `<div class="summary-row"><strong>Error Code</strong><span>${escapeHtml(task.errorCode)}</span></div>` : ""}
    </div>
    ${task.errorMessage ? `<div class="error-box">${escapeHtml(task.errorMessage)}</div>` : ""}
  `;
}

function renderResult(result) {
  // 一般使用者只需要任務狀態總覽與子任務進度；
  // 解析結果表格與原始 JSON 不再顯示，避免資訊重複與版面複雜。
  void result;
}

async function callManualTool() {
  try {
    const toolName = elements.toolSelect.value;
    const args = JSON.parse(elements.toolArgs.value || "{}");
    const response = await callMcpTool(toolName, args);
    elements.rawResponse.textContent = getToolText(response);
    showToast("工具呼叫完成");
  } catch (error) {
    elements.rawResponse.textContent = error.message;
    showToast(error.message);
  }
}

function seedToolArgs(toolName) {
  const examples = {
    list_available_reports: {},
    get_report_parameters: { reportId: "sales-summary" },
    create_download_task: {
      reportId: "sales-summary",
      debug: false,
      parameters: {
        startDate: "2026-06-01",
        endDate: "2026-06-15",
        channel: "online"
      }
    },
    create_batch_download_task: {
      debug: false,
      continueOnError: true,
      retryEnabled: true,
      maxRetries: 3,
      retryDelaySeconds: 5,
      items: [
        {
          reportId: "sales-summary",
          parameters: {
            startDate: "2026-06-01",
            endDate: "2026-06-15",
            channel: "online"
          }
        }
      ]
    },
    get_download_task: { taskId: "paste-task-id-here" },
    get_batch_download_task: { taskId: "paste-batch-task-id-here" },
    get_download_result: { taskId: "paste-task-id-here" },
    get_batch_download_result: { taskId: "paste-batch-task-id-here" },
    parse_download_file: { filePath: "paste-file-path-here" }
  };
  elements.toolArgs.value = JSON.stringify(examples[toolName] ?? {}, null, 2);
}

function readParameters() {
  const inputs = elements.parameterFields.querySelectorAll("[data-param]");
  const values = [...inputs].reduce((parameters, input) => {
    parameters[input.dataset.param] = input.value;
    return parameters;
  }, {});

  for (const parameter of state.parameters) {
    const fallback = defaultValueFor(parameter);
    if (values[parameter.name] === undefined || values[parameter.name] === "") {
      values[parameter.name] = fallback;
    }
  }

  return values;
}

function defaultValueFor(parameter) {
  if (parameter.defaultValue !== undefined) return parameter.defaultValue;
  if (parameter.name === "startDate") return "2026-06-01";
  if (parameter.name === "endDate") return "2026-06-15";
  if (parameter.name === "asOfDate") return "2026-06-15";
  if (parameter.name === "year") return "114";
  if (parameter.type === "enum") return parameter.options?.[0] ?? "";
  return "";
}

function formatOptionLabel(name, value) {
  if (name !== "outputFormat") return value;
  const labels = {
    pdf: "PDF",
    excel: "Excel",
    xml: "XML"
  };
  return labels[String(value).toLowerCase()] ?? value;
}

function formatBatchParameterValue(name, value) {
  return name === "outputFormat" ? formatOptionLabel(name, value) : value;
}

function formatParameters(parameters) {
  return Object.entries(parameters)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

function normalizeParameters(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, item === undefined ? "" : String(item)])
  );
}

function normalizeDefinitions(value) {
  const rows = Array.isArray(value) ? value : [value];
  return rows
    .map((definition) => {
      const kindOptions = Array.isArray(definition?.kindOptions)
        ? definition.kindOptions.map((item) => String(item).trim()).filter(Boolean)
        : String(definition?.kindOptions ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      const uniqueKindOptions = [...new Set(kindOptions)];
      const kind = String(definition?.kind ?? uniqueKindOptions[0] ?? "").trim();

      return {
        id: String(definition?.id ?? "").trim(),
        name: String(definition?.name ?? "").trim(),
        description: String(definition?.description ?? "").trim(),
        menuPath: Array.isArray(definition?.menuPath)
          ? definition.menuPath.map((item) => String(item).trim()).filter(Boolean)
          : String(definition?.menuPath ?? "").split(/\r?\n|>/).map((item) => item.trim()).filter(Boolean),
        businessType: String(definition?.businessType ?? "").trim(),
        fundType: String(definition?.fundType ?? "").trim(),
        year: String(definition?.year ?? "").trim(),
        stage: String(definition?.stage ?? "").trim(),
        outputFormat: String(definition?.outputFormat ?? "").trim(),
        kind,
        kindOptions: kind && !uniqueKindOptions.includes(kind)
          ? [kind, ...uniqueKindOptions]
          : uniqueKindOptions,
        printLevel: String(definition?.printLevel ?? "\u4e0d\u9069\u7528").trim(),
        usagePrintStopLevel: String(definition?.usagePrintStopLevel ?? "\u4e0d\u9069\u7528").trim(),
        accountLevel: String(definition?.accountLevel ?? "\u4e0d\u9069\u7528").trim(),
        accountCode: String(definition?.accountCode ?? "\u4e0d\u9069\u7528").trim(),
        accountPrintLevel: String(definition?.accountPrintLevel ?? "\u4e0d\u9069\u7528").trim()
      };
    })
    .filter((definition) => definition.id && definition.name);
}

function normalizeBatchItems(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      reportId: String(item?.reportId ?? ""),
      reportName: String(item?.reportName ?? item?.reportId ?? ""),
      parameters: normalizeParameters(item?.parameters)
    }))
    .filter((item) => item.reportId);
}

function normalizeBatchPresets(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((preset) => ({
      id: String(preset?.id ?? globalThis.crypto?.randomUUID?.() ?? Date.now()),
      name: String(preset?.name ?? "").trim(),
      description: String(preset?.description ?? "").trim(),
      continueOnError: preset?.continueOnError !== false,
      items: normalizeBatchItems(preset?.items),
      createdAt: String(preset?.createdAt ?? new Date().toISOString()),
      updatedAt: String(preset?.updatedAt ?? new Date().toISOString())
    }))
    .filter((preset) => preset.name);
}

function cloneBatchItems(items) {
  return normalizeBatchItems(JSON.parse(JSON.stringify(items ?? [])));
}

function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function readLegacyBatchItems() {
  try {
    return normalizeBatchItems(JSON.parse(localStorage.getItem(storageKeys.legacyBatchItems) || "[]"));
  } catch {
    return [];
  }
}

async function callMcpTool(toolName, args = {}) {
  return fetchJson("/api/mcp/call", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      toolName,
      arguments: args
    })
  });
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message ?? `Request failed: ${response.status}`);
  }

  return data;
}

function parseToolResponse(response) {
  return JSON.parse(getToolText(response));
}

function getToolText(response) {
  const text = response.content?.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("MCP response does not contain text content.");
  }
  return text;
}

function markServer(ok, text) {
  elements.serverDot.classList.toggle("ok", ok);
  elements.serverDot.classList.toggle("error", !ok);
  elements.serverStatus.textContent = text;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    elements.toast.classList.remove("visible");
  }, 2600);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function initTheme() {
  const theme = localStorage.getItem(storageKeys.theme);
  if (theme === "dark") {
    document.body.classList.add("dark-theme");
  } else if (theme === "light") {
    document.body.classList.add("light-theme");
  }
}

function toggleTheme() {
  const isDark = document.body.classList.contains("dark-theme") || 
                 (!document.body.classList.contains("light-theme") && window.matchMedia("(prefers-color-scheme: dark)").matches);
  if (isDark) {
    document.body.classList.remove("dark-theme");
    document.body.classList.add("light-theme");
    localStorage.setItem(storageKeys.theme, "light");
    showToast("已切換至淺色模式");
  } else {
    document.body.classList.remove("light-theme");
    document.body.classList.add("dark-theme");
    localStorage.setItem(storageKeys.theme, "dark");
    showToast("已切換至深色模式");
  }
}

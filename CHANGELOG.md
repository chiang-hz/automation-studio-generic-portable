
## v2.4.8 — Python 批次失敗策略選項顯示修正

- 修正 v2.4.7 的 `frontend/dist/studio.js` 與 `public/modern/studio.js` 不同步，導致發布與版本頁面缺少「批次任務失敗時」選項。
- 更新首頁 `/modern/studio.js` 資產版本參數，避免舊瀏覽器快取繼續載入舊功能。
- `scripts/install-frontend.mjs` 安裝前端時同步複製最新的編譯 JS，防止未來再次發生。
- 原有 `batch-settings.json` 匯出設定與 `--on-error` 覆寫邏輯維持不變。

## v2.4.7 — Python batch error policy

- Python batch now defaults to continue after failed rows.
- Export UI allows continue/stop and saves batch-settings.json for Selenium and Playwright.
- --on-error overrides export-time preference.

## v2.4.6 — Python batch export (JSON / CSV / XLSX)

- Python Selenium / Playwright exports can include `batch_runner.py`, `run-batch.bat`, `run-batch-cdp.bat`, `batch.json`, and CSV example.
- Support sequential enabled-row runs, stop/continue policy, per-row logs, and JSON/CSV summaries.
- Accept Automation Studio batch JSON/CSV, plus Excel with column headers matching parameter keys.
- Export current Batch Grid rows only with explicit opt-in and redact sensitive/secret parameters.
- CDP batch reuses authorized local Chrome; no parallel access to the same login profile.
- Batch parameter temp files are cleared after each row; check-only runs offline.

## v2.4.5 - Windows Schannel revocation failure during Node.js bootstrap

- Fix `setup-runtime.bat` stopping immediately with `curl: (35) ... CRYPT_E_NO_REVOCATION_CHECK` when bundled `runtime\node\node.exe` is missing. The previous bootstrap only recognized curl exit 60; Schannel revocation lookup failures can return exit 35.
- Download Node.js with normal TLS validation first. Only after curl 35, retry with `--ssl-revoke-best-effort` and then, only if still 35, `--ssl-no-revoke`. Both preserve certificate-chain verification. Existing curl 60 fallback remains scoped to the pinned Node.js download.
- All download paths validate the pinned SHA-256 before the downloaded binary is executed. No global TLS environment bypass; ordinary npm setup starts with certificate verification. Failed downloads report the actual curl exit code.
- Preserves v2.4.4 Chrome detection, project-local setup temporary directory, EPERM/EXDEV recovery, Python exports and existing project data. Windows enterprise proxy restrictions may still require an approved CA or proxy configuration.

## v2.4.4 - Use existing Chrome; skip unnecessary Playwright browser downloads

- `setup-runtime.bat` now checks for installed Google Chrome **after** installing the Node packages and, when found, skips Playwright browser installation altogether. None of `chromium-*`, `chromium_headless_shell-*`, `ffmpeg-*`, or `winldd-*` is downloaded by the default setup in that case.
- Browser selection preserves existing workflow settings: a project configured for `bundled` transparently falls back to installed Chrome only when the bundled Chromium is absent. An explicitly selected Chrome still uses Chrome. No Edge fallback or workflow JSON rewrite.
- Supports Chrome in standard per-user / Program Files locations plus `CHROME_PATH`, `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`, and `CHROMIUM_EXECUTABLE_PATH` overrides.
- If no local Chrome is found, the installer retains the v2.4.3 bundled-Chromium installation path. To explicitly install bundled Chromium even with Chrome detected, run `setup-runtime.bat --install-bundled-browser`.
- Existing browser binaries are **not deleted** automatically. Video recording with Playwright is not part of this project's current functionality; bundled Chromium and its tools are only needed when the user chooses that browser or local Chrome cannot be used.
- Preserves temporary-path staging on the project drive, EPERM/EXDEV recovery, per-download TLS policy and package integrity checks.

## v2.4.3 - Windows EPERM package install recovery

- Fix `EPERM: operation not permitted, rename .../extracted -> .../node_modules/concat-map` on restricted or heavily scanned Windows machines. Retry transient `EPERM`, `EACCES` and `EBUSY` errors with bounded delays, then use safe directory-copy fallback when the target path is absent. `EXDEV` still falls back to copy.
- If copying is interrupted by a transient lock, clean partial output before retrying; never silently merge files into an already-existing package destination. Verify the package version after installing.
- Preserve previous package versions when a replacement fails. Clean staging on success, retain recovery backup if restoration fails, and show actionable diagnostics if corporate access controls also prevent copying.
- Keep v2.4.2 same-volume temporary files, TLS issuer-only fallback, HTTPS restrictions and mandatory SHA-512 package integrity checks; no global TLS bypass.
- Installed and verified versions are skipped on re-run. No user project/workflow/CDP/Playwright behavior changes. Added Windows lock/retry/copy/rollback regression tests.

## v2.4.2 - Setup Runtime TLS issuer recovery and same-volume staging

- `setup-runtime.bat` uses `.local\setup-temp` beneath the current project directory for `TEMP`, `TMP` and `TMPDIR`. Both node.exe bootstrap and npm-package extraction now keep temporary files on the same drive as the installation destination, eliminating the standard C: -> D: `EXDEV` rename failure.
- Node package HTTPS transfers first verify certificates. On issuer-chain errors only, retry **that single HTTPS request** with certificate verification disabled, and enforce the original manifest's pinned SHA-512 integrity before unpacking. Subsequent HTTPS requests re-enable certificate verification automatically. Network/HTTP errors do not trigger insecure retries.
- Playwright Chromium installation similarly starts with normal TLS; on verified issuer-error output only, it retries in a separate one-time subprocess with TLS validation disabled. Parent process and `start.bat` never inherit this exception. Prefer a company-approved `NODE_EXTRA_CA_CERTS` when available.
- Downloading pinned `node.exe` retains curl's certificate-verified first attempt and a fallback only for curl error 60, with mandatory pinned SHA-256 before execution. The exception is limited to that transfer.
- `EXDEV` move fallback copies the unpacked directory, cleans the source, and preserves/restores the previous package on installation failures. Added offline tests for TLS recovery/restoration, SHA-512 verification, project-volume staging, `EXDEV`, Chromium fallback and idempotent installs.
- Preserves Python Selenium/Playwright downloads, CDP, Stealth options, workflows and the app's runtime package manifest; no workflow JSON format change.

## v2.4.1 - Python browser download isolation and artifact verification

- Selenium no longer redirects Chrome's browser-wide downloads to the official `downloads/` folder during startup. Only an explicit download action sets a unique `.local/download-staging/capture-*` directory; the browser default is restored in `finally`, including click failures and timeouts.
- Completed files are checked for Chrome CRX component signatures (including CRX files disguised as `downloads.htm`), Office/PDF type mismatches, and HTML login/error pages when an Excel/PDF document was requested. Only validated action-window captures are promoted to `downloads/`.
- Suspicious or unrelated files remain in `.local/download-staging/` with `[DOWNLOAD-QUARANTINE]` and diagnostic messages; no silently deleting Chrome model files. Files created outside explicit download steps no longer get redirected into project `downloads/` by the exported Python runtime.
- Python Playwright `expect_download` and authenticated direct HTTP downloads also validate file identity before saving to the final folder. Preserve original name extension logic, collision numbering, profile/CDP login and dependency bootstrap.
- Selenium file monitoring is a bounded per-action capture, not proof of a CDP download-event identity. A legitimate unrelated download started during the same capture window with an indistinguishable format remains a residual attribution risk; do not claim full event-source attribution.
- Added tests for CRX + valid XLSX simultaneously, bad HTML, default routing restoration, source format checks and Playwright event-backed downloads.

## v2.4.0 - Python Download Extension Preservation

- Python Selenium and Playwright downloads now preserve server/browser file extensions when a custom name has no extension.
- Direct HTTP downloads read Content-Disposition (including UTF-8 filename*) and Content-Type instead of guessing from a dynamic .ashx / .php URL.
- When file names and headers lack extensions, detect specific file magic signatures and inspect Office ZIP members (XLSX/DOCX/PPTX) before naming; otherwise report [DOWNLOAD-WARN] and keep the extensionless name rather than guessing.
- Existing explicit custom extensions stay unchanged. Collisions use numbered names rather than overwriting a previous file.
- Applies to newly exported Python engines and a drop-in engine.py repair; unrelated selectors, CDP, and dependency bootstrap are unchanged.
- Regression tests cover download naming for both Python backends and all download methods.

## v2.3.9 — Selenium Fixed Header Click / Download Repair

- Selenium `click` 與瀏覽器下載均在點擊前將元素置中，避免固定導覽列遮擋。
- 只在 ChromeDriver 回報真正的 `ElementClickInterceptedException` 時嘗試短暫重捲，仍遮擋則停止；不使用 JavaScript 強制點擊。
- 同步用於 check/uncheck，保留 CDP、Managed Browser、原 TypeScript 與 Playwright 功能。

## v2.3.8 - Selenium active dropdown popup disambiguation

- 修正 v2.3.7 已轉換成精確 `role=option` 但仍偵測到 2 個同名選項的問題；Python Selenium 會記錄上一步真正點擊的 combobox，優先使用其 `aria-controls` / `aria-owns` 限定作用中的清單。
- 改善 Selenium 的 `role` 查找：忽略 ARIA 隱藏、inert、hidden 區域內的選項，貼近 Playwright 的 accessible role 語意。
- 當 ARIA 關聯無法區分重複選項時，利用瀏覽器命中測試僅選擇唯一可由滑鼠命中的候選項；若仍非唯一則安全停止並列出候選項的 popup、狀態與位置。
- 修正適用於所有新版 Selenium Python 匯出專案，**不會**自動修改既有 workflow.json，原來的 run-cdp.bat、登入復原、依賴安裝與 TS/Playwright 匯出保持不變。
- 新增真實離線 Chromium 回歸案例：兩個同名選項位於不同選單、ARIA 不可存取項目、重疊選項，以及同一有效選單真的重複（應拒絕）。未在使用者實際網站完成端到端驗收。

## v2.3.7 - Selenium dropdown semantic locator repair

- When recorded dropdown selectors include a broad CSS `[role="option"]` plus exactly one `text` rule with `exact: true`, the Selenium Python runtime combines them into `role=option` and the exact accessible name. This prevents two visible options or duplicated outer/inner text from triggering false ambiguity.
- Explicit `role=option` / exact-name locators take precedence and never degrade to broad fallback selectors that might click another option if the named target disappears.
- Preserve explicit `matchMode: first|last|nth` semantics, and preserve normal behavior for unrelated selectors without exact option evidence.
- Keep `unique` fail-closed behavior if multiple genuinely identical options exist. No automatic first-item selection and no changes to the original TypeScript executor or stored user workflows.
- New Chromium-backed regression tests include the recorded `決算報表` / `中央銀行` / `損益表` selector patterns, nested/duplicated labels and true duplicate options.
- Existing Python exports can be patched by replacing only `engine.py`; new Selenium exports include the fix automatically. Site-specific validation is still required.

## v2.3.6 - Selenium invalid selector / Playwright shorthand repair

- Fix ChromeDriver `invalid selector` in exported Selenium workflows where a CSS-typed locator is actually a Playwright XPath shorthand (`//...`, `xpath=...`, `..`) or a `css=` / `text=` prefixed locator. Selenium now routes XPath to XPath and text queries to the existing browser-side text resolver; CSS prefixes are removed safely.
- Apply the same locator routing to element interactions, selector-state waits, frame selection, list snapshots and the data extraction frame probe.
- When every locator fallback fails, show the selector strategy and an abbreviated rejected value rather than only a huge ChromeDriver stacktrace.
- Preserve unique/visible element checking; never auto-select an arbitrary match or retry submit actions.
- New regression tests exercise both previously invalid shortcuts and legitimate ambiguity failures.
- Site-specific selectors cannot be verified without the actual failing `workflow.json` / DOM. This fix is a generic compatibility repair, not a claim that the company website was re-tested.

## v2.3.5 - Python export dependency auto-install

- Python Playwright/Selenium ZIP exports now include `dependency_bootstrap.py` and `launch-python.bat`.
- `run.bat` and `run-cdp.bat` automatically verify `requirements.txt`, install missing/incompatible Python packages into a local `.local/python-env` virtual environment and then execute the workflow.
- Installed dependencies are reused on subsequent runs; no administrator privileges, global pip changes or separate Node.js install required for Selenium.
- Prefer trusted local `wheelhouse/` wheels before normal verified-HTTPS pip index; support offline-only and auto-install opt-out environment flags. Never disable TLS checks.
- `--check-only` stays offline and does not install packages or open Chrome. Errors about pip, proxy, CA and wheelhouse are explicit.
- Does not bundle Python/Chrome or modify CDP/Managed Browser authentication behavior. Selenium ChromeDriver availability remains a separate browser-driver prerequisite.

## v2.3.4 - Selenium Python 全動作元件相容強化

- 依 v2.3.3 `StepKind` 定義對齊 29 種動作元件，維持原 TypeScript/Playwright 相容。
- Selenium 支援 Playwright 擴充 CSS（`:has-text`, `:text`, `:text-is`, `:text-matches`, `:visible`）及 Chrome 原生 `:has`；支援角色、無障礙名稱、標籤與 placeholder 解析。
- 點擊、等待、清單快照、新增資料監控及資料擷取統一相容定位語意，不強迫使用者手動替換 CSS/XPath。
- 強化 Selenium iframe 搜尋、登入 CDP 工作階段下載位置、資料擷取等待及錯誤回報。
- `attached` / `hidden` / `visible` 等等待與驗證改為計算真正符合的元素，不再因多個可見按鈕錯誤通過 hidden 判斷。
- 條件分支與迴圈現在同樣進行步驟後驗證；下載驗證需要已保存的檔案。
- Python ZIP 根據 `saveDocument` 格式在 `requirements.txt` 自動列出 Word／Excel 套件；新增 `locator_compat.js`。
- 加入 Chromium 離線頁面驗證及新版 Python／TS 匯出測試。
- 限制：Stealth 非可攜動作元件，不會移植到 Selenium；Node.js 專用 JavaScript 及網站安全驗證仍須人工處理。沒有在使用者公司網站做完整 E2E。

## v2.3.3 - Python selector visibility and uniqueness parity

- Fixed exported Python Playwright and Selenium locators checking **all DOM matches** for
  `matchMode=unique`. They now follow the TypeScript engine: consider only visible
  elements outside responsive/mobile/drawer/offcanvas containers.
- Apply the same filtered candidate order to first, last and nth; preserve an explicit
  failure if multiple eligible desktop elements remain.
- Error messages include the selector strategy and the number of eligible matches.
- Added Playwright Chromium browser regressions and Selenium locator regression tests.
- Existing exported Python ZIPs can be patched by replacing their `engine.py` only.
- If a step legitimately matches two visible desktop buttons, narrow its selectors
  inside Automation Studio and re-export; do **not** force first/last blindly.

## v2.3.2 — Python CDP 一鍵執行

- Python Playwright / Selenium 匯出 ZIP 新增 `run-cdp.bat` 與 `cdp_bootstrap.py`，整合 Chrome 啟動、CDP 就緒檢查、人工登入與流程執行。
- Python runner 新增 `--cdp-endpoint`，執行期間覆寫為 CDP，不改寫工作流程 JSON。
- Chrome 使用專用持續登入 Profile（LocalAppData），連線限制於本機且不匯出 Cookie 或憑證。
- 未設定登入檢查的流程需人工確認登入完成；既有登入健康檢查則保持原來的自動判斷。
- Chrome 不可用、埠被占用、無法啟動 DevTools 等情況提供可讀錯誤訊息。
- v2.3.1 原有 29 種動作元件及 TypeScript 匯出功能不變。

# v2.3.1 — Python 動作元件相容性擴充（2026-10-25）

全面補齊 Python 匯出的 29 種流程動作元件（詳見文末 v2.3.1 說明）。

## v2.3.0 — Python 雙引擎精簡匯出（2026-10-25）

- 發布與版本新增 Python · Playwright 及 Python · Selenium 獨立專案 ZIP 選項；保留全部原匯出格式。
- Python 共用流程語意執行器、獨立 Managed Browser Profile、同一瀏覽器人工登入復原及 CDP 連線。
- Python 匯出前相容性檢查、禁止假成功執行尚未支援之 JS / Frame / Stealth / 週期刷新等步驟。
- 移除重複封裝：Python、Chrome、Selenium/Playwright 與 ChromeDriver 均不包含於流程 ZIP，可由共用環境部署。
- 新增 PYTHON-EXPORT-README.zh-TW.md 和 Python 匯出測試；不包含登入憑證或瀏覽器資料。
- 為維持安全，Python 無法直接解密 v2.2.4 Node 加密憑證庫；需持久化專用 Profile 或授權 CDP。

## v2.2.4 — Managed 登入狀態與人工驗證恢復

- 當已啟用的共用登入狀態無法在管理瀏覽器通過網站驗證時，有頭模式暫停，讓使用者自行完成正常登入或 Cloudflare 安全驗證，返回應用程式按「人工操作完成，繼續執行」後再次驗證。
- 無頭模式仍拒絕繼續，並明確提示必須由人員完成網站驗證。**不自動繞過 Cloudflare**。
- 同一批次工作站會保留已由使用者完成登入的 BrowserContext，供後續同一工作站的批次列繼續使用；不同工作站仍需獨立通過站台驗證。
- 批次沿用工作階段時，重新執行登入有效性檢查；失敗則停止同專案尚未執行的任務。
- 原有加密儲存與取消/暫停、匯出格式均保留。

## v2.2.3 — 非資訊人員登入狀態自動辨識

- CDP 登入後可直接列出專案允許網域中的已開啟網頁，選擇管理頁面，**自動填入登入檢查網址**；不再要求一般使用者輸入 URL。
- 新增「自動辨識」登入後專屬元素及「在 Chrome 點選」備援方式，自動填入 CSS。只有登入後看得到且無 Cookie 的對照頁看不到的元素才能通過辨識。
- 保留原始技術欄位，但置於預設收折的進階設定。保留手動備援、CDP 本機端點、加密保存、鎖定、解鎖、專案隔離及最多 3 個管理瀏覽器批次登入共用。
- 嚴格限制 CDP 本機連線及專案網域白名單，排除登入／OAuth 回呼頁，避免將網址查詢參數、Hash、授權碼寫入專案設定。
- 本機網頁未登入對照無法完成時拒絕自動確認，避免以公開 DOM 元件誤判登入；不擷取帳密或繞過 MFA。
- 內建已編譯介面透過本機 auth-state-panel.js 提供完整操作；若日後重新編譯 React 原始碼，也會沿用同一介面，避免出現重複設定。

## v2.2.2 — 登入狀態錯誤顯示修正
- 修復 API `error` 物件被顯示為 `[object Object]`，改顯示實際的 `message` 和可辨識錯誤代碼。
- 在 CDP 擷取和解鎖前驗證 HTTPS 網址、登入專屬 CSS、允許網域及本機 CDP 位址。
- 伺服器保留登入模組提供的錯誤代碼，方便診斷。
- 保持登入共用預設關閉，既有專案及自動化流程不變。

## v2.2.1 — CDP 登入狀態安全共用（2026-10-24）

- 在網站與瀏覽器工作站新增「CDP 登入狀態共用」設定，可從本機已登入的 Chrome 以 CDP 保存加密 Storage State，並在管理模式解鎖後載入。
- 使用 AES-256-GCM 與 scrypt，依專案及 HTTPS origin 限定、預設停用、最多保存 24 小時，密語與登入資料不進入工作流程或匯出 ZIP。
- 非 CDP 批次（最多 3 個瀏覽器）每一工作使用獨立 BrowserContext，且於執行前驗證網站登入標記；驗證失敗時停止後續批次任務。
- 啟用此功能的批次工作另使用每筆獨立的下載子資料夾 `auth-batch/<run-id>`。
- 保留原有 CDP 循序作業、錄製、一般 Profile、工作流程與文件匯出功能，未啟用時行為不變。
- 內建已編譯前端版本透過不依賴 Vite 的登入狀態管理面板接入（`public/auth-state-panel.js`）；React 原始碼亦提供對應的完整設定介面。

## V2.2.0 網頁資料擷取與彙整文件

- 新增「擷取網頁資料」：單頁欄位、重複清單、HTML 表格、文字／HTML／屬性、必填檢查、追加或取代集合、來源網址與擷取時間。
- 新增「保存彙整文件」：Word（.docx）表格／逐筆段落、JSON（.json）陣列、Excel（.xlsx）文字儲存格；支援輸出欄位順序、標題、工作表名稱及本機時間檔名。
- 輸出至預設下載路徑，使用防覆寫檔名，並登錄於執行紀錄；匯入、匯出及獨立 TypeScript 使用相同擷取與產檔邏輯。
- Word／Excel 以本機 Open XML 產生，無須新增正式執行套件或連線至外部服務。單次最多擷取 5000 筆，每次執行集合上限 50,000 筆。
- 保留短 ID 匯入修正、系統 CA／TLS 驗證及說明圖示更新；交付包不含 node.exe。

## 不含 Node 執行檔的交付包（V2.1.0）

- 本次 ZIP 排除 `node.exe`，保留精簡執行套件與 `setup-runtime.bat`。更新可沿用原資料夾的 Node；首次使用由安裝腳本補齊。

## 使用說明圖示調整（V2.1.0）

- 「主要操作說明」各項目改用與左側功能對應的 Lucide 圖示，取代單字標示；圖示尺寸與線條粗細維持一致。

## 使用說明分類調整（V2.1.0）

- 將「保存頁面 PDF」整併為「自動化設計器」下的可展開操作說明。
- 在「批次任務」與「發布與版本」之間新增「執行紀錄」，說明篩選、詳情、成果下載、失敗診斷包與紀錄刪除。
- 「網站與工作站」標題與左側功能名稱一致，系統設定的紀錄說明聚焦於保留與清理。

# Automation Studio 版本更新紀錄（CHANGELOG）
> 本文件集中保存歷次版本、修補與功能調整紀錄；來源為原 ZIP 根目錄中的獨立版本更新 `.md` 文件。為避免遺漏，保留各文件原文及原檔名。
> `README.md`（使用與部署說明）、`AGENTS.md`（開發指引）、`VERSIONING.md`（版號規則）繼續獨立保留。新增版本紀錄請附加於本檔，不再另建單一版本 `.md`。

## 目錄
- [v2.1.0](#v210)（1 筆）
- [v2.0.6](#v206)（3 筆）
- [v2.0.5](#v205)（1 筆）
- [v1.4.2](#v142)（5 筆）
- [v1.4.1](#v141)（1 筆）
- [v1.4.0](#v140)（1 筆）
- [v1.3.0](#v130)（1 筆）
- [v1.2.4](#v124)（1 筆）
- [v1.2.3](#v123)（1 筆）
- [v1.2.2](#v122)（1 筆）
- [v1.2.1](#v121)（1 筆）
- [v1.2.0](#v120)（1 筆）
- [v1.1.6](#v116)（1 筆）
- [v1.1.5](#v115)（1 筆）
- [v1.1.4](#v114)（1 筆）
- [v1.1.3](#v113)（1 筆）
- [v1.1.2](#v112)（1 筆）
- [v1.1.1](#v111)（1 筆）
- [v1.1.0](#v110)（1 筆）
- [v1.0.40](#v1040)（10 筆）
- [v1.0.13](#v1013)（1 筆）
- [v1.0.12](#v1012)（3 筆）
- [v1.0.11](#v1011)（1 筆）
- [v1.0.10](#v1010)（2 筆）
- [v1.0.9](#v109)（5 筆）
- [v1.0.8](#v108)（4 筆）
- [v1.0.7](#v107)（1 筆）
- [未標註版本的修補紀錄](#未標註版本的修補紀錄)

---

<a id="v210"></a>

## v2.1.0

### 等待新資料：定期重新整理（新增功能）

- 在「等待清單新資料」與「等待第一筆新資料」步驟設定新增「定期重新整理」開關及間隔秒數（5～600 秒、預設 10 秒）。
- 停用時維持原本的 DOM 輪詢，啟用時每隔指定秒數重新整理目前分頁，保留先前已取得的郵件／清單基準快照，不會重新建立基準。
- 新資料一旦符合條件即停止刷新，既有步驟逾時時間控制最長等待時間。支援停止任務及獨立 TypeScript 執行流程。
- 同步更新工作流程欄位、內建執行器、發布 TypeScript、步驟設定表單與測試；舊工作流程預設不啟用。
- 維持既有其他功能與匯入匯出格式，不新增步驟類型。

---

<a id="v206"></a>

## v2.0.6

### V2.0.6_COLLAPSE_PERSISTENCE_FIX.md

# v2.0.6 條件分支收折狀態修正

- 使用瀏覽器 localStorage 保存每個專案、每個條件步驟、True/False 分支的收折狀態。
- 切換功能頁面、階層清單與視覺畫布、重新整理後保留狀態。
- 移除步驟後，清理已刪除步驟對應的紀錄。
- 不修改工作流程 JSON、匯入匯出格式或執行器。
- 同步更新 frontend/src/components/Designer.tsx、frontend/dist/studio.js、public/modern/studio.js 和瀏覽器資產快取參數。
- 版號仍為 v2.0.6。

驗證：JavaScript 語法檢查通過；未進行完整瀏覽器 E2E 測試。

### V2.0.6_STEP_SETTINGS_SELECTION_FIX.md

# v2.0.6 步驟設定選取互動修正

- 步驟單擊僅更新選取項目，不再關閉已開啟的設定面板。
- 雙擊仍可開啟設定面板。
- 階層清單非控制項、非步驟區的空白處單擊將關閉設定面板。
- 視覺畫布空白處單擊將關閉設定面板。
- 版號不變；更新模組快取參數。

### V2.0.6_STEP_TOOLBAR_NO_OVERLAP.md

# v2.0.6 浮動工具列修正

## 原因
v2.0.5 的改動只寫入 `frontend/src/styles.css`，但部署時實際載入 `public/modern/assets/studio.css`，其中仍保留 `right:12px;top:-14px`。`public/index.html` 引用的版本參數也未更新，因此會繼續遮住上移按鈕。

## 修正
- 將階層清單的操作工具列限定在卡片左側 `left:8px` 與右側預留 `56px` 之間，操作按鈕可在狹窄卡片中等比例縮小，永不侵入上移／下移按鈕所在欄位。
- 保留工具列滑入與鍵盤 focus 顯示模式；視覺畫布節點維持原樣。
- 同步 `frontend/src/styles.css`、`public/modern/assets/studio.css`、`frontend/dist/assets/studio.css`；保留原 v2.0.5 的總覽及系統設定版面寬度修正。
- 更新靜態資源引用參數與系統版本至 2.0.6。

## 驗收方式
在「階層清單」對步驟卡片懸停，應可同時看到工具列與右側上移／下移按鈕，且可分別點擊，互不遮擋。需另外確認狹窄卡片與一般寬度皆符合。


<a id="v205"></a>

## v2.0.5

### V2.0.5_LAYOUT_ALIGNMENT.md

# v2.0.5 UI alignment

- Offset the floating step action toolbar left of the reorder controls, retaining access to both up/down buttons.
- Normalize dashboard and settings content containers to the same full available workspace width used by other pages.
- No workflow engine, recorder, or execution behavior changes.


<a id="v142"></a>

## v1.4.2

### V1.4.2_REACT_SPA_STAGE1.md

# V1.4.2 React SPA 遷移第一階段

## 本階段完成

- 專案總覽改由 React 元件呈現，React Query 讀取既有 `/api/studio/dashboard`。
- 建立專案由總覽中的 React 表單呼叫既有 `/api/studio/projects`，沿用既有欄位與允許網域預設。
- 專案列可開啟設計器；符合原快速執行檢查條件的專案可直接啟動流程。
- 參數與資料頁改由 React 管理，沿用原 Key 格式、唯一性、敏感值與相依選項規則；更新後同步測試參數及批次列。
- 發布與版本頁改由 React 管理；版本欄位維持自動儲存，成果選項沿用既有匯出 API 與 ZIP 命名。
- `StudioRestClient` 加入共用 JSON 請求、錯誤轉換、Dashboard、專案建立／讀取及建立執行工作的型別化方法。
- 後端路由、流程 JSON、Playwright／CDP、SSE 錄製串流、取消與下載流程未變更。

## 遷移方式

本階段接管專案總覽、參數與資料、發布與版本。建立完成後會透過相容橋接器刷新尚未遷移的工作區狀態，再導向工作站，確保既有專案選單及建立流程可繼續使用。其他頁面仍由既有控制器管理，避免一次替換大量執行相關行為。

## 後續遷移項目

1. 以 React App Shell 取代靜態 HTML 導覽與頁面切換。
2. 將工作站、參數、發布、系統設定、說明、回報及原始 JSON 頁面改為 React 元件。
3. 把設計器、Debug、批次、AI 與執行紀錄的 `window.studioBridge` 呼叫逐步改為 SDK／React store 操作。
4. 移除首頁的 `public/app.js`／`public/bridge.js` UI 控制依賴，並保留 `/classic/`、`/legacy/` 相容入口。
5. 完成全站回歸驗收後，再將整體遷移列為 V1.5.0 功能里程碑。

完整 SPA 尚未完成；此版本是分階段遷移中的可用檢查點。

### V1.4.2_REACT_SPA_STAGE2.md

# V1.4.2 React SPA 遷移第二階段

## 本階段完成

- 工作站、系統設定、說明、問題回報與原始工作流程 JSON 由 React 頁面呈現。
- 工作站表單直接管理專案草稿；保存與套用 JSON 使用既有 Project API。
- 錄製器、Chrome CDP、瀏覽器 Profile、錄製事件加入流程與專案管理操作透過型別化 runtime SDK 接到原有控制器，保留既有呼叫順序與 SSE／輪詢處理。
- 一般系統設定、Debug／執行紀錄清理使用新增的型別化 Settings API。
- AI Provider 編輯面板沿用既有憑證遮罩、Provider 測試與網路診斷行為，掛載於 React 設定頁。
- 問題回報保留原有收件地址驗證、郵件主旨、診斷欄位及隱私提醒；指南頁保留完整既有說明內容。
- React 元件改由 `StudioRuntimeSdk` 呼叫目前仍由相容轉接層處理的操作。
- 後端路由實作、流程與匯出資料格式、Playwright 執行器、CDP 規則、SSE 事件格式、取消及下載協定未更動。

## 驗收範圍

- `npm run frontend:build`
- `npm run frontend:check`
- `npm run check:all`
- `npm test`
- 本機頁面切換與截圖驗收未完成：sandbox 阻止 UI server 監聽 localhost（`listen EPERM`），且 Playwright Chromium 未安裝。

## 相容層界線

AI 探索、流程設計器、Debug、批次與執行紀錄中的既有控制器操作仍經 `StudioRuntimeSdk` 的相容方法處理，以保留目前已驗證的長流程及執行狀態同步。新的表單頁與 REST 操作不再直接呼叫 `window.studioBridge`。本階段沒有移除 `/classic/` 或 `/legacy/`。

### V1.4.2_REACT_SPA_STAGE3_UI_HOTFIX.md

# V1.4.2 React SPA 第三階段介面修正

## 本次調整

- 開發者功能改用 Monaco 呈現原始工作流程 JSON，提供行號、縮排與 JSON 語法色彩，並沿用既有 JSON 驗證及套用 API。
- 側欄交界的收合控制改為低調方向箭頭，游標移入或鍵盤聚焦時才顯示。
- 開發者功能標題列的程式碼圖示與文字對齊。
- 側欄收合時保留「建立新專案」及「匯入可攜工作流程」圖示入口，原本按鈕與匯入流程不變。
- 刪除設計器步驟後關閉設定面板，避免自動跳出另一個步驟的設定。
- 設定步驟後保留定位規則的展開狀態；未手動展開時，套用不會自動打開定位規則。

## 相容與驗證

- 只修改前端、相容橋接層、靜態導覽標記及本階段說明文件。
- 後端 API、流程資料格式、Playwright／CDP 執行、SSE、下載協定與 `/classic/`、`/legacy/` 未更動。
- `npm run check:all`、`npm test` 與 `npm run frontend:build` 通過。
- 本次未完成瀏覽器實際操作截圖驗收；前一階段記錄的執行環境限制仍適用。

### V1.4.2_REACT_SPA_STAGE4_UI_REFINEMENTS.md

# V1.4.2 React SPA 第四階段介面調整

## 本次調整

- 側欄分隔線全高可點；箭頭只在游標移入時顯示，並跟隨游標位置。
- 自動化設計器新增「復原」操作，可復原目前專案最近 50 次步驟內容變更。
- 全站頁首標題區塊固定使用 1120px 最大寬度，與「說明與支援」頁面對齊；窄螢幕仍會自動縮小。
- 收合側欄時仍可開啟目前專案選單並切換專案。

## 相容與驗證

- 僅修改前端、相容橋接層、靜態導覽標記及本階段說明文件。
- 後端 API、流程資料格式、Playwright／CDP 執行、SSE、下載協定與 `/classic/`、`/legacy/` 未更動。
- `npm run check:all`、`npm test`（6 個測試檔全數通過）與 `npm run frontend:build` 通過。
- 本次未完成瀏覽器實際操作截圖驗收；執行環境的瀏覽器預覽限制仍適用。

### V1.4.2_REACT_SPA_STAGE5_UI_REFINEMENTS.md

# V1.4.2 React SPA Stage 5 UI refinements

## Changes

- Expanded the shared page header to the full content width of the workspace, removing the 1120px cap.
- Fixed the EBAS existing-features icon mount so the Globe icon renders inside the existing sidebar link.
- Separated project changes from step selection in the frontend store. Switching projects closes the step settings sheet; selecting a step within the current project still opens it.

## Validation

- `npm run check:all` passed.
- `npm test` passed: all 6 test files.
- `npm run frontend:build` passed.
- Browser interaction validation was unavailable because the runtime has no installed Playwright Python package or Chromium executable.

No backend workflow behavior or API contracts were changed.


<a id="v141"></a>

## v1.4.1

### V1.4.1_COMMERCIAL_FRONTEND_HOTFIX.md

# V1.4.1 前端操作補強

## 本次調整

- 側欄收合後改顯示 68px 圖示導覽列，保留主要頁面與開發者功能的入口。
- 收合／展開按鈕移至側欄與內容區交界；按鈕位置隨側欄寬度移動。
- 側欄展開狀態保存於本機，重新整理後延續上次選擇。
- 新增 `G` 後按 `P/D/B/T/R`，快速切換專案總覽、設計器、批次、Debug、執行紀錄。
- 新增 `[` 收合、`]` 展開及 `Ctrl/⌘+Enter` 執行完整流程。
- 快捷鍵在輸入欄位、Monaco 編輯器與對話框中不攔截文字輸入或操作。
- 小螢幕與中等寬度保留圖示導覽，不再直接隱藏側欄。
- 新增具型別的 Studio REST client，指令面板改由 client 讀取專案清單；沿用原有 `/api/studio/projects` 路由。

## 相容與驗證

- 僅變更 React 前端原始碼、編譯資源及系統版本資訊。
- 後端 API、流程資料格式、Playwright／CDP 執行、下載、EBAS、SSE、`/classic/`、`/legacy/` 均未修改。
- 本版採漸進式解耦：指令面板已經由型別化 REST client 讀取專案清單；其餘既有頁面仍透過 `public/bridge.js` 呼叫穩定的 `public/app.js` 控制器。尚未將全站改寫為純 React SPA。
- `npm run frontend:build` 與 `npm run check:all` 通過；`npm test` 的 6 個測試檔全部通過。
- 時區檔名測試改在同一 Node 程序切換 `TZ` 驗證，避免受限執行環境中子程序 stdout 為空而誤判。
- 瀏覽器截圖驗收未完成：測試服務可啟動，但 Chromium 下載端回傳空檔，環境中沒有可用的瀏覽器執行檔。


<a id="v140"></a>

## v1.4.0

### V1.4.0_HIERARCHY_BRANCH_LAYOUT_HOTFIX.md

# V1.4.0 階層清單條件分支版面修復

## 問題

在「自動化設計器 → 階層清單」中，條件步驟若在 True / False 分支內持續巢狀建立條件，原版會讓每一層 `.modern-branches` 都再次切成左右兩欄。可用寬度因此呈指數縮小，最後造成：

- 分支標籤被拆成逐字換行。
- 步驟名稱只剩極窄欄寬，文字錯亂。
- 圖示、拖曳控制與標題互相擠壓。
- 條件層級越多，問題越明顯。

## 修正方式

本修復僅調整階層清單的呈現樣式，不修改 Workflow 資料結構、步驟執行器、條件判斷、拖曳、編輯或匯出邏輯。

1. 最外層條件在寬螢幕仍保留 True / False 左右雙欄，維持快速比較。
2. 第二層起的巢狀條件改為單欄垂直排列，停止每層再把寬度減半。
3. 巢狀分支使用負水平邊距抵銷父層 padding，使深層條件維持近似固定可讀寬度，不會隨深度持續變窄。
4. 分支內步驟改為不做整列 flex 換行，文字只在標題內容本身換行。
5. 加入 `min-width: 0`、`overflow-wrap` 與 `word-break`，避免長名稱撐破容器或逐字擠壓。
6. 原有 1200px 以下響應式規則仍有效；中小尺寸螢幕會將條件分支全部改為單欄。

## 修改檔案

- `frontend/src/styles.css`
- `public/modern/assets/studio.css`
- `tests/hierarchy-branch-regression.py`（新增深層條件分支版面回歸測試）

## 驗證

以 4 層連續條件建立與問題截圖相同型態的階層結構，測得：

- 1365px：第一層維持雙欄；後續 3 層皆為單欄。
- 深層分支寬度維持約 453px，不再由約 477px 反覆減半。
- 1024px、768px、390px：所有條件分支自動改為單欄。
- 以上尺寸均無頁面層級水平溢出。
- `npm run check` 通過。

版本號維持 `V1.4.0`，本次為版面 Hotfix，不改變既有功能行為。


<a id="v130"></a>

## v1.3.0

### V1.3.0_STEALTH.md

# V1.3.0 專案可選 Stealth

使用方式：網站與瀏覽器工作站 → 啟用 Stealth（此專案） → 儲存專案 → 停止並重新啟動錄製瀏覽器。預設關閉。

更新後請在程式目錄執行 npm install 安裝新增套件。匯出的 TypeScript 也請於匯出目錄執行 npm install；相依套件已列入 package.json。

套用範圍：錄製器、流程執行器與匯出 TypeScript。一般啟動、固定 Profile、固定 Profile 初始分頁均處理。CDP 不套用；EBAS 既有功能不接入。設定隨個別專案保存，舊專案預設關閉。

設定變更不會回補已開啟的錄製瀏覽器；執行器若發現設定不一致會提示重啟錄製瀏覽器。每次啟動使用獨立插件實例。未啟用或 CDP 模式不載入插件。

驗證：npm run check 通過；npm test 共 171 項通過，涵蓋原有功能、插件開關、實例隔離、固定 Profile 初始分頁掛鉤、專案儲存、匯出與 CDP 排除。

限制：本環境沒有可用 Chromium，未進行實際瀏覽器或目標網站端對端測試。已驗證實際插件套件可載入及註冊，但不代表網站不會阻擋。Stealth 無法保證不被偵測，也不能修復 Session、Cookie、randomNo 或限流問題。


<a id="v124"></a>

## v1.2.4

### V1.2.4_LOCAL_TIME_TASK_CANCELLATION.md

# V1.2.4 本機時間與任務中斷

## 下載檔名

EBAS 既有功能下載檔名改用執行程式所在電腦的本機時區，格式為 `報表名稱-YYYY-MM-DDTHH-mm-ss-SSS.副檔名`。例如本機 2026/10/05 14:01:20.123，檔名時間為 `2026-10-05T14-01-20-123`，沒有 UTC 的 Z。保留毫秒與網站實際下載副檔名。內部任務、事件與 Debug 紀錄仍使用 UTC，舊檔名不會改名。

## 任務中斷

下載任務建立後，任務狀態會顯示「中斷任務」按鈕，支援單筆、循序批次與 A/B 平行批次。

- 中斷請求後顯示「正在中斷」，按鈕停用。
- 關閉該下載的 BrowserContext，解除下載監聽與等待計時器；不關閉共用 Browser，也不取消其他任務。
- 停止後續批次項目與重試倒數。
- 下載工作結束後顯示「已中斷」，批次額外顯示中斷項目數。
- 已完成檔案保留，已結束任務不再提供中斷按鈕。

MCP 新增 `cancel_download_task`、`cancel_batch_download_task`，輸入 `{"taskId":"任務識別碼"}`。狀態新增 `cancelling`、`cancelled`，批次結果支援讀取已中斷任務中的完成檔案。

## 更新及驗證

停止舊版程式及下載任務後，解壓縮新版，保留原 data、EBAS session 及瀏覽器 Profile。

- npm run check 通過。
- npm test：165 項通過、0 項失敗。
- 新增 14 項測試，涵蓋台北／UTC／美國時區與跨日、中文與副檔名、單筆與排隊中斷、完成檔案保留、A/B 批次中斷、重試倒數取消、Context 隔離、EBAS 導航與自訂下載監聽取消、MCP、按鈕狀態及完成／中斷競態。
- 未在實際 EBAS 網站及 Windows 瀏覽器操作驗證；瀏覽器與事件介面使用模擬行為測試。


<a id="v123"></a>

## v1.2.3

### V1.2.3_EBAS_BROWSER_MODE.md

# V1.2.3 EBAS 瀏覽器模式

## 行為

| 操作 | 瀏覽器模式 |
| --- | --- |
| 工作站 A/B 人工登入 | 固定有頭，顯示視窗 |
| Session 健康檢查 | 固定無頭 |
| 單筆下載 | 依進階設定選擇，預設有頭 |
| 批次下載 | 依進階設定選擇，預設有頭；所有項目與重試沿用 |

開發者功能 → EBAS → 進階設定 → 瀏覽器模式：
- 顯示瀏覽器視窗（建議）
- 無頭模式

Debug 加無頭時 UI 顯示提醒，不會改變選擇。有頭及無頭各自使用獨立 Playwright Browser instance，各任務使用獨立 BrowserContext；兩種模式的中斷與重建互不清除另一模式的 instance。人工登入及健康檢查另外啟動瀏覽器，保持固定模式。

任務狀態顯示保存於該任務的 browserMode，後續更改畫面選項不會改寫既有任務。批次子項目也保留模式。

## MCP

`create_download_task`、`create_batch_download_task` 都新增可選 `browserMode`：
- `headed`：預設，顯示視窗。
- `headless`：無頭模式。

未知值會回報 INVALID_PARAMETERS，不會默默切換。EBAS 下載模式不再由 HEADLESS 環境變數決定。

## 更新與檢查

先停止舊程式與下載任務，解壓縮新版本並保留原 data、EBAS session 與瀏覽器 Profile。新版本操作介面可直接選擇模式。

- npm run check 通過，涵蓋新增模式驗證、service、MCP 與 EBAS adapter。
- npm test：151 項通過，0 項失敗。
- 新增 7 項行為測試：模式預設與拒絕非法值、獨立 instance 與並行去重、失敗恢復及跨模式隔離、單筆 Debug/模式傳遞、A/B 批次與重試傳遞、MCP schema/參數、UI 提醒不改變選擇。
- 確認既有人工登入 headless:false 及健康檢查 headless:true。
- 未在實際 EBAS 網站或 Windows 瀏覽器執行登入與下載；Browser 生命週期使用模擬 Playwright 介面驗證。


<a id="v122"></a>

## v1.2.2

### V1.2.2_RECORDER_ENHANCEMENTS.md

# V1.2.2 錄製器補強

## 功能

1. 錄製 Enter、Tab、Escape、方向鍵及組合按鍵；組字中或長按重複事件不加入流程。
2. 按鍵／點擊／離開欄位前保存最新填值；加入流程和停止錄製也會取得仍聚焦欄位內容。
3. 錄製單檔、多檔上傳並保存檔名。上傳步驟預設停用，請補完整本機路徑，每行一個，再啟用。平台與 TypeScript 匯出可操作隱藏 input。
4. 工作站提供選取元素建立可見、文字、欄位值驗證，攔截選取過程的 pointer／mouse／click，避免實際操作元素。可按 Esc 或取消選取；禁止密碼及檔案值驗證。
5. 優先保存當下唯一的穩定元素識別，保留其他備援定位。
6. 操作前等待元素可見；下一步所在 Frame 的等待可獨立跨 Frame 搜尋。文字與欄位值驗證等待非同步結果直到逾時。
7. 密碼值清空，錄製出的密碼填值步驟預設停用。

## 操作

啟動錄製後操作網站；要建立驗證時，在工作站選擇種類並按「選取驗證元素」，於錄製視窗點選目標。完成後加入流程，檢查上傳路徑、參數與驗證預期值，再測試執行。

升級前停止原程式及錄製工作站，解壓縮新版本。保留原專案 data 和瀏覽器 Profile；切勿用空資料覆蓋原資料。CDP 使用者請重新整理舊分頁後開始錄製，以載入新版事件監聽。

## 驗證結果

- npm run check：通過。
- npm test：144 項通過，0 項失敗。
- 新增 13 項行為測試：鍵盤／填值順序、IME 與長按過濾、密碼遮蔽、焦點與停止前保存、多檔上傳、選取點擊攔截、驗證種類、定位優先順序、隱藏 input 執行、Frame 模式同步與取消、跨 Frame 等待、非同步驗證。
- 可匯入流程及 TypeScript 匯出內容保留 press／upload／assert，匯出 runner 語法檢查通過。
- 未進行實際瀏覽器或內部網站操作驗證；事件錄製以模擬 DOM 行為測試，執行器以模擬 Playwright 介面測試。

## 限制

檔案實際內容及完整本機路徑不會從瀏覽器錄製。拖放上傳、作業系統檔案視窗、瀏覽器工具列操作不在本次範圍。剪貼簿快捷鍵依賴執行時的剪貼簿；不自動擷取剪貼簿。業務分支、最後成功判斷和特殊網站仍須測試與調整。


<a id="v121"></a>

## v1.2.1

### V1.2.1_NAME_HELP_STYLE_FIX.md

# V1.2.1 名稱與操作說明樣式

- 中文名稱改為「網站自動化流程設計平台」，同步更新瀏覽器分頁標題。
- 網站與工作站、測試與 Debug、發布與版本的補充說明共用收折卡片結構與樣式。
- 統一補充說明標題和本文字級為 14px，統一內容留白及展開標示；保留鍵盤操作與焦點提示。


<a id="v120"></a>

## v1.2.0

### V1.2.0_RUN_HISTORY_MANAGEMENT.md

# Automation Studio V1.2.0 執行紀錄管理

## 執行紀錄頁

- 每筆已完成、失敗或取消的紀錄可單獨刪除；也可全選目前篩選結果、多選刪除、刪除目前篩選結果或清除所有已完成紀錄。
- 佇列中、執行中與等待人工操作的紀錄受到保護；後端刪除前會在同一筆紀錄的寫入佇列中再次確認狀態。
- 失敗紀錄提供「下載失敗診斷包 ZIP」。若該次 Debug 證據已清理，下載 API 回覆 `DIAGNOSTICS_PURGED`，介面顯示「診斷資料已清理」。
- 用量摘要列出各狀態紀錄數、執行紀錄 JSON 大小、Debug 資料大小與合計，不計入已下載成果檔案。
- 刪除紀錄時會刪除執行紀錄 JSON 和該次 Debug 目錄；已下載成果檔案會保留。

## 保留與清理

- 系統設定新增 `runHistoryRetentionDays`，預設 30 天，範圍 1 至 365 天，與原本 Debug `retentionDays` 分開儲存。
- 到期掃描只刪除超過保留天數且狀態為完成、失敗或取消的紀錄。
- 啟動和流程結束時會檢查清理時間；自動掃描最多每 24 小時一次。設定頁可手動立即清理。
- 清理狀態寫入 `data/studio/run-history-cleanup-status.json`。

## API

- `GET /api/studio/runs/summary`：取得紀錄與 Debug 用量、狀態數及清理狀態。
- `POST /api/studio/runs/delete`：以 `{ "runIds": ["..."] }` 刪除一筆或多筆可刪除紀錄。
- `POST /api/studio/runs/clear-completed`：清除所有已完成紀錄。
- `DELETE /api/studio/runs/:runId`：刪除單筆可刪除紀錄。
- `POST /api/studio/settings/run-history-cleanup`：立即清理到期執行紀錄。
- `GET /api/studio/runs/:runId/diagnostics`：下載失敗診斷包 ZIP；診斷資料已清除時回覆 HTTP 410。

## 驗證

- `npm run check` 通過。
- `npm test`：131 項通過。
- 本機 HTTP smoke test 通過：Health 版本、獨立保留設定、用量摘要、手動清理、診斷包下載／資料已清理回應、紀錄刪除與前端資源。


<a id="v116"></a>

## v1.1.6

### V1.1.6_RECORDER_FRAMEPATH_NORMALIZATION_HOTFIX.md

# Automation Studio V1.1.6 Recorder FramePath Normalization Hotfix

## 問題

停止錄製後，前端會重新渲染保留的 `lastDiagnostic`。部分舊式 Frame 網站回報的 `framePath` 可能是字串、JSON 字串或舊格式物件，而 V1.1.5 直接執行 `item.framePath.join(" → ")`，因此出現 `item.framePath.join is not a function`。

## 修正

1. 前端新增 `recorderFramePathList()`，所有 Frame 路徑顯示前一律正規化。
2. 後端 `ingestRecorderDiagnostic()` 對 `framePath` / `frameUrl` 先正規化，再寫入 `lastDiagnostic`。
3. 停止錄製暫存狀態只會保留已正規化的診斷 Frame 資訊。
4. 保留既有錄製事件與 SmartKMS 相容功能。

## 版號

依 PATCH 規則更新為 `1.1.6`。


<a id="v115"></a>

## v1.1.5

### V1.1.5_RECORDER_STATE_RETENTION_HOTFIX.md

# V1.1.5 Recorder 未提交事件保留與狀態同步修復

## 問題

V1.1.4 雖已改用 SSE 顯示錄製事件，但視窗重新取得焦點或 SSE/API 暫時錯誤時，前端會把錯誤狀態直接渲染成 `events: []`。後端事件仍在，因此「加入流程步驟」仍可取得資料，但畫面上的錄製清單會看似消失。

## 修正

- 前端保存每個目前專案的最後有效 Recorder snapshot。
- API 或 SSE 暫時失敗只標示同步警告，不清空事件。
- 同一 `startedAt` Session 只接受 revision 不倒退的狀態；舊回應無法覆蓋新狀態。
- 切換專案或啟動新錄製時重置 snapshot。
- 「清除本次事件」及「加入流程步驟」為明確清空點。
- 後端保留停止錄製／瀏覽器關閉前尚未提交的 Recorder events，使停止後仍可加入流程。

## 使用者可見行為

錄製途中即使 SSE 重連、Automation Studio 視窗切換或暫時同步失敗，已顯示的事件仍會留在清單。若同步暫時中斷，工作站會顯示提示，而不是顯示「尚未錄製任何操作」。


<a id="v114"></a>

## v1.1.4

### V1.1.4_RECORDER_SSE_SELECTOR_FRAME_FIX.md

# V1.1.4 Recorder SSE / selector / frame 修復

## 問題

1. SmartKMS 操作已進入 Recorder backend，但工作站錄製事件清單不會逐筆刷新；按「加入流程步驟」卻能建立步驟。
2. 診斷包顯示錄製後的 click 步驟 `selectors: []`，且本應位於 `DocContent` 的公告連結被記到父層 `FormDocList.action`，執行時因此回報「此步驟尚未設定元件定位方式」。

## 修復

- 新增 Recorder SSE stream endpoint；事件／診斷 revision 改變即推送 status，不再依賴背景頁籤 long-poll callback 的即時性。
- 視窗 focus / visibility 恢復時另強制 GET status，作為休眠後同步保險。
- 瀏覽器端事件同時送出 selectorBackup 與 elementMeta；後端依序使用 selector、selectors、selectorBackup，再以 name/id/text/targetUrl 重建。
- page self-reported frameUrl/framePath 優先，binding source 僅作 fallback。
- recordedEventsToSteps 對空 selector 再建 text / targetUrl fallback，避免產生不可執行 click。


<a id="v113"></a>

## v1.1.3

### V1.1.3_REALTIME_RECORDER_SELECTOR_NORMALIZATION.md

# V1.1.3 錄製事件即時顯示與 selector 正規化

## 問題

1. 在 SmartKMS 的獨立錄製瀏覽器操作時，Automation Studio 工作站頁籤位於背景，原本每 1.5 秒的 `setInterval` 可能被 Chromium 節流，造成事件已抵達後端但前端延後一次顯示。
2. 少數錄製事件的 `selector` 不是陣列，提交錄製結果時 `sanitizeRecordedSelectors()` 直接呼叫 `flatMap()`，產生 `selectors.flatMap is not a function`。

## 修正

- Recorder session 新增遞增 revision 與等待者通知。
- 新增 `/recorder/watch?after=<revision>` long-poll；事件一抵達後端即喚醒前端。
- 前端取消固定 1.5 秒 recorder polling timer，改為持續 long-poll。
- Recorder ingest 將 selector 陣列、單一物件、巢狀陣列、JSON 字串統一正規化。
- 錄製轉流程與前端事件清單再各自做一次防禦式正規化。
- 保留 V1.1.2 的 Binding / Frame Bridge / Console Beacon 多通道與跨 Frame 錄製能力。


<a id="v112"></a>

## v1.1.2

### V1.1.2_RECORDER_TRANSPORT_BRIDGE_HOTFIX.md

# V1.1.2 Recorder transport bridge hotfix

SmartKMS 診斷資料證明 Playwright 能讀到 `mainFrame` / `DocContent` DOM，且公告標題是標準 anchor，但人工點擊仍未進入錄製事件，問題因此集中在瀏覽器端 Recorder 到 Node 的事件回傳通道。

本版：

1. 保留 Playwright `exposeBinding` 主通道。
2. 新增同源 Top-window bridge queue；子 Frame 在換頁前同步把事件放到最上層 Window，Node 每 500ms 僅抽取 queue，不掃描 DOM。
3. 新增 Console beacon 備援；即使 Frame binding 未被安裝／遭頁面覆寫，仍可由 Playwright console listener 收回事件。
4. 每筆 event / diagnostic 帶 transportId，後端跨三通道去重。
5. 對可操作元素增加 pointerdown 先行記錄；舊式網站若在 click 前同步導頁也不會漏錄，後續正常 click 會被合併。
6. Frame health 增加 Binding 可用數，錄製 UI 顯示備援是否啟用及最近事件通道。


<a id="v111"></a>

## v1.1.1

### V1.1.1_FRAME_AWARE_RECORDER_HOTFIX.md

# V1.1.1 Frame-aware persistent recorder

本版針對 SmartKMS／舊式內網多層 Frame 網站「畫面可操作但錄製事件遺失」的問題，補上 Recorder 生命周期管理。

## 修正重點

1. Recorder 是否已安裝改以目前 `Document` 標記，不再只依賴 `Window` 狀態。
2. 監聽 `frameattached`、`framenavigated`、`domcontentloaded`、`load`，Frame 或 Document 更新後立即確認 Recorder。
3. 每 2.5 秒執行低頻率健康檢查，僅在缺失時補裝；錄製停止時一併清除 watchdog。
4. 錄製事件由 Playwright binding 補上完整 Frame path，便於判斷實際操作位於哪一層 Frame。
5. Frame 內錄製產生的流程步驟會保留 Frame URL 規則，並預設啟用 `autoFrameSearch`。
6. 執行器與 TypeScript runner 會先嘗試原 Frame；若 Frame URL／結構改變，再 fallback 搜尋主頁及其他 Frame。
7. 工作站錄製狀態顯示 Frame 健康數與自動修復次數。
8. 失敗診斷包彙整所有 Frame 的文字與階層資訊，並將表單遮罩套用到所有 Frame。

## 版本

依 `VERSIONING.md` 規則，本次屬於相容性／錄製器修正，版本由 `1.1.0` 升為 `1.1.1`。


<a id="v110"></a>

## v1.1.0

### V1.1.0_VERSION_BROWSER_RECORDER.md

# V1.1.0 版本、瀏覽器與舊式內網錄製修正

## 版本
- 系統版本統一為 1.1.0。
- 新增 VERSIONING.md；系統版本與專案版本分離。

## Microsoft Edge
- 移除「系統 Microsoft Edge」選項。
- 移除 Edge 自動 fallback。
- 舊專案若 browser.channel=msedge，載入時自動正規化為 bundled。
- 原因：企業 Edge 可能受 Remote Debugging、IE mode、Enterprise Site List 等原則影響，無法保證 Playwright 導頁與錄製注入。

## SmartKMS / 舊式內網錄製
- 單擊事件改成立即送出，不再用 280ms browser timer 延後。
- dblclick 由後端移除同目標近期 click，再保留單一 dblclick。
- 加強 ExtJS、KMS、grid/tree/table cell 與事件代理型元素辨識。
- 新 popup 自動成為目前錄製頁。

這可處理「點擊後頁面立即換頁／frame 重建，導致舊文件 timer 被銷毀而沒有錄到 click」的情況。若目標頁實際被 Edge IE mode 開啟，仍不屬於 Playwright Chromium DOM，請改用隨附 Chromium 或 Chrome。


<a id="v1040"></a>

## v1.0.40

### V1.0.40_HELP_READABILITY_TYPESCRIPT_FAQ_HOTFIX.md

# V1.0.40 Help readability + TypeScript FAQ hotfix

- Raised minimum font sizes across the Help Center for flow labels, operation guides, FAQ answers, tips, and architecture annotations.
- Added a detailed FAQ for running the published TypeScript project independently.
- Documents the actual runtime dependency (`playwright`), Node.js 22.6+ requirement for the exported `--experimental-strip-types` runner, package installation, optional Chromium installation, parameter setup, and Windows startup.
- Clarifies that TypeScript and ts-node are not required by the generated runner.
- Includes guidance for restricted/offline corporate Windows environments without disabling TLS verification.

### V1.0.40_HELP_REPORT_HOTFIX.md

# V1.0.40 Help Center and Issue Reporting

- Added left-sidebar **使用說明** and **回報問題** entries.
- Added an in-app help center with a quick-start flow, feature guides, troubleshooting principles, FAQ, and system architecture diagram.
- Added an issue report form that can open the user's default mail client with a prefilled recipient, subject, environment context, problem description, reproduction steps, expected result, and actual result.
- Added a copy-to-clipboard fallback for environments that use OWA or do not have a default desktop mail client.
- Added **問題回報收件信箱** to System Settings; it is stored locally with other Studio settings.
- Optional initial recipient can be provided through `AUTOMATION_STUDIO_SUPPORT_EMAIL` when no settings file exists.
- The generated report deliberately excludes passwords, cookies, MFA codes, verification codes, and workflow parameter values.

### V1.0.40_INLINE_RUN_DETAILS_QUICK_RUN_HOTFIX.md

# V1.0.40 Inline Run Details + Dashboard Quick Run Hotfix

## Changes

1. Run history details are now rendered directly below the selected run row and collapse in place.
2. Run status and per-step status indicators use aligned circular icons for completed, failed, running, paused, queued, and cancelled states.
3. Debug tabs remain available inside each expanded run detail and continue to refresh while a run is active.
4. The dashboard recent-project list shows an `執行流程` button only when the project can be started with its current saved/default values:
   - project is not archived;
   - at least one workflow step is enabled;
   - required parameters have usable saved defaults (dependent selects may use their first valid option);
   - enabled navigation/new-tab URLs can be resolved and pass the project's allowed-domain rules.
5. Clicking the project row still opens the designer; clicking `執行流程` loads the project and starts the full workflow directly in Test/Debug.

## Validation

- `npm run check`
- `npm test -- --runInBand`
- 67/67 tests passed.

### V1.0.40_LONG_ERROR_SCROLL_RETENTION_HOTFIX.md

# V1.0.40 long error and run-detail scroll retention hotfix

- Long Test/Debug run-monitor errors now stay within the monitor card, wrap at arbitrary selector/XPath characters, preserve line breaks, and scroll inside a capped-height error area.
- Long per-step messages use the same bounded wrapping behavior so a single selector error cannot stretch the step list layout.
- Run-history polling now refreshes the expanded run data without performing the previous double table render.
- Before a run-history rerender, the page position and scroll positions for step results, download results, debug output, and the runs table wrapper are captured and restored.
- Switching run-history debug tabs also preserves the current expanded-detail scroll position.

### V1.0.40_PROJECT_DIALOG_RUN_HISTORY_HOTFIX.md

# Automation Studio v1.0.40 - Project Dialog & Run History Hotfix

本次修正內容：

1. 建立自動化專案對話框
   - 「取消」與右上角「關閉」改為明確的非 submit 按鈕。
   - 關閉時只關閉並重設表單，不再誤觸建立專案流程。
   - Escape / cancel 事件統一走相同關閉處理。

2. 執行紀錄詳細資訊
   - 執行紀錄表格每一列可點選展開詳細資訊。
   - 顯示狀態、執行模式、完成進度、執行時間。
   - 顯示各步驟執行結果與下載成果。
   - 提供「執行日誌、Console、Network、Popup / Download、變數」五類 Debug 資訊。
   - 執行紀錄頁自動輪詢時，已展開的執行詳情會同步更新。

3. 專案總覽「可發布」現行計量邏輯
   - 後端 dashboard 的 readyCount 目前計算 `project.status === "ready"` 的專案數。
   - 此數字目前不是由「發布前檢查」四項條件自動判定。

驗證：
- `npm run check` 通過。
- `npm test`：66 / 66 通過。

### V1.0.40_STATUS_ICON_ALIGNMENT_HOTFIX.md

# V1.0.40 status icon alignment hotfix

- Unified the status icon rendering in run details and step results.
- Switched both areas to the same circular icon component, size, and alignment model.
- Adjusted the run detail status layout so the icon and label align cleanly and consistently.
- Kept existing run history behavior unchanged.

### V1.0.40_STATUS_ICON_SVG_HOTFIX.md

# V1.0.40 status icon SVG hotfix

- Fixed the run-detail status card selector so label typography no longer leaks into nested status icons.
- Replaced font-dependent status characters with fixed inline SVG symbols.
- Run status and step-result status now use the same status-icon component, dimensions, alignment, border, and color rules.
- Added explicit SVG sizing, stroke, margin reset, and box sizing to keep completed/failed/running/paused/queued/cancelled icons centered.

### V1.0.40_TEST_DEBUG_RUN_MONITOR_HOTFIX.md

# V1.0.40 Test & Debug run monitor hotfix

- Rebuilt the Test & Debug run-monitor information hierarchy.
- Fixed the old step status `<i>` marker conflict introduced by the unified status-icon CSS.
- Run status and step results now use the same SVG status icon component as run history.
- Added explicit progress percentage, current-step summary, step/download counters, and a dedicated error panel.
- Split step execution results and download results into clearly labeled sections with meaningful empty states.
- Preserved the existing execution, continue, cancel, download-open, polling, state-comparison, and debug behaviors.

### V1.0.40_UI_DEBUG_HOTFIX.md

# Automation Studio v1.0.40

本版調整：

1. 系統設定的「儲存系統設定」按鈕增加與上方欄位的垂直間距。
2. 發布與版本的「版本號」與「變更說明」改為輸入後自動儲存，且變更說明獨立保存。
3. 批次清單空白時顯示乾淨的空狀態，不顯示無意義的勾選與刪除控制。
4. 自動化設計器 Debug 抽屜依執行日誌、Console、Network、Popup / Download、變數分頁顯示對應資訊。
5. EBAS 既有功能移入「開發者功能」。
6. 產品版本更新為 1.0.40。

### V1.0.40_WORKSPACE_TOPBAR_ACTIONS_HOTFIX.md

# V1.0.40 workspace topbar actions hotfix

- Limit the top-right project action group to views under the sidebar Work Space section only.
- Keep the save state, refresh, and quick-run controls visible on Dashboard, Workstation, Designer, Parameters, and Test/Debug.
- Hide the whole action group on Batch, Runs, Publish, Settings, Help, Report Issue, and Developer views.
- Add an explicit hidden-state CSS rule so the flex layout cannot override the HTML hidden attribute.


<a id="v1013"></a>

## v1.0.13

### V1.0.13_DEBUG_RETENTION_HOTFIX.md

# V1.0.13 Debug 保留與自動清理

本版讓「系統設定 > Debug 保留天數」與「Debug 保存方式」真正接入執行器與維護機制。

## 保存方式

- `僅失敗任務`：成功 run 完成後，只刪除該 run 自己的 Debug 目錄；不掃描或刪除其他歷史 run。失敗與取消 run 依保留天數保存。
- `全部任務`：成功、失敗、取消 run 都保存，直到超過 Debug 保留天數。

## 到期清理

採「事件觸發 + 24 小時節流」：

1. Automation Studio 啟動時檢查一次是否已距上次完整清理 24 小時。
2. 任一流程完成後只做輕量的時間判斷；未滿 24 小時不掃描 Debug 目錄。
3. 已滿 24 小時才在背景啟動完整到期清理。
4. single-flight：同一時間只允許一個完整清理工作，避免批次任務重複掃描。
5. 正在執行、等待或暫停中的 run 不會被刪除。
6. 另提供「立即清理過期 Debug」按鈕，可忽略 24 小時節流手動執行一次。

完整清理使用 run 的 `endedAt` 判斷到期；另外會清理舊版遺留、已無執行紀錄且資料夾名稱為 `run-*` 的過期孤兒 Debug 目錄。

## 系統設定資訊

系統設定會顯示：

- 上次完成清理時間
- 最近一次刪除的 run 數量
- 最近一次釋放的磁碟空間
- 下次最早可自動清理時間
- 最近清理錯誤（若有）

清理狀態保存在 `data/studio/debug-cleanup-status.json`，與一般系統設定分開，避免每次 run 完成都改寫 `settings.json`。


<a id="v1012"></a>

## v1.0.12

### V1.0.12_DEBUG_AI_FAILURE_DIAGNOSTICS.md

# V1.0.12 測試與 Debug：AI 失敗分析與診斷包

## 新增功能

- 執行失敗後可在「測試與 Debug」直接按「AI 分析失敗原因」。
- AI 會使用失敗步驟、錯誤訊息、最近執行事件、Console／Network／Popup／Download 資訊，以及失敗頁面的實際元素摘要進行分析。
- AI 回傳根因、證據、信心程度、建議與「候選步驟設定修正」。
- 候選修正不會自動套用；使用者確認後才修改原失敗步驟。
- AI 不得修改 step.id、step.kind、流程結構，也不能自行發明 selector。新的 selector 必須來自失敗頁面的實際 selectorCandidates 或原步驟既有 selector。
- 新增「下載失敗診斷包 ZIP」。診斷包包含執行摘要、失敗步驟、事件、頁面文字／元素摘要、selector 候選及遮罩後的失敗截圖。

## 診斷包遮罩

- 敏感參數／secret 參數值遮罩。
- Workflow 變數值不輸出，只保留變數名稱。
- URL query 值遮罩。
- Authorization、API Key、Token、Password 等常見憑證字串遮罩。
- 本機絕對路徑只保留檔名。
- 失敗截圖會遮罩 input、textarea、select、contenteditable 等表單欄位內容。

> 自動遮罩無法保證移除畫面中所有業務資料；提供外部 AI 前仍應人工檢查 ZIP 內容。

### V1.0.12_DESIGNER_STEP_RUN_BUTTONS_HOTFIX.md

# V1.0.12 自動化設計器步驟快速執行按鍵修正

## 目的

在「自動化設計器 → 流程步驟」的每一個流程卡片內直接提供局部 Debug 操作，減少必須先選取步驟、再切換到「測試與 Debug」頁面的操作次數。

## 新增功能

- 每個已啟用流程步驟新增「只執行此步驟」。
- 每個已啟用流程步驟新增「從此步驟執行」。
- 條件分支與迴圈內的巢狀子步驟同樣提供兩個按鍵。
- 點擊按鍵時會先把該步驟設為目前選取步驟，再沿用 V1.0.11 的局部 Debug 執行邏輯。
- 執行建立成功後會自動切換到「測試與 Debug」查看執行監控。
- 停用中的步驟不提供直接執行，避免建立沒有有效步驟的 Debug 執行。

## 執行語意

- `只執行此步驟`：只執行目前卡片代表的步驟。
- `從此步驟執行`：從目前卡片代表的步驟開始，接續同層後續步驟，再銜接外層後續流程。

兩種方式都不會自動重跑該步驟之前的登入、導頁、變數建立或其他前置狀態。

### V1.0.12_UI_INFORMATION_ARCHITECTURE_HOTFIX.md

# V1.0.12 UI Information Architecture Hotfix

本修正版針對資訊密度與功能分類調整介面，不變更既有流程格式或執行邏輯。

## 使用說明重新編排

- 移除獨立的「測試與 Debug：步驟執行方式」大區塊。
- 移除獨立的「測試失敗後：AI 分析與失敗診斷包」大區塊。
- 兩者改放在「主要操作說明 → 測試與 Debug」內，並以個別 `<details>` 收折。
- 使用者只在需要時展開細節，降低同一頁一次呈現過多資訊的閱讀負擔。

## AI 流程助理移至開發者功能

- 左側「工作空間」不再直接顯示「AI 流程助理」。
- 「AI 流程助理」改放在左側「開發者功能」收折選單內。
- 進入 AI 流程助理時，頁首分類顯示為「開發者功能」，且不顯示工作空間專用的快速儲存／執行控制列。

## 系統設定 AI Provider 分層收折

- 整個「AI Provider」設定區預設收折，需要時再展開。
- Gemini、OpenAI、Ollama / Local、OpenAI-compatible、Company AI Gateway 等每個 Provider 也改成獨立收折區塊。
- Provider 摘要顯示名稱、類型、用途與啟用狀態；展開後才顯示 Endpoint、Model、Timeout、驗證方式、密鑰來源及測試連線等完整設定。
- 收折只影響介面呈現，不改變原有設定內容、保存方式與 Provider 測試功能。


<a id="v1011"></a>

## v1.0.11

### V1.0.11_STEP_DEBUG_EXECUTION.md

# V1.0.11 測試與 Debug 步驟範圍執行

## 變更內容

- 將原「執行選取步驟」明確改名為「只執行此步驟」。
- 新增「從此步驟執行」，可由選取步驟一路執行至流程結束。
- 後端步驟尋找改為遞迴，條件分支與迴圈內的巢狀子步驟可直接單獨執行。
- 從巢狀子步驟開始時，會執行該步驟、所在子清單的後續步驟，再接續父層容器後方的流程；不重跑外層條件判斷或先前迴圈。
- 測試頁會顯示目前選取步驟，未選取時局部測試按鈕停用。
- 執行紀錄新增 `from-step` 模式標籤。
- 使用說明新增三種測試方式、操作流程、巢狀步驟與前置狀態注意事項。

## 使用原則

- 只要驗證 selector、點擊、輸入或下載：使用「只執行此步驟」。
- 前半段已人工準備，只想驗證中後段：使用「從此步驟執行」。
- 最終驗收：使用「執行完整流程」。
- 局部執行不會自動重建前置頁面狀態或流程變數。


<a id="v1010"></a>

## v1.0.10

### V1.0.10_AI_EXECUTION_MONITOR.md

# V1.0.10 AI 執行監控

本版讓 AI 流程助理在產生或修改 Workflow 時，持續顯示「目前正在做什麼」與「正在等待什麼」，避免長時間只有按鈕轉圈而無法判斷停滯位置。

## 監控階段

介面會顯示：

1. 準備 AI 工作
2. 啟動／接管瀏覽器
3. 掃描目前頁面
4. 等待 AI 決定下一步
5. 驗證 selector
6. 執行網站操作／等待頁面反應
7. 收集網站證據
8. 等待 AI 產生 Workflow
9. 驗證 Workflow
10. 建立候選流程

網站探索期間，後端 exploration session 會持續更新 AI planning、selector probe、browser action、page wait 等狀態；前端每秒取得最新狀態，所以即使原本的長 HTTP 請求尚未回傳，也能看到目前卡在哪個階段。

## 停滯提示

- AI Provider 等待超過 30 秒：提示 AI 回覆時間較長。
- selector 驗證超過 10 秒：提示元素可能改變、位於 iframe 或暫時不可操作。
- 網站操作／頁面反應超過 15 秒：提示頁面可能沒有產生預期變化。
- 相同網站操作連續出現 3 次以上：提示可能進入重複探索。
- 狀態超過 30 秒沒有更新：提示可能停滯。

## 操作按鈕

- `重新嘗試目前步驟`：在失敗或停止後重新嘗試最近的 AI 工作。若網站探索證據已完成且失敗點位於 Workflow 產生階段，會優先沿用既有證據，不重新操作網站。
- `停止目前探索`：停止目前前端 AI 工作；若仍在網站探索階段，會同時關閉探索 session。若已進入 Workflow AI 產生階段，會保留完成的網站證據，方便重試。
- `複製診斷資訊`：複製版本、Provider、Timeout、目前 URL、階段、等待原因、selector、最後成功動作、最近 20 筆事件與最近錯誤，方便除錯。

## AI Provider Timeout

OpenAI、Gemini、OpenAI-compatible、Company Gateway 與 Ollama 的新預設 Timeout 調整為 180000 ms（180 秒）。

若 AbortController 因逾時中止請求，錯誤會明確顯示：

`AI 回應逾時：等待超過 N 秒，已停止本次請求。`

並使用 `AI_TIMEOUT` 錯誤代碼，不再只顯示 `This operation was aborted`。

## Token 使用

執行監控、計時、停滯判斷、狀態輪詢、停止、診斷資訊與本機重試控制均由程式處理，不額外呼叫 AI。只有真正要求 AI 重新規劃、產生 Workflow 或修改流程時才會使用 AI Provider。

### V1.0.10_AI_PROJECT_APPLY_ENABLE_HOTFIX.md

# V1.0.10 AI Project Apply Enable Hotfix

- 修正 AI 草稿已有 targetUrl，但第一個 `navigate` 步驟漏掉 `url` 時被驗證器判定無效，導致「建立為新專案」與「套用至目前專案」無法點選。
- `navigate` 缺少網址時，程式會優先採用步驟 value 中的合法 HTTP(S) URL，否則自動採用 Workflow `targetUrl`，並留下 warning。
- 強化 AI prompt，要求 `navigate` 明確輸出 URL。
- 草稿操作按鈕新增停用原因 tooltip 與畫面提示；若只是沒有目前專案，會明確告知仍可「建立為新專案」。
- `newTab` 未指定 URL 時視為開啟空白分頁並顯示 warning，不再誤用 navigate 的必填規則。


<a id="v109"></a>

## v1.0.9

### V1.0.9_AI_DOWNLOAD_EXPLORATION_RULE_HOTFIX.md

# V1.0.9 AI Download Exploration Rule Hotfix

This hotfix changes AI website exploration download handling.

- Local file downloads are treated as read-only exploration actions.
- PDF, Excel, XML, ZIP, document and attachment downloads may be explored automatically.
- Multiple requested downloads do not require manual handoff merely because multiple files are saved locally.
- A programmatic fallback converts download-only manual planner decisions into safe clicks on observed download elements.
- Already visited download elements on the same page are skipped so exploration can proceed to additional files.
- Recorder download events are preserved in AI evidence as `action: download`.
- Workflow generation is instructed to convert trusted download traces into `kind: download` with `downloadMode: auto`.
- Destructive or remote side effects such as delete, submit, pay, approve, publish or save changes still require manual handling, even when a download is also involved.

### V1.0.9_AI_PERSISTENT_ERROR_LOG_HOTFIX.md

# V1.0.9 AI 流程助理持久錯誤紀錄修正

## 問題
AI 流程助理在網站探索、草稿產生或多輪修改發生例外時，多數訊息只透過全域 toast 顯示；toast 會在約 3.6 秒後自動隱藏，造成錯誤一閃而逝，使用者無法確認內容。

## 修正
- AI 流程助理新增「AI 錯誤紀錄」持久面板。
- 紀錄發生時間、發生階段與完整錯誤訊息。
- 保留最近 20 筆錯誤。
- 錯誤紀錄寫入 AI Workflow 本機 session，重新整理頁面後仍保留。
- 可單筆關閉或按「全部清除」移除。
- 清除 AI 草稿不會順便刪除錯誤紀錄；錯誤只由錯誤面板的關閉／清除操作移除。
- 原有 toast 仍作為即時提示，但不再是唯一錯誤顯示位置。

## 涵蓋階段
- 開啟／顯示／關閉網站檢視
- AI 網站探索與流程草稿產生
- 多輪對話式修改
- 候選修改正式套用
- 建立 AI 草稿專案
- 套用 AI 草稿至目前專案

### V1.0.9_CANDIDATE_CONFIRMATION_UI_HOTFIX.md

# V1.0.9 Candidate Confirmation UI Hotfix

- 候選修改的流程步驟直接標示差異：綠色新增、黃色修改、紅色刪除、箭頭顯示移動位置。
- 已刪除步驟保留為紅色虛線列供確認，不會混入候選流程實際資料。
- 新增「確認並套用至目前專案」按鈕：單次確認後直接把候選版寫入目前專案，同時保存上一版快照。
- 保留「僅套用至 AI 草稿」供需要分段檢查時使用。
- 候選版無實際差異或驗證失敗時，直接套用按鈕停用。
- 確認、放棄、復原與差異顯示均由本機程式執行，不新增 AI 呼叫。
- 若候選版已正式套用至目前專案，「復原上一版」會同時將 AI 草稿與正式專案一併復原，仍不呼叫 AI。

### V1.0.9_CONVERSATIONAL_AI_WORKFLOW.md

# V1.0.9 對話式 AI 流程修改

## 目標

讓 AI 流程助理在產生初版 Workflow 後，可以持續以自然語言修改同一份草稿，而不是每次重新產生整份流程。

## 新增功能

- 多輪對話式修改：保留最近對話與目前草稿作為修改上下文。
- 最小變更原則：提示 AI 僅修改本輪明確要求的內容，未提及步驟與參數保持原狀。
- 穩定步驟 ID：既有 step.id / parameter.id 在修改時保留，方便差異比較與版本追蹤。
- 差異預覽：修改結果先成為候選版，列出新增、刪除、修改、移動的步驟與參數差異。
- 明確套用：只有按下「套用此次修改」後，候選版才成為目前草稿。
- 放棄修改：候選版可直接丟棄，不影響目前草稿。
- 必要時重新探索網站：若修改需要新的互動元素而目前沒有可信 selector，AI 先回報需要探索；系統再透過真實瀏覽器取得 selector 後重新產生候選版。
- 復原上一版：按鈕直接從本機版本快照還原，不呼叫 AI、不消耗 AI 額度。
- 本機版本快照：保留最近 20 個已套用前版本，並保存於瀏覽器 localStorage，重新整理後仍可繼續對話與復原。

## selector 安全原則

對話修改不得自行發明 selector。互動 selector 只能來自：

1. 目前 AI 草稿既有 selector；
2. 目前專案既有 selector；
3. AI 網站探索實際觀察取得的 selector。

若都不存在，系統要求重新探索網站。

## 復原行為

「復原上一版」只執行本機程式：

1. 從版本堆疊取出上一份草稿與驗證結果；
2. 將目前草稿切回上一版；
3. 更新對話紀錄，明確註記後續以復原後版本為準；
4. 不呼叫 `/api/studio/ai/*`，因此不產生 AI 使用量。

### V1.0.9_CONVERSATIONAL_REVISION_EXPLORATION_HOTFIX.md

# V1.0.9 對話式修改／網站探索狀態 Hotfix

## 問題

多輪對話修改時，只要存在一個尚未完成 (`readyForDraft=false`) 的 AI 網站探索工作階段，候選流程驗證就會直接回報：

`AI 網站探索尚未完成，請先完成實際網站檢視或人工操作後再產生流程。`

這會誤擋不需要網站元素的修改，例如調整等待時間、步驟名稱、條件、參數或既有步驟順序。

另外，若網站探索停在登入／MFA／人工確認階段，`/ai/workflows/revise` 也會無條件拒絕所有修改。

## 修正

- 初版流程產生仍要求網站探索完成。
- 對話式修改不再要求整個探索工作階段必須 `readyForDraft=true`。
- 對話式修改仍逐一檢查互動步驟 selector：
  - 既有流程 selector 可直接沿用。
  - 已由網站探索驗證的 selector 可使用。
  - AI 自行發明或未驗證的新 selector 仍會被拒絕並要求重新探索。
- `/ai/workflows/revise` 不再因探索停在人工操作而無條件中止；由本輪修改需求決定是否真的需要恢復探索。

## 使用行為

- 改名稱、等待時間、條件、參數、順序：直接產生候選修改，不需完成或重開網站探索。
- 新增／改成操作新的按鈕、輸入框、下載連結：AI 會回報需要重新探索，系統再開啟／繼續網站檢視取得 selector。
- 初次產生流程：仍維持先探索網站再產生草稿的安全機制。


<a id="v108"></a>

## v1.0.8

### V1.0.8_AI_EXPLORATION_IDENTIFIER_HOTFIX.md

# V1.0.8 AI Exploration Identifier Hotfix

## Problem
AI Workflow Assistant failed when starting site exploration with:

`識別碼只能包含英數字、句點、底線與連字號。`

## Cause
The temporary recorder project id was generated as `__${sessionId}`. Existing project/profile safety validation requires the first character to be alphanumeric, so the leading underscores were rejected before the exploration browser could start.

## Fix
- Generate temporary recorder project IDs through `createAIRecorderProjectId()`.
- Use the `ai-recorder-` alphanumeric prefix.
- Normalize unexpected characters and cap the identifier at 120 characters.
- Add regression coverage for normal, Chinese/space-containing, and path-like session ids.

## Validation
- `npm run check`: passed.
- `npm test`: 82/82 passed.

### V1.0.8_AI_SITE_EXPLORATION.md

# Automation Studio V1.0.8 AI Site Exploration

本版將 AI 流程助理由「僅依文字猜測流程」改為「先實際網站探索，再產生流程」。

## 主要調整

1. 新增可見瀏覽器網站檢視工作階段，沿用目前專案的 managed/CDP 瀏覽器設定。
2. AI 每次只能操作當下 DOM 中真實存在的 element ref，不可直接發明 selector。
3. 實際操作或 selector probe 會沿用錄製器的 selector 產生邏輯，保留 role/label/name/testId/CSS/text 等候選。
4. 登入、MFA、驗證碼與高風險送出操作改為人工接手，完成後可繼續探索。
5. Workflow 草稿驗證改為強制 selector lineage：互動步驟 selector 必須來自本次探索或既有專案。
6. 沒有 selector 的 click/fill/select/download 等互動步驟不再只是 warning，而會阻止建立／套用草稿。
7. 新增 UI 狀態：網站檢視尚未開始、已開啟、等待人工操作、探索完成。

## 隱私

探索內容不傳送密碼、Cookie、登入憑證或欄位實際輸入值。可操作元素的名稱、標籤、按鈕文字及必要 URL 結構會送至目前設定的 AI Provider，因此機敏網站建議使用本機 Ollama 或內部 Gateway。

### V1.0.8_NODE_STRIP_ONLY_HOTFIX.md

# V1.0.8 Node strip-only TypeScript 啟動修復

## 問題

啟動時 Node 直接使用 `--experimental-strip-types` 載入 TypeScript，`src/studio/ai/siteExplorer.ts` 原本採用 constructor parameter property：

```ts
constructor(private readonly recorder: RecorderManager) {}
```

此語法需要 TypeScript 轉譯，不屬於 strip-only 可直接移除的型別語法，因此會在實際模組載入時拋出 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。

## 修正

改為先宣告欄位，再於 constructor 內賦值：

```ts
private readonly recorder: RecorderManager;

constructor(recorder: RecorderManager) {
  this.recorder = recorder;
}
```

## 驗證

- `npm run check` 通過。
- 完整測試通過。
- 直接 `import('./src/studio/ai/siteExplorer.ts')` 成功。
- 直接啟動 `src/ui/server.ts` 可正常進入 `MCP UI ready`。
- 新增回歸測試，避免 AI 網站探索模組再次使用 Node strip-only 不支援的 constructor parameter property。

### V1.0.8_TLS_REJECT_UNAUTHORIZED_STARTUP_HOTFIX.md

# V1.0.8 TLS startup hotfix

依需求，在專案啟動腳本中自動設定：

```bat
set "NODE_TLS_REJECT_UNAUTHORIZED=0"
```

套用範圍：

- `start.bat`
- `start-ebas-ui.bat`

此設定僅存在於該批次檔啟動的程序樹，不會寫入 Windows 全域環境變數。

注意：此模式會停用 Node.js HTTPS/TLS 憑證驗證，因此僅適合已知且受控的內部網路環境。


<a id="v107"></a>

## v1.0.7

### V1.0.7_GEMINI_TLS_HOTFIX.md

# Automation Studio V1.0.7 Gemini / TLS Hotfix

## Gemini

- Endpoint：`https://generativelanguage.googleapis.com/v1beta`
- 預設 Model：`gemini-3.5-flash-lite`
- Auth mode：API Key
- Header：`x-goog-api-key: <key>`
- 429/500/502/503/504：1s -> 2s -> 4s 自動重試

## TLS 診斷

AI Provider 設定頁新增「診斷目前 Provider」。診斷不傳送 API Key；只測 DNS/TLS/HTTP 並顯示：

- Node 版本
- Endpoint
- HTTP status（有任何 HTTP 回應都表示 DNS/TLS 已通）
- `NODE_USE_SYSTEM_CA`
- `NODE_EXTRA_CA_CERTS`
- `NODE_TLS_REJECT_UNAUTHORIZED`
- 底層錯誤 code / cause

若顯示 `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`，正式解法是取得公司 Root / Intermediate CA 的 PEM chain，於啟動 Automation Studio 前設定：

```bat
set "NODE_EXTRA_CA_CERTS=D:\AI\certs\company-ca-chain.pem"
call start.bat
```

`NODE_TLS_REJECT_UNAUTHORIZED=0` 僅可短暫診斷，不應寫入正式啟動檔。


## 未標註版本的修補紀錄

### BATCH_DOWNLOAD_RESULT_HOTFIX.md

# Automation Studio v1.0.39 - Batch download result hotfix

## Changes

1. Run history / batch results now show download artifacts with the same actions as Test & Debug:
   - Open file
   - Open folder
2. Batch-mode downloads append a timestamp before the source extension.
   - Example: `損益表-114.xlsx` -> `損益表-114-20260914-154512.xlsx`
3. Non-batch Test & Debug runs keep the existing filename behavior.
4. Existing manual-login batch session reuse, parameter-ID repair, configurable download directory, iframe download lookup, and short-lived popup download tolerance are preserved.

### BATCH_MANUAL_CONTINUE_HOTFIX.md

# v1.0.39 批次人工登入與工作階段沿用修正

本修正版新增：

1. 執行紀錄頁在 `paused` 任務顯示「人工操作完成，繼續執行」按鈕。
2. 執行紀錄頁停留時每秒自動刷新，人工登入完成後可直接送出 continue 指令。
3. 批次任務建立共用瀏覽器工作階段；上一筆成功完成後，下一筆沿用同一 BrowserContext / CDP 連線。
4. 同一批次中，已人工完成過的相同 manual 步驟會在後續批次自動視為已完成，避免每一筆都重新要求登入。
5. 最後一筆批次完成後會正常釋放受管理瀏覽器；CDP 模式只斷開 Playwright 連線，不關閉使用者瀏覽器。
6. 若中途批次失敗或取消，會釋放該批次暫存工作階段，後續任務不會誤用失敗狀態。

操作方式：

- 啟動批次後切到「執行紀錄」。
- 第一筆流程到人工登入步驟時，狀態顯示「等待人工操作」。
- 在瀏覽器完成 EBAS SSO 登入。
- 回到 Automation Studio，點「人工操作完成，繼續執行」。
- 第一筆完成後，同批次後續任務會沿用登入工作階段，並略過相同的人工登入 checkpoint。

### BATCH_PARAMETER_CONTROLS_HOTFIX.md

# Batch parameter controls hotfix

Automation Studio v1.0.39 batch rows now mirror the Test & Debug parameter controls.

- `select` parameters render as dropdowns using workflow `options`.
- `boolean` parameters render as true/false dropdowns.
- number/date/secret/text parameters use matching input types.
- New batch rows inherit workflow parameter `defaultValue` values.
- Existing rows receive defaults only for newly added/missing parameters; user-edited values are preserved.
- Batch boolean values are submitted as booleans, matching Test & Debug behavior.

### DEPENDENT_SELECT_AND_FORMAT_HOTFIX.md

# v1.0.39 相依下拉選單與多格式流程支援

本修正版在既有批次參數控制功能上新增：

1. 流程參數可設定相依下拉選單：`dependsOn` + `dependentOptions`。
2. 「測試與 Debug」中，父參數變更時，子下拉選單立即依對照表縮小選項。
3. 「批次任務」中，每一列的父參數變更時，該列子下拉選單立即重新篩選；原值若已不合法，改用該分類的預設/第一個選項。
4. 參數編輯器新增「相依參數」與「相依選項」設定欄位。
5. 匯出 JSON Schema 會保留 `x-dependsOn` 與 `x-dependentOptions` metadata。
6. EBAS v1.3.0 流程新增輸出格式參數：Excel / PDF / XML，並依格式切換勾選狀態與下載副檔名。

相依選項編輯格式：

```text
決算主要表=損益表|盈虧撥補表|現金流量表|資產負債表
決算明細表=XX收入明細表|XX成本(或費用)明細表|成本彙總表
決算參考表=員工人數彙計表|用人費用彙計表|各項費用彙計表
```

### DESIGNER_DELETE_INDEPENDENT_SCROLL_HOTFIX.md

# Designer delete button + independent scrolling hotfix

- 每一個流程步驟卡片右側新增刪除按鈕（×），支援主流程及條件/迴圈內巢狀步驟。
- 保留原本步驟設定中的刪除按鈕與 Delete 快捷鍵。
- 桌面版設計器左側「動作元件」、中間「流程步驟」、右側「步驟設定」改為各自獨立捲動。
- 三欄標題固定在各欄上方，僅內容區捲動，避免調整長流程時左右欄位跟著跑掉。
- 窄螢幕維持響應式堆疊並限制單一面板高度，避免破壞原本版面。

### DESIGNER_PAGE_WIDTH_RELAYOUT_HOTFIX.md

# Automation Studio v1.0.39 page width relayout

- Assigns a content max-width to every main workspace page instead of forcing every page to the same 1600px width.
- Aligns the top header to the active page width.
- Gives Automation Designer the widest layout and redistributes palette/canvas/properties widths according to their content needs.
- Narrows form-heavy pages for readability and keeps table/debug pages wider.
- Preserves the existing independent scrolling and per-step delete controls.
- Keeps responsive single-column behavior on smaller screens.

### DGBAS_CDP_DOWNLOAD_SINK_HOTFIX.md

# DGBAS Chrome DevTools download sink hotfix

## Problem

DGBAS `Download.ashx` can trigger a Chrome download and close the initiating target immediately. A Playwright `download` event may therefore be observed while `download.path()`, `saveAs()`, `createReadStream()`, or a BrowserContext request already sees a closed target/context.

## Fix

For PDF click-download steps when `downloadPdfInsteadOfPreview` is enabled:

1. Before clicking, create an isolated temporary download directory.
2. Attach a Chromium CDP session to the source page.
3. Configure `Page.setDownloadBehavior` (falling back to `Browser.setDownloadBehavior`) so Chrome itself writes downloads directly into that directory.
4. Remove `target=_blank` and keep the existing PDF-download preference.
5. Click once.
6. Poll the isolated directory until the `.crdownload` file is finalized and the file size is stable.
7. Verify `%PDF-` for PDF URLs, then copy the finished file into the configured Automation Studio download directory.
8. Keep the former Playwright download/PDF-response/stream/curl/request paths only as fallbacks.

This moves the primary save operation *before* the short-lived page can close and does not depend on Playwright's `Download` object after the event is emitted.

### DGBAS_CDP_NETWORK_RESOURCE_HOTFIX.md

# DGBAS CDP network-resource download hotfix

This build adds a pre-click PDF download path based on Chrome DevTools Protocol `Network.loadNetworkResource` and `IO.read`.

For PDF links with a stable href and `downloadPdfInsteadOfPreview=true`, Automation Studio now asks Chrome itself to fetch the resource with browser credentials and cache disabled, streams the response to a temporary file, validates the `%PDF-` signature, and then copies the file to the configured download directory.

This path runs before the legacy click/download-event path, so it does not depend on Playwright `Download.saveAs()`, a popup remaining alive, or `BrowserContext.request` after the source page closes. Existing download methods remain as fallbacks.

### DGBAS_CHROME_NETWORK_DOWNLOAD_HOTFIX.md

# DGBAS Chrome Network Download Hotfix

This hotfix adds a new fallback path for `downloadMode: auto`.

Order:
1. Existing Node/Playwright `context.request.get()` direct download.
2. New Chrome-network navigation download: open a temporary page in the same BrowserContext, navigate directly to the anchor URL, then save either a native Chrome download or the PDF response body.
3. Existing source-element click/download/PDF-preview capture.
4. Existing saveAs/createReadStream/URL recovery chain.

The new path uses Chrome's TLS trust, cookies, session and network stack. It is designed for public/corporate sites whose download endpoint opens an inline PDF or where Node TLS differs from Chrome TLS.

No selectors, workflow steps, allowed domains, or explicit `direct` / `click` mode semantics were removed.

### DGBAS_DOWNLOAD_ASHX_HOTFIX.md

# DGBAS Download.ashx PDF response hotfix

- Recognize DGBAS `Download.ashx` PDF links whose filename/path is Base64-encoded in query parameters `n` or `u`.
- Preserve the decoded original filename when response headers use a generic content type or omit a PDF filename.
- Keeps existing direct-download, TLS fallback, native browser download, and stream-recovery behavior unchanged.

### DGBAS_PDF_DIRECT_CLICK_HOTFIX.md

# DGBAS PDF direct-click hotfix

This hotfix adds an opt-in browser setting: `browser.downloadPdfInsteadOfPreview`.

When enabled for a managed persistent Chrome profile, Automation Studio writes Chrome's supported preference `plugins.always_open_pdf_externally=true` before browser startup. Download steps can therefore use native click-based downloads instead of opening the built-in PDF viewer. The executor also removes `target=_blank` from PDF anchors immediately before a forced-download click so the source page is not replaced by a preview tab.

The supplied DGBAS workflow enables this setting and changes the final PDF download step to `downloadMode: "click"`. Existing `auto`, direct-request, certificate fallback, response capture, and stream recovery behavior is preserved for other workflows.

### DOWNLOAD_CONTEXT_CLOSED_NATIVE_FALLBACK_HOTFIX.md

# Download context-closed native fallback hotfix

- Fixes downloads where Playwright receives the native `download` event but the originating page or BrowserContext closes before `saveAs()` / `context.request.get()` can finish.
- Native download staging now first uses `download.path()` and copies the browser-owned temporary file while the context is alive, then falls back to `saveAs()` and `createReadStream()`.
- Before clicking, the runner snapshots User-Agent, Referer and relevant cookies for recovery without querying a later-closed BrowserContext.
- On Windows, if the Playwright download object is no longer usable, the runner now tries the OS `curl.exe` (Schannel / Windows certificate store) with the captured request headers before attempting `context.request.get()`.
- This fallback is independent of the source page and Playwright BrowserContext lifetime, so short-lived DGBAS `Download.ashx` pages cannot invalidate the final recovery request.
- Existing direct download, Chrome-network download, PDF response capture, TLS/CA handling, stream recovery, filename handling and designer UI changes remain intact.

### DOWNLOAD_FALLBACK_GUARD_HOTFIX.md

# 下載憑證自動降級防護 Hotfix

本修正以增加防護為原則，不移除或取代既有下載機制。

- `downloadMode=auto`：直接下載遇到 TLS/CA 信任錯誤時不終止步驟，自動切換至既有瀏覽器點擊下載。
- `downloadMode=direct`：維持嚴格模式，直接下載失敗仍回報錯誤，不擅自更改使用者指定模式。
- 瀏覽器已觸發下載、但 `download.saveAs()` 失敗時，先讀取 Playwright 已取得的 `createReadStream()` 內容保存，避免不必要的第二次 Node HTTPS 請求。
- 只有既有下載串流也不可用時，才使用原下載 URL 進行最後救援。
- 保留 `NODE_USE_SYSTEM_CA=1` 支援；未關閉 TLS 憑證驗證。
- 自動降級會在執行結果留下說明，便於判斷實際採用的下載路徑。

### DOWNLOAD_SYSTEM_CA_HOTFIX.md

# Automation Studio v1.0.39 - Windows system CA download hotfix

## 問題

部分 Windows／公司網路環境會由 HTTPS 檢查設備重新簽發網站憑證。Chrome 會使用 Windows 信任憑證庫，因此人工開啟或下載正常；但 Playwright 的 `APIRequestContext` 由 Node.js 發出請求，若 Node 未啟用系統 CA，就可能在直接下載時出現：

```text
apiRequestContext.get: unable to get local issuer certificate
```

這不是 selector、PDF 連結或允許網域錯誤，而是「瀏覽器與 Node 使用不同憑證信任來源」造成。

## 修正

1. `start.bat` 預設加入 `NODE_USE_SYSTEM_CA=1`。
2. `start-ebas-ui.bat` 套用相同設定。
3. 由 Automation Studio 匯出的 TypeScript 專案 `start.bat` 也會自動套用。
4. 不設定 `NODE_TLS_REJECT_UNAUTHORIZED=0`，不關閉 TLS 驗證。
5. 不修改原流程的 `downloadMode`、selector、PDF 點擊／直接下載邏輯，因此原本可正常執行的流程維持原行為。

## 若仍失敗

若公司根憑證未安裝在 Windows 信任憑證庫，請由資訊單位提供 CA 憑證，並在啟動前設定 `NODE_EXTRA_CA_CERTS`。不要關閉 TLS 驗證。

### EBAS_DOWNLOAD_HOTFIX.md

# EBAS download hotfix for Automation Studio v1.0.39

This build contains two EBAS/download fixes:

1. Download steps now honor `autoFrameSearch`. EBAS renders `#print` inside the `main` iframe, so the final Excel download step can locate and click the Print button.
2. `Settings -> Default download path` is now used by workflow downloads. Relative paths resolve from the Automation Studio folder; absolute Windows paths such as `D:\EBAS下載` are used directly.

The download artifact open/open-folder API uses the same configured download root.

The earlier short-lived popup/page-close download race hotfix is retained.

### PUBLISH_RUNS_BATCH_LAYOUT_HOTFIX.md

# Publish / Runs / Batch layout hotfix

Target: Automation Studio v1.0.39

## Changes

1. Publish & Version
   - The change-notes textarea is initialized from the current project's original description when a project is first shown.
   - Switching projects refreshes the initial notes, while typing within the same project is not overwritten by routine renders.

2. Run History
   - Uses a fixed-layout table with explicit column proportions.
   - Long error URLs and stack traces wrap within the error cell instead of widening the page.
   - Project IDs and downloaded filenames are clipped/ellipsized where appropriate.
   - Action buttons remain within the action column so the full run-history feature set stays visible within the page width on desktop.

3. Batch Tasks
   - Keeps the batch list full-width at the top.
   - Groups advanced settings into Execution pacing, Retry/concurrency, and Debug/storage sections.
   - Adds an auto-save indicator and improves spacing, sticky table headers, alternating rows, and responsive layout.

### REPEATED_DOWNLOAD_LIFETIME_HOTFIX.md

# Repeated download lifetime hotfix

- Fixes a repeat-run race where the first PDF download succeeds but a later run receives the native download event and then loses the short-lived source page/context before `saveAs()` executes.
- Native download bytes are now staged immediately when the browser emits the `download` event.
- Final naming and duplicate-file handling remain unchanged; the staged file is copied to the normal configured download directory and then removed.
- Existing direct, Chrome-network, PDF-response, stream, TLS/CA, and URL recovery paths remain available.
- The generated TypeScript runner receives the same protection so exported workflows behave consistently.

### RUN_HISTORY_WINDOWS_EPERR_HOTFIX.md

# V1.0.40 Windows Run History EPERM Hotfix

修正 Windows 環境在流程已完成後，儲存 `data/studio/runs/run-*.json` 時偶發：

`EPERM: operation not permitted, rename '...json.<pid>.tmp' -> '...json'`

## 調整內容

- 同一個 JSON 檔案改為序列化寫入，避免同一 Run 的進度、下載、Console 與完成狀態互相競爭 rename。
- tmp 檔名加入 PID、時間戳與序號，不再只使用固定 PID tmp 名稱。
- `EPERM`、`EBUSY`、`EACCES` 採指數退避重試（50ms 起，最多 1 秒間隔，共 8 次重試）。
- 排隊前先建立 JSON 快照，避免 mutable Run 在等待寫入期間改變，造成紀錄順序不一致。
- 若執行紀錄在重試後仍因外部程式鎖檔而無法保存，只輸出 `[run-store]` 警告，不再把已成功完成的自動化流程改判為失敗。
- tmp 檔在失敗後 best-effort 清理，避免長期累積。

此修正不改變 workflow schema、專案匯入格式或既有瀏覽器自動化邏輯。



## v2.3.1 — Python Action Compatibility

- Extend Python Playwright/Selenium exports to all 27 workflow step kinds (browser-side JavaScript, clipboard, waitNewFirst/waitNewListItem, periodic refresh).
- Add structured list snapshots, iframe scoping, component actions, direct authenticated HTTP link download, and table/Word/Excel document format alignment.
- Preserve original TypeScript runner and original Managed Auth. Python profiles remain separate; Stealth plugin is not ported.
- Fail closed for Node-only scripts and Selenium-only Playwright CSS without valid fallback.

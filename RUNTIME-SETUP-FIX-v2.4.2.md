# Automation Studio v2.4.2：setup-runtime 安裝修復

## 原因

- `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`：Node.js 無法信任目前 HTTPS 伺服器/公司代理憑證的發行者。
- `EXDEV: cross-device link not permitted`：安裝器原本把解壓資料寫到 C: 的系統 TEMP，之後用 `rename()` 移到 D: 的專案目錄，跨磁碟移動失敗。

## 修改

1. 執行 `setup-runtime.bat` 時使用目前安裝路徑下 `.local\setup-temp` 作為 TEMP、TMP、TMPDIR；Node 程式也以專案目錄計算，不依賴目前命令列工作磁碟。
2. Node 套件先以正常憑證驗證下載；僅遇無法信任簽發者時，對該筆 HTTPS 請求暫時不驗證憑證，下一筆請求自動恢復；固定 SHA-512 完整性檢查不可省略。
3. `node.exe` 下載先驗證憑證，僅 curl 的錯誤碼 60 觸發 `--insecure` 單次重試；通過固定 SHA-256 才能執行。
4. Playwright Chromium 僅在安裝子程序明確顯示 TLS 發行者憑證錯誤時，用獨立子程序短暫關閉驗證重試，父程序和 `start.bat` 永遠維持正常驗證。
5. `rename` 若在特殊磁碟/掛載環境仍回報 EXDEV，自動以跨磁碟複製取代，失敗時復原既有套件並清理暫存。

## 更新方式

- **整包更新**：備份原專案資料、工作流程與登入 Profile，停止程式，將 v2.4.2 完整 ZIP 解壓至既有位置。保留原有 `runtime/node/node.exe`、`runtime/browsers/`、`data/`、`downloads/`。
- **只修正 setup-runtime**：備份原本檔案，將修補包內 `setup-runtime.bat` 覆蓋專案根目錄、`scripts/setup-portable-runtime.mjs` 覆蓋 `scripts/` 子目錄，保持既有 `scripts/portable-runtime-packages.json` 不變。
- 雙擊 `setup-runtime.bat`。已正確安裝且版本符合的套件會被略過；失敗不會自行改變已安裝的 Node.js 版本。

## 安全界線

自動忽略 TLS 憑證驗證會降低運輸安全性，只用於使用者明確要求且所需套件已具有獨立、固定完整性校驗的環節。若公司政策不允許，請在受信任環境預先下載或匯入核准的公司 CA 並設定 `NODE_EXTRA_CA_CERTS`。不要對常駐執行環境或所有程式設定 `NODE_TLS_REJECT_UNAUTHORIZED=0`。

## 驗證限制

新增自動化測試涵蓋 TLS 只在單次請求關閉、下一次恢復、SHA-512 檢驗、EXDEV 備援與同磁碟暫存；Windows 企業代理、Chrome 真實下載仍須在目標電腦實測。

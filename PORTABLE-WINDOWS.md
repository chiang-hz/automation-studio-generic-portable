# Windows 可攜版啟動與修復

1. 此更新包不包含 `node.exe`，仍保留精簡執行套件。更新既有安裝時解壓縮覆蓋原資料夾，保留原本的 `runtime\node\node.exe`，再雙擊 `start.bat`。首次使用請先執行 `setup-runtime.bat` 下載必要執行檔。正常啟動只使用專案資料夾內的 Node.js，並使用 Windows 系統信任憑證庫驗證 TLS。
2. 若缺少 `runtime\node\node.exe` 或必要的 `node_modules`，先執行 `setup-runtime.bat`。**若電腦已安裝 Chrome，會直接使用 Chrome，不需下載隨附 Chromium。**
3. 安裝程式先使用正常 TLS 驗證下載；若失敗，僅對該次安裝重試暫時關閉憑證驗證。Node.js 使用固定 SHA-256，npm 套件使用固定 SHA-512 驗證內容。Chromium 由 Playwright 安裝器處理，沒有獨立的雜湊比對；如不接受這項風險，請用正常憑證連線安裝，或使用電腦已有的 Chrome。
4. 公司憑證不在 Windows 信任庫時，請向資訊單位取得憑證；需要時在執行前指定 `NODE_EXTRA_CA_CERTS` 的 PEM 路徑。

`setup-runtime.bat` 需要 Windows 內建的 `curl.exe`、`certutil.exe` 與 `tar.exe`。下載失敗不會改用系統 Node.js 或 npm；需由網路管理員確認下載網域可連線。此包未隨附 Chromium。若偵測到 Chrome，舊專案即使選擇「隨附 Chromium」，在該瀏覽器不存在時也會自動使用 Chrome。若無 Chrome，安裝器才會下載隨附 Chromium；如需強制安裝隨附版，使用 `setup-runtime.bat --install-bundled-browser`。`ffmpeg`、`winldd` 並非現有流程錄製、下載與 CDP 功能所必需。

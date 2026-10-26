

## v2.4.1 下載隔離與驗證

- Selenium 不在啟動 Chrome 時把所有下載導向專案 downloads。僅在執行 download 步驟期間暫時設定獨立 `.local/download-staging/capture-*`，結束後將 Chrome 下載設定恢復為 `default`。
- 檢驗檔案內容及預期格式後，才把檔案移到 `downloads/`。若偵測到 CRX 元件（包括錯名 `downloads.htm` 的 Chrome AI 模型），或 Excel/PDF 格式不符，移入診斷區保留，不當成報表。
- 若網頁只回傳登入／錯誤 HTML，但流程預期 Excel/PDF，步驟會失敗而非偽裝成成功下載。
- 非預期檔案保留在 `.local/download-staging/`，不會自動刪除。可在確認不需診斷後自行清理；資料夾可能含敏感頁面內容，請勿外傳。
- 由於 Selenium 無 Playwright `expect_download` 的每次點擊事件物件，分離目錄及格式驗證無法完全排除同一時段產生、且格式一致的其他下載。使用者需在實際網站驗收。

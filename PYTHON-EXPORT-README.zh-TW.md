## v2.4.7 批次失敗策略

Python 批次預設個別失敗繼續下一筆。匯出時選擇「失敗後停止」會寫入 batch-settings.json，命令列 --on-error stop 或 continue 可覆寫。任一筆失敗時整批最後仍回傳非零狀態碼。



## v2.4.1 下載隔離與驗證

- Selenium 不在啟動 Chrome 時把所有下載導向專案 downloads。僅在執行 download 步驟期間暫時設定獨立 `.local/download-staging/capture-*`，結束後將 Chrome 下載設定恢復為 `default`。
- 檢驗檔案內容及預期格式後，才把檔案移到 `downloads/`。若偵測到 CRX 元件（包括錯名 `downloads.htm` 的 Chrome AI 模型），或 Excel/PDF 格式不符，移入診斷區保留，不當成報表。
- 若網頁只回傳登入／錯誤 HTML，但流程預期 Excel/PDF，步驟會失敗而非偽裝成成功下載。
- 非預期檔案保留在 `.local/download-staging/`，不會自動刪除。可在確認不需診斷後自行清理；資料夾可能含敏感頁面內容，請勿外傳。
- 由於 Selenium 無 Playwright `expect_download` 的每次點擊事件物件，分離目錄及格式驗證無法完全排除同一時段產生、且格式一致的其他下載。使用者需在實際網站驗收。


## v2.4.6 Python 批次匯出

在「發布與版本」勾選 Python Selenium／Playwright 後，可加入批次工具，並可選擇是否將「批次任務」現有清單寫入匯出 ZIP（預設不勾選，敏感參數自動排除）。

- `run-batch.bat`：逐筆執行，使用各筆獨立的 Chrome 流程。
- `run-batch-cdp.bat`：重用已登入的本機 CDP Chrome，逐筆執行，不平行操作。
- `batch.json` / `batch.example.csv`：修改 `enabled`，用參數 Key 填值；也可從 Excel 製作第一列為參數 Key 的 `batch.xlsx`。
- 使用 `--input batch.xlsx --on-error continue` 可指定檔案與失敗時繼續；`--check-only` 檢查格式，不開瀏覽器、不下載。
- `.local/batch-runs/<執行序號>/summary.json`、`summary.csv` 及各筆日誌保存結果；每筆暫存參數在結束後刪除。
- Excel 中需要保留前置零的欄位請設定為文字，避免被 Excel 自行轉成數字。

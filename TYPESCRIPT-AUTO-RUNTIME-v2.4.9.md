# TypeScript 自動依賴安裝（v2.4.9）

- TypeScript 匯出的 `start.bat` 現會檢查 playwright / Stealth 必要套件。
- 缺少時執行 npm install；僅在憑證鏈錯誤時重試單次 `npm --strict-ssl=false`。
- 優先使用本機 Chrome，禁止下載 Playwright Chromium。
- npm cache 和 TEMP/TMP 位於匯出資料夾 `.local` 下，減少跨磁碟問題。
- 使用者電腦仍須有 Node.js 與 npm。Windows 憑證問題優先建議使用公司核准 CA。

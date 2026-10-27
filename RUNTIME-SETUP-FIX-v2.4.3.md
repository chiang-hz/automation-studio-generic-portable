# Automation Studio v2.4.3 — Windows EPERM 安裝修正

## 發生原因

Windows 在解壓 npm 套件後，可能因防毒軟體掃描、檔案索引、程式尚在使用 `node_modules`，或目錄 ACL 權限限制，導致將暫存目錄移入 `node_modules` 時發生 `EPERM`。即使暫存目錄與安裝目錄同在 D:，仍可能發生，與前版修正的跨磁碟 `EXDEV` 不同。

## 修正內容

- 安裝前先檢查已安裝的套件版本；已符合者略過，重新執行不會全部重新下載。
- 以同磁碟 `.local\setup-temp` 解壓，維持 SHA-512 完整性驗證。
- `EPERM`、`EACCES`、`EBUSY` 發生時短暫重試重新命名；仍失敗就改以不覆蓋既有目的目錄的安全複製安裝。
- 複製部分失敗會清理不完整檔案後有限次重試；安裝成功會檢查 `package.json` 版本。
- 如果套件替換失敗，盡可能還原原本的套件並保留失敗復原備份。
- 延用前版僅在憑證發行者信任錯誤時才針對單次 HTTPS 請求暫時放寬 TLS 驗證，不修改系統 TLS 設定；仍建議使用企業認可 CA。從未放寬套件 SHA-512 驗證。

## 使用方法

1. 關閉 Automation Studio 視窗及其執行中的 Node.js 程序，避免占用 `node_modules`。不需要先刪除 `node_modules`。
2. 將修補 ZIP 的 `scripts\setup-portable-runtime.mjs` 複製覆蓋到原程式對應路徑；也可以使用完整 v2.4.3 版。
3. 重新雙擊 `setup-runtime.bat`。已安裝完成且版本符合的套件會自動跳過，剩下套件繼續安裝。
4. 如果複製也被拒絕，請確認專案資料夾具有寫入權限、Windows Defender/公司端點防護有無封鎖紀錄，並由公司 IT 協助核准；不要直接關閉端點防護軟體。

> 此修正可處理通常的暫時檔案占用和 rename 限制；若企業政策禁止對該目錄寫入，程式無法也不應繞過安全控制。Linux 模擬與離線 Node 測試已執行，目標 Windows 電腦仍需實機驗收。

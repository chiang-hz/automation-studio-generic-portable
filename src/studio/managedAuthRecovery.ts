/**
 * A site can reject an imported Storage State when it requires a fresh login or
 * human security verification. We NEVER attempt to solve or bypass a challenge.
 * Offer a visible browser for user-driven authentication, then verify again.
 */
export type ManagedAuthResult = "valid" | "recovered-manually";

export async function ensureManagedAuthentication(options: {
  headless: boolean;
  verify: () => Promise<void>;
  pauseForHuman: () => Promise<void>;
}): Promise<ManagedAuthResult> {
  try {
    await options.verify();
    return "valid";
  } catch {
    // Fail closed: a background worker cannot solicit a human security check.
    if (options.headless) {
      const err = new Error("保存的登入狀態未通過網站驗證，且目前為無頭模式。請切換為顯示管理瀏覽器，人工完成網站登入或 Cloudflare 驗證；程式不會自動繞過驗證。");
      Object.assign(err, {code: "AUTH_INVALID"});
      throw err;
    }
    try {
      await options.pauseForHuman();
    } catch (cause) {
      const err = new Error("等待人工登入或網站安全驗證未完成；工作流程已停止，不會在未驗證下繼續執行。", {cause});
      Object.assign(err, {code: "AUTH_INVALID"});
      throw err;
    }
    try {
      await options.verify();
      return "recovered-manually";
    } catch (cause) {
      const err = new Error("人工操作後，管理瀏覽器仍未通過登入檢查。可能是 Session 無效、後臺權限不足或 Cloudflare 仍要求驗證。請在同一管理瀏覽器確認能開啟登入後管理頁面。", {cause});
      Object.assign(err, {code: "AUTH_INVALID"});
      throw err;
    }
  }
}

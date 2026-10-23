/** A fresh plugin instance per managed browser; CDP is deliberately unchanged. */
export async function prepareStudioChromium(
  playwright: { chromium: any },
  settings: { stealth?: boolean; connectionMode?: string },
  loadPlugins = async () => {
    const [extra, plugin] = await Promise.all([
      import("playwright-extra"),
      import("puppeteer-extra-plugin-stealth")
    ]);
    return { addExtra: extra.addExtra, StealthPlugin: plugin.default };
  }
): Promise<any> {
  if (settings.stealth !== true || settings.connectionMode === "cdp") return playwright.chromium;
  try {
    const { addExtra, StealthPlugin } = await loadPlugins();
    const chromium = addExtra(playwright.chromium);
    chromium.use(StealthPlugin());
    // playwright-extra hooks new pages, but persistent contexts already contain a page.
    // Apply the page hooks before the caller navigates that initial page.
    if (typeof chromium.launchPersistentContext === "function") {
      const launchPersistent = chromium.launchPersistentContext.bind(chromium);
      chromium.launchPersistentContext = async (...args: any[]) => {
        const context = await launchPersistent(...args);
        try {
          for (const page of context.pages()) {
            await chromium.plugins.dispatchBlocking("onPageCreated", page);
          }
          return context;
        } catch (error) {
          await context.close().catch(() => undefined);
          throw error;
        }
      };
    }
    return chromium;
  } catch (error) {
    throw new Error("無法載入 Stealth。請在專案目錄執行 npm install，或關閉此專案的 Stealth 設定。", { cause: error });
  }
}

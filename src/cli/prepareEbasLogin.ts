import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "../config.ts";
import { resolveChromiumExecutablePath } from "../adapters/chromiumExecutable.ts";

const config = loadConfig();
const { chromium } = await import("playwright");

await fs.mkdir(path.dirname(config.ebasStorageStatePath), { recursive: true });

const executablePath = await resolveChromiumExecutablePath(config);
const browser = await chromium.launch({
  headless: false,
  ...(executablePath ? { executablePath } : {})
});
const context = await browser.newContext();
const page = await context.newPage();

console.log("Opening EBAS SSO login page...");
await page.goto(config.ebasLoginUrl, {
  waitUntil: "domcontentloaded",
  timeout: 60_000
});

console.log("");
console.log("請在開啟的瀏覽器完成 EBAS SSO 登入。");
console.log("登入後若沒有自動進入系統，可手動開啟：");
console.log(config.ebasEntryUrl);
console.log("");

const rl = readline.createInterface({ input, output });
await rl.question("完成登入並確認可進入 EBAS 1103 後，回到這裡按 Enter 儲存 session...");
rl.close();

await context.storageState({
  path: config.ebasStorageStatePath
});

await browser.close();

console.log(`EBAS session saved: ${config.ebasStorageStatePath}`);

import { spawn } from "node:child_process";

export function interfaceOpenCommand(port: number, platform: string = process.platform): { command: string; args: string[] } {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("介面連接埠必須為 1–65535。");
  const url = `http://127.0.0.1:${port}/`;
  if (platform === "win32") return { command: "cmd.exe", args: ["/d", "/c", "start", "", url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

export async function openInterfaceOnStartup(
  port: number,
  launch: (command: string, args: string[]) => Promise<void> = launchDetached
): Promise<boolean> {
  const { command, args } = interfaceOpenCommand(port);
  await launch(command, args);
  return true;
}

function launchDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

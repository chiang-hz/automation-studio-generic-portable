import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export type DownloadOpenMode = "file" | "folder";

export async function resolveStudioDownloadArtifact(filePath: string, downloadRoot = path.resolve("./downloads")): Promise<{ filePath: string; directory: string; normalizedFrom?: string }> {
  const root = path.resolve(downloadRoot);
  const resolved = path.resolve(filePath);
  const relative = path.relative(root, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("只允許開啟目前設定之 downloads 下載目錄內的檔案。");
  }
  const stat = await fs.stat(resolved).catch(() => undefined);
  if (!stat?.isFile()) throw new Error("下載檔案已不存在，無法開啟。");
  // Repair download records created before the extension-preserving filename
  // fix. The bytes are a valid PDF, but a long file name may have lost its
  // .pdf suffix and Windows will not know which application to use.
  if (!path.extname(resolved) && await hasPdfSignature(resolved)) {
    const repaired = `${resolved}.pdf`;
    if (!(await pathExists(repaired))) await fs.rename(resolved, repaired);
    return { filePath: repaired, directory: path.dirname(repaired), normalizedFrom: resolved };
  }
  return { filePath: resolved, directory: path.dirname(resolved) };
}

export async function openStudioDownloadArtifact(filePath: string, mode: DownloadOpenMode, downloadRoot = path.resolve("./downloads")): Promise<{ filePath: string; directory: string }> {
  const artifact = await resolveStudioDownloadArtifact(filePath, downloadRoot);
  if (process.platform === "win32") {
    if (mode === "file") {
      await runWindowsShellOpen(artifact.filePath, "file");
      return artifact;
    }
    await runWindowsShellOpen(artifact.directory, "folder");
    if (!(await waitForWindowsExplorerDirectory(artifact.directory, 5_000))) {
      throw new Error(`已送出 Explorer 開啟命令，但未確認資料夾視窗：${artifact.directory}`);
    }
    return artifact;
  }
  if (process.platform === "darwin") await runCommand("open", [mode === "file" ? artifact.filePath : artifact.directory]);
  else await runCommand("xdg-open", [mode === "file" ? artifact.filePath : artifact.directory]);
  return artifact;
}

async function hasPdfSignature(filePath: string): Promise<boolean> {
  const handle = await fs.open(filePath, "r").catch(() => undefined);
  if (!handle) return false;
  try {
    const bytes = Buffer.alloc(5);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytesRead === 5 && bytes.toString("ascii") === "%PDF-";
  } finally {
    await handle.close();
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  return Boolean(await fs.stat(filePath).catch(() => undefined));
}

async function runWindowsShellOpen(target: string, mode: DownloadOpenMode): Promise<void> {
  const script = mode === "file"
    ? [
      "$ErrorActionPreference = 'Stop'",
      "$shell = New-Object -ComObject Shell.Application",
      "if (-not (Test-Path -LiteralPath $env:TARGET_PATH -PathType Leaf)) { throw '下載檔案已不存在。' }",
      // ShellExecute uses the same file association as a human double-click,
      // unlike a detached child process that can finish before Windows handles it.
      "$shell.ShellExecute($env:TARGET_PATH, '', '', 'open', 1)",
      "Start-Sleep -Milliseconds 600"
    ].join("; ")
    : [
      "$ErrorActionPreference = 'Stop'",
      "$target = [System.IO.Path]::GetFullPath($env:TARGET_PATH).TrimEnd('\\\\')",
      "if (-not (Test-Path -LiteralPath $target -PathType Container)) { throw '下載資料夾已不存在。' }",
      "$shell = New-Object -ComObject Shell.Application",
      "$shell.Open($target)",
      "$activator = New-Object -ComObject WScript.Shell",
      "$deadline = (Get-Date).AddSeconds(5)",
      "do { Start-Sleep -Milliseconds 250; foreach ($window in @($shell.Windows())) { try { $folder = $window.Document.Folder.Self.Path; if ($folder -and ([System.IO.Path]::GetFullPath($folder).TrimEnd('\\\\') -ieq $target)) { $window.Visible = $true; [void]$activator.AppActivate([int]$window.HWND); exit 0 } } catch {} } } while ((Get-Date) -lt $deadline)",
      "throw ('未能開啟或帶到前景的資料夾：' + $target)"
    ].join("; ");
  await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { TARGET_PATH: target });
}

function runCommand(command: string, args: string[], extraEnv?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, env: extraEnv ? { ...process.env, ...extraEnv } : process.env });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} 無法執行開啟命令${stderr.trim() ? `：${stderr.trim()}` : ""}`));
    });
  });
}

async function waitForWindowsExplorerDirectory(directory: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isWindowsExplorerDirectoryOpen(directory)) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

async function isWindowsExplorerDirectoryOpen(directory: string): Promise<boolean> {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$target = [System.IO.Path]::GetFullPath($env:TARGET_DIR).TrimEnd('\\\\')",
    "$shell = New-Object -ComObject Shell.Application",
    "foreach ($window in @($shell.Windows())) { try { $path = $window.Document.Folder.Self.Path; if ($path -and ([System.IO.Path]::GetFullPath($path).TrimEnd('\\\\') -ieq $target)) { exit 0 } } catch {} }",
    "exit 1"
  ].join("; ");
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, TARGET_DIR: directory }
    });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 3_000);
    child.once("error", () => { clearTimeout(timer); resolve(false); });
    child.once("exit", (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

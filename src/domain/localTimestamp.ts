/** Filename-safe timestamp in the host computer's local timezone. Logs stay UTC. */
export function localFilenameTimestamp(now = new Date()): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
}

/** Compact local timestamp used in user-facing PDF filenames. */
export function localPdfFilenameTimestamp(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** Build a safe PDF name, optionally replacing an existing timestamp with the current local time. */
export function buildPagePdfFilename(
  configuredName: string,
  fallbackName: string,
  useLocalTime: boolean,
  now = new Date()
): string {
  const lastPathPart = String(configuredName || fallbackName || "page").trim().split(/[\\/]/).at(-1) ?? "page";
  const safe = lastPathPart.replace(/[<>:"|?*\x00-\x1f]/g, "-").replace(/[. ]+$/g, "").trim();
  const withoutExtension = safe.replace(/\.pdf$/i, "").replace(/\.[^.]+$/, "");
  const base = (withoutExtension.replace(/[_-]\d{8}_\d{6}$/, "").trim() || "page").slice(0, 150);
  return `${base}${useLocalTime ? `_${localPdfFilenameTimestamp(now)}` : ""}.pdf`;
}

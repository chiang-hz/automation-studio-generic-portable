import fs from "node:fs/promises";
import path from "node:path";
import { createZip } from "./zip.ts";

export interface WebDataField { name: string; selector: string; mode?: "text" | "html" | "attribute"; attribute?: string; required?: boolean }
export interface WebDataConfig {
  dataCollection?: string; dataMode?: "single" | "list" | "table"; dataRowSelector?: string;
  dataFields?: WebDataField[]; dataAppend?: boolean; dataIncludeSource?: boolean; dataLimit?: number;
  timeoutMs?: number; documentFormat?: "docx" | "json" | "xlsx"; documentTitle?: string;
  documentFileName?: string; documentColumns?: string[]; documentLayout?: "table" | "paragraphs";
  documentUseLocalTime?: boolean; documentSheetName?: string;
}
export type DataRow = Record<string, string>;
const unsafeNames = new Set(["__proto__", "prototype", "constructor"]);
export function collectionName(config: WebDataConfig): string {
  const name = String(config.dataCollection ?? "records").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(name) || unsafeNames.has(name)) throw new Error("資料集合名稱須以英文字母或底線開頭，最多 80 個英數字或底線。");
  return name;
}
export function validateWebDataConfig(config: WebDataConfig): void {
  collectionName(config);
  if (config.dataMode && !["single", "list", "table"].includes(config.dataMode)) throw new Error("不支援的擷取模式。");
  const fields = config.dataMode === "table" ? [] : config.dataFields ?? [];
  if (config.dataMode !== "table" && (!fields.length || fields.length > 100)) throw new Error("請設定 1～100 個擷取欄位。");
  const names = new Set<string>();
  for (const field of fields) {
    const name = String(field.name ?? "").trim();
    if (!name || name.length > 100 || unsafeNames.has(name) || names.has(name) || ["_sourceUrl", "_capturedAt"].includes(name)) throw new Error("欄位名稱不可空白、重複或使用保留名稱。");
    names.add(name);
    if (field.mode && !["text", "html", "attribute"].includes(field.mode)) throw new Error(`欄位「${name}」的擷取類型無效。`);
    if (field.mode === "attribute" && !String(field.attribute ?? "").trim()) throw new Error(`欄位「${name}」需要屬性名稱。`);
  }
  if (["list", "table"].includes(config.dataMode ?? "") && !config.dataRowSelector?.trim()) throw new Error("清單或表格模式需要 CSS 定位規則。");
  if (config.dataLimit !== undefined && (!Number.isInteger(config.dataLimit) || config.dataLimit < 1 || config.dataLimit > 5000)) throw new Error("單次擷取上限須為 1～5000 的整數。");
}
export function parseDataCollection(value: unknown): DataRow[] {
  if (value === undefined) return [];
  if (typeof value !== "string") throw new Error("資料集合必須是 JSON 陣列，請確認沒有與其他流程變數同名。");
  let rows: unknown;
  try { rows = JSON.parse(value); } catch { throw new Error("資料集合不是有效的 JSON 陣列。"); }
  if (!Array.isArray(rows) || rows.length > 50000 || rows.some(row => !row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length > 102 || Object.entries(row).some(([key, value]) => unsafeNames.has(key) || typeof value !== "string"))) throw new Error("資料集合格式錯誤：應為文字欄位物件陣列，最多 50,000 筆。");
  return rows as DataRow[];
}
/** CSS selectors are relative to each list item; an empty field selector reads the item itself. */
export async function extractWebData(scope: any, config: WebDataConfig, expand: (value: unknown) => string, sourceUrl: string): Promise<DataRow[]> {
  validateWebDataConfig(config);
  const mode = config.dataMode ?? "single", limit = config.dataLimit ?? 1000, timeout = config.timeoutMs ?? 30000;
  const capturedAt = new Date().toISOString();
  const addSource = (row: DataRow) => config.dataIncludeSource === false ? row : { ...row, _sourceUrl: sourceUrl, _capturedAt: capturedAt };
  if (mode === "table") {
    const table = scope.locator(expand(config.dataRowSelector)).first();
    await table.waitFor({ state: "attached", timeout });
    const rows = await table.locator("tr").evaluateAll((elements: any[], max: number) => elements.slice(0, max + 1).map(row => Array.from(row.children).filter((cell: any) => /^(TD|TH)$/.test(cell.tagName)).map((cell: any) => ({ text: (cell.innerText ?? cell.textContent ?? "").trim(), header: cell.tagName === "TH" }))), limit);
    const nonempty = rows.filter((row: any[]) => row.length);
    if (!nonempty.length) throw new Error("指定的表格沒有可擷取的儲存格。");
    const hasHeader = nonempty[0].some((cell: any) => cell.header);
    const body = hasHeader ? nonempty.slice(1) : nonempty;
    const width = Math.max(...nonempty.map((row: any[]) => row.length));
    if (width > 100) throw new Error("表格最多支援 100 欄。");
    const used = new Set<string>();
    const headers = Array.from({ length: width }, (_, index) => {
      const base = (hasHeader ? nonempty[0][index]?.text : "") || `欄位${index + 1}`;
      let name = unsafeNames.has(base) || ["_sourceUrl", "_capturedAt"].includes(base) ? `欄位${index + 1}` : base;
      for (let suffix = 2; used.has(name); suffix++) name = `${base}_${suffix}`;
      used.add(name); return name;
    });
    if (!body.length) throw new Error("表格只有標題，沒有資料列。");
    return body.slice(0, limit).map((cells: any[]) => addSource(Object.fromEntries(headers.map((name, i) => [name, String(cells[i]?.text ?? "")]))));
  }
  let roots: any[];
  if (mode === "list") {
    const locator = scope.locator(expand(config.dataRowSelector));
    await locator.first().waitFor({ state: "attached", timeout });
    const count = Math.min(await locator.count(), limit);
    roots = Array.from({ length: count }, (_, index) => locator.nth(index));
  } else roots = [scope];
  const result: DataRow[] = [];
  for (const root of roots) {
    const entries: [string, string][] = [];
    for (const field of config.dataFields ?? []) {
      const selector = expand(field.selector).trim();
      const locator = selector ? root.locator(selector) : mode === "list" ? root : scope.locator("body");
      const count = await locator.count();
      if (count > 1) throw new Error(`欄位「${field.name}」匹配 ${count} 個元件，請縮小定位範圍。`);
      if (!count) {
        if (field.required) throw new Error(`必填欄位「${field.name}」找不到元件。`);
        entries.push([field.name.trim(), ""]); continue;
      }
      const value = field.mode === "html" ? await locator.innerHTML({ timeout }) : field.mode === "attribute" ? await locator.getAttribute(expand(field.attribute), { timeout }) : await locator.innerText({ timeout });
      const text = String(value ?? "").trim();
      if (field.required && !text) throw new Error(`必填欄位「${field.name}」為空白。`);
      entries.push([field.name.trim(), text]);
    }
    result.push(addSource(Object.fromEntries(entries)));
  }
  if (!result.length) throw new Error("沒有擷取到任何資料。");
  return result;
}
export async function captureWebData(scope: any, config: WebDataConfig, variables: Record<string, string | boolean>, expand: (value: unknown) => string, sourceUrl: string): Promise<number> {
  const name = collectionName(config);
  const previous = config.dataAppend === false ? [] : parseDataCollection(variables[name]);
  const rows = await extractWebData(scope, config, expand, sourceUrl);
  if (previous.length + rows.length > 50000) throw new Error("資料集合超過 50,000 筆，請分批保存。");
  // Commit only after all fields succeed; a failed extraction leaves the collection unchanged.
  variables[name] = JSON.stringify([...previous, ...rows]);
  return rows.length;
}
const xml = (value: unknown): string => String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const packageXml = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;
export function documentColumns(rows: DataRow[], requested?: string[]): string[] {
  const all = [...new Set(rows.flatMap(row => Object.keys(row)))];
  if (!requested?.length) return all;
  if (new Set(requested).size !== requested.length || requested.some(key => !all.includes(key))) throw new Error("輸出欄位不可重複，且必須存在於資料集合中。");
  return requested;
}
export function buildCollectedDocument(rows: DataRow[], config: WebDataConfig): Buffer {
  if (!rows.length) throw new Error("資料集合為空白，請先執行擷取網頁資料。");
  const columns = documentColumns(rows, config.documentColumns);
  const title = config.documentTitle?.trim() || "網頁資料彙整";
  const format = config.documentFormat ?? "docx";
  if (format === "json") return Buffer.from(JSON.stringify(rows.map(row => Object.fromEntries(columns.map(column => [column, row[column] ?? ""]))), null, 2) + "\n", "utf8");
  const types = (items: string) => packageXml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${items}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`);
  const rels = (type: string, target: string) => packageXml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>${type === "officeDocument" ? '<Relationship Id="rIdCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' : ""}</Relationships>`);
  const coreEntry = { name: "docProps/core.xml", data: packageXml(`<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xml(title)}</dc:title><dc:creator>Automation Studio</dc:creator></cp:coreProperties>`) };
  if (format === "docx") {
    const paragraph = (text: string, bold = false) => `<w:p><w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
    const cell = (text: string, bold = false) => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>${text.split(/\r?\n/).map(line => paragraph(line, bold)).join("")}</w:tc>`;
    const body = config.documentLayout === "paragraphs" ? rows.map((row, index) => paragraph(`第 ${index + 1} 筆`, true) + columns.map(column => paragraph(`${column}：${row[column] ?? ""}`)).join("")).join("") : `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(side => `<w:${side} w:val="single" w:sz="4" w:color="C8D0D8"/>`).join("")}</w:tblBorders></w:tblPr><w:tblGrid>${columns.map(() => '<w:gridCol w:w="2400"/>').join("")}</w:tblGrid><w:tr><w:trPr><w:tblHeader/></w:trPr>${columns.map(column => cell(column, true)).join("")}</w:tr>${rows.map(row => `<w:tr>${columns.map(column => cell(row[column] ?? "")).join("")}</w:tr>`).join("")}</w:tbl>`;
    return createZip([
      coreEntry,
      { name: "[Content_Types].xml", data: types('<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>') },
      { name: "_rels/.rels", data: rels("officeDocument", "word/document.xml") },
      { name: "word/document.xml", data: packageXml(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraph(title, true)}${paragraph(`共 ${rows.length} 筆資料`)}${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`) }
    ]);
  }
  if (format !== "xlsx") throw new Error("輸出格式僅支援 docx、json 或 xlsx。");
  const columnId = (index: number) => { let label = ""; for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + (n - 1) % 26) + label; return label; };
  const sheetName = (config.documentSheetName || "資料彙整").replace(/[\[\]:*?/\\]/g, "_").replace(/^'+|'+$/g, "").slice(0, 31) || "資料彙整";
  const matrix = [columns, ...rows.map(row => columns.map(column => row[column] ?? ""))];
  const sheetRows = matrix.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((text, index) => {
    if (String(text).length > 32767) throw new Error(`Excel 第 ${rowIndex + 1} 列的「${columns[index]}」超過儲存格 32,767 字元上限；請改存 JSON 或 Word。`);
    return `<c r="${columnId(index)}${rowIndex + 1}" t="inlineStr" s="${rowIndex ? 0 : 1}"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
  }).join("")}</row>`).join("");
  return createZip([
    coreEntry,
    { name: "[Content_Types].xml", data: types('<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>') },
    { name: "_rels/.rels", data: rels("officeDocument", "xl/workbook.xml") },
    { name: "xl/workbook.xml", data: packageXml(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: "xl/_rels/workbook.xml.rels", data: packageXml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>') },
    { name: "xl/styles.xml", data: packageXml('<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf fontId="1" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>') },
    { name: "xl/worksheets/sheet1.xml", data: packageXml(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="${columns.length}" width="30" customWidth="1"/></cols><sheetData>${sheetRows}</sheetData><autoFilter ref="A1:${columnId(columns.length - 1)}${matrix.length}"/></worksheet>`) }
  ]);
}
export async function saveCollectedDocument(config: WebDataConfig, variables: Record<string, string | boolean>, directory: string, expand: (value: unknown) => string): Promise<string> {
  const name = collectionName(config), rows = parseDataCollection(variables[name]);
  const options = { ...config, documentTitle: expand(config.documentTitle || "網頁資料彙整"), documentSheetName: expand(config.documentSheetName || "資料彙整"), documentColumns: config.documentColumns?.map(expand) };
  const bytes = buildCollectedDocument(rows, options);
  const ext = config.documentFormat ?? "docx";
  let stem = expand(config.documentFileName || "網頁資料彙整").replace(/\.(docx|json|xlsx)$/i, "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^\.+|[. ]+$/g, "").slice(0, 120) || "網頁資料彙整";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
  if (config.documentUseLocalTime !== false) {
    const d = new Date(), pad = (n: number) => String(n).padStart(2, "0");
    stem += `_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }
  await fs.mkdir(directory, { recursive: true });
  for (let i = 0; i < 10000; i++) {
    const target = path.join(directory, `${stem}${i ? `_${i}` : ""}.${ext}`);
    try { await fs.writeFile(target, bytes, { flag: "wx" }); return target; }
    catch (error: any) { if (error.code !== "EEXIST") throw error; }
  }
  throw new Error("同名檔案過多，請調整文件檔名。");
}

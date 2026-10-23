import { validateRow, type BatchRow, type Parameter, type Project } from './model.ts';

const FORMAT = 'automation-studio-batch';
const ENABLED_COLUMN = '__studio_enabled';
const isSecret = (p: Parameter) => p.sensitive === true || p.type === 'secret';
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function exportBatchContent(project: Project, rows: BatchRow[], format: 'json'|'csv'): string {
  const parameters = project.parameters.filter(p => !isSecret(p));
  if (format === 'json') return JSON.stringify({
    format: FORMAT, version: 1, project: { id: project.id, name: project.name },
    parameters: project.parameters.map(p => ({ name: p.name, label: p.label, type: p.type, redacted: isSecret(p) })),
    rows: rows.map(row => ({ enabled: row.enabled, parameters: Object.fromEntries(parameters.map(p => [p.name, row.parameters[p.name] ?? ''])) }))
  }, null, 2);
  if (project.parameters.some(p => p.name === ENABLED_COLUMN)) throw new Error(`參數名稱 ${ENABLED_COLUMN} 與 CSV 執行欄位重複，請使用 JSON 匯出。`);
  const quote = (value: unknown) => '"' + String(value ?? '').replaceAll('"', '""') + '"';
  return '\uFEFF' + [[ENABLED_COLUMN, ...parameters.map(p => p.name)], ...rows.map(row => [String(row.enabled), ...parameters.map(p => row.parameters[p.name] ?? '')])].map(cells => cells.map(quote).join(',')).join('\r\n');
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [], row: string[] = [];
  let value = '', quoted = false, closed = false;
  const cell = () => { row.push(value); value = ''; closed = false; };
  const line = () => { cell(); rows.push([...row]); row.length = 0; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i+1] === '"') { value += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else value += c;
    } else if (c === ',') cell();
    else if (c === '\r' || c === '\n') { if (c === '\r' && text[i+1] === '\n') i++; line(); }
    else if (c === '"' && value === '' && !closed) quoted = true;
    else if (closed || c === '"') throw new Error('CSV 引號格式錯誤。');
    else value += c;
  }
  if (quoted) throw new Error('CSV 引號未結束。');
  if (value !== '' || row.length || closed) line();
  return rows;
}

/** Validate the complete imported file before exposing any rows to the UI. */
export function importBatchContent(text: string, format: 'json'|'csv', parameters: Parameter[], makeRow: () => BatchRow): { rows: BatchRow[]; errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  const fail = (message: string) => ({ rows: [], errors: [message], warnings: [] });
  text = text.replace(/^\uFEFF/, '');
  let rawRows: unknown[];
  try {
    if (format === 'json') {
      const file: unknown = JSON.parse(text);
      if (!record(file) || file.format !== FORMAT || file.version !== 1 || !Array.isArray(file.rows) || !Array.isArray(file.parameters)) return fail('此檔案不是支援的批次 JSON，請使用「匯出批次內容」產生的檔案。');
      for (const source of file.parameters) {
        if (!record(source) || typeof source.name !== 'string') return fail('JSON 參數欄位格式錯誤。');
        const target = parameters.find(p => p.name === source.name);
        if (!target) return fail(`目前專案沒有參數：${source.name}。`);
        if (target.type !== source.type) return fail(`參數 ${target.label} 的類型與目前專案不一致。`);
      }
      rawRows = file.rows;
    } else {
      const matrix = parseCsv(text);
      const headers = matrix.shift();
      if (!headers?.length) return fail('CSV 沒有欄位名稱。');
      if (new Set(headers).size !== headers.length) return fail('CSV 欄位名稱重複。');
      for (const header of headers) if (header !== ENABLED_COLUMN && !parameters.some(p => p.name === header)) return fail(`目前專案沒有參數：${header || '（空白欄位）'}。CSV 欄位名稱須使用參數 Key。`);
      if (parameters.some(p => p.name === ENABLED_COLUMN)) return fail('CSV 執行欄位與專案參數重複，請使用 JSON 匯入。');
      rawRows = matrix.map((cells, index) => {
        if (cells.length !== headers.length) throw new Error(`CSV 第 ${index+2} 行的欄位數量不符。`);
        const values = Object.fromEntries(headers.map((h, i) => [h, cells[i]]));
        return { enabled: values[ENABLED_COLUMN] ?? true, parameters: Object.fromEntries(headers.filter(h => h !== ENABLED_COLUMN).map(h => [h, values[h]])) };
      });
    }
  } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
  if (rawRows.length > 10_000) return fail('每次最多匯入 10,000 筆批次資料。');
  const rows: BatchRow[] = [];
  let missingSecrets = false;
  let incomplete = false;
  for (const [index, raw] of rawRows.entries()) {
    if (!record(raw) || !record(raw.parameters)) { errors.push(`第 ${index+1} 列的參數格式錯誤。`); continue; }
    const enabled = raw.enabled ?? true;
    if (![true, false, 'true', 'false'].includes(enabled as boolean|string)) { errors.push(`第 ${index+1} 列的執行勾選狀態須為 true 或 false。`); continue; }
    for (const key of Object.keys(raw.parameters)) if (!parameters.some(p => p.name === key)) errors.push(`第 ${index+1} 列有未知參數：${key}。`);
    const defaults = makeRow();
    const values = Object.fromEntries(parameters.map(p => [p.name, isSecret(p) ? '' : defaults.parameters[p.name] ?? '']));
    for (const p of parameters) {
      if (!own(raw.parameters, p.name)) continue;
      const value = raw.parameters[p.name];
      if (typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) { errors.push(`第 ${index+1} 列的 ${p.label} 必須為文字、數字或布林值。`); continue; }
      values[p.name] = p.type === 'boolean' && ['true','false'].includes(String(value).toLowerCase()) ? String(value).toLowerCase() === 'true' : typeof value === 'boolean' ? value : String(value);
    }
    const validatedParameters = parameters.filter(p => {
      if (isSecret(p) && String(values[p.name] ?? '') === '') { missingSecrets ||= p.required; return false; }
      return true;
    }).map(p => {
      if (p.required && String(values[p.name] ?? '').trim() === '') { incomplete = true; return { ...p, required: false }; }
      return p;
    });
    for (const error of validateRow(validatedParameters, values)) errors.push(`第 ${index+1} 列：${error}`);
    rows.push({ id: defaults.id, enabled: enabled === true || enabled === 'true', parameters: values });
  }
  if (missingSecrets) warnings.push('匯出檔不包含密碼或敏感參數，執行前請補填必填的敏感欄位。');
  if (incomplete) warnings.push('部分資料尚未填寫必填參數，執行前請補填。');
  return { rows: errors.length ? [] : rows, errors, warnings };
}

import { useState } from 'react';
import { Download, FileArchive, PackageCheck } from 'lucide-react';
import { runtimeSdk } from '../sdk/runtimeSdk';
import { useStudio } from '../store';
import { studioApi, type ExportSelection } from '../sdk/restClient';
import { Button } from './ui/button';

const initialSelection: ExportSelection = { portableWorkflow: true, typescript: true, skill: true, pythonPlaywright: false, pythonSelenium: false, pythonBatch: true, pythonBatchOnError: "continue", pythonBatchIncludeCurrentRows: false, includeTests: true, includeExamples: true };
const checkLabels = ['入口網址格式正確', '允許網域已設定', '流程至少有一個啟用步驟', '密碼、Cookie 與工作站不會匯出'];

export function PublishManager() {
  const snapshot = useStudio(state => state.snapshot);
  const project = snapshot.state.project;
  const [selection, setSelection] = useState(initialSelection);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  if (!project) return <section className="card"><p className="muted">請先選取或建立專案，再管理發布與匯出。</p></section>;

  let validUrl = false;
  try { validUrl = /^https?:$/.test(new URL(project.targetUrl).protocol); } catch { validUrl = false; }
  const checks = [validUrl, Boolean(project.allowedDomains?.length), Boolean(project.steps?.some(step => step.enabled)), true];
  const patchSelection = (key: keyof ExportSelection, value: boolean) => setSelection(current => ({ ...current, [key]: value }));
  const exportProject = async () => {
    setError('');
    if (!selection.portableWorkflow && !selection.typescript && !selection.skill && !selection.pythonPlaywright && !selection.pythonSelenium) { setError('請至少選擇一種成果格式。'); return; }
    setRunning(true);
    try {
      if (runtimeSdk.snapshot().state.dirty) {
        await runtimeSdk.save();
        if (runtimeSdk.snapshot().state.dirty) throw new Error('專案尚未成功儲存，請先處理儲存狀態再匯出。');
      }
      const current = runtimeSdk.snapshot().state.project;
      if (!current) throw new Error('目前沒有開啟的專案。');
      const effectiveSelection: ExportSelection = {
        ...selection,
        pythonBatchRows: selection.pythonBatchIncludeCurrentRows && (selection.pythonPlaywright || selection.pythonSelenium)
          ? runtimeSdk.snapshot().state.batchRows.map(row => ({enabled: row.enabled, parameters: row.parameters})) : undefined
      };
      const blob = await studioApi.exportProject(current.id, effectiveSelection);
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = `${current.id}-${current.version || '1.0.0'}-export.zip`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 1_000);
      runtimeSdk.toast('成果 ZIP 已產生並開始下載');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '成果產生失敗。';
      setError(message);
      runtimeSdk.toast(message, true);
    } finally { setRunning(false); }
  };

  return <div className="publish-manager">
    <div className="publish-grid">
      <section className="card">
        <div className="section-heading"><div><h2>版本資訊</h2><p>發布不會覆蓋專案，可重複產生不同成果。</p></div></div>
        <label className="field"><span>專案版本號</span><input value={String(project.version ?? '1.0.0')} onChange={event => runtimeSdk.patchProject({ version: event.target.value })}/><small>這是工作流程專案自己的版本，與 Automation Studio 系統版本分開管理；版本號與變更說明會在輸入後自動儲存。</small></label>
        <label className="field"><span>變更說明</span><textarea rows={5} placeholder="說明這個版本調整了哪些步驟或參數" value={String(project.releaseNotes ?? project.description ?? '')} onChange={event => runtimeSdk.patchProject({ releaseNotes: event.target.value })}/><small>初次開啟舊專案時會先帶入原專案說明；後續內容會獨立保存並在輸入後自動儲存。</small></label>
        <label className="field"><span>發布狀態</span><select value={String(project.status ?? 'draft')} onChange={event => runtimeSdk.patchProject({ status: event.target.value }, true)}><option value="draft">草稿</option><option value="ready">可發布</option><option value="archived">已封存</option></select></label>
      </section>
      <section className="card export-card">
        <div className="section-heading"><div><h2>選擇成果</h2><p>可複選；所有成果會合併成一個 ZIP。</p></div><FileArchive size={19}/></div>
        {([
          ['portableWorkflow', '可攜工作流程', '可匯入本程式繼續編輯與執行', 'JSON'],
          ['typescript', 'TypeScript', '獨立 Playwright 專案與啟動腳本', 'TS'],
          ['pythonPlaywright', 'Python · Playwright', '使用 Chrome，優先相容性（套件內有 Node 驅動）', 'PY'],
          ['pythonSelenium', 'Python · Selenium', '輕量、無 Node.js 執行元件、使用現有 Chrome', 'PY'],
          ['skill', 'SKILL.md', '供 Codex／代理程式理解與操作', 'SKILL']
        ] as const).map(([key, title, detail, badge]) => <label className="export-option" key={key}><input type="checkbox" checked={selection[key]} onChange={event => patchSelection(key, event.target.checked)}/><span><b>{title}</b><small>{detail}</small></span><em>{badge}</em></label>)}
        {(selection.pythonPlaywright || selection.pythonSelenium) && <div className="checkbox-row" style={{flexDirection:'column', alignItems:'flex-start', gap:8}}>
          <label><input type="checkbox" checked={selection.pythonBatch !== false} onChange={event => patchSelection('pythonBatch', event.target.checked)}/> 包含 Python 批次工具（JSON／CSV／Excel、run-batch.bat、CDP 批次）</label>
          {selection.pythonBatch !== false && <label className="field"><span>批次任務失敗時</span><select value={selection.pythonBatchOnError ?? 'continue'} onChange={event => setSelection(current => ({ ...current, pythonBatchOnError: event.target.value as 'continue' | 'stop' }))}><option value="continue">繼續執行下一筆（預設）</option><option value="stop">停止整批任務</option></select></label>}
          {selection.pythonBatch !== false && <label><input type="checkbox" checked={!!selection.pythonBatchIncludeCurrentRows} onChange={event => patchSelection('pythonBatchIncludeCurrentRows', event.target.checked)}/> 同時帶入目前批次清單（{snapshot.state.batchRows.length} 筆；不包含敏感參數）</label>}
          <small>預設只匯出範例清單；敏感資料及登入資訊不會寫入 ZIP。CDP 批次固定依序執行。</small>
        </div>}
        <div className="checkbox-row"><label><input type="checkbox" checked={selection.includeTests} onChange={event => patchSelection('includeTests', event.target.checked)}/> 包含測試案例</label><label><input type="checkbox" checked={selection.includeExamples} onChange={event => patchSelection('includeExamples', event.target.checked)}/> 包含範例參數</label></div>
      </section>
      <section className="card checks-card">
        <div className="section-heading"><div><h2>發布前檢查</h2><p>匯出時自動移除敏感預設值。</p></div><PackageCheck size={19}/></div>
        <ul className="publish-check-list">{checks.map((ok, index) => <li className={ok ? 'ok' : 'needs-attention'} key={checkLabels[index]}><span aria-hidden="true">{ok ? '✓' : '!'}</span>{checkLabels[index]}</li>)}</ul>
        {error && <p className="publish-error" role="alert">{error}</p>}
        <Button variant="default" className="full-button" disabled={running} onClick={() => void exportProject()}><Download size={15}/>{running ? '正在產生成果…' : '產生成果 ZIP'}</Button>
      </section>
    </div>
  </div>;
}

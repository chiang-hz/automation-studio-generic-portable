import { useEffect, useRef, useState } from 'react';
import { BookOpen, Check, Clipboard, FileJson2, LifeBuoy, Mail, Save, ShieldCheck, Sparkles } from 'lucide-react';
import type { Project } from '../model';
import { useStudio } from '../store';
import { studioApi } from '../sdk/restClient';
import { runtimeSdk } from '../sdk/runtimeSdk';
import { Button } from './ui/button';
import { StudioCodeEditor } from './CodeEditor';

export function HelpPage({ sourceView }: { sourceView: HTMLElement }) {
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const destination = content.current;
    if (!destination) return;
    const nodes = [...sourceView.children].filter((node): node is HTMLElement => node instanceof HTMLElement && node.id !== 'modern-help' && !node.classList.contains('modern-help-source'));
    const records = nodes.map(node => {
      const marker = document.createComment('help content position');
      node.parentNode?.insertBefore(marker, node);
      destination.appendChild(node);
      return { node, marker };
    });
    return () => records.forEach(({ node, marker }) => {
      if (marker.parentNode) marker.parentNode.insertBefore(node, marker);
      marker.remove();
    });
  }, [sourceView]);

  return <div className="studio-page support-page">
    <section className="studio-card support-page-intro"><div className="support-intro-icon"><BookOpen size={20}/></div><div><div className="studio-eyebrow">HELP & SUPPORT</div><h2>使用說明</h2><p>流程編輯、PDF 保存、批次資料與發布的操作指南，已依 2.1.0 版更新。</p></div><Button variant="secondary" onClick={() => runtimeSdk.navigate('report')}><LifeBuoy size={15}/>回報問題</Button></section>
    <div className="support-document" ref={content}/>
  </div>;
}

type IssueReport = { subject: string; category: string; severity: string; description: string; steps: string; expected: string; actual: string; contact: string };
const emptyReport: IssueReport = { subject: '', category: '流程執行', severity: 'normal', description: '', steps: '', expected: '', actual: '', contact: '' };

function ReportField({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return <label className={`field ${wide ? 'field-wide' : ''}`}><span>{label}</span>{children}</label>;
}

export function ReportPage() {
  const { snapshot } = useStudio();
  const [form, setForm] = useState<IssueReport>({ ...emptyReport });
  const [copied, setCopied] = useState(false);
  const email = String(snapshot.state.settings?.issueReportEmail ?? '').trim();
  const project = snapshot.state.project as Project | null;
  const cdp = (project as any)?.browser?.connectionMode === 'cdp';

  const update = (patch: Partial<IssueReport>) => setForm(current => ({ ...current, ...patch }));
  const prepare = () => runtimeSdk.prepareIssueReport(form);
  const copy = async () => {
    const report = prepare();
    const text = `主旨：${report.subject}\n收件者：${report.to || '（尚未設定）'}\n\n${report.body}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      runtimeSdk.toast('問題回報內容已複製');
      window.setTimeout(() => setCopied(false), 1800);
    } catch { runtimeSdk.toast('無法存取剪貼簿，請確認瀏覽器權限後重試。', true); }
  };
  const send = () => {
    const report = prepare();
    if (!report.to) {
      runtimeSdk.toast('尚未設定問題回報收件信箱，請先到系統設定填寫。', true);
      runtimeSdk.navigate('settings');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(report.to)) {
      runtimeSdk.toast('問題回報收件信箱格式不正確，請先到系統設定修正。', true);
      runtimeSdk.navigate('settings');
      return;
    }
    const href = `mailto:${encodeURIComponent(report.to)}?subject=${encodeURIComponent(report.subject)}&body=${encodeURIComponent(report.body)}`;
    if (href.length > 7500) runtimeSdk.toast('回報內容較長；若郵件程式未完整帶入內容，可改用「複製回報內容」。');
    window.location.href = href;
  };
  const clear = () => { setForm({ ...emptyReport }); runtimeSdk.toast('問題回報表單已清除'); };

  return <div className="studio-page report-page">
    <section className="studio-card">
      <header className="studio-card-heading"><div><div className="studio-eyebrow">SUPPORT REQUEST</div><h2>回報問題</h2><p>建立郵件草稿並附上必要診斷資訊，寄送至系統管理者設定的信箱。</p></div><span className={`pill ${email ? 'status-success' : 'status-error'}`}><Mail size={14}/>{email || '尚未設定收件信箱'}</span></header>
      <aside className="studio-notice privacy-notice"><ShieldCheck size={16}/><span><b>隱私提醒</b>系統不會自動加入密碼、Cookie、MFA、驗證碼或參數實際值。若自行貼上 Debug 記錄，請先確認其中沒有敏感資訊。</span></aside>
      <div className="studio-form-grid">
        <ReportField label="問題類別"><select value={form.category} onChange={event => update({ category: event.target.value })}>{['流程執行','錄製與 Selector','下載','批次任務','匯入／匯出','介面顯示','系統設定','其他'].map(value => <option key={value}>{value}</option>)}</select></ReportField>
        <ReportField label="影響程度"><select value={form.severity} onChange={event => update({ severity: event.target.value })}><option value="normal">一般問題</option><option value="important">影響工作</option><option value="blocking">無法繼續使用</option></select></ReportField>
        <ReportField label="主旨" wide><input value={form.subject} placeholder="簡短描述問題" onChange={event => update({ subject: event.target.value })}/></ReportField>
        <ReportField label="問題描述" wide><textarea rows={4} value={form.description} placeholder="發生什麼情況、在哪一個頁面或功能發生。" onChange={event => update({ description: event.target.value })}/></ReportField>
        <ReportField label="重現步驟" wide><textarea rows={4} value={form.steps} placeholder="例如：1. 開啟執行紀錄  2. 展開失敗任務  3. 查看錯誤內容" onChange={event => update({ steps: event.target.value })}/></ReportField>
        <ReportField label="預期結果"><textarea rows={3} value={form.expected} placeholder="原本預期系統如何運作" onChange={event => update({ expected: event.target.value })}/></ReportField>
        <ReportField label="實際結果"><textarea rows={3} value={form.actual} placeholder="實際看到的結果或錯誤訊息" onChange={event => update({ actual: event.target.value })}/></ReportField>
        <ReportField label="聯絡方式（選填）" wide><input value={form.contact} placeholder="姓名、分機或回覆 Email" onChange={event => update({ contact: event.target.value })}/></ReportField>
      </div>
      <div className="studio-button-row report-actions"><Button variant="primary" onClick={send}><Mail size={15}/>開啟郵件並回報</Button><Button onClick={() => void copy()}>{copied ? <Check size={15}/> : <Clipboard size={15}/>}複製回報內容</Button><Button variant="ghost" onClick={clear}>清除</Button></div>
    </section>
    <aside className="studio-card report-context-card"><header className="studio-card-heading"><div><div className="studio-eyebrow">DIAGNOSTIC CONTEXT</div><h2>將自動附帶</h2><p>辨識環境所需的非敏感資訊。</p></div><Sparkles size={18}/></header><dl className="report-context"><div><dt>系統版本</dt><dd>Automation Studio V2.1.0</dd></div><div><dt>目前專案</dt><dd>{project?.name ?? '尚未開啟專案'}</dd></div><div><dt>專案 ID</dt><dd className="mono">{project?.id ?? '—'}</dd></div><div><dt>瀏覽器模式</dt><dd>{cdp ? 'Chrome CDP 接管' : 'Automation Studio 管理瀏覽器'}</dd></div><div><dt>回報時間</dt><dd>{new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date())}</dd></div></dl><div className="studio-notice"><b>沒有預設郵件程式？</b><span>按「複製回報內容」，再貼到組織使用的郵件系統中。</span></div></aside>
  </div>;
}

export function DeveloperPage() {
  const { snapshot } = useStudio();
  const project = snapshot.state.project as Project | null;
  const [value, setValue] = useState(() => project ? JSON.stringify(project, null, 2) : '');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!dirty) setValue(project ? JSON.stringify(project, null, 2) : ''); }, [project?.id, snapshot.revision]);

  const save = async () => {
    if (!project) return;
    setBusy(true);
    try {
      const parsed = JSON.parse(value) as Project;
      if (!parsed.id || !parsed.name || !Array.isArray(parsed.steps) || !Array.isArray(parsed.parameters)) throw new Error('JSON 缺少 id、name、steps 或 parameters。');
      if (parsed.id !== project.id) throw new Error('不可透過 JSON 修改專案 ID。');
      const response = await studioApi.updateProject(parsed);
      runtimeSdk.adoptProject(response.project);
      setValue(JSON.stringify(response.project, null, 2));
      setDirty(false);
      runtimeSdk.toast('工作流程 JSON 已套用');
    } catch (error) { runtimeSdk.toast(error instanceof Error ? error.message : String(error), true); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); runtimeSdk.toast('JSON 已複製'); }
    catch { runtimeSdk.toast('無法存取剪貼簿，請確認瀏覽器權限後重試。', true); }
  };

  return <div className="studio-page developer-page"><section className="studio-card">
    <header className="studio-card-heading"><div><div className="studio-eyebrow">SOURCE WORKFLOW</div><h2>工作流程原始碼</h2><p>進階使用者可直接編輯 JSON；套用前會檢查基本結構並由既有專案 API 驗證。</p></div><FileJson2 size={19}/></header>
    {!project ? <div className="studio-empty">請先選取專案。</div> : <>
      <div className="developer-json-meta"><span className="pill mono">{project.id}</span><span className="muted">{dirty ? '有尚未套用的 JSON 變更' : '目前內容已與專案同步'}</span></div>
      <div className="developer-json-editor"><StudioCodeEditor value={value} onChange={next => { setValue(next); setDirty(true); }} language="json" height="100%" path={`studio://workflow/${project.id}.json`} ariaLabel="工作流程原始碼編輯器"/></div>
      <div className="studio-button-row developer-json-actions"><Button onClick={() => void copy()}><Clipboard size={15}/>複製</Button><Button variant="primary" onClick={() => void save()} disabled={busy || !dirty}><Save size={15}/>{busy ? '驗證與套用中…' : '套用 JSON'}</Button></div>
    </>}
  </section></div>;
}

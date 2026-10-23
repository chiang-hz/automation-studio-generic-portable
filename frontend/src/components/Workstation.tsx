import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Globe, LoaderCircle, Play, Plus, Save, Square, Trash2, UserRound, X } from 'lucide-react';
import type { Project } from '../model';
import { useStudio } from '../store';
import { runtimeSdk, type WorkstationAction } from '../sdk/runtimeSdk';
import { Button } from './ui/button';

type BrowserSettings = {
  connectionMode?: 'managed' | 'cdp';
  channel?: string;
  cdpEndpoint?: string;
  cdpAutoLaunch?: boolean;
  cdpInitialPageMode?: 'first' | 'url' | 'index';
  cdpInitialPageTarget?: string;
  cdpInitialPageIndex?: number;
  reuseProfile?: boolean;
  downloadPdfInsteadOfPreview?: boolean;
  stealth?: boolean;
  headless?: boolean;
  [key: string]: unknown;
};

interface WorkstationProject extends Project {
  browser: BrowserSettings;
  adapter?: string;
}

function cloneProject(project: Project): WorkstationProject {
  const copy = structuredClone(project) as WorkstationProject;
  copy.browser ??= {};
  copy.browser.connectionMode ??= 'managed';
  copy.browser.channel ??= 'bundled';
  copy.browser.cdpEndpoint ??= 'http://127.0.0.1:9222';
  copy.browser.cdpAutoLaunch ??= true;
  copy.browser.cdpInitialPageMode ??= 'first';
  copy.browser.cdpInitialPageTarget ??= '';
  copy.browser.cdpInitialPageIndex ??= 1;
  copy.allowedDomains ??= [];
  return copy;
}

function Field({ label, hint, className = '', children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return <label className={`field ${className}`}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

function Switch({ checked, onChange, title, hint, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; title: string; hint?: string; disabled?: boolean }) {
  return <label className="switch-field"><input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)}/><span><b>{title}</b>{hint && <small>{hint}</small>}</span></label>;
}

export function Workstation() {
  const { snapshot } = useStudio();
  const sourceProject = snapshot.state.project as Project | null;
  const [draft, setDraft] = useState<WorkstationProject | null>(() => sourceProject ? cloneProject(sourceProject) : null);
  const [domainEntry, setDomainEntry] = useState('');
  const [assertionKind, setAssertionKind] = useState<'visible' | 'text' | 'value'>('visible');
  const [busy, setBusy] = useState<WorkstationAction | 'save' | null>(null);
  const dirty = useRef(false);
  const sourceId = sourceProject?.id;

  useEffect(() => {
    if (!sourceProject) { setDraft(null); dirty.current = false; return; }
    if (draft?.id !== sourceProject.id || !dirty.current) {
      setDraft(cloneProject(sourceProject));
      dirty.current = false;
    }
  }, [sourceId, snapshot.revision]);

  const cdp = draft?.browser.connectionMode === 'cdp';
  const recorder = snapshot.state.recorderSnapshot ?? { active: false, events: [] };
  const profile = snapshot.state.profileStatus ?? {};
  const cdpStatus = snapshot.state.cdpStatus;
  const events = Array.isArray(recorder.events) ? recorder.events : [];
  const domainsText = useMemo(() => (draft?.allowedDomains ?? []).join('\n'), [draft?.id, draft?.allowedDomains]);

  const change = (update: (current: WorkstationProject) => WorkstationProject) => {
    dirty.current = true;
    setDraft(current => current ? update(current) : current);
  };
  const changeField = <K extends keyof WorkstationProject>(key: K, value: WorkstationProject[K]) => change(current => ({ ...current, [key]: value }));
  const changeBrowser = <K extends keyof BrowserSettings>(key: K, value: BrowserSettings[K]) => change(current => ({ ...current, browser: { ...current.browser, [key]: value } }));
  const save = async () => {
    if (!draft) return;
    setBusy('save');
    try {
      if (await runtimeSdk.saveWorkstation(draft)) {
        dirty.current = false;
        const fresh = useStudio.getState().snapshot.state.project as Project | null;
        if (fresh) setDraft(cloneProject(fresh));
      }
    } finally { setBusy(null); }
  };
  const act = async (action: WorkstationAction, payload?: Record<string, unknown>) => {
    if (!draft) return;
    setBusy(action);
    try {
      await runtimeSdk.actOnWorkstation(action, draft, payload);
      if (action === 'startRecorder' || action === 'commitRecording' || action === 'deleteProject' || action === 'duplicateProject') {
        dirty.current = false;
        const fresh = useStudio.getState().snapshot.state.project as Project | null;
        setDraft(fresh ? cloneProject(fresh) : null);
      }
    } catch (error) {
      runtimeSdk.toast(error instanceof Error ? error.message : String(error), true);
    } finally { setBusy(null); }
  };
  const addDomain = () => {
    const value = domainEntry.trim();
    if (!value || !draft) return;
    if ((draft.allowedDomains ?? []).includes(value)) { setDomainEntry(''); return; }
    change(current => ({ ...current, allowedDomains: [...(current.allowedDomains ?? []), value] }));
    setDomainEntry('');
  };
  const removeDomain = (value: string) => change(current => ({ ...current, allowedDomains: (current.allowedDomains ?? []).filter(domain => domain !== value) }));

  if (!draft) return <div className="studio-page"><section className="studio-card studio-empty"><Globe size={22}/><h2>先選取或建立專案</h2><p>工作站設定會隨專案保存。</p><Button variant="primary" onClick={() => runtimeSdk.navigate('dashboard')}>前往專案總覽</Button></section></div>;

  return <div className="studio-page workstation-page">
    <section className="studio-card">
      <header className="studio-card-heading"><div><div className="studio-eyebrow">PROJECT WORKSTATION</div><h2>網站與瀏覽器工作站</h2><p>設定入口網址、網域安全界線，以及錄製使用的瀏覽器環境。</p></div><span className={`pill ${recorder.active ? 'status-running' : ''}`}>{recorder.active ? '錄製中' : '未錄製'}</span></header>
      <div className="studio-form-grid">
        <Field label="專案名稱" className="field-wide"><input value={draft.name} onChange={event => changeField('name', event.target.value)}/></Field>
        <Field label="目標網址" className="field-wide"><input type="url" placeholder="https://example.com" value={draft.targetUrl} onChange={event => changeField('targetUrl', event.target.value)}/></Field>
        <Field label="允許網域" className="field-wide" hint="一般網域只允許完全相同主機。確實需要子網域時，請明確輸入 *.example.com。執行前仍會檢查流程中的網址。">
          <div className="workstation-domain-add"><input placeholder="例如 auth.example.com 或 *.example.com" value={domainEntry} onChange={event => setDomainEntry(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addDomain(); } }}/><Button size="sm" onClick={addDomain}><Plus size={14}/>新增</Button></div>
          <div className="workstation-domain-list">{(draft.allowedDomains ?? []).length ? draft.allowedDomains!.map(domain => <span className="workstation-domain-chip" key={domain}>{domain}<button type="button" title={`移除 ${domain}`} onClick={() => removeDomain(domain)}><X size={13}/></button></span>) : <span className="muted">尚未設定允許網域</span>}</div>
          <textarea rows={3} aria-label="允許網域清單" value={domainsText} onChange={event => changeField('allowedDomains', event.target.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean))}/>
        </Field>
        <Field label="瀏覽器連線模式" hint="CDP 會連接你手動開啟的本機 Chrome；流程結束只解除連線，不關閉 Chrome。">
          <select value={draft.browser.connectionMode} onChange={event => changeBrowser('connectionMode', event.target.value as 'managed' | 'cdp')}><option value="managed">Automation Studio 管理瀏覽器</option><option value="cdp">接管現有 Chrome（CDP）</option></select>
        </Field>
        {!cdp && <Field label="瀏覽器" hint="管理模式由 Automation Studio 啟動瀏覽器；固定使用電腦版 1440 × 900。"><select value={String(draft.browser.channel)} onChange={event => changeBrowser('channel', event.target.value)}><option value="bundled">隨附 Chromium（錄製建議）</option><option value="chrome">系統 Google Chrome</option></select></Field>}
        <Field label="網站元件 Adapter"><select value={draft.adapter ?? 'generic'} onChange={event => changeField('adapter', event.target.value)}><option value="generic">通用 HTML</option><option value="extjs">ExtJS</option><option value="ksi">Ksi</option><option value="ebas">EBAS 範例</option></select></Field>
        {!cdp && <Switch checked={draft.browser.stealth === true} onChange={value => changeBrowser('stealth', value)} title="啟用 Stealth（此專案）" hint="僅適用管理模式；變更後請儲存並重新啟動瀏覽器。不能保證網站不阻擋。"/>}
        {!cdp && <Switch checked={draft.browser.reuseProfile === true} onChange={value => changeBrowser('reuseProfile', value)} title="保留登入狀態" hint="管理模式使用專案固定 Profile；登入憑證由使用者在瀏覽器內輸入。"/>}
        <Switch checked={draft.browser.downloadPdfInsteadOfPreview === true} onChange={value => changeBrowser('downloadPdfInsteadOfPreview', value)} title="PDF 直接下載，不開啟預覽" hint="使用專案專用 Chrome Profile；變更後請重新啟動錄製／執行瀏覽器。"/>
        {!cdp && <Switch checked={draft.browser.headless === true} onChange={value => changeBrowser('headless', value)} title="背景模式" hint="錄製與人工登入仍會顯示瀏覽器。"/>}
        {cdp && <div className="workstation-cdp-box field-wide">
          <div><b>CDP 接管設定</b><p>只允許 localhost、127.0.0.1 或 ::1 的本機端點。</p></div>
          <div className="studio-form-grid">
            <Field label="CDP 位址" className="field-wide"><input value={String(draft.browser.cdpEndpoint)} placeholder="http://127.0.0.1:9222" onChange={event => changeBrowser('cdpEndpoint', event.target.value)}/></Field>
            <Switch checked={draft.browser.cdpAutoLaunch !== false} onChange={value => changeBrowser('cdpAutoLaunch', value)} title="執行時自動啟動 Chrome" hint="若 CDP 尚未啟動，Automation Studio 會使用專用 Chrome Profile。"/>
            <Field label="起始分頁"><select value={String(draft.browser.cdpInitialPageMode)} onChange={event => changeBrowser('cdpInitialPageMode', event.target.value as BrowserSettings['cdpInitialPageMode'])}><option value="first">第一個可控制分頁</option><option value="url">網址包含</option><option value="index">第 N 個分頁</option></select></Field>
            {draft.browser.cdpInitialPageMode === 'url' && <Field label="網址片段"><input value={String(draft.browser.cdpInitialPageTarget)} onChange={event => changeBrowser('cdpInitialPageTarget', event.target.value)}/></Field>}
            {draft.browser.cdpInitialPageMode === 'index' && <Field label="分頁編號"><input type="number" min="1" value={Number(draft.browser.cdpInitialPageIndex ?? 1)} onChange={event => changeBrowser('cdpInitialPageIndex', Math.max(1, Number(event.target.value || 1)))}/></Field>}
          </div>
          <div className="studio-button-row"><Button onClick={() => void act('testCdp')} disabled={busy !== null}><Globe size={15}/>{busy === 'testCdp' ? '連線中…' : '啟動並接管 Chrome'}</Button><Button variant="ghost" onClick={() => void act('copyCdpCommand')}><Copy size={15}/>複製手動啟動指令</Button><span className={`pill ${cdpStatus?.error ? 'status-error' : cdpStatus ? 'status-success' : ''}`}>{cdpStatus?.error ? '連線失敗' : cdpStatus ? `已連線 ${cdpStatus.version || 'Chrome'}` : '尚未連線'}</span></div>
          {cdpStatus?.tabs && <div className="workstation-cdp-tabs">{cdpStatus.tabs.map((tab: any) => <div key={tab.index}><b>{tab.index === cdpStatus.selectedIndex ? '✓ ' : ''}{tab.index}. {tab.title || '（無標題）'}</b><code>{tab.url || 'about:blank'}</code></div>)}</div>}
          {cdpStatus?.error && <p className="field-hint status-error">{cdpStatus.error}</p>}
        </div>}
      </div>
      <div className="workstation-profile"><span className={`pill ${profile?.hasData ? 'status-success' : ''}`}><UserRound size={14}/>{cdp ? '登入狀態由 Chrome 管理' : profile?.hasData ? '瀏覽器資料已保存' : draft.browser.reuseProfile ? '尚未建立登入資料' : '不保留登入狀態'}</span><p>{cdp ? 'CDP 模式使用你連接的 Chrome Profile；Automation Studio 不會建立或清除這份登入資料。' : profile?.error ? profile.error : profile?.hasData ? '下次執行此專案會沿用本機 Profile；網站仍可能要求重新驗證。' : draft.browser.reuseProfile ? '完成登入並正常關閉瀏覽器後，Cookie／網站資料會保存在此專案的本機 Profile。' : '每次新開瀏覽器都使用全新工作階段。'}</p></div>
      <div className="studio-button-row workstation-actions">
        <Button variant="primary" onClick={() => void save()} disabled={busy !== null}><Save size={15}/>{busy === 'save' ? '儲存中…' : '儲存設定'}</Button>
        <Button onClick={() => void act('startRecorder')} disabled={busy !== null}><Play size={15}/>{cdp ? '接管 Chrome 並錄製' : '啟動瀏覽器並錄製'}</Button>
        <Button onClick={() => void act('focusRecorder')} disabled={busy !== null}><Globe size={15}/>顯示錄製視窗</Button>
        <Button variant="ghost" onClick={() => void act('stopRecorder')} disabled={busy !== null}><Square size={14}/>停止錄製</Button>
        <Button variant="ghost" onClick={() => void act('clearProfile')} disabled={busy !== null || cdp || !profile?.hasData}><Trash2 size={14}/>清除登入狀態</Button>
        <Button variant="ghost" onClick={() => void act('duplicateProject')} disabled={busy !== null}>複製專案</Button>
        <Button variant="danger" onClick={() => void act('deleteProject')} disabled={busy !== null}>刪除專案</Button>
      </div>
      <aside className="studio-notice"><b>登入與驗證安全邊界</b><span>帳號、MFA、驗證碼及機器人驗證由使用者在獨立瀏覽器視窗完成。登入狀態只保存在本機 Profile，不會隨可攜 ZIP 匯出。</span></aside>
    </section>

    <section className="studio-card workstation-recording">
      <header className="studio-card-heading"><div><div className="studio-eyebrow">LIVE RECORDER</div><h2>錄製事件</h2><p>人工操作會轉成可編輯步驟；未加入流程的事件會暫時保留。</p></div><span className="pill mono">{events.length} 筆</span></header>
      <div className="studio-button-row workstation-assertion"><Field label="點選元素新增驗證"><select value={assertionKind} onChange={event => setAssertionKind(event.target.value as typeof assertionKind)}><option value="visible">元素可見</option><option value="text">文字內容</option><option value="value">欄位值</option></select></Field><Button onClick={() => void act('setRecorderAssertion', { mode: assertionKind })} disabled={!recorder.active || busy !== null}>選取驗證元素</Button><Button variant="ghost" onClick={() => void act('setRecorderAssertion', { mode: '' })} disabled={!recorder.active || !recorder.assertionMode}>取消選取</Button></div>
      <div className={`workstation-recorder-status ${recorder.active ? 'status-running' : ''}`} role="status">
        {recorder.assertionMode ? '請在錄製視窗點選元素；本次點擊只建立驗證。可按 Esc 或取消選取。' : recorder.active ? `錄製視窗：${recorder.browserSource ?? '已啟動'} · ${recorder.url ?? '正在開啟目標網址'}` : events.length ? `錄製已停止 · 尚有 ${events.length} 筆未加入流程的事件` : '支援 Enter／Tab／快捷鍵與上傳錄製；上傳步驟需補完整路徑後啟用。'}
        {recorder.navigationError && <p className="status-error">目標網址載入失敗，請顯示錄製視窗後手動前往：{recorder.navigationError}</p>}
        {recorder.active && recorder.frameHealth?.frames && <p>Frame 錄製器 {recorder.frameHealth.healthyFrames ?? 0}/{recorder.frameHealth.frames} · Binding {recorder.frameHealth.bindingFrames ?? 0}/{recorder.frameHealth.frames}{recorder.frameHealth.repairedFrames ? ` · 已自動修復 ${recorder.frameHealth.repairedFrames} 次` : ''}</p>}
        {recorder.active && recorder.transportHealth?.lastTransport && <p>最近錄製通道：{recorder.transportHealth.lastTransport === 'binding' ? 'Binding' : recorder.transportHealth.lastTransport === 'bridge' ? 'Frame Bridge' : 'Console Beacon'}</p>}
        {snapshot.state.recorderSyncError && <p className="status-error">{snapshot.state.recorderSyncError}</p>}
      </div>
      {events.length ? <div className="workstation-event-list">{events.map((event: any, index: number) => {
        const selector = Array.isArray(event.selector) ? event.selector[0] : event.selector;
        return <article key={`${index}-${event.type}-${event.label}`}><div><span className="pill">{String(event.type || 'event').toUpperCase()}</span><b>{event.label || '未命名操作'}</b></div><p>{selector?.strategy ? `${selector.strategy}：${selector.value ?? '—'}` : '尚無 selector 診斷'}{event.frameUrl ? ` · Frame: ${event.frameUrl}` : ''}{event.type === 'press' ? ` · ${event.value ?? ''}` : ''}{event.type === 'upload' ? ' · 待補完整路徑，加入後預設停用' : ''}{event.type === 'assert' ? ` · ${event.verification?.kind ?? ''}` : ''}</p></article>;
      })}</div> : <div className="studio-empty compact"><LoaderCircle size={16}/><span>尚未錄製任何操作。</span></div>}
      {recorder.lastDiagnostic && <p className={`workstation-diagnostic ${recorder.lastDiagnostic.result === 'ignored' ? 'status-error' : ''}`}>最近操作：{String(recorder.lastDiagnostic.eventType || '—').toUpperCase()} · {recorder.lastDiagnostic.tag || '—'} · {recorder.lastDiagnostic.result === 'recorded' ? '已錄製' : '未錄製'} · {recorder.lastDiagnostic.reason || ''}</p>}
      <div className="studio-button-row"><Button variant="primary" onClick={() => void act('commitRecording')} disabled={!events.length || busy !== null}>加入流程步驟</Button><Button variant="ghost" onClick={() => void act('clearRecording')} disabled={!events.length || busy !== null}>清除本次事件</Button><Button variant="ghost" onClick={() => runtimeSdk.navigate('designer')}>前往流程設計器</Button></div>
    </section>
  </div>;
}

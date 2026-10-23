import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, Check, Clock3, FolderDown, LoaderCircle, Mail, Palette, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import { runtimeSdk } from '../sdk/runtimeSdk';
import { studioApi, type CleanupStatus, type StudioSettings } from '../sdk/restClient';
import { useStudio } from '../store';
import { Button } from './ui/button';

function dateLabel(value?: string) {
  if (!value) return '尚未執行';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function bytesLabel(value?: number) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function CleanupSummary({ title, status, onRun, busy }: { title: string; status?: CleanupStatus; onRun: () => void; busy: boolean }) {
  return <section className="settings-cleanup-card">
    <div className="settings-cleanup-icon"><Clock3 size={16}/></div>
    <div className="settings-cleanup-copy"><b>{title}</b><p>上次清理：{dateLabel(status?.lastCompletedAt)}</p><p>最近移除：{Number(status?.deletedRuns ?? 0)} 筆 · {bytesLabel(status?.reclaimedBytes)}</p>{status?.nextEligibleAt && <p>下次自動檢查：{dateLabel(status.nextEligibleAt)}</p>}{status?.lastError && <p className="status-error"><AlertCircle size={13}/>{status.lastError}</p>}</div>
    <Button onClick={onRun} disabled={busy || status?.running === true}>{busy || status?.running ? <LoaderCircle size={15} className="spin"/> : <RefreshCw size={15}/>}立即清理</Button>
  </section>;
}

function mountLegacyAISettings(host: HTMLElement | null) {
  if (!host) return () => {};
  const legacy = document.querySelector<HTMLElement>('#settingsView .ai-settings-card');
  if (!legacy || legacy.parentElement === host) return () => {};
  const originalParent = legacy.parentElement;
  const marker = document.createComment('AI provider settings mount');
  originalParent?.insertBefore(marker, legacy);
  host.appendChild(legacy);
  return () => {
    if (marker.parentNode) marker.parentNode.insertBefore(legacy, marker);
    marker.remove();
  };
}

export function SettingsPage() {
  const { snapshot } = useStudio();
  const aiSlot = useRef<HTMLDivElement>(null);
  const liveSettings = (snapshot.state.settings ?? {}) as StudioSettings;
  const [draft, setDraft] = useState<StudioSettings>(() => {
    return { ...liveSettings };
  });
  const [cleanup, setCleanup] = useState({ debug: liveSettings.debugCleanupStatus, runs: liveSettings.runHistoryCleanupStatus });
  const [busy, setBusy] = useState<'save' | 'debug' | 'runs' | null>(null);
  const dirty = useRef(false);

  useEffect(() => mountLegacyAISettings(aiSlot.current), []);
  useEffect(() => {
    if (!dirty.current) {
      const next = { ...(snapshot.state.settings ?? {}) } as StudioSettings;
      setDraft(next);
      setCleanup({ debug: next.debugCleanupStatus, runs: next.runHistoryCleanupStatus });
      runtimeSdk.syncSettingsDraft(next as Record<string, unknown>);
    }
  }, [snapshot.revision]);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const refreshStatus = async () => {
      try {
        const response = await studioApi.getSettings();
        if (!active) return;
        setCleanup({ debug: response.settings.debugCleanupStatus, runs: response.settings.runHistoryCleanupStatus });
        if (response.settings.debugCleanupStatus?.running || response.settings.runHistoryCleanupStatus?.running) {
          timer = window.setTimeout(refreshStatus, 1500);
        }
      } catch { /* The settings page remains usable with its last confirmed status. */ }
    };
    void refreshStatus();
    return () => { active = false; window.clearTimeout(timer); };
  }, []);

  const update = (patch: Partial<StudioSettings>) => {
    dirty.current = true;
    const next = { ...draft, ...patch };
    runtimeSdk.syncSettingsDraft(next as Record<string, unknown>);
    setDraft(next);
  };

  const persist = async (): Promise<boolean> => {
    setBusy('save');
    try {
      const settings = { ...draft, ai: runtimeSdk.readAISettingsDraft() as StudioSettings['ai'] };
      const response = await studioApi.updateSettings(settings);
      runtimeSdk.adoptSettings(response.settings as Record<string, unknown>);
      dirty.current = false;
      setDraft(response.settings);
      setCleanup({ debug: response.settings.debugCleanupStatus, runs: response.settings.runHistoryCleanupStatus });
      return true;
    } catch (error) {
      runtimeSdk.toast(error instanceof Error ? error.message : String(error), true);
      return false;
    } finally { setBusy(null); }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (await persist()) runtimeSdk.toast('系統設定已儲存');
  };

  const runCleanup = async (kind: 'debug' | 'runs') => {
    if (!(await persist())) return;
    setBusy(kind);
    try {
      const response = kind === 'debug' ? await studioApi.cleanupExpiredDebug() : await studioApi.cleanupExpiredRunHistory();
      runtimeSdk.adoptSettings(response.settings as Record<string, unknown>);
      dirty.current = false;
      setDraft(response.settings);
      setCleanup({ debug: response.settings.debugCleanupStatus, runs: response.settings.runHistoryCleanupStatus });
      const result = response.result ?? {};
      runtimeSdk.toast(`${kind === 'debug' ? 'Debug' : '執行紀錄'}清理完成：移除 ${Number(result.deletedRuns ?? 0)} 筆，釋放 ${bytesLabel(result.reclaimedBytes)}`);
    } catch (error) {
      runtimeSdk.toast(error instanceof Error ? error.message : String(error), true);
    } finally { setBusy(null); }
  };

  return <div className="studio-page settings-page">
    <form className="studio-card" onSubmit={submit} noValidate>
      <header className="studio-card-heading"><div><div className="studio-eyebrow">LOCAL PREFERENCES</div><h2>系統設定</h2><p>設定只保存在這台電腦的程式資料夾。啟動服務後會固定自動開啟介面。</p></div><span className="pill"><ShieldCheck size={14}/>本機設定</span></header>
      <div className="studio-form-grid">
        <label className="field"><span><Palette size={14}/>介面配色</span><select value={String(draft.theme ?? 'system')} onChange={event => update({ theme: event.target.value as StudioSettings['theme'] })}><option value="system">依系統</option><option value="light">淺色</option><option value="dark">深色</option></select></label>
        <label className="field"><span>Debug 保留天數</span><input type="number" min={1} max={365} value={Number(draft.retentionDays ?? 30)} onChange={event => update({ retentionDays: Math.min(365, Math.max(1, Number(event.target.value) || 1)) })}/></label>
        <label className="field"><span>執行紀錄保留天數</span><input type="number" min={1} max={365} value={Number(draft.runHistoryRetentionDays ?? 30)} onChange={event => update({ runHistoryRetentionDays: Math.min(365, Math.max(1, Number(event.target.value) || 1)) })}/><small>與 Debug 保留天數分開設定；只清理已完成、失敗或取消的紀錄。</small></label>
        <label className="field"><span><FolderDown size={14}/>預設下載路徑</span><input value={String(draft.defaultDownloadDir ?? './downloads')} onChange={event => update({ defaultDownloadDir: event.target.value })}/></label>
        <label className="field"><span>Debug 保存方式</span><select value={String(draft.debugRetention ?? 'failures')} onChange={event => update({ debugRetention: event.target.value as StudioSettings['debugRetention'] })}><option value="failures">僅失敗任務</option><option value="all">全部任務</option></select><small>成功任務完成後只刪除該次 run 的 Debug；失敗／取消任務依保留天數處理。</small></label>
        <label className="field field-wide"><span><Mail size={14}/>問題回報收件信箱</span><input type="email" placeholder="例如 support@example.gov.tw" value={String(draft.issueReportEmail ?? '')} onChange={event => update({ issueReportEmail: event.target.value })}/><small>「回報問題」會以此信箱作為預設收件人。</small></label>
      </div>
      <div className="settings-cleanup-list">
        <CleanupSummary title="Debug 到期清理" status={cleanup.debug} onRun={() => void runCleanup('debug')} busy={busy === 'debug'}/>
        <CleanupSummary title="執行紀錄到期清理" status={cleanup.runs} onRun={() => void runCleanup('runs')} busy={busy === 'runs'}/>
      </div>
      <div className="studio-button-row settings-save-row"><span className="muted">{dirty.current ? '有尚未儲存的變更' : '變更已儲存'}</span><Button type="submit" variant="primary" disabled={busy !== null}><Save size={15}/>{busy === 'save' ? '儲存中…' : '儲存系統設定'}</Button></div>
    </form>
    <div className="studio-card ai-provider-mount">
      <header className="studio-card-heading"><div><div className="studio-eyebrow">AI CONFIGURATION</div><h2>AI Provider</h2><p>供 AI 流程助理與失敗分析使用；現有 Provider、憑證來源與連線診斷功能維持原樣。</p></div><Check size={18}/></header>
      <div ref={aiSlot} className="legacy-ai-settings-slot" />
      <p className="field-hint">修改 AI Provider 後，請使用上方 Provider 面板中的儲存按鈕。API Key 僅依目前選擇的環境變數或本機設定來源處理。</p>
    </div>
  </div>;
}

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, FolderPlus, Play, RefreshCw } from 'lucide-react';
import { runtimeSdk } from '../sdk/runtimeSdk';
import { projectIsQuickRunnable } from '../model';
import { studioApi, type DashboardProject, type DashboardSummary } from '../sdk/restClient';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

function formatTime(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

const statusLabels: Record<string, string> = {
  queued: '等待中', running: '執行中', paused: '等待人工操作', completed: '完成', failed: '失敗', cancelled: '已取消'
};

export function Dashboard() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [targetUrl, setTargetUrl] = useState('');
  const [description, setDescription] = useState('');
  const [formError, setFormError] = useState('');
  const dashboard = useQuery({
    queryKey: ['studio-dashboard'],
    queryFn: ({ signal }) => studioApi.getDashboard(signal),
    staleTime: 10_000,
    refetchInterval: 30_000
  });
  const createProject = useMutation({
    mutationFn: () => {
      const target = targetUrl.trim();
      return studioApi.createProject({ name: name.trim(), targetUrl: target, description: description.trim(), allowedDomains: [new URL(target).hostname] });
    },
    onSuccess: async ({ project }) => {
      await queryClient.invalidateQueries({ queryKey: ['studio-dashboard'] });
      await queryClient.invalidateQueries({ queryKey: ['studio-projects'] });
      setCreateOpen(false);
      setName(''); setTargetUrl(''); setDescription(''); setFormError('');
      await runtimeSdk.refresh();
      await runtimeSdk.loadProject(project.id);
      runtimeSdk.navigate('workstation');
    },
    onError: error => setFormError(error instanceof Error ? error.message : '建立專案失敗。')
  });
  const quickRun = useMutation({
    mutationFn: async (projectId: string) => {
      await runtimeSdk.loadProject(projectId);
      await runtimeSdk.run('full');
    },
    onError: error => runtimeSdk.toast(error instanceof Error ? error.message : '無法啟動流程。', true)
  });

  const data = dashboard.data as DashboardSummary | undefined;
  const projects = data?.recentProjects ?? [];
  const runs = data?.recentRuns ?? [];
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError('');
    createProject.mutate();
  };

  return <div className="react-dashboard">
    <section className="dashboard-welcome">
      <div><span className="kicker">AUTOMATION WORKSPACE</span><h2>把成功操作，變成可重複的工作流程</h2><p>從網址開始錄製、參數化、測試與除錯，再輸出可攜流程、TypeScript 或 SKILL.md。</p></div>
      <Button variant="default" onClick={() => runtimeSdk.navigate('designer')}>開啟流程設計器<ArrowRight size={15}/></Button>
    </section>

    {dashboard.isError && <div className="dashboard-error" role="alert">{dashboard.error instanceof Error ? dashboard.error.message : '無法讀取專案總覽。'}<Button size="sm" onClick={() => void dashboard.refetch()}>重試</Button></div>}
    <div className="dashboard-metrics" aria-live="polite">
      {[['專案', data?.projectCount], ['可發布', data?.readyCount], ['執行次數', data?.runCount], ['成功率', `${data?.successRate ?? 0}%`]].map(([label, value]) => <article className="dashboard-metric" key={String(label)}><span>{label}</span><strong>{dashboard.isPending ? '—' : value ?? 0}</strong><small>{label === '可發布' ? '已完成基本設定' : label === '成功率' ? '完成任務占比' : label === '執行次數' ? '所有專案累計' : '目前工作區'}</small></article>)}
    </div>

    <div className="dashboard-columns">
      <section className="card dashboard-card">
        <div className="section-heading"><div><h2>最近專案</h2><p>繼續設計或複製現有流程。</p></div><div className="dashboard-heading-actions"><Button size="icon" variant="ghost" title="重新整理" aria-label="重新整理專案總覽" onClick={() => void dashboard.refetch()} disabled={dashboard.isFetching}><RefreshCw size={15}/></Button><Button size="sm" onClick={() => setCreateOpen(true)}><FolderPlus size={14}/>建立專案</Button></div></div>
        <div className="dashboard-project-list">
          {dashboard.isPending ? <div className="dashboard-empty">正在讀取專案…</div> : projects.length ? projects.map(project => <article className="dashboard-project" key={project.id}>
            <button className="dashboard-project-open" onClick={() => { void runtimeSdk.loadProject(project.id).then(() => runtimeSdk.navigate('designer')); }} aria-label={`開啟專案 ${project.name}`}><span className="dashboard-project-mark">{project.name.slice(0, 1)}</span><span className="dashboard-project-info"><b>{project.name}</b><small>{project.description || project.targetUrl}</small></span></button>
            <div className="dashboard-project-actions"><time>{formatTime(project.updatedAt)}</time>{projectIsQuickRunnable(project) && <Button size="sm" variant="default" disabled={quickRun.isPending} onClick={() => quickRun.mutate(project.id)}><Play size={13}/>{quickRun.isPending && quickRun.variables === project.id ? '啟動中…' : '執行流程'}</Button>}</div>
          </article>) : <div className="dashboard-empty">尚無專案。建立專案後即可開始錄製與設計。</div>}
        </div>
      </section>
      <section className="card dashboard-card">
        <div className="section-heading"><div><h2>最近執行</h2><p>快速掌握完成狀態與最後錯誤。</p></div><Button size="sm" variant="ghost" onClick={() => runtimeSdk.navigate('runs')}>查看全部<ArrowRight size={14}/></Button></div>
        <div className="dashboard-run-list">{dashboard.isPending ? <div className="dashboard-empty">正在讀取執行紀錄…</div> : runs.length ? runs.map(run => <article className="dashboard-run" key={run.id}><span className={`dashboard-run-dot ${run.status}`} aria-hidden="true"/><div><b>{run.projectName}</b><small>{statusLabels[run.status] ?? run.status} · {run.completedSteps}/{run.totalSteps} 步驟</small></div><time>{formatTime(run.startedAt)}</time></article>) : <div className="dashboard-empty">尚無執行紀錄。</div>}</div>
      </section>
    </div>

    <Dialog open={createOpen} onOpenChange={setCreateOpen} title="建立自動化專案" description="提供網址後即可開始錄製與設計。">
      <form className="dashboard-create-form" onSubmit={submit}>
        <label>專案名稱<input autoFocus required value={name} onChange={event => setName(event.target.value)} placeholder="例如：每月報表下載"/></label>
        <label>目標網址<input type="url" required value={targetUrl} onChange={event => setTargetUrl(event.target.value)} placeholder="https://example.com"/></label>
        <label>說明<textarea rows={3} value={description} onChange={event => setDescription(event.target.value)}/></label>
        {formError && <p className="dashboard-form-error" role="alert">{formError}</p>}
        <div className="dashboard-form-actions"><Button type="button" onClick={() => setCreateOpen(false)}>取消</Button><Button variant="default" type="submit" disabled={createProject.isPending}>{createProject.isPending ? '建立中…' : '建立並開啟'}</Button></div>
      </form>
    </Dialog>
  </div>;
}

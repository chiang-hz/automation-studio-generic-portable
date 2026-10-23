import React, { useEffect, useLayoutEffect, useState, Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Search, Sun, Moon, ChevronLeft, ChevronRight, FolderKanban, LayoutDashboard, Globe,
  Workflow, Database, FlaskConical, Table2, History, Package, Settings,
  HelpCircle, MessageCircle, Sparkles, Wrench, FileJson2, FolderPlus, FileUp,
  PanelLeftClose, PanelLeftOpen, X
} from 'lucide-react';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { runtimeSdk } from './sdk/runtimeSdk';
import { studioApi, type StudioSettings } from './sdk/restClient';
import { useStudio } from './store';
import { Designer, PropertySheet } from './components/Designer';
import { BatchGrid } from './components/BatchGrid';
import { DebugWorkbench, DiagnosticsDiff } from './components/DebugInspector';
import { AIChat, AIDiff, AIFloatingBar } from './components/AIAssistant';
import { RunsGrid } from './components/RunsGrid';
import { Dashboard } from './components/Dashboard';
import { ParameterManager } from './components/ParameterManager';
import { PublishManager } from './components/PublishManager';
import { Workstation } from './components/Workstation';
import { SettingsPage } from './components/SettingsPage';
import { HelpPage, ReportPage, DeveloperPage } from './components/SupportPages';
import { CommandPalette } from './components/CommandPalette';
import { CodeEditor } from './components/CodeEditor';
import { Button } from './components/ui/button';
import {createHoverIntent} from './hoverIntent';

const client = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });
const icons: Record<string, typeof Workflow> = {
  dashboard: LayoutDashboard, workstation: Globe, designer: Workflow,
  parameters: Database, test: FlaskConical, batch: Table2, runs: History,
  publish: Package, settings: Settings, help: HelpCircle, report: MessageCircle,
  aiWorkflow: Sparkles, developer: FileJson2
};
const viewShortcuts: Record<string, string> = {
  dashboard: 'G then P', designer: 'G then D', batch: 'G then B',
  test: 'G then T', runs: 'G then R'
};

function host(id: string, parent: Element, before?: Element | null, tagName = 'div') {
  let element = document.getElementById(id);
  if (!element) {
    element = document.createElement(tagName);
    element.id = id;
    parent.insertBefore(element, before ?? null);
  }
  return element;
}

const designerHost = host('modern-designer', document.querySelector('.canvas-pane')!);
const batchHost = host('modern-batch', document.querySelector('.batch-list-card')!);
const debugHost = host('modern-debug', document.getElementById('testView')!, document.querySelector('.comparison-card'));
const aiChatHost = host('modern-ai-chat', document.querySelector('.ai-chat-panel')!, document.querySelector('#aiWorkflowConversation'));
const aiDiffHost = host('modern-ai-diff', document.querySelector('.ai-workflow-preview-card')!, document.querySelector('#aiWorkflowPreview'));
const aiBarHost = host('modern-ai-bar', document.body);
const diagnosticsHost = host('modern-diagnostics', document.getElementById('debugAIPatchPanel')!, document.getElementById('debugAIPatchPreview'));
const runsHost = host('modern-runs', document.querySelector('#runsView > .card')!);
const dashboardHost = host('modern-dashboard', document.getElementById('dashboardView')!);
const parametersHost = host('modern-parameters', document.getElementById('parametersView')!);
const publishHost = host('modern-publish', document.getElementById('publishView')!);
const workstationHost = host('modern-workstation', document.getElementById('workstationView')!);
const settingsHost = host('modern-settings', document.getElementById('settingsView')!);
const helpHost = host('modern-help', document.getElementById('helpView')!);
const reportHost = host('modern-report', document.getElementById('reportView')!);
const developerHost = host('modern-developer', document.getElementById('developerView')!);
const helpSourceView = document.getElementById('helpView')!;
const globalHost = host('modern-global-controls', document.querySelector('.topbar')!, document.getElementById('workspaceTopbarActions'));
const sidebarToggleHost = host('modern-sidebar-toggle', document.body);
const projectSwitcherIconHost = host('modern-project-switcher-icon', document.querySelector('.project-select-control')!, null, 'span');
const newProjectIconHost = document.querySelector<HTMLElement>('#newProjectButton .sidebar-action-icon')!;
const importProjectIconHost = document.querySelector<HTMLElement>('#importProjectButton .sidebar-action-icon')!;
newProjectIconHost.replaceChildren();
importProjectIconHost.replaceChildren();
const paletteControlsHost = host('modern-palette-controls', document.querySelector('.palette-pane .pane-heading')!);
const paletteSearchHost = host('modern-palette-search', document.querySelector('.palette-pane')!, document.getElementById('stepPalette'));
const developerSummary = document.querySelector('.developer-menu > summary')!;
const developerSummaryHost = host('modern-developer-summary-icon', developerSummary);
developerSummaryHost.classList.add('modern-developer-summary-icon');
const developerLegacyHost = document.querySelector<HTMLElement>('.developer-menu .developer-link > span')!;
developerLegacyHost.id = 'modern-developer-legacy-icon';
developerLegacyHost.replaceChildren();

document.querySelectorAll('.nav-item>span,.developer-menu button[data-view]>span').forEach(el => el.replaceChildren());
const navHosts = [...document.querySelectorAll<HTMLElement>('.nav-item,.developer-menu button[data-view]')]
  .map(button => ({ element: button.querySelector('span')!, button, view: button.dataset.view! }));

function isTypingSurface(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest(
    'input,textarea,select,[contenteditable=""],[contenteditable="true"],[role="textbox"],.monaco-editor'
  ));
}

function Studio() {
  const { snapshot, setCommand } = useStudio();
  const [themeSaving, setThemeSaving] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('studio-sidebar-collapsed') === 'true');
  const [editors, setEditors] = useState<{ target: HTMLTextAreaElement | HTMLInputElement; mount: HTMLElement; language: string }[]>([]);
  const [paletteCollapsed, setPaletteCollapsed] = useState(() => localStorage.getItem('studio-palette-collapsed-v2') !== 'false');
  const [palettePeeking,setPalettePeeking]=useState(false);
  const [paletteFilter, setPaletteFilter] = useState('');

  useLayoutEffect(() => {
    document.documentElement.classList.add('modern-active');
    document.documentElement.classList.add('react-dashboard-active');
    document.documentElement.classList.add('react-parameters-active');
    document.documentElement.classList.add('react-publish-active');
    document.documentElement.classList.add('react-workstation-active', 'react-settings-active', 'react-report-active', 'react-developer-active');
    useStudio.getState().refresh();
    window.studioStartup?.complete('ui');
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('sidebar-collapsed', collapsed);
    localStorage.setItem('studio-sidebar-collapsed', String(collapsed));
  }, [collapsed]);

  useEffect(() => {
    document.querySelector('.palette-pane')?.classList.toggle('is-collapsed', paletteCollapsed);
    localStorage.setItem('studio-palette-collapsed-v2', String(paletteCollapsed));
  }, [paletteCollapsed]);

  useEffect(() => {
    const pane = document.querySelector('.palette-pane');
    setPalettePeeking(false);
    const intent=createHoverIntent(()=>setPalettePeeking(true),()=>setPalettePeeking(false));
    const enter=()=>{if(paletteCollapsed&&!pane?.classList.contains('hover-suppressed')&&window.matchMedia('(hover:hover)').matches)intent.enter();};
    const leave=()=>{intent.leave();pane?.classList.remove('hover-suppressed');};
    pane?.addEventListener('pointerenter',enter);
    pane?.addEventListener('pointerleave',leave);
    return()=>{intent.dispose();pane?.removeEventListener('pointerenter',enter);pane?.removeEventListener('pointerleave',leave);};
  }, [paletteCollapsed]);

  useEffect(()=>{document.querySelector('.palette-pane')?.classList.toggle('is-peeking',palettePeeking);},[palettePeeking]);

  useEffect(() => {
    const query = paletteFilter.trim().toLowerCase();
    const buttons = document.querySelectorAll<HTMLButtonElement>('#stepPalette button[data-kind]');
    buttons.forEach(btn => {
      const text = `${btn.textContent ?? ''} ${btn.dataset.kind ?? ''}`.toLowerCase();
      btn.hidden = Boolean(query && !text.includes(query));
    });
    const groups = document.querySelectorAll<HTMLElement>('#stepPalette .palette-group-title');
    groups.forEach(group => {
      const groupName = group.dataset.paletteGroup;
      if (!groupName) return;
      const groupButtons = document.querySelectorAll<HTMLButtonElement>(`#stepPalette button[data-group="${groupName}"]`);
      group.hidden = Boolean(query && groupButtons.length > 0 && [...groupButtons].every(b => b.hidden));
    });
  }, [paletteFilter]);

  useEffect(() => {
    const selector = snapshot.view === 'designer' ? '#stepSelectors,#regexPattern'
      : snapshot.view === 'developer' ? '#workflowJson'
      : snapshot.view === 'parameters' ? '#parameterDependentOptions' : '';
    const fields = selector ? [...document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(selector)] : [];
    setEditors(previous => {
      const next = fields.map(target => {
        const old = previous.find(editor => editor.target === target);
        if (old) return old;
        const mount = document.createElement('div');
        target.after(mount);
        return { target, mount, language: target.id === 'regexPattern' ? 'regex' : 'json' };
      });
      for (const old of previous) {
        if (!next.some(editor => editor.target === old.target)) {
          old.target.classList.remove('modern-code-source');
          old.mount.remove();
        }
      }
      return next;
    });
  }, [snapshot.revision, snapshot.view]);

  useEffect(() => {
    let awaitingG = false;
    let timeout: number | undefined;
    const navigate = (view: string) => runtimeSdk.navigate(view);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        awaitingG = false;
        window.clearTimeout(timeout);
        return;
      }
      if (isTypingSurface(event.target) || document.querySelector('[role="dialog"]')) {
        awaitingG = false;
        window.clearTimeout(timeout);
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey) return;

      if (event.key === '[' || event.key === ']') {
        event.preventDefault();
        setCollapsed(event.key === '[');
        return;
      }
      if (event.key.toLowerCase() === 'g' && event.key.length === 1) {
        awaitingG = true;
        window.clearTimeout(timeout);
        timeout = window.setTimeout(() => { awaitingG = false; }, 900);
        return;
      }
      if (!awaitingG) return;
      awaitingG = false;
      window.clearTimeout(timeout);
      const destinations: Record<string, string> = { p: 'dashboard', d: 'designer', b: 'batch', t: 'test', r: 'runs' };
      const destination = destinations[event.key.toLowerCase()];
      if (destination) {
        event.preventDefault();
        navigate(destination);
      }
    };
    const onRunShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key !== 'Enter' || isTypingSurface(event.target)) return;
      if (!useStudio.getState().snapshot.state.project || document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      void runtimeSdk.run('full');
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keydown', onRunShortcut);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keydown', onRunShortcut);
      window.clearTimeout(timeout);
    };
  }, [setCollapsed]);

  useEffect(() => {
    if (snapshot.view !== 'designer') useStudio.getState().setSheet(false);
  }, [snapshot.view]);

  const toggleTheme = async () => {
    if (themeSaving) return;
    const original = String(snapshot.state.settings?.theme ?? 'system');
    const next = snapshot.theme === 'dark' ? 'light' : 'dark';
    setThemeSaving(true);
    runtimeSdk.setTheme(next);
    try {
      const response = await studioApi.updateSettings({ ...(snapshot.state.settings as StudioSettings), theme: next });
      runtimeSdk.adoptSettings(response.settings as Record<string, unknown>);
    } catch (error) {
      runtimeSdk.setTheme(original);
      runtimeSdk.toast(`無法儲存介面配色：${error instanceof Error ? error.message : String(error)}`, true);
    } finally {
      setThemeSaving(false);
    }
  };

  return <>
    {createPortal(
      <div className="global-controls">
        <Button id="command-open" onClick={() => setCommand(true)} className="command-launch" aria-label="搜尋與指令，Ctrl 或 Command 加 K">
          <Search size={15}/><span>搜尋與指令</span><kbd>Ctrl K</kbd>
        </Button>
        <Button size="icon" variant="ghost" title="切換深淺色" aria-label="切換深淺色" disabled={themeSaving} onClick={() => { void toggleTheme(); }}>
          {snapshot.theme === 'dark' ? <Sun size={16}/> : <Moon size={16}/>}
        </Button>
      </div>, globalHost
    )}
    {createPortal(<Button size="icon" variant="ghost" className="palette-collapse-toggle" aria-controls="stepPalette" aria-expanded={!paletteCollapsed||palettePeeking} aria-label={paletteCollapsed ? '展開動作元件' : '收合動作元件'} title={paletteCollapsed ? '停留 0.8 秒顯示元件；點擊固定展開' : '收合動作元件'} onClick={event => { setPalettePeeking(false); document.querySelector('.palette-pane')?.classList.toggle('hover-suppressed', !paletteCollapsed); event.currentTarget.blur(); setPaletteCollapsed(value => !value); }}>{paletteCollapsed ? <PanelLeftOpen size={16}/> : <PanelLeftClose size={16}/>}</Button>, paletteControlsHost)}
    {createPortal(
      <div className="palette-search-box">
        <Search size={13}/>
        <input value={paletteFilter} onChange={e => setPaletteFilter(e.target.value)} placeholder="篩選動作元件…" aria-label="篩選動作元件"/>
        {paletteFilter && <button type="button" aria-label="清除動作元件篩選" onClick={() => setPaletteFilter('')}><X size={12}/></button>}
      </div>, paletteSearchHost
    )}
    {createPortal(<FolderPlus size={17} aria-hidden="true"/>, newProjectIconHost)}
    {createPortal(<FileUp size={17} aria-hidden="true"/>, importProjectIconHost)}
    {createPortal(<Wrench size={17} strokeWidth={1.7} aria-hidden="true"/>, developerSummaryHost)}
    {createPortal(
      <Button
        id="sidebar-toggle"
        size="icon"
        variant="secondary"
        className="sidebar-boundary-toggle"
        title={collapsed ? '展開側欄' : '收合側欄'}
        aria-label={collapsed ? '展開側欄' : '收合側欄'}
        aria-expanded={!collapsed}
        onPointerEnter={event => event.currentTarget.style.setProperty('--pointer-y', `${event.clientY}px`)}
        onPointerMove={event => event.currentTarget.style.setProperty('--pointer-y', `${event.clientY}px`)}
        onClick={() => setCollapsed(value => !value)}
      ><span className="sidebar-boundary-indicator">{collapsed ? <ChevronRight size={18}/> : <ChevronLeft size={18}/>}</span></Button>, sidebarToggleHost
    )}
    {createPortal(<FolderKanban size={17} strokeWidth={1.7} aria-hidden="true"/>, projectSwitcherIconHost)}
    {navHosts.map(({ element, button, view }) => {
      const Icon = icons[view] ?? Workflow;
      const label = runtimeSdk.labels[view]?.[0] ?? view;
      button.title = `${label}${viewShortcuts[view] ? ` · ${viewShortcuts[view]}` : ''}`;
      button.setAttribute('aria-label', label);
      return createPortal(<Icon size={17} strokeWidth={1.7} aria-hidden="true"/>, element, view);
    })}
    {createPortal(<Globe size={16} strokeWidth={1.7} aria-hidden="true"/>, developerLegacyHost)}
    {snapshot.view === 'dashboard' && createPortal(<Dashboard/>, dashboardHost)}
    {snapshot.view === 'parameters' && createPortal(<ParameterManager/>, parametersHost)}
    {snapshot.view === 'publish' && createPortal(<PublishManager/>, publishHost)}
    {snapshot.view === 'workstation' && createPortal(<Workstation/>, workstationHost)}
    {snapshot.view === 'settings' && createPortal(<SettingsPage/>, settingsHost)}
    {snapshot.view === 'help' && createPortal(<HelpPage sourceView={helpSourceView}/>, helpHost)}
    {snapshot.view === 'report' && createPortal(<ReportPage/>, reportHost)}
    {snapshot.view === 'developer' && createPortal(<DeveloperPage/>, developerHost)}
    {snapshot.view === 'designer' && createPortal(<Designer/>, designerHost)}
    {snapshot.view === 'batch' && createPortal(<BatchGrid/>, batchHost)}
    {snapshot.view === 'test' && createPortal(<DebugWorkbench/>, debugHost)}
    {snapshot.view === 'test' && createPortal(<DiagnosticsDiff/>, diagnosticsHost)}
    {snapshot.view === 'aiWorkflow' && createPortal(<AIChat/>, aiChatHost)}
    {snapshot.view === 'aiWorkflow' && createPortal(<AIDiff/>, aiDiffHost)}
    {snapshot.view === 'aiWorkflow' && createPortal(<AIFloatingBar/>, aiBarHost)}
    {snapshot.view === 'runs' && createPortal(<RunsGrid/>, runsHost)}
    {editors.filter(editor => editor.target.isConnected).map(editor => createPortal(
      <CodeEditor target={editor.target} language={editor.language}/>, editor.mount,
      `${editor.target.id}-${snapshot.state.selectedStepId}`
    ))}
    <PropertySheet/>
    <CommandPalette/>
  </>;
}

class UIErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) {
    console.error('Modern UI failed to render.', error);
    window.studioStartup?.fail('介面無法正常顯示，請重新整理後再試。');
  }
  render() {
    return this.state.failed
      ? <div role="alert" className="ui-fallback"><p>介面載入失敗，請重新整理後再試。</p><Button onClick={() => window.location.reload()}>重新整理</Button></div>
      : this.props.children;
  }
}

const mount = document.createElement('div');
mount.id = 'studio-react-root';
document.body.append(mount);
createRoot(mount).render(
  <UIErrorBoundary><QueryClientProvider client={client}><Studio/></QueryClientProvider></UIErrorBoundary>
);

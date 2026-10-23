import {reorderWorkflowSteps,type StepDropMode,type BatchRow,type Parameter,type Project,type Step} from '../model';
import { bridge, type Bridge, type Snapshot } from '../bridge';

export type WorkstationAction =
  | 'testCdp'
  | 'copyCdpCommand'
  | 'startRecorder'
  | 'focusRecorder'
  | 'stopRecorder'
  | 'setRecorderAssertion'
  | 'commitRecording'
  | 'clearRecording'
  | 'clearProfile'
  | 'duplicateProject'
  | 'deleteProject';

/** Typed façade for the existing browser, recorder and shell workflows. */
export class StudioRuntimeSdk {
  constructor(private readonly adapter: Bridge = bridge) {}

  get labels(): Record<string, string[]> { return this.adapter.labels; }
  snapshot(): Snapshot { return this.adapter.snapshot(); }
  subscribe(listener: () => void): () => void { return this.adapter.subscribe(listener); }
  kindLabel(kind: string): string { return this.adapter.kindLabel(kind); }
  options(parameter: Parameter, values: Record<string, string | boolean>): string[] { return this.adapter.options(parameter, values); }
  navigate(view: string): void { this.adapter.navigate(view); }
  loadProject(id: string): Promise<void> { return this.adapter.loadProject(id); }
  refresh(): Promise<void> { return this.adapter.refresh(); }
  setParameters(parameters: Parameter[]): void { this.adapter.setParameters(parameters); }
  patchProject(patch: Partial<Project>, immediateSave = false): void { this.adapter.patchProject(patch, immediateSave); }
  run(mode = 'full'): Promise<void> { return this.adapter.run(mode); }
  save(): Promise<void> { return this.adapter.save(); }
  toast(message: string, error = false): void { this.adapter.toast(message, error); }
  select(id: string): void { this.adapter.select(id); }
  restoreSteps(steps: Step[], selectedStepId?: string): boolean { return this.adapter.restoreSteps(steps, selectedStepId); }
  action(id: string, action: string): void { this.adapter.action(id, action); }
  insert(kind: string, owner: string | null, branch: string, index: number): void { this.adapter.insert(kind, owner, branch, index); }
  move(id: string, offset: number): boolean { return this.adapter.move(id, offset); }
  reorder(sourceId:string,targetId:string,mode:StepDropMode):boolean {
    const steps=reorderWorkflowSteps(this.snapshot().state.project?.steps??[],sourceId,targetId,mode);
    if(!steps)return false;
    return this.adapter.restoreSteps(steps,sourceId);
  }
  newBatchRow = (): BatchRow => this.adapter.newBatchRow();
  setBatchRows(rows: BatchRow[]): void { this.adapter.setBatchRows(rows); }
  runBatch(rows: BatchRow[]): Promise<void> { return this.adapter.runBatch(rows); }
  click(id: string): void { this.adapter.click(id); }
  publish(): void { this.adapter.publish(); }
  selected(): Step | undefined { return this.adapter.selected(); }
  debugText(tab: string): string { return this.adapter.debugText(tab); }
  filteredRuns(): any[] { return this.adapter.filteredRuns(); }
  selectRun(id: string, on: boolean): void { this.adapter.selectRun(id, on); }
  openHistory(id: string): Promise<void> { return this.adapter.openHistory(id); }
  closeHistory(): void { this.adapter.closeHistory(); }
  historyMarkup(): string { return this.adapter.historyMarkup(); }
  historyClick(event: unknown): void { this.adapter.historyClick(event); }
  runHistoryAction(id: string, action: string): void { this.adapter.runHistoryAction(id, action); }
  openDownloadFolder(): void { this.adapter.openDownloadFolder(); }
  invoke(id: string): Promise<void> { return this.adapter.invoke(id); }
  setTheme(theme: string): void { this.adapter.setTheme(theme); }

  syncWorkstationDraft(project: Project): boolean {
    return this.adapter.syncWorkstationDraft(project);
  }

  saveWorkstation(project: Project): Promise<boolean> {
    return this.adapter.saveWorkstationDraft(project);
  }

  async actOnWorkstation(action: WorkstationAction, project: Project, payload?: Record<string, unknown>): Promise<unknown> {
    if (action === 'startRecorder') {
      if (!this.syncWorkstationDraft(project)) throw new Error('目前專案已變更，請重新載入工作站。');
    } else if ((action === 'testCdp' || action === 'copyCdpCommand') && !this.adapter.syncWorkstationFields(project)) {
      throw new Error('目前專案已變更，請重新載入工作站。');
    }
    if (action === 'startRecorder' && !(await this.saveWorkstation(project))) return false;
    return this.adapter.workstationAction(action, payload);
  }

  adoptProject(project: Project): boolean {
    return this.adapter.adoptProject(project);
  }

  syncSettingsDraft(settings: Record<string, unknown>): void {
    this.adapter.syncSettingsDraft(settings);
  }

  readAISettingsDraft(): Record<string, unknown> {
    return this.adapter.readAISettingsDraft();
  }

  adoptSettings(settings: Record<string, unknown>): void {
    this.adapter.adoptSettings(settings);
  }

  prepareIssueReport(values: Record<string, string>): { to: string; subject: string; body: string } {
    return this.adapter.prepareIssueReport(values);
  }

}

export const runtimeSdk = new StudioRuntimeSdk();

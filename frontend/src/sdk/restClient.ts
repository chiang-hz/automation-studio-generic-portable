import type { Project } from '../model';

export interface ProjectChoice {
  id: string;
  name: string;
}

interface ProjectListResponse {
  projects?: ProjectChoice[];
}

export interface DashboardRun {
  id: string;
  projectName: string;
  status: string;
  completedSteps: number;
  totalSteps: number;
  startedAt?: string;
}

export interface DashboardProject extends Project {
  updatedAt?: string;
  allowedDomains?: string[];
}

export interface DashboardSummary {
  projectCount?: number;
  readyCount?: number;
  runCount?: number;
  successRate?: number;
  recentProjects?: DashboardProject[];
  recentRuns?: DashboardRun[];
}

export interface ProjectCreateInput {
  name: string;
  targetUrl: string;
  description?: string;
  allowedDomains?: string[];
}

export interface ProjectResponse {
  project: Project;
}

export interface RunResponse {
  run: {
    id: string;
    [key: string]: unknown;
  };
}

export interface ExportSelection {
  portableWorkflow: boolean;
  typescript: boolean;
  skill: boolean;
  includeTests: boolean;
  includeExamples: boolean;
}

export interface StudioSettings {
  theme?: 'system' | 'light' | 'dark';
  retentionDays?: number;
  runHistoryRetentionDays?: number;
  defaultDownloadDir?: string;
  debugRetention?: 'failures' | 'all';
  issueReportEmail?: string;
  ai?: Record<string, unknown>;
  debugCleanupStatus?: CleanupStatus;
  runHistoryCleanupStatus?: CleanupStatus;
  [key: string]: unknown;
}

export interface CleanupStatus {
  running?: boolean;
  lastCompletedAt?: string;
  nextEligibleAt?: string;
  deletedRuns?: number;
  reclaimedBytes?: number;
  lastError?: string;
}

export interface SettingsResponse {
  settings: StudioSettings;
}

export interface CleanupResponse extends SettingsResponse {
  result?: { deletedRuns?: number; reclaimedBytes?: number };
}

export class StudioApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'StudioApiError';
  }
}

/** Typed access to existing Studio REST routes; this client does not change the runtime protocol. */
export class StudioRestClient {
  constructor(private readonly baseUrl = '/api/studio') {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (init.body != null && !(init.body instanceof FormData) && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    const contentType = response.headers.get('content-type') ?? '';
    const payload = contentType.includes('json') ? await response.json().catch(() => null) : await response.text();
    if (!response.ok) {
      const value = payload as { error?: string | { message?: string; code?: string }; message?: string } | null;
      const nested = typeof value?.error === 'object' ? value.error : undefined;
      const message = (nested?.message ?? value?.message ?? (typeof value?.error === 'string' ? value.error : '')) || `Studio API 請求失敗（HTTP ${response.status}）`;
      throw new StudioApiError(message, response.status, nested?.code);
    }
    return payload as T;
  }

  async listProjects(signal?: AbortSignal): Promise<ProjectChoice[]> {
    const payload = await this.request<ProjectListResponse>('/projects', { signal });
    return Array.isArray(payload.projects) ? payload.projects : [];
  }

  getDashboard(signal?: AbortSignal): Promise<DashboardSummary> {
    return this.request('/dashboard', { signal });
  }

  getProject(id: string, signal?: AbortSignal): Promise<ProjectResponse> {
    return this.request(`/projects/${encodeURIComponent(id)}`, { signal });
  }

  updateProject(project: Project, signal?: AbortSignal): Promise<ProjectResponse> {
    return this.request(`/projects/${encodeURIComponent(project.id)}`, { method: 'PUT', body: JSON.stringify(project), signal });
  }

  createProject(input: ProjectCreateInput, signal?: AbortSignal): Promise<ProjectResponse> {
    return this.request('/projects', { method: 'POST', body: JSON.stringify(input), signal });
  }

  createRun(projectId: string, input: { parameters?: Record<string, string | boolean>; stepId?: string; runMode?: string }, signal?: AbortSignal): Promise<RunResponse> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/runs`, { method: 'POST', body: JSON.stringify(input), signal });
  }

  getSettings(signal?: AbortSignal): Promise<SettingsResponse> {
    return this.request('/settings', { signal });
  }

  updateSettings(settings: StudioSettings, signal?: AbortSignal): Promise<SettingsResponse> {
    return this.request('/settings', { method: 'PUT', body: JSON.stringify(settings), signal });
  }

  cleanupExpiredDebug(signal?: AbortSignal): Promise<CleanupResponse> {
    return this.request('/settings/debug-cleanup', { method: 'POST', signal });
  }

  cleanupExpiredRunHistory(signal?: AbortSignal): Promise<CleanupResponse> {
    return this.request('/settings/run-history-cleanup', { method: 'POST', signal });
  }

  async exportProject(projectId: string, selection: ExportSelection, signal?: AbortSignal): Promise<Blob> {
    const response = await fetch(`${this.baseUrl}/projects/${encodeURIComponent(projectId)}/export`, {
      method: 'POST',
      headers: { accept: 'application/zip', 'content-type': 'application/json' },
      body: JSON.stringify(selection),
      signal
    });
    if (!response.ok) {
      const value = await response.json().catch(() => null) as { error?: string | { message?: string; code?: string }; message?: string } | null;
      const nested = typeof value?.error === 'object' ? value.error : undefined;
      const message = (nested?.message ?? value?.message ?? (typeof value?.error === 'string' ? value.error : '')) || `成果產生失敗（HTTP ${response.status}）`;
      throw new StudioApiError(message, response.status, nested?.code);
    }
    return response.blob();
  }
}

export const studioApi = new StudioRestClient();

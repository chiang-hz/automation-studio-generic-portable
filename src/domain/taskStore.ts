import type { DownloadTask } from "./types.ts";

export class TaskStore {
  private readonly tasks = new Map<string, DownloadTask>();

  create(task: DownloadTask): DownloadTask {
    this.tasks.set(task.id, task);
    return task;
  }

  get(taskId: string): DownloadTask | undefined {
    return this.tasks.get(taskId);
  }

  update(taskId: string, patch: Partial<DownloadTask>): DownloadTask | undefined {
    const current = this.tasks.get(taskId);
    if (!current) return undefined;

    const next: DownloadTask = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    this.tasks.set(taskId, next);
    return next;
  }
}

import type {AnalysisTask, TaskQueue} from './task-queue';

export class InlineQueue implements TaskQueue {
  readonly tasks: AnalysisTask[] = [];
  private readonly delivered = new Set<string>();
  constructor(private readonly handler?: (task: AnalysisTask) => Promise<void>) {}

  async enqueue(task: AnalysisTask) {
    if (this.delivered.has(task.jobId)) return;
    if (this.handler) await this.handler(task);
    this.delivered.add(task.jobId);
    this.tasks.push({...task});
  }
}

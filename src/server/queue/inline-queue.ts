import type {AnalysisTask, TaskQueue} from './task-queue';

export class InlineQueue implements TaskQueue {
  readonly tasks: AnalysisTask[] = [];
  constructor(private readonly handler?: (task: AnalysisTask) => Promise<void>) {}

  async enqueue(task: AnalysisTask) {
    this.tasks.push({...task});
    if (this.handler) await this.handler(task);
  }
}

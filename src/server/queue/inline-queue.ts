import type {QueuedTask, TaskQueue} from './task-queue';

export class InlineQueue implements TaskQueue {
  readonly tasks: QueuedTask[] = [];
  private readonly delivered = new Set<string>();
  constructor(private readonly handler?: (task: QueuedTask) => Promise<void>) {}

  async enqueue(task: QueuedTask) {
    const id = task.type === 'analyze_collection' ? task.jobId : `${task.type}:${task.providerRunId}${task.type === 'cleanup_provider_artifact' ? `:${task.providerArtifactId}` : ''}`;
    if (this.delivered.has(id)) return;
    if (this.handler) await this.handler(task);
    this.delivered.add(id);
    this.tasks.push({...task});
  }
}

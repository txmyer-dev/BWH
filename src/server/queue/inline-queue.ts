import {createHash} from 'node:crypto';

import type {QueuedTask, TaskQueue} from './task-queue';

export class InlineQueue implements TaskQueue {
  readonly tasks: QueuedTask[] = [];
  private readonly delivered = new Set<string>();
  constructor(private readonly handler?: (task: QueuedTask) => Promise<void>) {}

  async enqueue(task: QueuedTask) {
    const id = task.type === 'analyze_collection' ? task.jobId : task.type === 'execute_provider_run' ? `${task.type}:${task.providerRunId}` : `${task.type}:${createHash('sha256').update(task.provider).update('\0').update(task.providerArtifactId).digest('hex')}`;
    if (this.delivered.has(id)) return;
    if (this.handler) await this.handler(task);
    this.delivered.add(id);
    this.tasks.push({...task});
  }
}

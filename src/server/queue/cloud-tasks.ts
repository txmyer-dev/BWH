import {createHash} from 'node:crypto';

import type {QueuedTask, TaskQueue} from './task-queue';

interface CloudTasksClientLike {
  createTask(request: {parent: string; task: {name: string; httpRequest: {httpMethod: 'POST'; url: string; headers: Record<string, string>; body: string; oidcToken: {serviceAccountEmail: string; audience: string}}}}): Promise<unknown>;
}

export interface CloudTasksConfig {
  queuePath: string;
  targetUrl: string;
  audience: string;
  serviceAccountEmail: string;
}

export class CloudTasksQueue implements TaskQueue {
  constructor(private readonly client: CloudTasksClientLike, private readonly config: CloudTasksConfig) {}

  async enqueue(task: QueuedTask) {
    const taskName = task.type === 'analyze_collection' || task.type === 'transcribe_asset'
      ? `analysis-${task.jobId}`
      : task.type === 'execute_provider_run'
        ? `provider-${task.type}-${task.providerRunId}`
        : `provider-${task.type}-${createHash('sha256').update(task.provider).update('\0').update(task.providerArtifactId).digest('hex').slice(0, 32)}`;
    try {
      await this.client.createTask({
        parent: this.config.queuePath,
        task: {
          name: `${this.config.queuePath}/tasks/${taskName}`,
          httpRequest: {
            httpMethod: 'POST', url: this.config.targetUrl,
            headers: {'Content-Type': 'application/json'},
            body: Buffer.from(JSON.stringify(task)).toString('base64'),
            oidcToken: {serviceAccountEmail: this.config.serviceAccountEmail, audience: this.config.audience}
          }
        }
      });
    } catch (error) {
      if ((error as {code?: number}).code === 6) return;
      throw error;
    }
  }
}

interface IdTokenTicket {getPayload(): {iss?: string; aud?: string | string[]; email?: string; email_verified?: boolean} | undefined;}
interface IdTokenVerifier {verifyIdToken(input: {idToken: string; audience: string}): Promise<IdTokenTicket>;}

export const verifyCloudTaskRequest = async (
  request: Request,
  verifier: IdTokenVerifier,
  config: Pick<CloudTasksConfig, 'audience' | 'serviceAccountEmail'>
) => {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) throw new Error('CLOUD_TASK_UNAUTHORIZED');
  try {
    const ticket = await verifier.verifyIdToken({idToken: authorization.slice(7), audience: config.audience});
    const payload = ticket.getPayload();
    const validIssuer = payload?.iss === 'https://accounts.google.com' || payload?.iss === 'accounts.google.com';
    const validAudience = payload?.aud === config.audience || (Array.isArray(payload?.aud) && payload.aud.includes(config.audience));
    if (!validIssuer || !validAudience || payload?.email !== config.serviceAccountEmail || payload.email_verified !== true) {
      throw new Error('CLOUD_TASK_UNAUTHORIZED');
    }
  } catch {
    throw new Error('CLOUD_TASK_UNAUTHORIZED');
  }
};

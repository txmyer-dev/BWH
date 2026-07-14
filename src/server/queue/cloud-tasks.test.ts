import {describe, expect, it, vi} from 'vitest';

import {CloudTasksQueue, verifyCloudTaskRequest} from './cloud-tasks';

describe('CloudTasksQueue', () => {
  it('creates an OIDC-authenticated task with a deterministic name', async () => {
    const createTask = vi.fn().mockResolvedValue([{}]);
    const queue = new CloudTasksQueue({createTask}, {
      queuePath: 'projects/p/locations/us/queues/analysis',
      targetUrl: 'https://service.example/api/internal/process-analysis',
      audience: 'https://service.example', serviceAccountEmail: 'tasks@p.iam.gserviceaccount.com'
    });
    const task = {type: 'analyze_collection' as const, projectId: crypto.randomUUID(), jobId: crypto.randomUUID()};
    await queue.enqueue(task);
    expect(createTask).toHaveBeenCalledWith({parent: expect.any(String), task: expect.objectContaining({
      name: expect.stringContaining(task.jobId), httpRequest: expect.objectContaining({
        url: expect.any(String), oidcToken: {audience: 'https://service.example', serviceAccountEmail: 'tasks@p.iam.gserviceaccount.com'}
      })
    })});
  });

  it('treats a duplicate deterministic Cloud Task as already enqueued', async () => {
    const createTask = vi.fn().mockRejectedValue({code: 6});
    const queue = new CloudTasksQueue({createTask}, {queuePath: 'queue', targetUrl: 'https://service.example/internal', audience: 'https://service.example', serviceAccountEmail: 'tasks@example.com'});
    await expect(queue.enqueue({type: 'analyze_collection', projectId: crypto.randomUUID(), jobId: crypto.randomUUID()})).resolves.toBeUndefined();
  });

  it('uses providerRunId for deterministic provider task names', async () => {
    const createTask = vi.fn().mockResolvedValue([{}]);
    const queue = new CloudTasksQueue({createTask}, {queuePath: 'queue', targetUrl: 'https://service.example/internal', audience: 'https://service.example', serviceAccountEmail: 'tasks@example.com'});
    const providerRunId = crypto.randomUUID();
    await queue.enqueue({type: 'execute_provider_run', projectId: crypto.randomUUID(), providerRunId});
    await queue.enqueue({type: 'cleanup_provider_artifact', projectId: crypto.randomUUID(), providerRunId: null, provider: 'google_gemini', providerArtifactId: 'files/artifact-one'});
    await queue.enqueue({type: 'cleanup_provider_artifact', projectId: crypto.randomUUID(), providerRunId: null, provider: 'google_gemini', providerArtifactId: 'files/artifact-two'});
    expect(createTask.mock.calls[0][0].task.name).toContain(providerRunId);
    expect(createTask.mock.calls[1][0].task.name).not.toContain('files/');
    expect(createTask.mock.calls[1][0].task.name).not.toContain('artifact-one');
    expect(createTask.mock.calls[0][0].task.name).not.toBe(createTask.mock.calls[1][0].task.name);
    expect(createTask.mock.calls[1][0].task.name).not.toBe(createTask.mock.calls[2][0].task.name);
  });

  it('uses provider plus artifact identifier as the safe cleanup identity domain', async () => {
    const createTask = vi.fn().mockResolvedValue([{}]); const queue = new CloudTasksQueue({createTask}, {queuePath: 'queue', targetUrl: 'https://service.example/internal', audience: 'https://service.example', serviceAccountEmail: 'tasks@example.com'});
    const base = {type: 'cleanup_provider_artifact' as const, projectId: crypto.randomUUID(), providerRunId: null, providerArtifactId: 'files/shared'};
    await queue.enqueue({...base, provider: 'google_gemini'}); await queue.enqueue({...base, provider: 'another_provider'});
    const names = createTask.mock.calls.map(([request]) => request.task.name); expect(new Set(names).size).toBe(2); expect(names.every((name) => !name.includes('files/') && !name.includes('shared'))).toBe(true);
  });

  it('uses the transcription job id as a deterministic safe queue identity', async () => {
    const createTask = vi.fn().mockResolvedValue([{}]);
    const queue = new CloudTasksQueue({createTask}, {queuePath: 'queue', targetUrl: 'https://service.example/internal', audience: 'https://service.example', serviceAccountEmail: 'tasks@example.com'});
    const task = {type: 'transcribe_asset' as const, projectId: crypto.randomUUID(), assetId: crypto.randomUUID(), jobId: crypto.randomUUID(), providerRunId: crypto.randomUUID()};
    await queue.enqueue(task);
    const name = createTask.mock.calls[0][0].task.name as string;
    expect(name).toContain(task.jobId);
    expect(name).not.toContain(task.assetId);
  });
});

describe('verifyCloudTaskRequest', () => {
  const config = {audience: 'https://service.example', serviceAccountEmail: 'tasks@p.iam.gserviceaccount.com'};
  it('verifies the bearer token audience, issuer, and service account', async () => {
    const verifyIdToken = vi.fn().mockResolvedValue({getPayload: () => ({aud: config.audience, iss: 'https://accounts.google.com', email: config.serviceAccountEmail, email_verified: true})});
    const request = new Request('https://service.example/internal', {headers: {authorization: 'Bearer signed-token', 'x-cloudtasks-taskname': 'caller-controlled'}});
    await expect(verifyCloudTaskRequest(request, {verifyIdToken}, config)).resolves.toBeUndefined();
    expect(verifyIdToken).toHaveBeenCalledWith({idToken: 'signed-token', audience: config.audience});
  });

  it('rejects a task header without verified OIDC and rejects wrong identities', async () => {
    const request = new Request('https://service.example/internal', {headers: {'x-cloudtasks-taskname': 'looks-real'}});
    await expect(verifyCloudTaskRequest(request, {verifyIdToken: vi.fn()}, config)).rejects.toThrow('CLOUD_TASK_UNAUTHORIZED');
    const wrong = {verifyIdToken: vi.fn().mockResolvedValue({getPayload: () => ({iss: 'https://evil.example', email: config.serviceAccountEmail, email_verified: true})})};
    await expect(verifyCloudTaskRequest(new Request('https://service.example/internal', {headers: {authorization: 'Bearer token'}}), wrong, config)).rejects.toThrow('CLOUD_TASK_UNAUTHORIZED');
  });
});

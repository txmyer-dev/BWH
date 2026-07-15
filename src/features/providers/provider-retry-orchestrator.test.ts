import {describe, expect, it, vi} from 'vitest';

import {InlineQueue} from '../../server/queue/inline-queue';
import {InMemoryTranscriptionRepository} from '../transcription/transcription-repository';
import {InMemoryProviderRunRepository} from './provider-run-repository';
import {ProviderRetryOrchestrator} from './provider-retry-orchestrator';
import {ProviderRunService} from './provider-run-service';

const prepare = async (operation: 'transcribe'|'compose_storyboard' = 'transcribe') => {
  let now = new Date('2026-07-14T12:00:00Z'); const projectId = crypto.randomUUID(); const assetId = crypto.randomUUID();
  const runs = new ProviderRunService(new InMemoryProviderRunRepository(() => now), {fingerprintSecret: 'secret', defaultBudgetMicros: 50_000, leaseMs: 10});
  const reserved = await runs.reserve({projectId, consentId: crypto.randomUUID(), consentSnapshotHash: 'snapshot', dataCategories: ['source_audio'], provider: operation === 'transcribe' ? 'deepgram' : 'google', model: operation === 'transcribe' ? 'nova-3' : 'gemini-3.1-flash-lite', operation, canonicalInput: {assetId}, estimatedCostMicros: 100, pricingVersion: 'v1'});
  const claim = await runs.claim(reserved.runId); await runs.beginDispatch(claim); now = new Date(now.getTime() + 11); await runs.reconcileExpired();
  const transcriptions = new InMemoryTranscriptionRepository(); const oldJob = await transcriptions.createJob(projectId, assetId, reserved.runId); const oldClaim = await transcriptions.claimJob(oldJob.id, projectId, assetId, reserved.runId, 1000, true); if (oldClaim.outcome === 'claimed') await transcriptions.markAmbiguousJob(oldJob.id, oldClaim.leaseToken);
  return {projectId, assetId, runs, transcriptions, oldJob, runId: reserved.runId};
};

describe('ProviderRetryOrchestrator', () => {
  it('authenticates before reading or mutating retry state', async () => {
    const runs = {get: vi.fn(), acknowledgeAndRetry: vi.fn()} as never; const transcriptions = {findJobByProviderRun: vi.fn()} as never;
    const service = new ProviderRetryOrchestrator(runs, transcriptions, undefined, async () => { throw new Error('PROJECT_FORBIDDEN'); });
    await expect(service.retry(crypto.randomUUID(), crypto.randomUUID())).rejects.toThrow('PROJECT_FORBIDDEN');
    expect((runs as {get: ReturnType<typeof vi.fn>}).get).not.toHaveBeenCalled();
  });

  it('one acknowledgement creates and queues one fresh exactly linked transcription job', async () => {
    const ctx = await prepare(); const queue = new InlineQueue(); const service = new ProviderRetryOrchestrator(ctx.runs, ctx.transcriptions, queue, async () => undefined);
    const result = await service.retry(ctx.projectId, ctx.runId);
    expect(result.run).toMatchObject({retryOfRunId: ctx.runId, status: 'reserved'}); expect(result.transcriptionJob?.id).not.toBe(ctx.oldJob.id);
    expect(result.transcriptionJob).toMatchObject({assetId: ctx.assetId, providerRunId: result.run.id, status: 'pending'});
    expect(queue.tasks).toEqual([{type: 'transcribe_asset', projectId: ctx.projectId, assetId: ctx.assetId, jobId: result.transcriptionJob!.id, providerRunId: result.run.id}]);
    expect(ctx.transcriptions.allJobs().find((job) => job.id === ctx.oldJob.id)?.status).toBe('provider_ambiguous');
  });

  it('retries the old acknowledgement idempotently after enqueue failure without another child or job', async () => {
    const ctx = await prepare(); const delivered: unknown[] = []; let fail = true; const queue = {enqueue: async (task: unknown) => { if (fail) { fail = false; throw new Error('down'); } delivered.push(task); }};
    const service = new ProviderRetryOrchestrator(ctx.runs, ctx.transcriptions, queue, async () => undefined);
    await expect(service.retry(ctx.projectId, ctx.runId)).rejects.toThrow('PROVIDER_RETRY_ENQUEUE_FAILED');
    expect(ctx.transcriptions.allJobs().find((job) => job.providerRunId !== ctx.runId)).toMatchObject({status: 'pending'});
    const recovered = await service.retry(ctx.projectId, ctx.runId); const children = (await ctx.runs.list(ctx.projectId)).filter((run) => run.retryOfRunId === ctx.runId);
    expect(children).toHaveLength(1); expect(ctx.transcriptions.allJobs().filter((job) => job.providerRunId === recovered.run.id)).toHaveLength(1); expect(delivered).toHaveLength(1);
  });

  it('validates the exact source job before acknowledging or reserving retry work', async () => {
    const ctx = await prepare(); const empty = new InMemoryTranscriptionRepository();
    const service = new ProviderRetryOrchestrator(ctx.runs, empty, new InlineQueue(), async () => undefined);
    await expect(service.retry(ctx.projectId, ctx.runId)).rejects.toThrow('TRANSCRIPTION_RETRY_SOURCE_INVALID');
    expect((await ctx.runs.get(ctx.runId))?.status).toBe('ambiguous');
    expect((await ctx.runs.list(ctx.projectId)).filter((run) => run.retryOfRunId === ctx.runId)).toHaveLength(0);
  });

  it('concurrent acknowledgements converge on one child and one fresh job', async () => {
    const ctx = await prepare(); const queue = new InlineQueue(); const service = new ProviderRetryOrchestrator(ctx.runs, ctx.transcriptions, queue, async () => undefined);
    const [left, right] = await Promise.all([service.retry(ctx.projectId, ctx.runId), service.retry(ctx.projectId, ctx.runId)]);
    expect(left.run.id).toBe(right.run.id); expect(left.transcriptionJob?.id).toBe(right.transcriptionJob?.id);
    expect((await ctx.runs.list(ctx.projectId)).filter((run) => run.retryOfRunId === ctx.runId)).toHaveLength(1);
  });

  it('preserves generic retry behavior for non-transcription operations without a queue', async () => {
    const ctx = await prepare('compose_storyboard'); const find = vi.spyOn(ctx.transcriptions, 'findJobByProviderRun');
    const result = await new ProviderRetryOrchestrator(ctx.runs, ctx.transcriptions, undefined, async () => undefined).retry(ctx.projectId, ctx.runId);
    expect(result.run.retryOfRunId).toBe(ctx.runId); expect(result.transcriptionJob).toBeUndefined(); expect(find).not.toHaveBeenCalled();
  });
});

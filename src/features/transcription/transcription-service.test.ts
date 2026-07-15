import {randomUUID} from 'node:crypto';
import {describe, expect, it} from 'vitest';

import {InMemoryEvidenceRepository} from '../evidence/evidence-repository';
import type {Asset, AssetRepository} from '../media/asset-service';
import {MemoryStorage} from '../media/memory-storage';
import type {ProviderExecutionInput, ProviderExecutor} from '../providers/types';
import {InMemoryTranscriptionRepository, TranscriptionService, deepgramTranscriptionPricing, nova3PrerecordedCostMicros} from './transcription-service';
import {InlineQueue} from '../../server/queue/inline-queue';
import {providerRuns} from '../../server/db/schema';

const projectId = randomUUID();
const asset = (kind: Asset['kind'] = 'source_audio'): Asset => ({
  id: randomUUID(), projectId, kind, originalName: 'memory.wav', mimeType: 'audio/wav',
  originalObjectKey: `projects/${projectId}/originals/memory.wav`, processingStatus: 'ready',
  reservationExpiresAt: null, size: 4, caption: null, capturedAtText: null,
  knownPeople: [], sequenceOrder: 0, transcript: null, durationMs: 1000
});

const setup = (source = asset(), options: {prepareError?: string; queue?: InlineQueue; executionError?: string} = {}) => {
  const assets: AssetRepository = {
    listByProject: async () => [source], findById: async (id) => id === source.id ? source : undefined,
    reservePending: async () => { throw new Error('unused'); }, finishCleanup: async () => undefined,
    complete: async () => { throw new Error('unused'); }
  };
  const storage = new MemoryStorage(); storage.upload(source.originalObjectKey, 4, source.mimeType, 'wave');
  const evidence = new InMemoryEvidenceRepository();
  const repository = new InMemoryTranscriptionRepository(evidence);
  const calls: Array<Record<string, unknown>> = [];
  const releasedRuns: string[] = [];
  const usages: unknown[] = [];
  let runId = randomUUID(); let executions = 0;
  let status: 'reserved'|'processing'|'dispatching'|'completed'|'failed'|'ambiguous' = 'reserved';
  const run = async <T>(input: ProviderExecutionInput<T>) => {
    calls.push(input as unknown as Record<string, unknown>); if (options.executionError) { status = options.executionError === 'ambiguous' ? 'ambiguous' : options.executionError === 'in_flight' ? 'processing' : options.executionError === 'consent_changed' ? 'reserved' : 'failed'; throw new Error(options.executionError === 'consent_changed' ? 'PROVIDER_PREPARED_CONSENT_CHANGED' : 'provider'); }
    if (executions++ > 0) return {runId, cacheHit: true, result: await input.loadResult(runId)};
    const dispatched = await input.dispatch({runId, providerIdempotencyKey: 'safe-id', signal: new AbortController().signal});
    usages.push(dispatched.usage);
    await input.persistResult({writeStructured: async (write) => write({} as never)}, {runId, leaseToken: randomUUID(), consentId: randomUUID(), dispatchDeadlineAt: new Date(Date.now() + 1000)}, dispatched.result);
    status = 'completed'; return {runId, cacheHit: false, result: dispatched.result};
  };
  const executor: ProviderExecutor = {
    prepare: async (input) => { calls.push(input as unknown as Record<string, unknown>); if (options.prepareError) throw new Error(options.prepareError); return {runId, cacheHit: status === 'completed'}; },
    releasePrepared: async (id) => { releasedRuns.push(id); return true; },
    execute: run,
    executePrepared: async (input) => run(input),
    getRunStatus: async () => status
  };
  let providerCalls = 0;
  const transcriber = {transcribe: async ({bytes}: {bytes: Uint8Array; mimeType: string}) => {
    providerCalls++; expect(Buffer.from(bytes).toString()).toBe('wave');
    return {text: 'We took the train.', language: 'en', confidence: 0.8, durationMs: 1000,
      segments: [{startMs: 0, endMs: 1000, text: 'We took the train.', speaker: 0}]};
  }};
  const queue = options.queue ?? new InlineQueue();
  return {service: new TranscriptionService(assets, storage, executor, transcriber, repository, evidence, queue, async () => undefined, 'nova-3'), repository, evidence, queue, calls, usages, releasedRuns, providerCalls: () => providerCalls, get runId() { return runId; }, setStatus: (next: typeof status) => { status = next; }, rotateRun: () => { runId = randomUUID(); status = 'reserved'; return runId; }};
};

describe('TranscriptionService', () => {
  it('prices prerecorded Nova-3 per exact duration with conservative ceiling', () => {
    expect(nova3PrerecordedCostMicros(1)).toBe(1);
    expect(nova3PrerecordedCostMicros(60_000)).toBe(7_700);
  });
  it('uses a truthful pricing identifier that fits the persisted varchar(40) boundary and fails closed on unknown models', () => {
    expect(deepgramTranscriptionPricing('nova-3').pricingVersion.length).toBeLessThanOrEqual(40);
    expect(providerRuns.pricingVersion.getSQLType()).toBe('varchar(40)');
    expect(() => deepgramTranscriptionPricing('nova-future')).toThrow('DEEPGRAM_TRANSCRIPTION_MODEL_UNPRICED');
  });
  it('routes bounded private bytes only within ProviderExecutor dispatch with canonical metadata', async () => {
    const source = asset(); const ctx = setup(source);
    await ctx.service.process({projectId, assetId: source.id});
    expect(ctx.calls[0]).toMatchObject({provider: 'deepgram', model: 'nova-3', operation: 'transcribe', dataCategories: ['source_audio'], estimatedCostMicros: 129});
    expect(ctx.calls[0]?.canonicalInput).toEqual({assetId: source.id, mimeType: source.mimeType, size: source.size, durationMs: 1000});
    expect(JSON.stringify(ctx.calls[0]?.canonicalInput)).not.toContain('wave');
    expect(ctx.usages[0]).toEqual({actualCostMicros: 129, requestCount: 1, metadata: {durationMs: 1000, model: 'nova-3', pricingVersion: 'dg-n3-pre-en-payg-20260714'}});
  });

  it('persists proposed transcript evidence and never confirms it automatically', async () => {
    const source = asset(); const ctx = setup(source);
    const transcript = await ctx.service.process({projectId, assetId: source.id});
    expect(transcript.assetId).toBe(source.id);
    const items = await ctx.evidence.listByProject(projectId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({kind: 'transcript', verificationStatus: 'proposed', sourceAssetIds: [source.id]});
    await expect(ctx.evidence.findTranscriptSegment(projectId, items[0].id)).resolves.toEqual({assetId: source.id, startMs: 0, endMs: 1000});
  });

  it('discloses creator narration under its exact consent category', async () => {
    const source = asset('creator_narration'); const ctx = setup(source);
    await ctx.service.process({projectId, assetId: source.id});
    expect(ctx.calls[0]).toMatchObject({dataCategories: ['creator_narration']});
  });

  it('loads a project-scoped durable cache result without a second provider call', async () => {
    const source = asset(); const ctx = setup(source);
    await ctx.service.process({projectId, assetId: source.id});
    await ctx.service.process({projectId, assetId: source.id});
    expect(ctx.providerCalls()).toBe(1);
  });

  it('supports creator-provided proposed evidence after terminal failure without calling Deepgram', async () => {
    const source = asset('creator_narration'); const ctx = setup(source);
    ctx.repository.recordTerminalFailure(projectId, source.id);
    const item = await ctx.service.addCreatorTranscript({projectId, assetId: source.id, text: 'This is my own account.'});
    expect(ctx.providerCalls()).toBe(0);
    expect(item).toMatchObject({kind: 'transcript', verificationStatus: 'proposed', sourceAssetIds: [source.id], sourceExcerpt: 'Creator-provided transcript: This is my own account.'});
  });

  it('enables manual fallback only after the linked provider run is safely failed', async () => {
    const source = asset(); const ctx = setup(source, {executionError: 'failed'}); await ctx.service.request(projectId, source.id);
    await expect(ctx.service.processTask(ctx.queue.tasks[0] as never)).rejects.toThrow('TRANSCRIPTION_FAILED');
    await expect(ctx.service.addCreatorTranscript({projectId, assetId: source.id, text: 'Creator account.'})).resolves.toMatchObject({verificationStatus: 'proposed'});
  });

  it('authorizes and enqueues one deterministic transcription job for a ready audio asset', async () => {
    const source = asset(); const ctx = setup(source);
    const requested = await ctx.service.request(projectId, source.id);
    expect(requested.status).toBe('pending');
    expect(ctx.queue.tasks).toEqual([{type: 'transcribe_asset', projectId, assetId: source.id, jobId: requested.id, providerRunId: ctx.runId}]);
    expect((await ctx.service.request(projectId, source.id)).id).toBe(requested.id);
  });

  it.each(['PROCESSING_CONSENT_REQUIRED', 'PROJECT_PROVIDER_BUDGET_EXCEEDED'])('creates no job or queue side effect when preparation fails with %s', async (code) => {
    const source = asset(); const ctx = setup(source, {prepareError: code});
    await expect(ctx.service.request(projectId, source.id)).rejects.toThrow(code);
    expect(ctx.repository.allJobs()).toHaveLength(0); expect(ctx.queue.tasks).toHaveLength(0);
  });

  it('leaves an exactly linked pending job and reservation recoverable when enqueue fails', async () => {
    const source = asset(); const queue = new InlineQueue(async () => { throw new Error('queue down'); }); const ctx = setup(source, {queue});
    await expect(ctx.service.request(projectId, source.id)).rejects.toThrow('TRANSCRIPTION_ENQUEUE_FAILED');
    expect(ctx.repository.allJobs()).toEqual([expect.objectContaining({assetId: source.id, providerRunId: ctx.runId, status: 'pending'})]);
  });

  it('releases a newly prepared reservation when project job capacity prevents linking it', async () => {
    const source = asset(); const ctx = setup(source);
    await ctx.repository.createJob(projectId, randomUUID(), randomUUID());
    await expect(ctx.service.request(projectId, source.id)).rejects.toThrow('PROJECT_TRANSCRIPTION_BUSY');
    expect(ctx.releasedRuns).toEqual([ctx.runId]);
    expect(ctx.queue.tasks).toHaveLength(0);
  });

  it('creates a fresh pending job only for a different explicitly prepared retry run', async () => {
    const repository = new InMemoryTranscriptionRepository(); const oldRun = randomUUID(); const retryRun = randomUUID(); const sourceId = randomUUID();
    const job = await repository.createJob(projectId, sourceId, oldRun);
    const claim = await repository.claimJob(job.id, projectId, sourceId, oldRun, 1000, true);
    if (claim.outcome !== 'claimed') throw new Error('test setup failed');
    await repository.markAmbiguousJob(job.id, claim.leaseToken);
    const retry = await repository.createJob(projectId, sourceId, retryRun);
    const repeated = await repository.createJob(projectId, sourceId, retryRun);
    expect(retry).toMatchObject({providerRunId: retryRun, status: 'pending'});
    expect(retry.id).not.toBe(job.id);
    expect(repeated.id).toBe(retry.id);
    expect(repository.allJobs()).toEqual(expect.arrayContaining([
      expect.objectContaining({id: job.id, providerRunId: oldRun, status: 'provider_ambiguous'}),
      expect.objectContaining({id: retry.id, providerRunId: retryRun, status: 'pending'})
    ]));
  });

  it('does not terminally fail or enable fallback for an ambiguous provider run', async () => {
    const source = asset(); const ctx = setup(source, {executionError: 'ambiguous'}); const requested = await ctx.service.request(projectId, source.id); const task = ctx.queue.tasks[0];
    await expect(ctx.service.processTask(task as never)).resolves.toBe('ambiguous');
    expect(ctx.repository.allJobs()[0].status).toBe('provider_ambiguous');
    await expect(ctx.service.addCreatorTranscript({projectId, assetId: source.id, text: 'manual'})).rejects.toThrow('CREATOR_TRANSCRIPT_FALLBACK_NOT_AVAILABLE');
    expect(requested.providerRunId).toBe(ctx.runId);
  });

  it('keeps a not-claimable in-flight provider run non-terminal', async () => {
    const source = asset(); const ctx = setup(source, {executionError: 'in_flight'}); await ctx.service.request(projectId, source.id);
    await expect(ctx.service.processTask(ctx.queue.tasks[0] as never)).resolves.toBe('in_flight');
    expect(ctx.repository.allJobs()[0].status).toBe('processing');
    await expect(ctx.service.addCreatorTranscript({projectId, assetId: source.id, text: 'manual'})).rejects.toThrow('CREATOR_TRANSCRIPT_FALLBACK_NOT_AVAILABLE');
  });

  it('converges a stale processing job to failed when its provider run already failed without another provider call', async () => {
    const source = asset(); const ctx = setup(source); const job = await ctx.service.request(projectId, source.id);
    await ctx.repository.claimJob(job.id, projectId, source.id, ctx.runId, 1, true); ctx.repository.expireJobForTest(job.id); ctx.setStatus('failed');
    await expect(ctx.service.processTask(ctx.queue.tasks[0] as never)).rejects.toThrow('TRANSCRIPTION_FAILED');
    expect(ctx.providerCalls()).toBe(0); expect(ctx.repository.allJobs()[0].status).toBe('failed');
  });

  it('retires untouched old-consent work without enabling fallback and lets renewed consent create fresh work', async () => {
    const source = asset(); const ctx = setup(source, {executionError: 'consent_changed'}); const old = await ctx.service.request(projectId, source.id);
    await expect(ctx.service.processTask(ctx.queue.tasks[0] as never)).resolves.toBe('retired_consent');
    expect(ctx.repository.allJobs()[0]).toMatchObject({id: old.id, providerRunId: old.providerRunId, status: 'retired_consent'});
    await expect(ctx.service.addCreatorTranscript({projectId, assetId: source.id, text: 'manual'})).rejects.toThrow('CREATOR_TRANSCRIPT_FALLBACK_NOT_AVAILABLE');
    await expect(ctx.service.processTask(ctx.queue.tasks[0] as never)).resolves.toBe('retired');
    const freshRunId = ctx.rotateRun(); const fresh = await ctx.service.request(projectId, source.id);
    expect(fresh).toMatchObject({providerRunId: freshRunId, status: 'pending'}); expect(fresh.id).not.toBe(old.id);
  });

  it('recovers a stale pre-dispatch job only while its exact provider run is safe', async () => {
    const source = asset(); const ctx = setup(source); const job = await ctx.service.request(projectId, source.id);
    await ctx.repository.claimJob(job.id, projectId, source.id, ctx.runId, 1, true); ctx.repository.expireJobForTest(job.id); ctx.setStatus('reserved');
    await expect(ctx.service.processTask(ctx.queue.tasks[0] as never)).resolves.toBe('completed');
  });

  it('never reclaims a stale job while the linked provider dispatch is long-running', async () => {
    const source = asset(); const ctx = setup(source); const job = await ctx.service.request(projectId, source.id);
    await ctx.repository.claimJob(job.id, projectId, source.id, ctx.runId, 1, true); ctx.repository.expireJobForTest(job.id); ctx.setStatus('dispatching');
    await expect(ctx.service.processTask(ctx.queue.tasks[0] as never)).resolves.toBe('busy');
    expect(ctx.providerCalls()).toBe(0);
  });

  it('recovers a stale job after its exact provider run durably completed', async () => {
    const source = asset(); const ctx = setup(source); const job = await ctx.service.request(projectId, source.id);
    await ctx.service.process({projectId, assetId: source.id, providerRunId: ctx.runId});
    await ctx.repository.claimJob(job.id, projectId, source.id, ctx.runId, 1, true); ctx.repository.expireJobForTest(job.id);
    await expect(ctx.service.processTask(ctx.queue.tasks[0] as never)).resolves.toBe('completed');
    expect(ctx.providerCalls()).toBe(1);
  });

  it.each(['image', 'text'] as const)('rejects non-audio asset kind %s', async (kind) => {
    const source = asset(kind); const ctx = setup(source);
    await expect(ctx.service.process({projectId, assetId: source.id})).rejects.toThrow('AUDIO_ASSET_NOT_READY');
  });
});

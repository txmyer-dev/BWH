import {randomUUID} from 'node:crypto';
import {describe, expect, it} from 'vitest';

import {InMemoryEvidenceRepository} from '../evidence/evidence-repository';
import type {Asset, AssetRepository} from '../media/asset-service';
import {MemoryStorage} from '../media/memory-storage';
import type {ProviderExecutor} from '../providers/types';
import {InMemoryTranscriptionRepository, TranscriptionService, nova3PrerecordedCostMicros} from './transcription-service';
import {InlineQueue} from '../../server/queue/inline-queue';

const projectId = randomUUID();
const asset = (kind: Asset['kind'] = 'source_audio'): Asset => ({
  id: randomUUID(), projectId, kind, originalName: 'memory.wav', mimeType: 'audio/wav',
  originalObjectKey: `projects/${projectId}/originals/memory.wav`, processingStatus: 'ready',
  reservationExpiresAt: null, size: 4, caption: null, capturedAtText: null,
  knownPeople: [], sequenceOrder: 0, transcript: null, durationMs: 1000
});

const setup = (source = asset()) => {
  const assets: AssetRepository = {
    listByProject: async () => [source], findById: async (id) => id === source.id ? source : undefined,
    reservePending: async () => { throw new Error('unused'); }, finishCleanup: async () => undefined,
    complete: async () => { throw new Error('unused'); }
  };
  const storage = new MemoryStorage(); storage.upload(source.originalObjectKey, 4, source.mimeType, 'wave');
  const evidence = new InMemoryEvidenceRepository();
  const repository = new InMemoryTranscriptionRepository(evidence);
  const calls: Array<Record<string, unknown>> = [];
  const usages: unknown[] = [];
  const runId = randomUUID(); let executions = 0;
  const executor: ProviderExecutor = {execute: async (input) => {
    calls.push(input as unknown as Record<string, unknown>);
    if (executions++ > 0) return {runId, cacheHit: true, result: await input.loadResult(runId)};
    const dispatched = await input.dispatch({runId, providerIdempotencyKey: 'safe-id', signal: new AbortController().signal});
    usages.push(dispatched.usage);
    await input.persistResult({writeStructured: async (write) => write({} as never)}, {runId, leaseToken: randomUUID(), consentId: randomUUID(), dispatchDeadlineAt: new Date(Date.now() + 1000)}, dispatched.result);
    return {runId, cacheHit: false, result: dispatched.result};
  }};
  let providerCalls = 0;
  const transcriber = {transcribe: async ({bytes}: {bytes: Uint8Array; mimeType: string}) => {
    providerCalls++; expect(Buffer.from(bytes).toString()).toBe('wave');
    return {text: 'We took the train.', language: 'en', confidence: 0.8, durationMs: 1000,
      segments: [{startMs: 0, endMs: 1000, text: 'We took the train.', speaker: 0}]};
  }};
  const queue = new InlineQueue();
  return {service: new TranscriptionService(assets, storage, executor, transcriber, repository, evidence, queue, async () => undefined), repository, evidence, queue, calls, usages, providerCalls: () => providerCalls};
};

describe('TranscriptionService', () => {
  it('prices prerecorded Nova-3 per exact duration with conservative ceiling', () => {
    expect(nova3PrerecordedCostMicros(1)).toBe(1);
    expect(nova3PrerecordedCostMicros(60_000)).toBe(7_700);
  });
  it('routes bounded private bytes only within ProviderExecutor dispatch with canonical metadata', async () => {
    const source = asset(); const ctx = setup(source);
    await ctx.service.process({projectId, assetId: source.id});
    expect(ctx.calls[0]).toMatchObject({provider: 'deepgram', model: 'nova-3', operation: 'transcribe', dataCategories: ['source_audio'], estimatedCostMicros: 129});
    expect(ctx.calls[0]?.canonicalInput).toEqual({assetId: source.id, mimeType: source.mimeType, size: source.size, durationMs: 1000});
    expect(JSON.stringify(ctx.calls[0]?.canonicalInput)).not.toContain('wave');
    expect(ctx.usages[0]).toEqual({actualCostMicros: 129, requestCount: 1, metadata: {durationMs: 1000, model: 'nova-3', pricingVersion: 'deepgram-nova-3-monolingual-prerecorded-payg-2026-07-14'}});
  });

  it('persists proposed transcript evidence and never confirms it automatically', async () => {
    const source = asset(); const ctx = setup(source);
    const transcript = await ctx.service.process({projectId, assetId: source.id});
    expect(transcript.assetId).toBe(source.id);
    const items = await ctx.evidence.listByProject(projectId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({kind: 'transcript', verificationStatus: 'proposed', sourceAssetIds: [source.id]});
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

  it('authorizes and enqueues one deterministic transcription job for a ready audio asset', async () => {
    const source = asset(); const ctx = setup(source);
    const requested = await ctx.service.request(projectId, source.id);
    expect(requested.status).toBe('pending');
    expect(ctx.queue.tasks).toEqual([{type: 'transcribe_asset', projectId, assetId: source.id, jobId: requested.id}]);
    expect((await ctx.service.request(projectId, source.id)).id).toBe(requested.id);
  });

  it.each(['image', 'text'] as const)('rejects non-audio asset kind %s', async (kind) => {
    const source = asset(kind); const ctx = setup(source);
    await expect(ctx.service.process({projectId, assetId: source.id})).rejects.toThrow('AUDIO_ASSET_NOT_READY');
  });
});

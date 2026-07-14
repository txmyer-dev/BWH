import {describe, expect, it, vi} from 'vitest';

import {InMemoryEvidenceRepository} from './evidence-repository';
import {EvidenceService} from './evidence-service';
import {InlineQueue} from '../../server/queue/inline-queue';
import type {TaskQueue} from '../../server/queue/task-queue';

const projectId = crypto.randomUUID();
const imageIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const candidate = {
  claim: 'Ruth is standing by a train.',
  kind: 'image_observation' as const,
  sourceAssetIds: [imageIds[0]],
  sourceExcerpt: 'Person beside train',
  confidence: 0.75,
  proposedStatus: 'proposed' as const
};

const analysis = {
  title: 'The Journey', theme: 'Travel', timeRange: '1950s', ordering: imageIds,
  evidenceCandidates: [candidate], hypotheses: [], rankedGaps: []
};

const setup = (authorized = true, queue: TaskQueue & {tasks?: unknown[]} = new InlineQueue(), now: () => Date = () => new Date('2026-07-14T12:00:00Z')) => {
  const repository = new InMemoryEvidenceRepository();
  const agent = {analyzeCollection: vi.fn().mockResolvedValue(analysis)};
  const assets = {listReadyAnalysisAssets: vi.fn().mockResolvedValue(imageIds.map((id) => ({id, kind: 'image' as const, imageBytes: 'data:image/jpeg;base64,YQ=='})))};
  const service = new EvidenceService(repository, queue, agent, assets, async () => {
    if (!authorized) throw new Error('PROJECT_FORBIDDEN');
  }, now);
  return {agent, assets, queue, repository, service};
};

describe('EvidenceService', () => {
  it('authorizes, requires three through seven ready images, and idempotently enqueues one analysis job', async () => {
    const {queue, service} = setup();
    const first = await service.requestAnalysis(projectId);
    const second = await service.requestAnalysis(projectId);
    expect(second).toEqual(first);
    expect(first.status).toBe('pending');
    expect(queue.tasks).toEqual([{type: 'analyze_collection', projectId, jobId: first.jobId}]);
  });

  it('recovers delivery when enqueue fails after job creation', async () => {
    const delivered: unknown[] = [];
    let fail = true;
    const queue: TaskQueue = {enqueue: async (task) => {
      if (fail) throw new Error('QUEUE_UNAVAILABLE');
      delivered.push(task);
    }};
    const context = setup(true, queue);
    await expect(context.service.requestAnalysis(projectId)).rejects.toThrow('QUEUE_UNAVAILABLE');
    fail = false;
    const recovered = await context.service.requestAnalysis(projectId);
    expect(delivered).toEqual([{type: 'analyze_collection', projectId, jobId: recovered.jobId}]);
  });

  it('rejects unauthorized requests before queueing', async () => {
    const {queue, service} = setup(false);
    await expect(service.requestAnalysis(projectId)).rejects.toThrow('PROJECT_FORBIDDEN');
    expect(queue.tasks).toHaveLength(0);
  });

  it('processes a job idempotently and persists only proposed evidence with provenance', async () => {
    const {agent, repository, service} = setup();
    const {jobId} = await service.requestAnalysis(projectId);
    await service.processAnalysis({projectId, jobId});
    await service.processAnalysis({projectId, jobId});
    expect(agent.analyzeCollection).toHaveBeenCalledTimes(1);
    const items = await repository.listByProject(projectId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({claim: candidate.claim, originalClaim: candidate.claim, verificationStatus: 'proposed', sourceAssetIds: [imageIds[0]]});
  });

  it('allows a failed task delivery to retry the same job without duplicate evidence', async () => {
    const context = setup();
    context.agent.analyzeCollection.mockRejectedValueOnce(new Error('TEMPORARY_PROVIDER_FAILURE')).mockResolvedValueOnce(analysis);
    const {jobId} = await context.service.requestAnalysis(projectId);
    await expect(context.service.processAnalysis({projectId, jobId})).rejects.toThrow('TEMPORARY_PROVIDER_FAILURE');
    await expect(context.service.processAnalysis({projectId, jobId})).resolves.toEqual(analysis);
    expect(await context.repository.listByProject(projectId)).toHaveLength(1);
  });

  it('retains a failed job for audit but creates and enqueues a fresh job on explicit retry', async () => {
    const context = setup();
    context.agent.analyzeCollection.mockRejectedValueOnce(new Error('PERMANENT_ANALYSIS_FAILURE'));
    const failed = await context.service.requestAnalysis(projectId);
    await expect(context.service.processAnalysis({projectId, jobId: failed.jobId})).rejects.toThrow('PERMANENT_ANALYSIS_FAILURE');

    const retried = await context.service.requestAnalysis(projectId);
    expect(retried.jobId).not.toBe(failed.jobId);
    expect(context.queue.tasks).toEqual([
      {type: 'analyze_collection', projectId, jobId: failed.jobId},
      {type: 'analyze_collection', projectId, jobId: retried.jobId}
    ]);
    expect(context.repository.allJobsForProject(projectId)).toEqual([
      expect.objectContaining({id: failed.jobId, status: 'failed'}),
      expect.objectContaining({id: retried.jobId, status: 'pending'})
    ]);
  });

  it('creates at most one fresh active job when failed-job retries race', async () => {
    const context = setup();
    context.agent.analyzeCollection.mockRejectedValueOnce(new Error('PERMANENT_ANALYSIS_FAILURE'));
    const failed = await context.service.requestAnalysis(projectId);
    await expect(context.service.processAnalysis({projectId, jobId: failed.jobId})).rejects.toThrow();

    const [left, right] = await Promise.all([
      context.service.requestAnalysis(projectId),
      context.service.requestAnalysis(projectId)
    ]);
    expect(left.jobId).toBe(right.jobId);
    expect(left.jobId).not.toBe(failed.jobId);
    expect(context.repository.allJobsForProject(projectId).filter((job) => ['pending', 'processing'].includes(job.status))).toHaveLength(1);
  });

  it('keeps completed delivery idempotent and starts a new job only on an explicit analysis request', async () => {
    const context = setup();
    const completed = await context.service.requestAnalysis(projectId);
    await context.service.processAnalysis({projectId, jobId: completed.jobId});
    await expect(context.service.processAnalysis({projectId, jobId: completed.jobId})).resolves.toBeUndefined();
    const next = await context.service.requestAnalysis(projectId);
    expect(next.jobId).not.toBe(completed.jobId);
    expect(context.repository.allJobsForProject(projectId)).toEqual([
      expect.objectContaining({id: completed.jobId, status: 'completed'}),
      expect.objectContaining({id: next.jobId, status: 'pending'})
    ]);
  });

  it('reclaims a crashed processing lease after timeout and excludes concurrent claims', async () => {
    let now = new Date('2026-07-14T12:00:00Z');
    const context = setup(true, new InlineQueue(), () => now);
    const {jobId} = await context.service.requestAnalysis(projectId);
    const crashed = await context.repository.claimAnalysisJob(jobId, projectId, now, 60_000);
    expect(crashed.outcome).toBe('claimed');
    await expect(context.service.processAnalysis({projectId, jobId})).rejects.toThrow('ANALYSIS_JOB_BUSY');
    now = new Date('2026-07-14T12:01:01Z');
    await expect(context.service.processAnalysis({projectId, jobId})).resolves.toEqual(analysis);
    expect(await context.repository.listByProject(projectId)).toHaveLength(1);
  });

  it('fences a stale worker after another delivery reclaims its expired lease', async () => {
    const context = setup();
    const {jobId} = await context.service.requestAnalysis(projectId);
    const first = await context.repository.claimAnalysisJob(jobId, projectId, new Date('2026-07-14T12:00:00Z'), 60_000);
    const second = await context.repository.claimAnalysisJob(jobId, projectId, new Date('2026-07-14T12:01:01Z'), 60_000);
    expect(first.outcome).toBe('claimed');
    expect(second.outcome).toBe('claimed');
    if (first.outcome !== 'claimed' || second.outcome !== 'claimed') throw new Error('CLAIM_SETUP_FAILED');
    await expect(context.repository.completeAnalysis(jobId, projectId, first.leaseToken, [candidate])).rejects.toThrow('ANALYSIS_LEASE_LOST');
    await context.repository.completeAnalysis(jobId, projectId, second.leaseToken, [candidate]);
    expect(await context.repository.listByProject(projectId)).toHaveLength(1);
  });

  it('allows only the creator to confirm, correct, or reject proposed evidence', async () => {
    const context = setup();
    const {jobId} = await context.service.requestAnalysis(projectId);
    await context.service.processAnalysis({projectId, jobId});
    const [item] = await context.repository.listByProject(projectId);

    const corrected = await context.service.confirmEvidence(item.id, 'Ruth is waiting beside a train.');
    expect(corrected).toMatchObject({verificationStatus: 'corrected', originalClaim: candidate.claim, claim: candidate.claim, correction: 'Ruth is waiting beside a train.'});
    await expect(context.service.confirmEvidence(item.id)).rejects.toThrow('EVIDENCE_ALREADY_REVIEWED');

    const unauthorized = setup(false);
    await unauthorized.repository.createProposed(projectId, [candidate]);
    const [other] = await unauthorized.repository.listByProject(projectId);
    await expect(unauthorized.service.confirmEvidence(other.id)).rejects.toThrow('PROJECT_FORBIDDEN');
  });

  it('never exposes proposed or rejected claims as facts', async () => {
    const context = setup();
    await context.repository.createProposed(projectId, [candidate, {...candidate, claim: 'Second claim'}]);
    const [first, second] = await context.repository.listByProject(projectId);
    await context.service.confirmEvidence(first.id);
    await context.service.rejectEvidence(second.id);
    const facts = await context.service.listVerifiedFacts(projectId);
    expect(facts).toEqual([expect.objectContaining({id: first.id, verificationStatus: 'confirmed'})]);
  });
});

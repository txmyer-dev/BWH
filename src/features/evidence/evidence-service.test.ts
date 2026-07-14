import {describe, expect, it, vi} from 'vitest';

import {InMemoryEvidenceRepository} from './evidence-repository';
import {EvidenceService} from './evidence-service';
import {InlineQueue} from '../../server/queue/inline-queue';

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

const setup = (authorized = true) => {
  const repository = new InMemoryEvidenceRepository();
  const queue = new InlineQueue();
  const agent = {analyzeCollection: vi.fn().mockResolvedValue(analysis)};
  const assets = {listReadyAnalysisAssets: vi.fn().mockResolvedValue(imageIds.map((id) => ({id, kind: 'image' as const, imageBytes: 'data:image/jpeg;base64,YQ=='})))};
  const service = new EvidenceService(repository, queue, agent, assets, async () => {
    if (!authorized) throw new Error('PROJECT_FORBIDDEN');
  });
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

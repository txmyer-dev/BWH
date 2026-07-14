import type {TaskQueue} from '../../server/queue/task-queue';
import type {AssetRepository} from '../media/asset-service';
import type {MediaStorage} from '../media/storage';
import type {AnalysisAsset} from '../story/schemas';
import type {StoryAgent} from '../story/story-agent';
import type {EvidenceRepository} from './evidence-repository';

export interface AnalysisAssetSource { listReadyAnalysisAssets(projectId: string): Promise<AnalysisAsset[]>; }

const isTerminalAnalysisFailure = (error: unknown) => {
  if (!(error instanceof Error)) return false;
  // Provider/network failures remain pending for Cloud Tasks redelivery.
  // Invalid inputs/output cannot succeed unchanged and are terminal until the
  // creator explicitly requests a fresh job after correcting the collection.
  return error.message.startsWith('PERMANENT_') || error.name === 'ZodError' || [
    'THREE_TO_SEVEN_READY_IMAGES_REQUIRED', 'INVALID_MODEL_OUTPUT',
    'UNKNOWN_EVIDENCE_SOURCE', 'INVALID_IMAGE_ORDERING', 'UNSAFE_IMAGE_SOURCE',
    'ANALYSIS_TEXT_TOO_LARGE'
  ].includes(error.message);
};

export class PrivateAnalysisAssetSource implements AnalysisAssetSource {
  constructor(private readonly repository: AssetRepository, private readonly storage: MediaStorage) {}

  async listReadyAnalysisAssets(projectId: string) {
    const ready = (await this.repository.listByProject(projectId))
      .filter((asset) => asset.processingStatus === 'ready')
      .sort((left, right) => {
        if (left.kind === 'image' && right.kind === 'image') return left.sequenceOrder - right.sequenceOrder;
        const rank = {image: 0, text: 1, source_audio: 2, creator_narration: 3};
        return rank[left.kind] - rank[right.kind];
      });
    const result: AnalysisAsset[] = [];
    for (const asset of ready) {
      if (asset.kind === 'image') {
        const bytes = await this.storage.readObject({objectKey: asset.originalObjectKey, maxBytes: 25 * 1024 * 1024});
        const context = [asset.caption, asset.capturedAtText && `Date: ${asset.capturedAtText}`, asset.knownPeople.length > 0 && `Known people: ${asset.knownPeople.join(', ')}`].filter(Boolean).join('\n');
        result.push({id: asset.id, kind: 'image', caption: context || undefined, imageBytes: `data:${asset.mimeType};base64,${bytes.toString('base64')}`});
      } else if (asset.kind === 'text') {
        if (asset.size > 50_000) throw new Error('ANALYSIS_TEXT_TOO_LARGE');
        const bytes = await this.storage.readObject({objectKey: asset.originalObjectKey, maxBytes: 50_000});
        result.push({id: asset.id, kind: 'text', text: bytes.toString('utf8')});
      } else if (asset.kind === 'source_audio' && asset.transcript) {
        if (Buffer.byteLength(asset.transcript, 'utf8') > 50_000) throw new Error('ANALYSIS_TEXT_TOO_LARGE');
        result.push({id: asset.id, kind: 'transcript', text: asset.transcript});
      }
    }
    return result;
  }
}

export class EvidenceService {
  constructor(
    private readonly repository: EvidenceRepository,
    private readonly queue: TaskQueue,
    private readonly agent: StoryAgent,
    private readonly assets: AnalysisAssetSource,
    private readonly assertCreator: (projectId: string) => Promise<void>,
    private readonly now: () => Date = () => new Date()
  ) {}

  async requestAnalysis(projectId: string): Promise<{jobId: string; status: string}> {
    await this.assertCreator(projectId);
    const current = await this.repository.findActiveAnalysisJob(projectId);
    if (current) {
      await this.queue.enqueue({type: 'analyze_collection', projectId, jobId: current.id});
      return {jobId: current.id, status: current.status};
    }
    const ready = await this.assets.listReadyAnalysisAssets(projectId);
    const imageCount = ready.filter((asset) => asset.kind === 'image').length;
    if (imageCount < 3 || imageCount > 7) throw new Error('THREE_TO_SEVEN_READY_IMAGES_REQUIRED');
    const job = await this.repository.createAnalysisJob(projectId);
    await this.queue.enqueue({type: 'analyze_collection', projectId, jobId: job.id});
    return {jobId: job.id, status: job.status};
  }

  async processAnalysis(input: {projectId: string; jobId: string}) {
    const claim = await this.repository.claimAnalysisJob(input.jobId, input.projectId, this.now(), 5 * 60 * 1_000);
    if (claim.outcome === 'completed' || claim.outcome === 'terminal') return;
    if (claim.outcome === 'busy') throw new Error('ANALYSIS_JOB_BUSY');
    if (claim.outcome === 'missing') throw new Error('ANALYSIS_JOB_NOT_FOUND');
    try {
      const assets = await this.assets.listReadyAnalysisAssets(input.projectId);
      const imageCount = assets.filter((asset) => asset.kind === 'image').length;
      if (imageCount < 3 || imageCount > 7) throw new Error('THREE_TO_SEVEN_READY_IMAGES_REQUIRED');
      const analysis = await this.agent.analyzeCollection({projectId: input.projectId, assets});
      await this.repository.completeAnalysis(input.jobId, input.projectId, claim.leaseToken, analysis.evidenceCandidates);
      return analysis;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ANALYSIS_FAILED';
      if (isTerminalAnalysisFailure(error)) {
        await this.repository.failAnalysis(input.jobId, claim.leaseToken, message);
      } else {
        await this.repository.retryAnalysis(input.jobId, claim.leaseToken, message);
      }
      throw error;
    }
  }

  async confirmEvidence(id: string, correction?: string) {
    const item = await this.repository.findById(id);
    if (!item) throw new Error('EVIDENCE_NOT_FOUND');
    await this.assertCreator(item.projectId);
    if (correction !== undefined) {
      const text = correction.trim();
      if (!text) throw new Error('CORRECTION_REQUIRED');
      return this.repository.review(id, 'corrected', text);
    }
    return this.repository.review(id, 'confirmed');
  }

  async rejectEvidence(id: string) {
    const item = await this.repository.findById(id);
    if (!item) throw new Error('EVIDENCE_NOT_FOUND');
    await this.assertCreator(item.projectId);
    return this.repository.review(id, 'rejected');
  }

  async listVerifiedFacts(projectId: string) {
    await this.assertCreator(projectId);
    return (await this.repository.listByProject(projectId)).filter((item) => item.verificationStatus === 'confirmed' || item.verificationStatus === 'corrected');
  }
}

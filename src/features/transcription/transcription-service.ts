import type {EvidenceRepository} from '../evidence/evidence-repository';
import type {EvidenceItem} from '../evidence/schemas';
import type {AssetRepository} from '../media/asset-service';
import type {MediaStorage} from '../media/storage';
import type {ProviderExecutor} from '../providers/types';
import {transcriptSchema, type Transcriber} from './transcriber';
import type {AssetTranscript, TranscriptionRepository} from './transcription-repository';
import type {TaskQueue, TranscriptionTask} from '../../server/queue/task-queue';

export {InMemoryTranscriptionRepository} from './transcription-repository';

const PRICE_MICROS_PER_MINUTE = 7_700; // Nova-3 monolingual pre-recorded PAYG: $0.0077/minute.
export const DEEPGRAM_NOVA3_PRICING_VERSION = 'deepgram-nova-3-monolingual-prerecorded-payg-2026-07-14';
export const nova3PrerecordedCostMicros = (durationMs: number) => Math.ceil(durationMs * PRICE_MICROS_PER_MINUTE / 60_000);
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;

export class TranscriptionService {
  constructor(
    private readonly assets: AssetRepository,
    private readonly storage: MediaStorage,
    private readonly executor: ProviderExecutor,
    private readonly transcriber: Transcriber,
    private readonly transcripts: TranscriptionRepository,
    private readonly evidence: EvidenceRepository,
    private readonly queue?: TaskQueue,
    private readonly assertCreator: (projectId: string) => Promise<void> = async () => undefined
  ) {}

  async request(projectId: string, assetId: string) {
    await this.assertCreator(projectId);
    const asset = await this.assets.findById(assetId);
    if (!asset || asset.projectId !== projectId || asset.processingStatus !== 'ready' || !['source_audio', 'creator_narration'].includes(asset.kind)) throw new Error('AUDIO_ASSET_NOT_READY');
    if (!this.queue) throw new Error('TRANSCRIPTION_QUEUE_REQUIRED');
    const job = await this.transcripts.createJob(projectId, assetId);
    await this.queue.enqueue({type: 'transcribe_asset', projectId, assetId, jobId: job.id});
    return job;
  }

  async processTask(task: TranscriptionTask) {
    const claim = await this.transcripts.claimJob(task.jobId, task.projectId, task.assetId, 60_000);
    if (claim.outcome !== 'claimed') return claim.outcome;
    try { await this.process({projectId: task.projectId, assetId: task.assetId}); await this.transcripts.completeJob(task.jobId, claim.leaseToken); return 'completed' as const; }
    catch { await this.transcripts.failJob(task.jobId, claim.leaseToken); throw new Error('TRANSCRIPTION_FAILED'); }
  }

  async process(input: {projectId: string; assetId: string}): Promise<AssetTranscript> {
    const asset = await this.assets.findById(input.assetId);
    if (!asset || asset.projectId !== input.projectId || asset.processingStatus !== 'ready' || !['source_audio', 'creator_narration'].includes(asset.kind)) {
      throw new Error('AUDIO_ASSET_NOT_READY');
    }
    const knownDurationMs = asset.durationMs ?? null;
    if (!knownDurationMs || !Number.isSafeInteger(knownDurationMs) || knownDurationMs <= 0) throw new Error('AUDIO_DURATION_REQUIRED');
    const dataCategory = asset.kind === 'creator_narration' ? 'creator_narration' : 'source_audio';
    const execution = await this.executor.execute({
      projectId: input.projectId, provider: 'deepgram', model: 'nova-3', operation: 'transcribe',
      dataCategories: [dataCategory],
      canonicalInput: {assetId: asset.id, mimeType: asset.mimeType, size: asset.size, durationMs: knownDurationMs},
      estimatedCostMicros: nova3PrerecordedCostMicros(knownDurationMs),
      pricingVersion: DEEPGRAM_NOVA3_PRICING_VERSION,
      dispatch: async ({signal}) => {
        const bytes = await this.storage.readObject({objectKey: asset.originalObjectKey, maxBytes: MAX_AUDIO_BYTES});
        const transcript = transcriptSchema.parse(await this.transcriber.transcribe({bytes, mimeType: asset.mimeType, signal}));
        if (transcript.segments.some((segment) => segment.endMs > knownDurationMs)) throw new Error('TRANSCRIPT_DURATION_MISMATCH');
        return {result: transcript, usage: {
          actualCostMicros: nova3PrerecordedCostMicros(transcript.durationMs), requestCount: 1,
          metadata: {durationMs: transcript.durationMs, model: 'nova-3', pricingVersion: DEEPGRAM_NOVA3_PRICING_VERSION}
        }};
      },
      loadResult: async (runId) => {
        const stored = await this.transcripts.findByProviderRun(input.projectId, runId);
        if (!stored || stored.assetId !== asset.id) throw new Error('TRANSCRIPT_RESULT_NOT_FOUND');
        transcriptSchema.parse({text: stored.text, language: stored.language, confidence: stored.confidence, durationMs: stored.durationMs, segments: stored.segments}); return stored;
      },
      persistResult: async (writer, claim, result) => {
        await this.transcripts.persistProviderResult({writer, projectId: input.projectId, assetId: asset.id, providerRunId: claim.runId, transcript: result});
      }
    });
    const stored = await this.transcripts.findByProviderRun(input.projectId, execution.runId);
    if (!stored) throw new Error('TRANSCRIPT_RESULT_NOT_FOUND');
    return stored;
  }

  async addCreatorTranscript(input: {projectId: string; assetId: string; text: string}): Promise<EvidenceItem> {
    await this.assertCreator(input.projectId);
    const asset = await this.assets.findById(input.assetId);
    if (!asset || asset.projectId !== input.projectId || asset.processingStatus !== 'ready' || !['source_audio', 'creator_narration'].includes(asset.kind)) throw new Error('AUDIO_ASSET_NOT_READY');
    if (!(await this.transcripts.hasTerminalFailure(input.projectId, input.assetId))) throw new Error('CREATOR_TRANSCRIPT_FALLBACK_NOT_AVAILABLE');
    const text = input.text.trim(); if (!text) throw new Error('CREATOR_TRANSCRIPT_REQUIRED');
    const [item] = await this.evidence.createProposed(input.projectId, [{
      claim: text, kind: 'transcript', sourceAssetIds: [asset.id], sourceExcerpt: `Creator-provided transcript: ${text}`,
      confidence: 1, proposedStatus: 'proposed'
    }]);
    if (!item) throw new Error('CREATOR_TRANSCRIPT_FAILED');
    return item;
  }
}

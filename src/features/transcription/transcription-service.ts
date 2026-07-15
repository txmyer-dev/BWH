import type {EvidenceRepository} from '../evidence/evidence-repository';
import type {EvidenceItem} from '../evidence/schemas';
import type {AssetRepository} from '../media/asset-service';
import type {MediaStorage} from '../media/storage';
import type {ProviderExecutionInput, ProviderExecutor} from '../providers/types';
import {transcriptSchema, type Transcript, type Transcriber} from './transcriber';
import type {AssetTranscript, TranscriptionJob, TranscriptionRepository} from './transcription-repository';
import type {TaskQueue, TranscriptionTask} from '../../server/queue/task-queue';

export {InMemoryTranscriptionRepository} from './transcription-repository';

export const deepgramTranscriptionPricing = (model: string) => {
  if (model !== 'nova-3') throw new Error('DEEPGRAM_TRANSCRIPTION_MODEL_UNPRICED');
  return {microsPerMinute: 7_700, pricingVersion: 'dg-n3-pre-en-payg-20260714'};
};
export const nova3PrerecordedCostMicros = (durationMs: number) => Math.ceil(durationMs * deepgramTranscriptionPricing('nova-3').microsPerMinute / 60_000);
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;

export class TranscriptionService {
  constructor(
    private readonly assets: AssetRepository,
    private readonly storage: MediaStorage,
    private readonly executor: ProviderExecutor,
    private readonly transcriber: Transcriber,
    private readonly transcripts: TranscriptionRepository,
    private readonly evidence: EvidenceRepository,
    private readonly queue: TaskQueue | undefined,
    private readonly assertCreator: (projectId: string) => Promise<void>,
    private readonly model: string
  ) { deepgramTranscriptionPricing(model); }

  private async providerInput(projectId: string, assetId: string) {
    const asset = await this.assets.findById(assetId);
    if (!asset || asset.projectId !== projectId || asset.processingStatus !== 'ready' || !['source_audio', 'creator_narration'].includes(asset.kind)) throw new Error('AUDIO_ASSET_NOT_READY');
    const durationMs = asset.durationMs ?? null; if (!durationMs || !Number.isSafeInteger(durationMs) || durationMs <= 0) throw new Error('AUDIO_DURATION_REQUIRED');
    const pricing = deepgramTranscriptionPricing(this.model);
    return {asset, metadata: {projectId, provider: 'deepgram', model: this.model, operation: 'transcribe' as const, dataCategories: [asset.kind === 'creator_narration' ? 'creator_narration' : 'source_audio'], canonicalInput: {assetId: asset.id, mimeType: asset.mimeType, size: asset.size, durationMs}, estimatedCostMicros: Math.ceil(durationMs * pricing.microsPerMinute / 60_000), pricingVersion: pricing.pricingVersion}};
  }

  async request(projectId: string, assetId: string) {
    await this.assertCreator(projectId);
    if (!this.queue) throw new Error('TRANSCRIPTION_QUEUE_REQUIRED');
    if (!this.executor.prepare) throw new Error('PROVIDER_PREPARE_REQUIRED');
    if (!this.executor.releasePrepared) throw new Error('PROVIDER_RESERVATION_RELEASE_REQUIRED');
    const {metadata} = await this.providerInput(projectId, assetId);
    const prepared = await this.executor.prepare(metadata);
    let job: TranscriptionJob;
    try { job = await this.transcripts.createJob(projectId, assetId, prepared.runId); }
    catch (error) {
      if (!prepared.cacheHit) await this.executor.releasePrepared(prepared.runId);
      throw error;
    }
    try { await this.queue.enqueue({type: 'transcribe_asset', projectId, assetId, jobId: job.id, providerRunId: prepared.runId}); }
    catch { throw new Error('TRANSCRIPTION_ENQUEUE_FAILED'); }
    return job;
  }

  async processTask(task: TranscriptionTask) {
    const providerStatus = await this.executor.getRunStatus?.(task.providerRunId);
    const allowStaleRecovery = providerStatus === 'reserved' || providerStatus === 'processing' || providerStatus === 'completed' || providerStatus === 'failed';
    const claim = await this.transcripts.claimJob(task.jobId, task.projectId, task.assetId, task.providerRunId, 60_000, allowStaleRecovery);
    if (claim.outcome !== 'claimed') return claim.outcome;
    if (providerStatus === 'failed') { await this.transcripts.failJob(task.jobId, claim.leaseToken); throw new Error('TRANSCRIPTION_FAILED'); }
    try { await this.process({projectId: task.projectId, assetId: task.assetId, providerRunId: task.providerRunId}); await this.transcripts.completeJob(task.jobId, claim.leaseToken); return 'completed' as const; }
    catch (error) {
      if (error instanceof Error && error.message === 'PROVIDER_PREPARED_CONSENT_CHANGED') { await this.transcripts.retireConsentChanged(task.jobId, task.projectId, task.providerRunId); return 'retired_consent' as const; }
      const status = await this.executor.getRunStatus?.(task.providerRunId);
      if (status === 'failed') { await this.transcripts.failJob(task.jobId, claim.leaseToken); throw new Error('TRANSCRIPTION_FAILED'); }
      if (status === 'ambiguous' || status === 'dispatching' || status === 'superseded_ambiguous') { await this.transcripts.markAmbiguousJob(task.jobId, claim.leaseToken); return 'ambiguous' as const; }
      return 'in_flight' as const;
    }
  }

  async process(input: {projectId: string; assetId: string; providerRunId?: string}): Promise<AssetTranscript> {
    const {asset, metadata} = await this.providerInput(input.projectId, input.assetId); const knownDurationMs = asset.durationMs!;
    const executionInput: ProviderExecutionInput<Transcript> = {
      ...metadata,
      dispatch: async ({signal}) => {
        const bytes = await this.storage.readObject({objectKey: asset.originalObjectKey, maxBytes: MAX_AUDIO_BYTES});
        const transcript = transcriptSchema.parse(await this.transcriber.transcribe({bytes, mimeType: asset.mimeType, signal}));
        if (transcript.segments.some((segment) => segment.endMs > knownDurationMs)) throw new Error('TRANSCRIPT_DURATION_MISMATCH');
        return {result: transcript, usage: {
          actualCostMicros: Math.ceil(transcript.durationMs * deepgramTranscriptionPricing(this.model).microsPerMinute / 60_000), requestCount: 1,
          metadata: {durationMs: transcript.durationMs, model: this.model, pricingVersion: deepgramTranscriptionPricing(this.model).pricingVersion}
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
    };
    const execution = input.providerRunId ? await (() => { if (!this.executor.executePrepared) throw new Error('PROVIDER_PREPARED_EXECUTION_REQUIRED'); return this.executor.executePrepared({...executionInput, preparedRunId: input.providerRunId}); })() : await this.executor.execute(executionInput);
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

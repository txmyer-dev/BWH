import type {TaskQueue} from '../../server/queue/task-queue';
import type {TranscriptionJob, TranscriptionRepository} from '../transcription/transcription-repository';
import type {ProviderRunService} from './provider-run-service';
import type {ProviderRun} from './types';

export type ProviderRetryResult = {run: ProviderRun; transcriptionJob?: TranscriptionJob};

export class ProviderRetryOrchestrator {
  constructor(
    private readonly runs: ProviderRunService,
    private readonly transcriptions: TranscriptionRepository,
    private readonly queue: TaskQueue | undefined,
    private readonly assertOwner: (projectId: string) => Promise<void>
  ) {}

  async retry(projectId: string, runId: string): Promise<ProviderRetryResult> {
    await this.assertOwner(projectId);
    const original = await this.runs.get(runId);
    if (!original || original.projectId !== projectId) throw new Error('PROVIDER_RUN_NOT_FOUND');
    if (original.operation !== 'transcribe') return {run: await this.runs.acknowledgeAndRetry(runId)};
    if (!this.queue) throw new Error('PROVIDER_RETRY_QUEUE_NOT_CONFIGURED');
    const source = await this.transcriptions.findJobByProviderRun(projectId, runId);
    if (!source || !['pending', 'processing', 'provider_ambiguous'].includes(source.status)) throw new Error('TRANSCRIPTION_RETRY_SOURCE_INVALID');
    const retry = await this.runs.acknowledgeAndRetry(runId);
    const job = await this.transcriptions.createRetryJob(projectId, runId, retry.id);
    try { await this.queue.enqueue({type: 'transcribe_asset', projectId, assetId: job.assetId, jobId: job.id, providerRunId: retry.id}); }
    catch { throw new Error('PROVIDER_RETRY_ENQUEUE_FAILED'); }
    return {run: retry, transcriptionJob: job};
  }
}

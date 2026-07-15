import type {ConsentService} from '../consent/consent-service';
import type {ProcessingProvider} from '../consent/schemas';
import type {ProviderExecutionInput, ProviderExecution, ProviderExecutor, ProviderPreparationInput, PreparedProviderExecutionInput} from './types';
import type {ProviderRunService} from './provider-run-service';

export class DefaultProviderExecutor implements ProviderExecutor {
  constructor(private readonly consents: ConsentService, private readonly runs: ProviderRunService) {}
  async prepare(input: ProviderPreparationInput) {
    const consent = await this.consents.assertProcessingConsent(input.projectId, input.provider as ProcessingProvider, input.dataCategories);
    return this.runs.reserve({...input, consentId: consent.id, consentSnapshotHash: consent.snapshotHash, dataCategories: input.dataCategories});
  }
  async releasePrepared(runId: string) { return this.runs.cancelReservation(runId); }
  async getRunStatus(runId: string) { return (await this.runs.get(runId))?.status; }
  async execute<T>(input: ProviderExecutionInput<T>): Promise<ProviderExecution<T>> {
    const prepared = await this.prepare(input);
    return this.executePrepared({...input, preparedRunId: prepared.runId});
  }
  async executePrepared<T>(input: PreparedProviderExecutionInput<T>): Promise<ProviderExecution<T>> {
    const existing = await this.runs.assertPrepared(input.preparedRunId, input);
    const dispatchConsent = await this.consents.assertProcessingConsent(input.projectId, input.provider as ProcessingProvider, input.dataCategories);
    if (dispatchConsent.id !== existing.consentId) throw new Error('PROVIDER_PREPARED_CONSENT_CHANGED');
    if (existing.status === 'completed') return {runId: existing.id, cacheHit: true, result: await input.loadResult(existing.id)};
    const claim = await this.runs.claim(existing.id);
    if (dispatchConsent.id !== claim.consentId) throw new Error('PROVIDER_PREPARED_CONSENT_CHANGED');
    await this.runs.beginDispatch(claim, async () => {
      const finalConsent = await this.consents.assertProcessingConsent(input.projectId, input.provider as ProcessingProvider, input.dataCategories);
      if (finalConsent.id !== claim.consentId) throw new Error('PROVIDER_PREPARED_CONSENT_CHANGED');
    });
    const controller = new AbortController();
    const heartbeat = setInterval(() => { void this.runs.heartbeat(claim).catch(() => controller.abort()); }, Math.max(1_000, Math.floor((claim.dispatchDeadlineAt.getTime() - Date.now()) / 2)));
    try {
      const dispatched = await input.dispatch({runId: claim.runId, providerIdempotencyKey: `provider-run-${claim.runId}`, signal: controller.signal});
      try {
        if (!dispatched.usage || !Number.isSafeInteger(dispatched.usage.actualCostMicros) || dispatched.usage.actualCostMicros < 0 || !Number.isSafeInteger(dispatched.usage.requestCount) || dispatched.usage.requestCount < 1) throw new Error('PROVIDER_USAGE_INVALID');
        await this.runs.completeWithResult(claim, dispatched.usage, (writer) => input.persistResult(writer, claim, dispatched.result));
      } catch (error) {
        await input.cleanupOrphanedResult?.(dispatched.result).catch(() => undefined);
        throw error;
      }
      return {runId: claim.runId, cacheHit: false, result: dispatched.result};
    } catch (error) {
      await this.runs.fail(claim, 'PROVIDER_DISPATCH_FAILED').catch(() => undefined);
      throw error;
    } finally { clearInterval(heartbeat); }
  }
}

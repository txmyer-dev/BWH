import type {ConsentService} from '../consent/consent-service';
import type {ProcessingProvider} from '../consent/schemas';
import type {ProviderExecutionInput, ProviderExecution, ProviderExecutor} from './types';
import type {ProviderRunService} from './provider-run-service';

export class DefaultProviderExecutor implements ProviderExecutor {
  constructor(private readonly consents: ConsentService, private readonly runs: ProviderRunService) {}
  async execute<T>(input: ProviderExecutionInput<T>): Promise<ProviderExecution<T>> {
    const consent = await this.consents.assertProcessingConsent(input.projectId, input.provider as ProcessingProvider, input.dataCategories);
    const reservation = await this.runs.reserve({...input, consentId: consent.id});
    if (reservation.cacheHit) return {runId: reservation.runId, cacheHit: true, result: await input.loadResult(reservation.runId)};
    const existing = await this.runs.get(reservation.runId);
    if (existing?.status === 'completed') return {runId: reservation.runId, cacheHit: true, result: await input.loadResult(reservation.runId)};
    const claim = await this.runs.claim(reservation.runId);
    const dispatchConsent = await this.consents.assertProcessingConsent(input.projectId, input.provider as ProcessingProvider, input.dataCategories);
    if (dispatchConsent.id !== claim.consentId) throw new Error('PROCESSING_CONSENT_REQUIRED');
    await this.runs.beginDispatch(claim, async () => {
      const finalConsent = await this.consents.assertProcessingConsent(input.projectId, input.provider as ProcessingProvider, input.dataCategories);
      if (finalConsent.id !== claim.consentId) throw new Error('PROCESSING_CONSENT_REQUIRED');
    });
    const controller = new AbortController();
    const heartbeat = setInterval(() => { void this.runs.heartbeat(claim).catch(() => controller.abort()); }, Math.max(1_000, Math.floor((claim.dispatchDeadlineAt.getTime() - Date.now()) / 2)));
    try {
      const result = await input.dispatch({runId: claim.runId, providerIdempotencyKey: `provider-run-${claim.runId}`, signal: controller.signal});
      await this.runs.completeWithResult(claim, input.estimatedCostMicros, () => input.persistResult(claim, result));
      return {runId: claim.runId, cacheHit: false, result};
    } catch (error) {
      await this.runs.fail(claim, 'PROVIDER_DISPATCH_FAILED').catch(() => undefined);
      throw error;
    } finally { clearInterval(heartbeat); }
  }
}

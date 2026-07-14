import {describe, expect, it, vi} from 'vitest';

import {InMemoryConsentRepository} from '../consent/consent-repository';
import {ConsentService} from '../consent/consent-service';
import {InMemoryProviderRunRepository} from './provider-run-repository';
import {DefaultProviderExecutor} from './provider-executor';
import {ProviderRunService} from './provider-run-service';

const makeHarness = async () => {
  const projectId = crypto.randomUUID();
  const consents = new InMemoryConsentRepository();
  const consent = new ConsentService(consents, async () => undefined);
  await consent.accept({projectId, purpose: 'processing', documentVersion: 'v1', providers: ['deepgram'], dataCategories: ['source_audio'], permissionConfirmed: true});
  const repository = new InMemoryProviderRunRepository();
  const runs = new ProviderRunService(repository, {fingerprintSecret: 'secret', defaultBudgetMicros: 50_000});
  return {projectId, consents, consent, runs, executor: new DefaultProviderExecutor(consent, runs)};
};

describe('ProviderExecutor', () => {
  it('rechecks consent before beginDispatch and never calls the provider when invalidated', async () => {
    const harness = await makeHarness();
    const dispatch = vi.fn();
    const originalClaim = harness.runs.claim.bind(harness.runs);
    vi.spyOn(harness.runs, 'claim').mockImplementation(async (id) => {
      const claim = await originalClaim(id);
      const valid = await harness.consents.findValid(harness.projectId, 'processing');
      await harness.consents.invalidate(valid!.id, new Date());
      return claim;
    });
    await expect(harness.executor.execute({projectId: harness.projectId, provider: 'deepgram', model: 'nova-3', operation: 'transcribe', dataCategories: ['source_audio'], canonicalInput: {audio: 'a'}, estimatedCostMicros: 100, pricingVersion: 'v1', dispatch, loadResult: vi.fn(), persistResult: vi.fn()}))
      .rejects.toThrow('PROCESSING_CONSENT_REQUIRED');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('persists a fenced result and serves cache hits without dispatch', async () => {
    const harness = await makeHarness();
    const stored = new Map<string, {text: string}>();
    const dispatch = vi.fn().mockResolvedValue({text: 'hello'});
    const input = {projectId: harness.projectId, provider: 'deepgram', model: 'nova-3', operation: 'transcribe' as const, dataCategories: ['source_audio'], canonicalInput: {audio: 'a'}, estimatedCostMicros: 100, pricingVersion: 'v1', dispatch, loadResult: async (id: string) => stored.get(id)!, persistResult: async (claim: {runId: string}, result: {text: string}) => { stored.set(claim.runId, result); }};
    const first = await harness.executor.execute(input);
    const second = await harness.executor.execute(input);
    expect(first.result).toEqual({text: 'hello'});
    expect(second).toMatchObject({runId: first.runId, cacheHit: true, result: {text: 'hello'}});
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch when beginDispatch cannot fence the claim', async () => {
    const harness = await makeHarness();
    const dispatch = vi.fn();
    vi.spyOn(harness.runs, 'beginDispatch').mockRejectedValue(new Error('PROVIDER_RUN_FENCED'));
    await expect(harness.executor.execute({projectId: harness.projectId, provider: 'deepgram', model: 'nova-3', operation: 'transcribe', dataCategories: ['source_audio'], canonicalInput: {audio: 'b'}, estimatedCostMicros: 100, pricingVersion: 'v1', dispatch, loadResult: vi.fn(), persistResult: vi.fn()})).rejects.toThrow('PROVIDER_RUN_FENCED');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('treats a dispatch error as ambiguous and never automatically calls again', async () => {
    const harness = await makeHarness();
    const dispatch = vi.fn().mockRejectedValue(new Error('connection reset'));
    const input = {projectId: harness.projectId, provider: 'deepgram', model: 'nova-3', operation: 'transcribe' as const, dataCategories: ['source_audio'], canonicalInput: {audio: 'uncertain'}, estimatedCostMicros: 100, pricingVersion: 'v1', dispatch, loadResult: vi.fn(), persistResult: vi.fn()};
    await expect(harness.executor.execute(input)).rejects.toThrow('connection reset');
    const [run] = await harness.runs.list(harness.projectId);
    expect(run.status).toBe('ambiguous');
    await expect(harness.executor.execute(input)).rejects.toThrow('PROVIDER_RUN_NOT_CLAIMABLE');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('rejects a replacement consent snapshot before provider I/O', async () => {
    const harness = await makeHarness(); const dispatch = vi.fn();
    const begin = harness.runs.beginDispatch.bind(harness.runs);
    vi.spyOn(harness.runs, 'beginDispatch').mockImplementation(async (claim, validateConsent) => {
      await harness.consent.accept({projectId: harness.projectId, purpose: 'processing', documentVersion: 'v2', providers: ['deepgram'], dataCategories: ['source_audio'], permissionConfirmed: true});
      await begin(claim, validateConsent);
    });
    await expect(harness.executor.execute({projectId: harness.projectId, provider: 'deepgram', model: 'nova-3', operation: 'transcribe', dataCategories: ['source_audio'], canonicalInput: {audio: 'replaced'}, estimatedCostMicros: 100, pricingVersion: 'v1', dispatch, loadResult: vi.fn(), persistResult: vi.fn()})).rejects.toThrow('PROCESSING_CONSENT_REQUIRED');
    expect(dispatch).not.toHaveBeenCalled();
  });
});

import {describe, expect, it, vi} from 'vitest';

import {InMemoryConsentRepository} from '../consent/consent-repository';
import {ConsentService} from '../consent/consent-service';
import {InMemoryProviderRunRepository} from './provider-run-repository';
import {DefaultProviderExecutor} from './provider-executor';
import {ProviderRunService} from './provider-run-service';
import type {ProviderResultWriter} from './types';

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
  it('prepares an exact consent-and-budget-bound run before deferred execution and rechecks consent', async () => {
    const harness = await makeHarness(); const dispatch = vi.fn();
    const metadata = {projectId: harness.projectId, provider: 'deepgram', model: 'nova-3', operation: 'transcribe' as const, dataCategories: ['source_audio'], canonicalInput: {assetId: crypto.randomUUID()}, estimatedCostMicros: 100, pricingVersion: 'dg-n3-pre-en-payg-20260714'};
    const prepared = await harness.executor.prepare(metadata);
    expect((await harness.runs.get(prepared.runId))?.status).toBe('reserved');
    const valid = await harness.consents.findValid(harness.projectId, 'processing'); await harness.consents.invalidate(valid!.id, new Date());
    await expect(harness.executor.executePrepared({...metadata, preparedRunId: prepared.runId, dispatch, loadResult: vi.fn(), persistResult: vi.fn()})).rejects.toThrow('PROCESSING_CONSENT_REQUIRED');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects worker metadata drift from the exact prepared run', async () => {
    const harness = await makeHarness(); const metadata = {projectId: harness.projectId, provider: 'deepgram', model: 'nova-3', operation: 'transcribe' as const, dataCategories: ['source_audio'], canonicalInput: {assetId: crypto.randomUUID()}, estimatedCostMicros: 100, pricingVersion: 'v1'};
    const prepared = await harness.executor.prepare(metadata);
    await expect(harness.executor.executePrepared({...metadata, model: 'nova-future', preparedRunId: prepared.runId, dispatch: vi.fn(), loadResult: vi.fn(), persistResult: vi.fn()})).rejects.toThrow('PROVIDER_PREPARATION_MISMATCH');
  });
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
    const dispatch = vi.fn().mockResolvedValue({result: {text: 'hello'}, usage: {actualCostMicros: 75, requestCount: 1, metadata: {seconds: 3}}});
    const input = {projectId: harness.projectId, provider: 'deepgram', model: 'nova-3', operation: 'transcribe' as const, dataCategories: ['source_audio'], canonicalInput: {audio: 'a'}, estimatedCostMicros: 100, pricingVersion: 'v1', dispatch, loadResult: async (id: string) => stored.get(id)!, persistResult: async (writer: {writeStructured: (write: (transaction: unknown) => Promise<void>) => Promise<void>}, claim: {runId: string}, result: {text: string}) => writer.writeStructured(async () => { stored.set(claim.runId, result); })};
    const first = await harness.executor.execute(input);
    const second = await harness.executor.execute(input);
    expect(first.result).toEqual({text: 'hello'});
    expect(second).toMatchObject({runId: first.runId, cacheHit: true, result: {text: 'hello'}});
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await harness.runs.get(first.runId))?.settledCostMicros).toBe(75);
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

  it('settles observed usage above estimate and blocks a subsequent reservation', async () => {
    const projectId = crypto.randomUUID(); const consents = new InMemoryConsentRepository(); const consent = new ConsentService(consents, async () => undefined);
    await consent.accept({projectId, purpose: 'processing', documentVersion: 'v1', providers: ['deepgram'], dataCategories: ['source_audio'], permissionConfirmed: true});
    const runs = new ProviderRunService(new InMemoryProviderRunRepository(), {fingerprintSecret: 'secret', defaultBudgetMicros: 150});
    const executor = new DefaultProviderExecutor(consent, runs);
    const persistResult = vi.fn(async (writer: {writeStructured: (write: (transaction: unknown) => Promise<void>) => Promise<void>}) => writer.writeStructured(async () => undefined));
    const first = {projectId, provider: 'deepgram', model: 'nova-3', operation: 'transcribe' as const, dataCategories: ['source_audio'], canonicalInput: {audio: 'first'}, estimatedCostMicros: 100, pricingVersion: 'v1', dispatch: vi.fn().mockResolvedValue({result: {text: 'done'}, usage: {actualCostMicros: 200, requestCount: 2}}), loadResult: vi.fn(), persistResult};
    await executor.execute(first);
    const [run] = await runs.list(projectId); expect(run.settledCostMicros).toBe(200); expect(run.requestCount).toBe(2);
    await expect(executor.execute({...first, canonicalInput: {audio: 'second'}})).rejects.toThrow('PROJECT_PROVIDER_BUDGET_EXCEEDED');
  });

  it('cleans a staged object when fenced persistence cannot commit', async () => {
    const harness = await makeHarness(); const cleanupOrphanedResult = vi.fn().mockResolvedValue(undefined);
    const visible = new Map<string, unknown>();
    vi.spyOn(harness.runs, 'completeWithResult').mockImplementation(async (_claim, _usage, persist) => {
      const pending = new Map<string, unknown>();
      await persist({writeStructured: async (write) => write({insertResult: (id: string, value: unknown) => pending.set(id, value)} as never)});
      throw new Error('PROVIDER_RUN_FENCED');
    });
    const persistResult = vi.fn(async (writer: ProviderResultWriter, claim: {runId: string}, result: unknown) => writer.writeStructured(async (transaction) => { (transaction as unknown as {insertResult: (id: string, value: unknown) => void}).insertResult(claim.runId, result); }));
    await expect(harness.executor.execute({projectId: harness.projectId, provider: 'deepgram', model: 'nova-3', operation: 'transcribe', dataCategories: ['source_audio'], canonicalInput: {audio: 'staged'}, estimatedCostMicros: 100, pricingVersion: 'v1', dispatch: vi.fn().mockResolvedValue({result: {objectKey: 'staging/run.wav'}, usage: {actualCostMicros: 100, requestCount: 1}}), loadResult: vi.fn(), persistResult, cleanupOrphanedResult})).rejects.toThrow('PROVIDER_RUN_FENCED');
    expect(persistResult).toHaveBeenCalled(); expect(visible.size).toBe(0);
    expect(cleanupOrphanedResult).toHaveBeenCalledWith({objectKey: 'staging/run.wav'});
  });

  it.each([
    ['missing', undefined],
    ['negative', {actualCostMicros: -1, requestCount: 1}],
    ['invalid', {actualCostMicros: Number.NaN, requestCount: 1}]
  ])('cleans staged output exactly once for %s observed usage and leaves the run ambiguous', async (_name, usage) => {
    const harness = await makeHarness(); const cleanupOrphanedResult = vi.fn().mockResolvedValue(undefined); const persistResult = vi.fn(); const staged = {objectKey: 'staging/invalid.wav'};
    await expect(harness.executor.execute({projectId: harness.projectId, provider: 'deepgram', model: 'nova-3', operation: 'transcribe', dataCategories: ['source_audio'], canonicalInput: {audio: `invalid-${_name}`}, estimatedCostMicros: 100, pricingVersion: 'v1', dispatch: vi.fn().mockResolvedValue({result: staged, usage}), loadResult: vi.fn(), persistResult, cleanupOrphanedResult} as never)).rejects.toThrow('PROVIDER_USAGE_INVALID');
    const [run] = await harness.runs.list(harness.projectId); expect(run.status).toBe('ambiguous'); expect(run.reservedCostMicros).toBe(100); expect(run.settledCostMicros).toBeNull();
    expect(persistResult).not.toHaveBeenCalled(); expect(cleanupOrphanedResult).toHaveBeenCalledTimes(1); expect(cleanupOrphanedResult).toHaveBeenCalledWith(staged);
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

  it('retires stale-consent work and dispatches only a replacement-consent run', async () => {
    const harness = await makeHarness(); const oldConsent = await harness.consents.findValid(harness.projectId, 'processing');
    const stale = await harness.runs.reserve({projectId: harness.projectId, consentId: oldConsent!.id, consentSnapshotHash: oldConsent!.snapshotHash, dataCategories: ['source_audio'], provider: 'deepgram', model: 'nova-3', operation: 'transcribe', canonicalInput: {audio: 'replacement-run'}, estimatedCostMicros: 100, pricingVersion: 'v1'});
    await harness.consent.accept({projectId: harness.projectId, purpose: 'processing', documentVersion: 'v2', providers: ['deepgram'], dataCategories: ['source_audio'], permissionConfirmed: true});
    const dispatch = vi.fn().mockResolvedValue({result: {text: 'new'}, usage: {actualCostMicros: 90, requestCount: 1}});
    const executed = await harness.executor.execute({projectId: harness.projectId, provider: 'deepgram', model: 'nova-3', operation: 'transcribe', dataCategories: ['source_audio'], canonicalInput: {audio: 'replacement-run'}, estimatedCostMicros: 100, pricingVersion: 'v1', dispatch, loadResult: vi.fn(), persistResult: async (writer) => writer.writeStructured(async () => undefined)});
    expect(executed.runId).not.toBe(stale.runId); expect(dispatch).toHaveBeenCalledTimes(1); expect((await harness.runs.get(stale.runId))?.activeResult).toBe(false);
  });
});

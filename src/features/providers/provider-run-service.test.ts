import {describe, expect, it} from 'vitest';

import type {Database} from '../../server/db/client';
import {fingerprintInput} from './input-fingerprint';
import {InMemoryProviderRunRepository, PostgresProviderRunRepository} from './provider-run-repository';
import {providerRunSummary, ProviderRunService} from './provider-run-service';
import {InMemoryTranscriptionRepository} from '../transcription/transcription-repository';

const projectId = crypto.randomUUID();
const consentId = crypto.randomUUID();
const input = {
  projectId, consentId, provider: 'deepgram', model: 'nova-3',
  operation: 'transcribe' as const, canonicalInput: {assetId: crypto.randomUUID(), sha256: 'abc'},
  estimatedCostMicros: 1_200, pricingVersion: '2026-07-14'
};

describe('provider run state and budget control', () => {
  it('uses project-scoped HMAC fingerprints', () => {
    expect(fingerprintInput('secret', projectId, {text: 'same'}))
      .not.toBe(fingerprintInput('secret', crypto.randomUUID(), {text: 'same'}));
  });

  it('distinguishes dates and rejects non-canonical input values', () => {
    expect(fingerprintInput('secret', projectId, {at: new Date('2026-01-01')})).not.toBe(fingerprintInput('secret', projectId, {at: new Date('2026-01-02')}));
    expect(() => fingerprintInput('secret', projectId, {missing: undefined})).toThrow('PROVIDER_INPUT_NOT_CANONICAL');
    expect(() => fingerprintInput('secret', projectId, {amount: Number.NaN})).toThrow('PROVIDER_INPUT_NOT_CANONICAL');
  });

  it('converges concurrent reservations and rejects over-budget work', async () => {
    const repository = new InMemoryProviderRunRepository();
    const runs = new ProviderRunService(repository, {fingerprintSecret: 'secret', defaultBudgetMicros: 2_000});
    const [left, right] = await Promise.all([runs.reserve(input), runs.reserve(input)]);
    expect(left.runId).toBe(right.runId);
    expect([left.cacheHit, right.cacheHit]).toEqual([false, false]);
    await expect(runs.reserve({...input, canonicalInput: {other: true}, estimatedCostMicros: 10_000_000}))
      .rejects.toThrow('PROJECT_PROVIDER_BUDGET_EXCEEDED');
  });

  it('enforces the project request budget before reserving another call', async () => {
    const runs = new ProviderRunService(new InMemoryProviderRunRepository(), {fingerprintSecret: 'secret', defaultBudgetMicros: 50_000, defaultRequestBudget: 1});
    await runs.reserve(input);
    await expect(runs.reserve({...input, canonicalInput: {different: true}})).rejects.toThrow('PROJECT_PROVIDER_REQUEST_BUDGET_EXCEEDED');
  });

  it('transactionally releases an unused reservation so budget and request capacity can be reused', async () => {
    const runs = new ProviderRunService(new InMemoryProviderRunRepository(), {fingerprintSecret: 'secret', defaultBudgetMicros: 2_000, defaultRequestBudget: 1});
    const reserved = await runs.reserve(input);
    await expect(runs.cancelReservation(reserved.runId)).resolves.toBe(true);
    await expect(runs.reserve({...input, canonicalInput: {different: true}})).resolves.toMatchObject({cacheHit: false});
    expect((await runs.get(reserved.runId))?.status).toBe('failed');
  });

  it('never cancels a shared reservation after a concurrent request links a job', async () => {
    const linkedRunIds = new Set<string>();
    const runs = new ProviderRunService(new InMemoryProviderRunRepository(() => new Date(), (runId) => linkedRunIds.has(runId)), {fingerprintSecret: 'secret', defaultBudgetMicros: 2_000, defaultRequestBudget: 1});
    const first = await runs.reserve(input); const shared = await runs.reserve(input);
    expect(shared.runId).toBe(first.runId);
    linkedRunIds.add(shared.runId);
    await expect(runs.cancelReservation(first.runId)).resolves.toBe(false);
    expect((await runs.get(first.runId))?.status).toBe('reserved');
  });

  it('retires an obsolete-consent reservation so replacement consent can reserve the same input', async () => {
    const repository = new InMemoryProviderRunRepository(); const runs = new ProviderRunService(repository, {fingerprintSecret: 'secret', defaultBudgetMicros: 9_000});
    const old = await runs.reserve(input);
    const replacement = await runs.reserve({...input, consentId: crypto.randomUUID()});
    expect(replacement.runId).not.toBe(old.runId);
    expect((await runs.get(old.runId))?.activeResult).toBe(false);
  });

  it('atomically retires linked untouched transcription work when renewed consent reserves a replacement', async () => {
    const jobs = new InMemoryTranscriptionRepository();
    const repository = new InMemoryProviderRunRepository(() => new Date(), () => false, (runId) => jobs.retireLinkedConsentWorkForTest(runId));
    const runs = new ProviderRunService(repository, {fingerprintSecret: 'secret', defaultBudgetMicros: 9_000});
    const old = await runs.reserve(input); const oldJob = await jobs.createJob(projectId, input.canonicalInput.assetId, old.runId);
    const replacement = await runs.reserve({...input, consentId: crypto.randomUUID(), consentSnapshotHash: 'renewed'});
    expect(replacement.runId).not.toBe(old.runId); expect((await runs.get(old.runId))?.lastError).toBe('PROVIDER_PREPARED_CONSENT_CHANGED');
    expect(jobs.allJobs().find((job) => job.id === oldJob.id)?.status).toBe('retired_consent');
    const fresh = await jobs.createJob(projectId, input.canonicalInput.assetId, replacement.runId);
    expect(fresh.status).toBe('pending'); expect(await jobs.hasTerminalFailure(projectId, input.canonicalInput.assetId)).toBe(false);
    await expect(jobs.claimJob(oldJob.id, projectId, input.canonicalInput.assetId, old.runId, 1000, true)).resolves.toEqual({outcome: 'retired'});
  });

  it('projects only compact owner-safe run fields', async () => {
    const runs = new ProviderRunService(new InMemoryProviderRunRepository(), {fingerprintSecret: 'secret', defaultBudgetMicros: 9_000}); const reserved = await runs.reserve(input); const run = (await runs.get(reserved.runId))!;
    expect(providerRunSummary(run)).not.toHaveProperty('leaseToken'); expect(providerRunSummary(run)).not.toHaveProperty('inputFingerprint'); expect(providerRunSummary(run)).not.toHaveProperty('consentId'); expect(providerRunSummary(run)).not.toHaveProperty('lastError');
  });

  it('acquires the consent advisory lock before locking an ambiguous retry row', async () => {
    const events: string[] = [];
    const transaction = {select: () => ({from: () => ({where: () => ({limit: async () => { events.push('candidate'); return [{projectId}]; }, for: async () => { events.push('row_lock'); return []; }})})}), execute: async () => { events.push('advisory'); }};
    const database = {transaction: async <T>(operation: (tx: typeof transaction) => Promise<T>) => operation(transaction)} as unknown as Database;
    await expect(new PostgresProviderRunRepository(database).acknowledgeAndRetry(crypto.randomUUID(), 1_000, 10)).rejects.toThrow('PROVIDER_RUN_NOT_AMBIGUOUS');
    expect(events).toEqual(['candidate', 'advisory', 'row_lock']);
  });

  it('expires pre-dispatch leases but makes expired dispatches ambiguous without reclaiming them', async () => {
    let now = new Date('2026-07-14T12:00:00Z');
    const repository = new InMemoryProviderRunRepository(() => now);
    const runs = new ProviderRunService(repository, {fingerprintSecret: 'secret', defaultBudgetMicros: 9_000, leaseMs: 1_000});
    const reserved = await runs.reserve(input);
    const first = await runs.claim(reserved.runId);
    now = new Date(now.getTime() + 1_001);
    const reclaimed = await runs.claim(reserved.runId);
    expect(reclaimed.leaseToken).not.toBe(first.leaseToken);
    await runs.beginDispatch(reclaimed);
    now = new Date(now.getTime() + 1_001);
    await runs.reconcileExpired();
    expect((await runs.get(reserved.runId))?.status).toBe('ambiguous');
    await expect(runs.claim(reserved.runId)).rejects.toThrow('PROVIDER_RUN_NOT_CLAIMABLE');
  });

  it('acknowledges ambiguous cost conservatively and links a retry while fencing late completion', async () => {
    let now = new Date('2026-07-14T12:00:00Z');
    const repository = new InMemoryProviderRunRepository(() => now);
    const runs = new ProviderRunService(repository, {fingerprintSecret: 'secret', defaultBudgetMicros: 9_000, leaseMs: 10});
    const reserved = await runs.reserve(input);
    const claim = await runs.claim(reserved.runId);
    await runs.beginDispatch(claim);
    now = new Date(now.getTime() + 11);
    await runs.reconcileExpired();
    const retry = await runs.acknowledgeAndRetry(reserved.runId);
    expect(retry.retryOfRunId).toBe(reserved.runId);
    expect((await runs.get(reserved.runId))?.settledCostMicros).toBe(input.estimatedCostMicros);
    await expect(runs.complete(claim, {actualCostMicros: input.estimatedCostMicros, requestCount: 1})).rejects.toThrow('PROVIDER_RUN_FENCED');
    expect((await runs.get(reserved.runId))?.status).toBe('superseded_ambiguous');
  });

  it('extends the dispatch deadline when a healthy worker heartbeats', async () => {
    let now = new Date('2026-07-14T12:00:00Z');
    const repository = new InMemoryProviderRunRepository(() => now);
    const runs = new ProviderRunService(repository, {fingerprintSecret: 'secret', defaultBudgetMicros: 9_000, leaseMs: 1_000});
    const reserved = await runs.reserve(input); const claim = await runs.claim(reserved.runId); await runs.beginDispatch(claim);
    now = new Date(now.getTime() + 900); await runs.heartbeat(claim);
    now = new Date(now.getTime() + 200); await runs.reconcileExpired();
    expect((await runs.get(reserved.runId))?.status).toBe('dispatching');
  });

  it('fences heartbeat and completion after the dispatch lease expires', async () => {
    let now = new Date('2026-07-14T12:00:00Z');
    const repository = new InMemoryProviderRunRepository(() => now);
    const runs = new ProviderRunService(repository, {fingerprintSecret: 'secret', defaultBudgetMicros: 9_000, leaseMs: 10});
    const reserved = await runs.reserve(input); const claim = await runs.claim(reserved.runId); await runs.beginDispatch(claim);
    now = new Date(now.getTime() + 11);
    await expect(runs.heartbeat(claim)).rejects.toThrow('PROVIDER_RUN_FENCED');
    await expect(runs.complete(claim, {actualCostMicros: 100, requestCount: 1})).rejects.toThrow('PROVIDER_RUN_FENCED');
  });
});

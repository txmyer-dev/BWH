import {randomUUID} from 'node:crypto';
import {and, desc, eq, inArray, lte, sql} from 'drizzle-orm';

import type {Database} from '../../server/db/client';
import {processingJobs, projectConsents, projectProviderBudgets, providerRunResults, providerRuns} from '../../server/db/schema';
import type {DispatchClaim, ProviderResultWriter, ProviderRun, ProviderUsage, ReserveProviderRunInput} from './types';

export type Reservation = {runId: string; cacheHit: boolean};
export interface ProviderRunRepository {
  reserve(input: ReserveProviderRunInput, budgetMicros: number, requestBudget: number): Promise<Reservation>;
  cancelReservation(runId: string): Promise<boolean>;
  get(runId: string): Promise<ProviderRun | undefined>;
  claim(runId: string, leaseMs: number): Promise<DispatchClaim>;
  beginDispatch(claim: DispatchClaim, validateConsent?: () => Promise<void>): Promise<void>;
  heartbeat(claim: DispatchClaim, leaseMs: number): Promise<void>;
  complete(claim: DispatchClaim, usage: ProviderUsage): Promise<void>;
  completeWithResult<T>(claim: DispatchClaim, usage: ProviderUsage, persist: (writer: ProviderResultWriter) => Promise<T>): Promise<T>;
  fail(claim: DispatchClaim, error: string): Promise<void>;
  reconcileExpired(): Promise<number>;
  acknowledgeAmbiguous(runId: string): Promise<ProviderRun>;
  acknowledgeAndRetry(runId: string, budgetMicros: number, requestBudget: number): Promise<ProviderRun>;
  list(projectId: string): Promise<ProviderRun[]>;
}

const clone = (run: ProviderRun): ProviderRun => ({...run, createdAt: new Date(run.createdAt), updatedAt: new Date(run.updatedAt), leaseExpiresAt: run.leaseExpiresAt && new Date(run.leaseExpiresAt), dispatchDeadlineAt: run.dispatchDeadlineAt && new Date(run.dispatchDeadlineAt)});

export class InMemoryProviderRunRepository implements ProviderRunRepository {
  private readonly runs = new Map<string, ProviderRun>();
  private lock: Promise<void> = Promise.resolve();
  constructor(private readonly now: () => Date = () => new Date(), private readonly isLinked: (runId: string) => boolean = () => false) {}

  private async atomic<T>(work: () => T | Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }

  async reserve(input: ReserveProviderRunInput, budgetMicros: number, requestBudget: number) {
    return this.atomic(() => {
      const sameInput = (run: ProviderRun) => run.projectId === input.projectId && run.provider === input.provider && run.model === input.model && run.operation === input.operation && run.inputFingerprint === input.inputFingerprint;
      const obsolete = [...this.runs.values()].find((run) => sameInput(run) && run.activeResult && (run.consentId !== input.consentId || run.consentSnapshotHash !== input.consentSnapshotHash));
      if (obsolete) { const uncertain = ['dispatching','ambiguous'].includes(obsolete.status); obsolete.status = uncertain ? 'superseded_ambiguous' : obsolete.status === 'completed' ? 'completed' : 'failed'; obsolete.settledCostMicros = uncertain ? obsolete.estimatedCostMicros : obsolete.settledCostMicros ?? 0; obsolete.reservedCostMicros = 0; obsolete.activeResult = false; obsolete.leaseToken = null; obsolete.leaseExpiresAt = null; obsolete.updatedAt = this.now(); }
      const reusable = [...this.runs.values()].find((run) => sameInput(run) && run.consentId === input.consentId && run.consentSnapshotHash === input.consentSnapshotHash && run.status === 'completed' && run.activeResult);
      if (reusable) { reusable.cacheHitCount += 1; return {runId: reusable.id, cacheHit: true}; }
      const active = [...this.runs.values()].find((run) => sameInput(run) && run.consentId === input.consentId && run.consentSnapshotHash === input.consentSnapshotHash && ['reserved', 'processing', 'dispatching', 'ambiguous'].includes(run.status));
      if (active) return {runId: active.id, cacheHit: false};
      const committed = [...this.runs.values()].filter((run) => run.projectId === input.projectId).reduce((sum, run) => sum + (run.settledCostMicros ?? run.reservedCostMicros), 0);
      if (committed + input.estimatedCostMicros > budgetMicros) throw new Error('PROJECT_PROVIDER_BUDGET_EXCEEDED');
      const requests = [...this.runs.values()].filter((run) => run.projectId === input.projectId).reduce((sum, run) => sum + run.requestCount + (['reserved','processing'].includes(run.status) ? 1 : 0), 0);
      if (requests + 1 > requestBudget) throw new Error('PROJECT_PROVIDER_REQUEST_BUDGET_EXCEEDED');
      const now = this.now();
      const id = randomUUID();
      this.runs.set(id, {id, ...input, status: 'reserved', reservedCostMicros: input.estimatedCostMicros, settledCostMicros: null, requestCount: 0, cacheHitCount: 0, leaseToken: null, leaseExpiresAt: null, dispatchDeadlineAt: null, providerIdempotencyKey: `provider-run-${id}`, retryOfRunId: input.retryOfRunId ?? null, activeResult: true, lastError: null, usageMetadata: null, createdAt: now, updatedAt: now});
      return {runId: id, cacheHit: false};
    });
  }

  async get(runId: string) { const run = this.runs.get(runId); return run && clone(run); }
  async cancelReservation(runId: string) { return this.atomic(() => { const run = this.runs.get(runId); if (!run || run.status !== 'reserved' || !run.activeResult || run.requestCount !== 0 || this.isLinked(runId)) return false; run.status = 'failed'; run.reservedCostMicros = 0; run.settledCostMicros = 0; run.activeResult = false; run.lastError = 'PROVIDER_RESERVATION_CANCELLED'; run.updatedAt = this.now(); return true; }); }
  async list(projectId: string) { return [...this.runs.values()].filter((run) => run.projectId === projectId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map(clone); }
  async claim(runId: string, leaseMs: number) {
    return this.atomic(() => {
      const run = this.runs.get(runId); const now = this.now();
      if (!run || !(['reserved', 'processing'].includes(run.status) && (!run.leaseExpiresAt || run.leaseExpiresAt <= now))) throw new Error('PROVIDER_RUN_NOT_CLAIMABLE');
      run.status = 'processing'; run.leaseToken = randomUUID(); run.leaseExpiresAt = new Date(now.getTime() + leaseMs); run.dispatchDeadlineAt = new Date(now.getTime() + leaseMs); run.updatedAt = now;
      return {runId, leaseToken: run.leaseToken, consentId: run.consentId, dispatchDeadlineAt: run.dispatchDeadlineAt};
    });
  }
  private fenced(claim: DispatchClaim) { const run = this.runs.get(claim.runId); if (!run || run.leaseToken !== claim.leaseToken || !run.activeResult) throw new Error('PROVIDER_RUN_FENCED'); return run; }
  async beginDispatch(claim: DispatchClaim, validateConsent?: () => Promise<void>) { await this.atomic(async () => { const run = this.fenced(claim); if (run.status !== 'processing' || !run.leaseExpiresAt || run.leaseExpiresAt <= this.now()) throw new Error('PROVIDER_RUN_FENCED'); await validateConsent?.(); run.status = 'dispatching'; run.requestCount += 1; run.updatedAt = this.now(); }); }
  async heartbeat(claim: DispatchClaim, leaseMs: number) { await this.atomic(() => { const run = this.fenced(claim); const now = this.now(); if (run.status !== 'dispatching' || !run.leaseExpiresAt || run.leaseExpiresAt <= now || !run.dispatchDeadlineAt || run.dispatchDeadlineAt <= now) throw new Error('PROVIDER_RUN_FENCED'); const deadline = new Date(now.getTime() + leaseMs); run.leaseExpiresAt = deadline; run.dispatchDeadlineAt = deadline; }); }
  private applyUsage(run: ProviderRun, usage: ProviderUsage) { run.status = 'completed'; run.settledCostMicros = Math.max(0, usage.actualCostMicros); run.reservedCostMicros = 0; run.requestCount = Math.max(1, usage.requestCount); run.usageMetadata = usage.metadata ?? null; run.leaseToken = null; run.leaseExpiresAt = null; run.updatedAt = this.now(); }
  async complete(claim: DispatchClaim, usage: ProviderUsage) { await this.atomic(() => { const run = this.fenced(claim); const now = this.now(); if (run.status !== 'dispatching' || !run.leaseExpiresAt || run.leaseExpiresAt <= now || !run.dispatchDeadlineAt || run.dispatchDeadlineAt <= now) throw new Error('PROVIDER_RUN_FENCED'); this.applyUsage(run, usage); }); }
  async completeWithResult<T>(claim: DispatchClaim, usage: ProviderUsage, persist: (writer: ProviderResultWriter) => Promise<T>) { return this.atomic(async () => { const run = this.fenced(claim); const now = this.now(); if (run.status !== 'dispatching' || !run.leaseExpiresAt || run.leaseExpiresAt <= now || !run.dispatchDeadlineAt || run.dispatchDeadlineAt <= now) throw new Error('PROVIDER_RUN_FENCED'); const writer: ProviderResultWriter = {writeStructured: async (write) => write({} as Parameters<typeof write>[0])}; const result = await persist(writer); this.applyUsage(run, usage); return result; }); }
  async fail(claim: DispatchClaim, error: string) { await this.atomic(() => { const run = this.fenced(claim); if (run.status !== 'processing' && run.status !== 'dispatching') throw new Error('PROVIDER_RUN_FENCED'); const wasDispatched = run.status === 'dispatching'; run.status = wasDispatched ? 'ambiguous' : 'failed'; run.lastError = error.slice(0, 1000); run.settledCostMicros = wasDispatched ? null : 0; run.reservedCostMicros = wasDispatched ? run.reservedCostMicros : 0; run.activeResult = wasDispatched; run.leaseToken = null; run.leaseExpiresAt = null; run.updatedAt = this.now(); }); }
  async reconcileExpired() { return this.atomic(() => { let count = 0; const now = this.now(); for (const run of this.runs.values()) { if (run.status === 'dispatching' && run.dispatchDeadlineAt && run.dispatchDeadlineAt <= now) { run.status = 'ambiguous'; run.leaseToken = null; run.leaseExpiresAt = null; run.updatedAt = now; count += 1; } else if (run.status === 'processing' && run.leaseExpiresAt && run.leaseExpiresAt <= now) { run.status = 'reserved'; run.leaseToken = null; run.leaseExpiresAt = null; run.updatedAt = now; count += 1; } } return count; }); }
  async acknowledgeAmbiguous(runId: string) { return this.atomic(() => { const run = this.runs.get(runId); if (!run || run.status !== 'ambiguous') throw new Error('PROVIDER_RUN_NOT_AMBIGUOUS'); run.status = 'superseded_ambiguous'; run.settledCostMicros = run.estimatedCostMicros; run.reservedCostMicros = 0; run.activeResult = false; run.updatedAt = this.now(); return clone(run); }); }
  async acknowledgeAndRetry(runId: string, budgetMicros: number, requestBudget: number) { return this.atomic(() => {
    const original = this.runs.get(runId); if (!original || original.status !== 'ambiguous') throw new Error('PROVIDER_RUN_NOT_AMBIGUOUS');
    const committed = [...this.runs.values()].filter((run) => run.projectId === original.projectId).reduce((sum, run) => sum + (run.settledCostMicros ?? run.reservedCostMicros), 0);
    if (committed + original.estimatedCostMicros > budgetMicros) throw new Error('PROJECT_PROVIDER_BUDGET_EXCEEDED');
    const requests = [...this.runs.values()].filter((run) => run.projectId === original.projectId).reduce((sum, run) => sum + run.requestCount + (['reserved','processing'].includes(run.status) ? 1 : 0), 0); if (requests + 1 > requestBudget) throw new Error('PROJECT_PROVIDER_REQUEST_BUDGET_EXCEEDED');
    const now = this.now(); original.status = 'superseded_ambiguous'; original.settledCostMicros = original.estimatedCostMicros; original.reservedCostMicros = 0; original.activeResult = false; original.updatedAt = now;
    const id = randomUUID(); const retry: ProviderRun = {...clone(original), id, status: 'reserved', settledCostMicros: null, reservedCostMicros: original.estimatedCostMicros, requestCount: 0, cacheHitCount: 0, leaseToken: null, leaseExpiresAt: null, dispatchDeadlineAt: null, providerIdempotencyKey: `provider-run-${id}`, retryOfRunId: original.id, activeResult: true, lastError: null, usageMetadata: null, createdAt: now, updatedAt: now}; this.runs.set(id, retry); return clone(retry);
  }); }
}

const mapRow = (row: typeof providerRuns.$inferSelect): ProviderRun => ({...row, operation: row.operation as ProviderRun['operation'], status: row.status as ProviderRun['status'], dataCategories: row.dataCategories as string[], usageMetadata: row.usageMetadata as ProviderRun['usageMetadata']});

export class PostgresProviderRunRepository implements ProviderRunRepository {
  constructor(private readonly database: Database, private readonly now: () => Date = () => new Date()) {}
  async reserve(input: ReserveProviderRunInput, budgetMicros: number, requestBudget: number) {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${input.projectId}), hashtext('processing'))`);
      const categories = JSON.stringify(input.dataCategories);
      const [consent] = await transaction.select({id: projectConsents.id}).from(projectConsents).where(and(eq(projectConsents.id, input.consentId), eq(projectConsents.projectId, input.projectId), eq(projectConsents.purpose, 'processing'), eq(projectConsents.snapshotHash, input.consentSnapshotHash), sql`${projectConsents.invalidatedAt} IS NULL`, sql`${projectConsents.providers} @> ${JSON.stringify([input.provider])}::jsonb`, sql`${projectConsents.dataCategories} @> ${categories}::jsonb`)).limit(1);
      if (!consent) throw new Error('PROCESSING_CONSENT_REQUIRED');
      await transaction.insert(projectProviderBudgets).values({projectId: input.projectId, limitMicros: budgetMicros, requestLimit: requestBudget, pricingVersion: input.pricingVersion}).onConflictDoNothing();
      const [obsolete] = await transaction.select().from(providerRuns).where(and(eq(providerRuns.projectId, input.projectId), eq(providerRuns.provider, input.provider), eq(providerRuns.model, input.model), eq(providerRuns.operation, input.operation), eq(providerRuns.inputFingerprint, input.inputFingerprint), eq(providerRuns.activeResult, true), sql`(${providerRuns.consentId} <> ${input.consentId} OR ${providerRuns.consentSnapshotHash} <> ${input.consentSnapshotHash})`)).for('update').limit(1);
      if (obsolete) { const uncertain = ['dispatching','ambiguous'].includes(obsolete.status); const reservedRequest = ['reserved','processing'].includes(obsolete.status) ? 1 : 0; await transaction.update(providerRuns).set({status: uncertain ? 'superseded_ambiguous' : obsolete.status === 'completed' ? 'completed' : 'failed', settledCostMicros: uncertain ? obsolete.estimatedCostMicros : obsolete.settledCostMicros ?? 0, reservedCostMicros: 0, activeResult: false, leaseToken: null, leaseExpiresAt: null, updatedAt: this.now()}).where(eq(providerRuns.id, obsolete.id)); await transaction.update(projectProviderBudgets).set({reservedMicros: sql`${projectProviderBudgets.reservedMicros} - ${obsolete.reservedCostMicros}`, settledMicros: sql`${projectProviderBudgets.settledMicros} + ${uncertain ? obsolete.estimatedCostMicros : 0}`, reservedRequests: sql`${projectProviderBudgets.reservedRequests} - ${reservedRequest}`, updatedAt: this.now()}).where(eq(projectProviderBudgets.projectId, obsolete.projectId)); }
      const [existing] = await transaction.select().from(providerRuns).where(and(eq(providerRuns.projectId, input.projectId), eq(providerRuns.consentId, input.consentId), eq(providerRuns.consentSnapshotHash, input.consentSnapshotHash), eq(providerRuns.provider, input.provider), eq(providerRuns.model, input.model), eq(providerRuns.operation, input.operation), eq(providerRuns.inputFingerprint, input.inputFingerprint), eq(providerRuns.activeResult, true), inArray(providerRuns.status, ['reserved','processing','dispatching','completed','ambiguous']))).limit(1);
      if (existing) {
        if (existing.status === 'completed') await transaction.update(providerRuns).set({cacheHitCount: sql`${providerRuns.cacheHitCount} + 1`, updatedAt: this.now()}).where(eq(providerRuns.id, existing.id));
        return {runId: existing.id, cacheHit: existing.status === 'completed'};
      }
      const [budget] = await transaction.select().from(projectProviderBudgets).where(eq(projectProviderBudgets.projectId, input.projectId)).for('update');
      if (!budget || budget.reservedMicros + budget.settledMicros + input.estimatedCostMicros > budget.limitMicros) throw new Error('PROJECT_PROVIDER_BUDGET_EXCEEDED');
      if (budget.reservedRequests + budget.settledRequests + 1 > budget.requestLimit) throw new Error('PROJECT_PROVIDER_REQUEST_BUDGET_EXCEEDED');
      const id = randomUUID(); const now = this.now();
      await transaction.update(projectProviderBudgets).set({reservedMicros: sql`${projectProviderBudgets.reservedMicros} + ${input.estimatedCostMicros}`, reservedRequests: sql`${projectProviderBudgets.reservedRequests} + 1`, updatedAt: now}).where(eq(projectProviderBudgets.projectId, input.projectId));
      await transaction.insert(providerRuns).values({id, ...input, status: 'reserved', reservedCostMicros: input.estimatedCostMicros, requestCount: 0, providerIdempotencyKey: `provider-run-${id}`, retryOfRunId: input.retryOfRunId ?? null, createdAt: now, updatedAt: now});
      return {runId: id, cacheHit: false};
    });
  }
  async get(runId: string) { const [row] = await this.database.select().from(providerRuns).where(eq(providerRuns.id, runId)).limit(1); return row && mapRow(row); }
  async cancelReservation(runId: string) { return this.database.transaction(async (transaction) => {
    const [candidate] = await transaction.select({projectId: providerRuns.projectId}).from(providerRuns).where(eq(providerRuns.id, runId)).limit(1);
    if (!candidate) return false;
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${candidate.projectId}), hashtext('processing'))`);
    const [run] = await transaction.select().from(providerRuns).where(eq(providerRuns.id, runId)).for('update').limit(1);
    if (!run || run.status !== 'reserved' || !run.activeResult || run.requestCount !== 0) return false;
    const [job] = await transaction.select({id: processingJobs.id}).from(processingJobs).where(eq(processingJobs.providerRunId, runId)).limit(1);
    const [result] = await transaction.select({runId: providerRunResults.providerRunId}).from(providerRunResults).where(eq(providerRunResults.providerRunId, runId)).limit(1);
    if (job || result) return false;
    const now = this.now();
    await transaction.update(providerRuns).set({status: 'failed', reservedCostMicros: 0, settledCostMicros: 0, activeResult: false, lastError: 'PROVIDER_RESERVATION_CANCELLED', updatedAt: now}).where(eq(providerRuns.id, runId));
    await transaction.update(projectProviderBudgets).set({reservedMicros: sql`${projectProviderBudgets.reservedMicros} - ${run.reservedCostMicros}`, reservedRequests: sql`${projectProviderBudgets.reservedRequests} - 1`, updatedAt: now}).where(eq(projectProviderBudgets.projectId, run.projectId));
    return true;
  }); }
  async list(projectId: string) { return (await this.database.select().from(providerRuns).where(eq(providerRuns.projectId, projectId)).orderBy(desc(providerRuns.createdAt))).map(mapRow); }
  async claim(runId: string, leaseMs: number) { return this.database.transaction(async (transaction) => { const now = this.now(); const token = randomUUID(); const deadline = new Date(now.getTime() + leaseMs); const [row] = await transaction.update(providerRuns).set({status: 'processing', leaseToken: token, leaseExpiresAt: deadline, dispatchDeadlineAt: deadline, updatedAt: now}).where(and(eq(providerRuns.id, runId), inArray(providerRuns.status, ['reserved','processing']), sql`(${providerRuns.leaseExpiresAt} IS NULL OR ${providerRuns.leaseExpiresAt} <= ${now})`)).returning(); if (!row) throw new Error('PROVIDER_RUN_NOT_CLAIMABLE'); return {runId, leaseToken: token, consentId: row.consentId, dispatchDeadlineAt: deadline}; }); }
  async beginDispatch(claim: DispatchClaim, validateConsent?: () => Promise<void>) { await validateConsent?.(); await this.database.transaction(async (transaction) => { const [candidate] = await transaction.select().from(providerRuns).where(eq(providerRuns.id, claim.runId)).limit(1); if (!candidate) throw new Error('PROVIDER_RUN_FENCED'); await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${candidate.projectId}), hashtext('processing'))`); const categories = JSON.stringify(candidate.dataCategories); const now = this.now(); const [row] = await transaction.update(providerRuns).set({status: 'dispatching', requestCount: sql`${providerRuns.requestCount} + 1`, updatedAt: now}).where(and(eq(providerRuns.id, claim.runId), eq(providerRuns.consentId, claim.consentId), eq(providerRuns.leaseToken, claim.leaseToken), eq(providerRuns.status, 'processing'), sql`${providerRuns.leaseExpiresAt} > ${now}`, eq(providerRuns.activeResult, true), sql`exists (select 1 from ${projectConsents} where ${projectConsents.id} = ${claim.consentId} and ${projectConsents.projectId} = ${candidate.projectId} and ${projectConsents.purpose} = 'processing' and ${projectConsents.snapshotHash} = ${candidate.consentSnapshotHash} and ${projectConsents.invalidatedAt} is null and ${projectConsents.providers} @> ${JSON.stringify([candidate.provider])}::jsonb and ${projectConsents.dataCategories} @> ${categories}::jsonb)`)).returning(); if (!row) throw new Error('PROVIDER_RUN_FENCED'); await transaction.update(projectProviderBudgets).set({reservedRequests: sql`${projectProviderBudgets.reservedRequests} - 1`, settledRequests: sql`${projectProviderBudgets.settledRequests} + 1`, updatedAt: now}).where(eq(projectProviderBudgets.projectId, row.projectId)); }); }
  async heartbeat(claim: DispatchClaim, leaseMs: number) { const now = this.now(); const deadline = new Date(now.getTime() + leaseMs); const [row] = await this.database.update(providerRuns).set({leaseExpiresAt: deadline, dispatchDeadlineAt: deadline, updatedAt: now}).where(and(eq(providerRuns.id, claim.runId), eq(providerRuns.leaseToken, claim.leaseToken), eq(providerRuns.status, 'dispatching'), eq(providerRuns.activeResult, true), sql`${providerRuns.leaseExpiresAt} > ${now}`, sql`${providerRuns.dispatchDeadlineAt} > ${now}`)).returning({id: providerRuns.id}); if (!row) throw new Error('PROVIDER_RUN_FENCED'); }
  private async completeInTransaction<T>(claim: DispatchClaim, usage: ProviderUsage, persist: (writer: ProviderResultWriter) => Promise<T>) { return this.database.transaction(async (transaction) => { const now = this.now(); const [before] = await transaction.select().from(providerRuns).where(and(eq(providerRuns.id, claim.runId), eq(providerRuns.leaseToken, claim.leaseToken), eq(providerRuns.status, 'dispatching'), eq(providerRuns.activeResult, true), sql`${providerRuns.leaseExpiresAt} > ${now}`, sql`${providerRuns.dispatchDeadlineAt} > ${now}`)).for('update'); if (!before) throw new Error('PROVIDER_RUN_FENCED'); const writer: ProviderResultWriter = {writeStructured: (write) => write(transaction)}; const result = await persist(writer); const settled = Math.max(0, usage.actualCostMicros); const requests = Math.max(1, usage.requestCount); await transaction.update(providerRuns).set({status: 'completed', settledCostMicros: settled, reservedCostMicros: 0, requestCount: requests, usageMetadata: usage.metadata ?? null, leaseToken: null, leaseExpiresAt: null, updatedAt: this.now()}).where(eq(providerRuns.id, before.id)); await transaction.update(projectProviderBudgets).set({reservedMicros: sql`${projectProviderBudgets.reservedMicros} - ${before.reservedCostMicros}`, settledMicros: sql`${projectProviderBudgets.settledMicros} + ${settled}`, settledRequests: sql`${projectProviderBudgets.settledRequests} + ${requests - 1}`, updatedAt: this.now()}).where(eq(projectProviderBudgets.projectId, before.projectId)); return result; }); }
  async complete(claim: DispatchClaim, usage: ProviderUsage) { await this.completeInTransaction(claim, usage, async () => undefined); }
  async completeWithResult<T>(claim: DispatchClaim, usage: ProviderUsage, persist: (writer: ProviderResultWriter) => Promise<T>) { return this.completeInTransaction(claim, usage, persist); }
  async fail(claim: DispatchClaim, error: string) { await this.database.transaction(async (transaction) => { const [before] = await transaction.select().from(providerRuns).where(and(eq(providerRuns.id, claim.runId), eq(providerRuns.leaseToken, claim.leaseToken), inArray(providerRuns.status, ['processing','dispatching']), eq(providerRuns.activeResult, true))).for('update'); if (!before) throw new Error('PROVIDER_RUN_FENCED'); const ambiguous = before.status === 'dispatching'; await transaction.update(providerRuns).set({status: ambiguous ? 'ambiguous' : 'failed', lastError: error.slice(0, 1000), settledCostMicros: ambiguous ? null : 0, reservedCostMicros: ambiguous ? before.reservedCostMicros : 0, activeResult: ambiguous, leaseToken: null, leaseExpiresAt: null, updatedAt: this.now()}).where(eq(providerRuns.id, before.id)); if (!ambiguous) await transaction.update(projectProviderBudgets).set({reservedMicros: sql`${projectProviderBudgets.reservedMicros} - ${before.reservedCostMicros}`, updatedAt: this.now()}).where(eq(projectProviderBudgets.projectId, before.projectId)); }); }
  async reconcileExpired() { const now = this.now(); const ambiguous = await this.database.update(providerRuns).set({status: 'ambiguous', leaseToken: null, leaseExpiresAt: null, updatedAt: now}).where(and(eq(providerRuns.status, 'dispatching'), lte(providerRuns.dispatchDeadlineAt, now))).returning({id: providerRuns.id}); const stale = await this.database.update(providerRuns).set({status: 'reserved', leaseToken: null, leaseExpiresAt: null, updatedAt: now}).where(and(eq(providerRuns.status, 'processing'), lte(providerRuns.leaseExpiresAt, now))).returning({id: providerRuns.id}); return ambiguous.length + stale.length; }
  async acknowledgeAmbiguous(runId: string) { return this.database.transaction(async (transaction) => { const [before] = await transaction.select().from(providerRuns).where(and(eq(providerRuns.id, runId), eq(providerRuns.status, 'ambiguous'))).for('update'); if (!before) throw new Error('PROVIDER_RUN_NOT_AMBIGUOUS'); const [run] = await transaction.update(providerRuns).set({status: 'superseded_ambiguous', settledCostMicros: before.estimatedCostMicros, reservedCostMicros: 0, activeResult: false, updatedAt: this.now()}).where(eq(providerRuns.id, runId)).returning(); await transaction.update(projectProviderBudgets).set({reservedMicros: sql`${projectProviderBudgets.reservedMicros} - ${before.reservedCostMicros}`, settledMicros: sql`${projectProviderBudgets.settledMicros} + ${before.estimatedCostMicros}`, updatedAt: this.now()}).where(eq(projectProviderBudgets.projectId, before.projectId)); return mapRow(run); }); }
  async acknowledgeAndRetry(runId: string, budgetMicros: number, requestBudget: number) { return this.database.transaction(async (transaction) => {
    const [candidate] = await transaction.select({projectId: providerRuns.projectId}).from(providerRuns).where(and(eq(providerRuns.id, runId), eq(providerRuns.status, 'ambiguous'))).limit(1); if (!candidate) throw new Error('PROVIDER_RUN_NOT_AMBIGUOUS');
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${candidate.projectId}), hashtext('processing'))`);
    const [original] = await transaction.select().from(providerRuns).where(and(eq(providerRuns.id, runId), eq(providerRuns.status, 'ambiguous'))).for('update'); if (!original) throw new Error('PROVIDER_RUN_NOT_AMBIGUOUS');
    const [consent] = await transaction.select({id: projectConsents.id}).from(projectConsents).where(and(eq(projectConsents.id, original.consentId), eq(projectConsents.snapshotHash, original.consentSnapshotHash), sql`${projectConsents.invalidatedAt} IS NULL`)).limit(1); if (!consent) throw new Error('PROCESSING_CONSENT_REQUIRED');
    const [budget] = await transaction.select().from(projectProviderBudgets).where(eq(projectProviderBudgets.projectId, original.projectId)).for('update'); if (!budget || budget.reservedMicros + budget.settledMicros + original.estimatedCostMicros > Math.min(budget.limitMicros, budgetMicros)) throw new Error('PROJECT_PROVIDER_BUDGET_EXCEEDED');
    if (budget.reservedRequests + budget.settledRequests + 1 > Math.min(budget.requestLimit, requestBudget)) throw new Error('PROJECT_PROVIDER_REQUEST_BUDGET_EXCEEDED');
    const now = this.now(); await transaction.update(providerRuns).set({status: 'superseded_ambiguous', settledCostMicros: original.estimatedCostMicros, reservedCostMicros: 0, activeResult: false, updatedAt: now}).where(eq(providerRuns.id, original.id));
    const id = randomUUID(); const [retry] = await transaction.insert(providerRuns).values({id, projectId: original.projectId, consentId: original.consentId, consentSnapshotHash: original.consentSnapshotHash, dataCategories: original.dataCategories, provider: original.provider, model: original.model, operation: original.operation, inputFingerprint: original.inputFingerprint, status: 'reserved', estimatedCostMicros: original.estimatedCostMicros, reservedCostMicros: original.estimatedCostMicros, pricingVersion: original.pricingVersion, requestCount: 0, providerIdempotencyKey: `provider-run-${id}`, retryOfRunId: original.id, createdAt: now, updatedAt: now}).returning();
    await transaction.update(projectProviderBudgets).set({reservedMicros: sql`${projectProviderBudgets.reservedMicros} + ${original.estimatedCostMicros} - ${original.reservedCostMicros}`, settledMicros: sql`${projectProviderBudgets.settledMicros} + ${original.estimatedCostMicros}`, reservedRequests: sql`${projectProviderBudgets.reservedRequests} + 1`, updatedAt: now}).where(eq(projectProviderBudgets.projectId, original.projectId)); return mapRow(retry);
  }); }
}

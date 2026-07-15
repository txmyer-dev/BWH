import {randomUUID} from 'node:crypto';
import {and, eq, lte, ne, or, sql} from 'drizzle-orm';

import type {Database} from '../../server/db/client';
import {assetTranscripts, assets as mediaAssets, evidenceItems, processingJobs, projectProviderBudgets, providerRuns, transcriptEvidenceSegments} from '../../server/db/schema';
import type {ProviderResultWriter} from '../providers/types';
import {transcriptSchema, type Transcript} from './transcriber';
import type {EvidenceRepository} from '../evidence/evidence-repository';

export type AssetTranscript = Transcript & {
  id: string; projectId: string; assetId: string; providerRunId: string; createdAt: Date;
};
export type TranscriptionJob = {id: string; projectId: string; assetId: string; providerRunId: string; status: 'pending'|'processing'|'completed'|'failed'|'provider_ambiguous'|'retired_consent'; leaseToken: string|null; leaseExpiresAt: Date|null};

export interface TranscriptionRepository {
  findByProviderRun(projectId: string, providerRunId: string): Promise<AssetTranscript | undefined>;
  persistProviderResult(input: {
    writer: ProviderResultWriter; projectId: string; assetId: string; providerRunId: string; transcript: Transcript;
  }): Promise<AssetTranscript>;
  createJob(projectId: string, assetId: string, providerRunId: string): Promise<TranscriptionJob>;
  findJobByProviderRun(projectId: string, providerRunId: string): Promise<TranscriptionJob | undefined>;
  createRetryJob(projectId: string, oldProviderRunId: string, retryProviderRunId: string): Promise<TranscriptionJob>;
  claimJob(jobId: string, projectId: string, assetId: string, providerRunId: string, leaseMs: number, allowStaleRecovery: boolean): Promise<{outcome: 'claimed'; leaseToken: string}|{outcome: 'busy'|'completed'|'terminal'|'ambiguous'|'retired'|'missing'}>;
  completeJob(jobId: string, leaseToken: string): Promise<void>;
  failJob(jobId: string, leaseToken: string): Promise<void>;
  markAmbiguousJob(jobId: string, leaseToken: string): Promise<void>;
  retireConsentChanged(jobId: string, projectId: string, providerRunId: string): Promise<void>;
  hasTerminalFailure(projectId: string, assetId: string): Promise<boolean>;
}

const map = (row: typeof assetTranscripts.$inferSelect): AssetTranscript => {
  const transcript = transcriptSchema.parse({text: row.text, language: row.language, confidence: row.confidence, durationMs: row.durationMs, segments: row.segments});
  return {id: row.id, projectId: row.projectId, assetId: row.assetId, providerRunId: row.providerRunId, ...transcript, createdAt: row.createdAt};
};

export class PostgresTranscriptionRepository implements TranscriptionRepository {
  constructor(private readonly database: Database) {}
  async findByProviderRun(projectId: string, providerRunId: string) {
    const row = await this.database.query.assetTranscripts.findFirst({where: (table, {and: all, eq: equals}) => all(equals(table.projectId, projectId), equals(table.providerRunId, providerRunId))});
    if (!row) return undefined;
    return map(row);
  }
  async persistProviderResult(input: {writer: ProviderResultWriter; projectId: string; assetId: string; providerRunId: string; transcript: Transcript}) {
    const valid = transcriptSchema.parse(input.transcript);
    let persisted: AssetTranscript | undefined;
    await input.writer.writeStructured(async (transaction) => {
      const id = randomUUID();
      const [previous] = await transaction.select({providerRunId: assetTranscripts.providerRunId}).from(assetTranscripts).where(and(eq(assetTranscripts.projectId, input.projectId), eq(assetTranscripts.assetId, input.assetId)));
      if (previous && previous.providerRunId !== input.providerRunId) await transaction.update(providerRuns).set({activeResult: false, updatedAt: new Date()}).where(and(eq(providerRuns.id, previous.providerRunId), ne(providerRuns.id, input.providerRunId)));
      const [row] = await transaction.insert(assetTranscripts).values({
        id, projectId: input.projectId, assetId: input.assetId, providerRunId: input.providerRunId,
        text: valid.text, language: valid.language, confidence: valid.confidence,
        durationMs: valid.durationMs, segments: valid.segments
      }).onConflictDoUpdate({target: assetTranscripts.assetId, set: {
        providerRunId: input.providerRunId, text: valid.text, language: valid.language,
        confidence: valid.confidence, durationMs: valid.durationMs, segments: valid.segments, createdAt: new Date()
      }}).returning();
      if (!row) throw new Error('TRANSCRIPT_PERSIST_FAILED');
      await transaction.update(mediaAssets).set({metadata: sql`${mediaAssets.metadata} || ${JSON.stringify({durationMs: valid.durationMs})}::jsonb`, updatedAt: new Date()}).where(and(eq(mediaAssets.id, input.assetId), eq(mediaAssets.projectId, input.projectId)));
      await transaction.delete(evidenceItems).where(and(
        eq(evidenceItems.projectId, input.projectId), eq(evidenceItems.assetId, input.assetId),
        eq(evidenceItems.type, 'transcript'), eq(evidenceItems.verificationStatus, 'proposed')
      ));
      const evidenceRows = valid.segments.map((segment) => ({
        id: randomUUID(), projectId: input.projectId, assetId: input.assetId, type: 'transcript',
        claim: segment.text, originalClaim: segment.text, sourceAssetIds: [input.assetId],
        sourceExcerpt: segment.text, confidence: valid.confidence ?? 0, verificationStatus: 'proposed'
      }));
      if (evidenceRows.length) {
        await transaction.insert(evidenceItems).values(evidenceRows);
        await transaction.insert(transcriptEvidenceSegments).values(evidenceRows.map((evidence, index) => ({evidenceItemId: evidence.id, transcriptId: row.id, projectId: input.projectId, assetId: input.assetId, startMs: valid.segments[index].startMs, endMs: valid.segments[index].endMs})));
      }
      persisted = map(row);
    });
    if (!persisted) throw new Error('TRANSCRIPT_PERSIST_FAILED');
    return persisted;
  }
  async createJob(projectId: string, assetId: string, providerRunId: string): Promise<TranscriptionJob> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${projectId}), hashtext('processing'))`);
      const exact = await transaction.query.processingJobs.findFirst({where: (table, {and: all, eq: equals, inArray}) => all(equals(table.projectId, projectId), equals(table.assetId, assetId), equals(table.providerRunId, providerRunId), equals(table.jobType, 'transcribe_asset'), inArray(table.status, ['pending', 'processing', 'provider_ambiguous']))});
      if (exact) return {id: exact.id, projectId, assetId, providerRunId, status: exact.status as TranscriptionJob['status'], leaseToken: exact.leaseToken, leaseExpiresAt: exact.leaseExpiresAt};
      const [run] = await transaction.select({status: providerRuns.status, activeResult: providerRuns.activeResult}).from(providerRuns).where(and(eq(providerRuns.id, providerRunId), eq(providerRuns.projectId, projectId))).limit(1);
      if (!run || !run.activeResult || !['reserved', 'completed'].includes(run.status)) throw new Error('TRANSCRIPTION_JOB_PROVIDER_NOT_LINKABLE');
      const conflict = await transaction.query.processingJobs.findFirst({where: (table, {and: all, eq: equals, inArray}) => all(equals(table.projectId, projectId), equals(table.jobType, 'transcribe_asset'), inArray(table.status, ['pending', 'processing']))});
      if (conflict) throw new Error(conflict.assetId === assetId ? 'TRANSCRIPTION_JOB_PROVIDER_MISMATCH' : 'PROJECT_TRANSCRIPTION_BUSY');
      const [row] = await transaction.insert(processingJobs).values({id: randomUUID(), projectId, assetId, providerRunId, jobType: 'transcribe_asset'}).returning();
      return {id: row.id, projectId, assetId, providerRunId, status: 'pending' as const, leaseToken: null, leaseExpiresAt: null};
    });
  }
  async findJobByProviderRun(projectId: string, providerRunId: string) { const row = await this.database.query.processingJobs.findFirst({where: (table, {and: all, eq: equals}) => all(equals(table.projectId, projectId), equals(table.providerRunId, providerRunId), equals(table.jobType, 'transcribe_asset'))}); if (!row?.assetId) return undefined; return {id: row.id, projectId, assetId: row.assetId, providerRunId, status: row.status as TranscriptionJob['status'], leaseToken: row.leaseToken, leaseExpiresAt: row.leaseExpiresAt}; }
  async createRetryJob(projectId: string, oldProviderRunId: string, retryProviderRunId: string) { return this.database.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${projectId}), hashtext('processing'))`);
    const [retry] = await transaction.select().from(providerRuns).where(and(eq(providerRuns.id, retryProviderRunId), eq(providerRuns.projectId, projectId))).for('update');
    if (!retry || !retry.activeResult || retry.operation !== 'transcribe' || retry.retryOfRunId !== oldProviderRunId || !['reserved', 'processing', 'completed'].includes(retry.status)) throw new Error('TRANSCRIPTION_RETRY_RUN_INVALID');
    const existing = await transaction.query.processingJobs.findFirst({where: (table, {and: all, eq: equals, inArray}) => all(equals(table.projectId, projectId), equals(table.providerRunId, retryProviderRunId), equals(table.jobType, 'transcribe_asset'), inArray(table.status, ['pending', 'processing', 'completed']))});
    if (existing?.assetId) return {id: existing.id, projectId, assetId: existing.assetId, providerRunId: retryProviderRunId, status: existing.status as TranscriptionJob['status'], leaseToken: existing.leaseToken, leaseExpiresAt: existing.leaseExpiresAt};
    const [oldJob] = await transaction.select().from(processingJobs).where(and(eq(processingJobs.projectId, projectId), eq(processingJobs.providerRunId, oldProviderRunId), eq(processingJobs.jobType, 'transcribe_asset'))).for('update');
    if (!oldJob?.assetId || !['pending', 'processing', 'provider_ambiguous'].includes(oldJob.status)) throw new Error('TRANSCRIPTION_RETRY_SOURCE_INVALID');
    await transaction.update(processingJobs).set({status: 'provider_ambiguous', leaseToken: null, leaseExpiresAt: null, lastError: 'PROVIDER_RESULT_AMBIGUOUS', updatedAt: new Date()}).where(eq(processingJobs.id, oldJob.id));
    const conflict = await transaction.query.processingJobs.findFirst({where: (table, {and: all, eq: equals, inArray}) => all(equals(table.projectId, projectId), equals(table.jobType, 'transcribe_asset'), inArray(table.status, ['pending', 'processing']))});
    if (conflict) throw new Error('PROJECT_TRANSCRIPTION_BUSY');
    const [row] = await transaction.insert(processingJobs).values({id: randomUUID(), projectId, assetId: oldJob.assetId, providerRunId: retryProviderRunId, jobType: 'transcribe_asset'}).returning();
    return {id: row.id, projectId, assetId: oldJob.assetId, providerRunId: retryProviderRunId, status: 'pending' as const, leaseToken: null, leaseExpiresAt: null};
  }); }
  async claimJob(jobId: string, projectId: string, assetId: string, providerRunId: string, leaseMs: number, allowStaleRecovery: boolean) {
    const now = new Date(); const leaseToken = randomUUID();
    const claimable = allowStaleRecovery ? or(eq(processingJobs.status, 'pending'), and(eq(processingJobs.status, 'processing'), lte(processingJobs.leaseExpiresAt, now))) : eq(processingJobs.status, 'pending');
    const [row] = await this.database.update(processingJobs).set({status: 'processing', leaseToken, leaseExpiresAt: new Date(now.getTime() + leaseMs), processingStartedAt: now, attemptCount: sql`${processingJobs.attemptCount} + 1`, updatedAt: now}).where(and(eq(processingJobs.id, jobId), eq(processingJobs.projectId, projectId), eq(processingJobs.assetId, assetId), eq(processingJobs.providerRunId, providerRunId), eq(processingJobs.jobType, 'transcribe_asset'), claimable)).returning();
    if (row) return {outcome: 'claimed' as const, leaseToken};
    const existing = await this.database.query.processingJobs.findFirst({where: (table, {and: all, eq: equals}) => all(equals(table.id, jobId), equals(table.projectId, projectId), equals(table.assetId, assetId), equals(table.providerRunId, providerRunId), equals(table.jobType, 'transcribe_asset'))});
    if (!existing) return {outcome: 'missing' as const};
    return {outcome: existing.status === 'completed' ? 'completed' as const : existing.status === 'failed' ? 'terminal' as const : existing.status === 'provider_ambiguous' ? 'ambiguous' as const : existing.status === 'retired_consent' ? 'retired' as const : 'busy' as const};
  }
  async completeJob(jobId: string, leaseToken: string) {
    const [row] = await this.database.update(processingJobs).set({status: 'completed', leaseToken: null, leaseExpiresAt: null, updatedAt: new Date()}).where(and(eq(processingJobs.id, jobId), eq(processingJobs.leaseToken, leaseToken), eq(processingJobs.status, 'processing'))).returning();
    if (!row) throw new Error('TRANSCRIPTION_JOB_LEASE_LOST');
  }
  async failJob(jobId: string, leaseToken: string) { await this.database.update(processingJobs).set({status: 'failed', leaseToken: null, leaseExpiresAt: null, lastError: 'TRANSCRIPTION_FAILED', updatedAt: new Date()}).where(and(eq(processingJobs.id, jobId), eq(processingJobs.leaseToken, leaseToken))); }
  async markAmbiguousJob(jobId: string, leaseToken: string) { await this.database.update(processingJobs).set({status: 'provider_ambiguous', leaseToken: null, leaseExpiresAt: null, lastError: 'PROVIDER_RESULT_AMBIGUOUS', updatedAt: new Date()}).where(and(eq(processingJobs.id, jobId), eq(processingJobs.leaseToken, leaseToken))); }
  async retireConsentChanged(jobId: string, projectId: string, providerRunId: string) { await this.database.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${projectId}), hashtext('processing'))`);
    const [job] = await transaction.select().from(processingJobs).where(and(eq(processingJobs.id, jobId), eq(processingJobs.projectId, projectId), eq(processingJobs.providerRunId, providerRunId), eq(processingJobs.jobType, 'transcribe_asset'))).for('update');
    if (!job) throw new Error('TRANSCRIPTION_JOB_NOT_FOUND'); if (job.status === 'retired_consent') return;
    const [run] = await transaction.select().from(providerRuns).where(and(eq(providerRuns.id, providerRunId), eq(providerRuns.projectId, projectId))).for('update');
    if (!run || !run.activeResult || !['reserved', 'processing'].includes(run.status) || run.requestCount !== 0) throw new Error('TRANSCRIPTION_CONSENT_RETIRE_NOT_SAFE');
    const now = new Date();
    await transaction.update(processingJobs).set({status: 'retired_consent', leaseToken: null, leaseExpiresAt: null, lastError: 'PROVIDER_PREPARED_CONSENT_CHANGED', updatedAt: now}).where(eq(processingJobs.id, jobId));
    await transaction.update(providerRuns).set({status: 'failed', activeResult: false, reservedCostMicros: 0, settledCostMicros: 0, leaseToken: null, leaseExpiresAt: null, lastError: 'PROVIDER_PREPARED_CONSENT_CHANGED', updatedAt: now}).where(eq(providerRuns.id, providerRunId));
    await transaction.update(projectProviderBudgets).set({reservedMicros: sql`${projectProviderBudgets.reservedMicros} - ${run.reservedCostMicros}`, reservedRequests: sql`${projectProviderBudgets.reservedRequests} - 1`, updatedAt: now}).where(eq(projectProviderBudgets.projectId, projectId));
  }); }
  async hasTerminalFailure(projectId: string, assetId: string) { return Boolean(await this.database.query.processingJobs.findFirst({where: (table, {and: all, eq: equals}) => all(equals(table.projectId, projectId), equals(table.assetId, assetId), equals(table.jobType, 'transcribe_asset'), equals(table.status, 'failed'))})); }
}

export class InMemoryTranscriptionRepository implements TranscriptionRepository {
  private readonly records = new Map<string, AssetTranscript>();
  private readonly jobs = new Map<string, TranscriptionJob>();
  constructor(private readonly evidence?: EvidenceRepository) {}
  async findByProviderRun(projectId: string, providerRunId: string) {
    const found = [...this.records.values()].find((row) => row.projectId === projectId && row.providerRunId === providerRunId);
    return found && structuredClone(found);
  }
  async persistProviderResult(input: {writer: ProviderResultWriter; projectId: string; assetId: string; providerRunId: string; transcript: Transcript}) {
    const valid = transcriptSchema.parse(input.transcript);
    const record = {id: randomUUID(), projectId: input.projectId, assetId: input.assetId, providerRunId: input.providerRunId, ...valid, createdAt: new Date()};
    await input.writer.writeStructured(async () => {
      this.records.set(input.assetId, record);
      const items = await this.evidence?.createProposed(input.projectId, valid.segments.map((segment) => ({
        claim: segment.text, kind: 'transcript' as const, sourceAssetIds: [input.assetId],
        sourceExcerpt: segment.text, confidence: valid.confidence ?? 0, proposedStatus: 'proposed' as const
      })));
      for (const [index, item] of (items ?? []).entries()) await this.evidence?.linkTranscriptSegment?.(input.projectId, item.id, {transcriptId: record.id, assetId: input.assetId, startMs: valid.segments[index].startMs, endMs: valid.segments[index].endMs});
    });
    return structuredClone(record);
  }
  async createJob(projectId: string, assetId: string, providerRunId: string) {
    const exact = [...this.jobs.values()].find((job) => job.projectId === projectId && job.assetId === assetId && job.providerRunId === providerRunId && ['pending', 'processing', 'provider_ambiguous'].includes(job.status));
    if (exact) return structuredClone(exact);
    if ([...this.jobs.values()].some((job) => job.projectId === projectId && ['pending', 'processing'].includes(job.status))) throw new Error('PROJECT_TRANSCRIPTION_BUSY');
    const job: TranscriptionJob = {id: randomUUID(), projectId, assetId, providerRunId, status: 'pending', leaseToken: null, leaseExpiresAt: null}; this.jobs.set(job.id, job); return structuredClone(job);
  }
  async findJobByProviderRun(projectId: string, providerRunId: string) { const job = [...this.jobs.values()].find((candidate) => candidate.projectId === projectId && candidate.providerRunId === providerRunId); return job && structuredClone(job); }
  async createRetryJob(projectId: string, oldProviderRunId: string, retryProviderRunId: string) {
    const existing = [...this.jobs.values()].find((job) => job.projectId === projectId && job.providerRunId === retryProviderRunId && ['pending', 'processing', 'completed'].includes(job.status)); if (existing) return structuredClone(existing);
    const oldJob = [...this.jobs.values()].find((job) => job.projectId === projectId && job.providerRunId === oldProviderRunId); if (!oldJob || !['pending', 'processing', 'provider_ambiguous'].includes(oldJob.status)) throw new Error('TRANSCRIPTION_RETRY_SOURCE_INVALID');
    const conflict = [...this.jobs.values()].find((job) => job.projectId === projectId && job.id !== oldJob.id && ['pending', 'processing'].includes(job.status)); if (conflict) throw new Error('PROJECT_TRANSCRIPTION_BUSY');
    oldJob.status = 'provider_ambiguous'; oldJob.leaseToken = null; oldJob.leaseExpiresAt = null;
    const job: TranscriptionJob = {id: randomUUID(), projectId, assetId: oldJob.assetId, providerRunId: retryProviderRunId, status: 'pending', leaseToken: null, leaseExpiresAt: null}; this.jobs.set(job.id, job); return structuredClone(job);
  }
  async claimJob(jobId: string, projectId: string, assetId: string, providerRunId: string, leaseMs: number, allowStaleRecovery: boolean) {
    const job = this.jobs.get(jobId); const now = new Date();
    if (!job || job.projectId !== projectId || job.assetId !== assetId || job.providerRunId !== providerRunId) return {outcome: 'missing' as const};
    if (job.status === 'completed') return {outcome: 'completed' as const}; if (job.status === 'failed') return {outcome: 'terminal' as const}; if (job.status === 'provider_ambiguous') return {outcome: 'ambiguous' as const}; if (job.status === 'retired_consent') return {outcome: 'retired' as const};
    if (job.status === 'processing' && (!allowStaleRecovery || !job.leaseExpiresAt || job.leaseExpiresAt > now)) return {outcome: 'busy' as const};
    job.status = 'processing'; job.leaseToken = randomUUID(); job.leaseExpiresAt = new Date(now.getTime() + leaseMs); return {outcome: 'claimed' as const, leaseToken: job.leaseToken};
  }
  async completeJob(jobId: string, leaseToken: string) { const job = this.jobs.get(jobId); if (!job || job.leaseToken !== leaseToken || job.status !== 'processing') throw new Error('TRANSCRIPTION_JOB_LEASE_LOST'); job.status = 'completed'; job.leaseToken = null; job.leaseExpiresAt = null; }
  async failJob(jobId: string, leaseToken: string) { const job = this.jobs.get(jobId); if (job?.leaseToken === leaseToken) { job.status = 'failed'; job.leaseToken = null; job.leaseExpiresAt = null; } }
  async hasTerminalFailure(projectId: string, assetId: string) { return [...this.jobs.values()].some((job) => job.projectId === projectId && job.assetId === assetId && job.status === 'failed'); }
  async markAmbiguousJob(jobId: string, leaseToken: string) { const job = this.jobs.get(jobId); if (job?.leaseToken === leaseToken) { job.status = 'provider_ambiguous'; job.leaseToken = null; job.leaseExpiresAt = null; } }
  async retireConsentChanged(jobId: string, projectId: string, providerRunId: string) { const job = this.jobs.get(jobId); if (!job || job.projectId !== projectId || job.providerRunId !== providerRunId) throw new Error('TRANSCRIPTION_JOB_NOT_FOUND'); if (!['pending', 'processing', 'retired_consent'].includes(job.status)) throw new Error('TRANSCRIPTION_CONSENT_RETIRE_NOT_SAFE'); job.status = 'retired_consent'; job.leaseToken = null; job.leaseExpiresAt = null; }
  recordTerminalFailure(projectId: string, assetId: string) { const job: TranscriptionJob = {id: randomUUID(), projectId, assetId, providerRunId: randomUUID(), status: 'failed', leaseToken: null, leaseExpiresAt: null}; this.jobs.set(job.id, job); }
  allJobs() { return [...this.jobs.values()].map((job) => structuredClone(job)); }
  expireJobForTest(jobId: string) { const job = this.jobs.get(jobId); if (job) job.leaseExpiresAt = new Date(0); }
  retireLinkedConsentWorkForTest(providerRunId: string) { const job = [...this.jobs.values()].find((candidate) => candidate.providerRunId === providerRunId && ['pending', 'processing'].includes(candidate.status)); if (job) { job.status = 'retired_consent'; job.leaseToken = null; job.leaseExpiresAt = null; } }
}

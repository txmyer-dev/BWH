import {randomUUID} from 'node:crypto';
import {and, eq, lte, ne, or, sql} from 'drizzle-orm';

import type {Database} from '../../server/db/client';
import {assetTranscripts, assets as mediaAssets, evidenceItems, processingJobs, providerRuns} from '../../server/db/schema';
import type {ProviderResultWriter} from '../providers/types';
import {transcriptSchema, type Transcript} from './transcriber';
import type {EvidenceRepository} from '../evidence/evidence-repository';

export type AssetTranscript = Transcript & {
  id: string; projectId: string; assetId: string; providerRunId: string; createdAt: Date;
};
export type TranscriptionJob = {id: string; projectId: string; assetId: string; status: 'pending'|'processing'|'completed'|'failed'; leaseToken: string|null; leaseExpiresAt: Date|null};

export interface TranscriptionRepository {
  findByProviderRun(projectId: string, providerRunId: string): Promise<AssetTranscript | undefined>;
  persistProviderResult(input: {
    writer: ProviderResultWriter; projectId: string; assetId: string; providerRunId: string; transcript: Transcript;
  }): Promise<AssetTranscript>;
  createJob(projectId: string, assetId: string): Promise<TranscriptionJob>;
  claimJob(jobId: string, projectId: string, assetId: string, leaseMs: number): Promise<{outcome: 'claimed'; leaseToken: string}|{outcome: 'busy'|'completed'|'terminal'|'missing'}>;
  completeJob(jobId: string, leaseToken: string): Promise<void>;
  failJob(jobId: string, leaseToken: string): Promise<void>;
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
      if (valid.segments.length) await transaction.insert(evidenceItems).values(valid.segments.map((segment) => ({
        id: randomUUID(), projectId: input.projectId, assetId: input.assetId, type: 'transcript',
        claim: segment.text, originalClaim: segment.text, sourceAssetIds: [input.assetId],
        sourceExcerpt: segment.text, confidence: valid.confidence ?? 0, verificationStatus: 'proposed'
      })));
      persisted = map(row);
    });
    if (!persisted) throw new Error('TRANSCRIPT_PERSIST_FAILED');
    return persisted;
  }
  async createJob(projectId: string, assetId: string): Promise<TranscriptionJob> {
    const existing = await this.database.query.processingJobs.findFirst({where: (table, {and: all, eq: equals, inArray}) => all(equals(table.projectId, projectId), equals(table.assetId, assetId), equals(table.jobType, 'transcribe_asset'), inArray(table.status, ['pending', 'processing']))});
    if (existing) return {id: existing.id, projectId, assetId, status: existing.status as TranscriptionJob['status'], leaseToken: existing.leaseToken, leaseExpiresAt: existing.leaseExpiresAt};
    const [row] = await this.database.insert(processingJobs).values({id: randomUUID(), projectId, assetId, jobType: 'transcribe_asset'}).onConflictDoNothing().returning();
    if (!row) return this.createJob(projectId, assetId);
    return {id: row.id, projectId, assetId, status: 'pending' as const, leaseToken: null, leaseExpiresAt: null};
  }
  async claimJob(jobId: string, projectId: string, assetId: string, leaseMs: number) {
    const now = new Date(); const leaseToken = randomUUID();
    const [row] = await this.database.update(processingJobs).set({status: 'processing', leaseToken, leaseExpiresAt: new Date(now.getTime() + leaseMs), processingStartedAt: now, attemptCount: sql`${processingJobs.attemptCount} + 1`, updatedAt: now}).where(and(eq(processingJobs.id, jobId), eq(processingJobs.projectId, projectId), eq(processingJobs.assetId, assetId), eq(processingJobs.jobType, 'transcribe_asset'), or(eq(processingJobs.status, 'pending'), and(eq(processingJobs.status, 'processing'), lte(processingJobs.leaseExpiresAt, now))))).returning();
    if (row) return {outcome: 'claimed' as const, leaseToken};
    const existing = await this.database.query.processingJobs.findFirst({where: (table, {and: all, eq: equals}) => all(equals(table.id, jobId), equals(table.projectId, projectId), equals(table.assetId, assetId), equals(table.jobType, 'transcribe_asset'))});
    if (!existing) return {outcome: 'missing' as const};
    return {outcome: existing.status === 'completed' ? 'completed' as const : existing.status === 'failed' ? 'terminal' as const : 'busy' as const};
  }
  async completeJob(jobId: string, leaseToken: string) {
    const [row] = await this.database.update(processingJobs).set({status: 'completed', leaseToken: null, leaseExpiresAt: null, updatedAt: new Date()}).where(and(eq(processingJobs.id, jobId), eq(processingJobs.leaseToken, leaseToken), eq(processingJobs.status, 'processing'))).returning();
    if (!row) throw new Error('TRANSCRIPTION_JOB_LEASE_LOST');
  }
  async failJob(jobId: string, leaseToken: string) { await this.database.update(processingJobs).set({status: 'failed', leaseToken: null, leaseExpiresAt: null, lastError: 'TRANSCRIPTION_FAILED', updatedAt: new Date()}).where(and(eq(processingJobs.id, jobId), eq(processingJobs.leaseToken, leaseToken))); }
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
      await this.evidence?.createProposed(input.projectId, valid.segments.map((segment) => ({
        claim: segment.text, kind: 'transcript' as const, sourceAssetIds: [input.assetId],
        sourceExcerpt: segment.text, confidence: valid.confidence ?? 0, proposedStatus: 'proposed' as const
      })));
    });
    return structuredClone(record);
  }
  async createJob(projectId: string, assetId: string) {
    const existing = [...this.jobs.values()].find((job) => job.projectId === projectId && job.assetId === assetId && ['pending', 'processing'].includes(job.status));
    if (existing) return structuredClone(existing);
    const job: TranscriptionJob = {id: randomUUID(), projectId, assetId, status: 'pending', leaseToken: null, leaseExpiresAt: null}; this.jobs.set(job.id, job); return structuredClone(job);
  }
  async claimJob(jobId: string, projectId: string, assetId: string, leaseMs: number) {
    const job = this.jobs.get(jobId); const now = new Date();
    if (!job || job.projectId !== projectId || job.assetId !== assetId) return {outcome: 'missing' as const};
    if (job.status === 'completed') return {outcome: 'completed' as const}; if (job.status === 'failed') return {outcome: 'terminal' as const};
    if (job.status === 'processing' && job.leaseExpiresAt && job.leaseExpiresAt > now) return {outcome: 'busy' as const};
    job.status = 'processing'; job.leaseToken = randomUUID(); job.leaseExpiresAt = new Date(now.getTime() + leaseMs); return {outcome: 'claimed' as const, leaseToken: job.leaseToken};
  }
  async completeJob(jobId: string, leaseToken: string) { const job = this.jobs.get(jobId); if (!job || job.leaseToken !== leaseToken || job.status !== 'processing') throw new Error('TRANSCRIPTION_JOB_LEASE_LOST'); job.status = 'completed'; job.leaseToken = null; job.leaseExpiresAt = null; }
  async failJob(jobId: string, leaseToken: string) { const job = this.jobs.get(jobId); if (job?.leaseToken === leaseToken) { job.status = 'failed'; job.leaseToken = null; job.leaseExpiresAt = null; } }
  async hasTerminalFailure(projectId: string, assetId: string) { return [...this.jobs.values()].some((job) => job.projectId === projectId && job.assetId === assetId && job.status === 'failed'); }
  recordTerminalFailure(projectId: string, assetId: string) { const job: TranscriptionJob = {id: randomUUID(), projectId, assetId, status: 'failed', leaseToken: null, leaseExpiresAt: null}; this.jobs.set(job.id, job); }
}

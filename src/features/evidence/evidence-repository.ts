import {randomUUID} from 'node:crypto';
import {and, eq, inArray, lte, or, sql} from 'drizzle-orm';

import type {Database} from '../../server/db/client';
import {evidenceItems, processingJobs} from '../../server/db/schema';
import type {EvidenceCandidate} from '../story/schemas';
import type {EvidenceItem, VerificationStatus} from './schemas';

export interface AnalysisJob {
  id: string;
  projectId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attemptCount: number;
  processingStartedAt: Date | null;
  leaseExpiresAt: Date | null;
  leaseToken: string | null;
}

export type ClaimResult =
  | {outcome: 'claimed'; leaseToken: string}
  | {outcome: 'busy'}
  | {outcome: 'completed'}
  | {outcome: 'missing'};

export interface EvidenceRepository {
  findActiveAnalysisJob(projectId: string): Promise<AnalysisJob | undefined>;
  createAnalysisJob(projectId: string): Promise<AnalysisJob>;
  claimAnalysisJob(jobId: string, projectId: string, now: Date, leaseMs: number): Promise<ClaimResult>;
  completeAnalysis(jobId: string, projectId: string, leaseToken: string, candidates: EvidenceCandidate[]): Promise<void>;
  failAnalysis(jobId: string, leaseToken: string, message: string): Promise<void>;
  createProposed(projectId: string, candidates: EvidenceCandidate[]): Promise<EvidenceItem[]>;
  findById(id: string): Promise<EvidenceItem | undefined>;
  review(id: string, status: Exclude<VerificationStatus, 'proposed'>, correction?: string): Promise<EvidenceItem>;
  listByProject(projectId: string): Promise<EvidenceItem[]>;
}

const mapEvidence = (row: typeof evidenceItems.$inferSelect): EvidenceItem => ({
  id: row.id, projectId: row.projectId, kind: row.type as EvidenceItem['kind'],
  claim: row.claim, originalClaim: row.originalClaim,
  sourceAssetIds: row.sourceAssetIds as string[], sourceExcerpt: row.sourceExcerpt,
  confidence: row.confidence, verificationStatus: row.verificationStatus as VerificationStatus,
  correction: row.correction
});

const mapJob = (row: typeof processingJobs.$inferSelect): AnalysisJob => ({
  id: row.id, projectId: row.projectId, status: row.status as AnalysisJob['status'],
  attemptCount: row.attemptCount, processingStartedAt: row.processingStartedAt,
  leaseExpiresAt: row.leaseExpiresAt, leaseToken: row.leaseToken
});

export class PostgresEvidenceRepository implements EvidenceRepository {
  constructor(private readonly database: Database) {}

  async findActiveAnalysisJob(projectId: string) {
    const row = await this.database.query.processingJobs.findFirst({
      where: (table, {and: all, eq: equals, inArray: inList}) => all(equals(table.projectId, projectId), equals(table.jobType, 'analyze_collection'), inList(table.status, ['pending', 'processing']))
    });
    return row ? mapJob(row) : undefined;
  }

  async createAnalysisJob(projectId: string) {
    const existing = await this.findActiveAnalysisJob(projectId);
    if (existing) return existing;
    const [row] = await this.database.insert(processingJobs).values({id: randomUUID(), projectId, jobType: 'analyze_collection'}).onConflictDoNothing().returning();
    if (!row) {
      const raced = await this.findActiveAnalysisJob(projectId);
      if (!raced) throw new Error('ANALYSIS_JOB_CONFLICT');
      return raced;
    }
    return mapJob(row);
  }

  async claimAnalysisJob(jobId: string, projectId: string, now: Date, leaseMs: number): Promise<ClaimResult> {
    const leaseToken = randomUUID();
    const [row] = await this.database.update(processingJobs).set({
      status: 'processing', attemptCount: sql`${processingJobs.attemptCount} + 1`,
      processingStartedAt: now, leaseExpiresAt: new Date(now.getTime() + leaseMs),
      leaseToken, lastError: null, updatedAt: now
    }).where(and(
      eq(processingJobs.id, jobId), eq(processingJobs.projectId, projectId),
      or(inArray(processingJobs.status, ['pending', 'failed']), and(eq(processingJobs.status, 'processing'), lte(processingJobs.leaseExpiresAt, now)))
    )).returning();
    if (row) return {outcome: 'claimed', leaseToken};
    const existing = await this.database.query.processingJobs.findFirst({where: (table, {and: all, eq: equals}) => all(equals(table.id, jobId), equals(table.projectId, projectId))});
    if (!existing) return {outcome: 'missing'};
    return {outcome: existing.status === 'completed' ? 'completed' : 'busy'};
  }

  async completeAnalysis(jobId: string, projectId: string, leaseToken: string, candidates: EvidenceCandidate[]) {
    await this.database.transaction(async (transaction) => {
      const [claimed] = await transaction.update(processingJobs).set({status: 'completed', leaseToken: null, leaseExpiresAt: null, updatedAt: new Date()}).where(and(eq(processingJobs.id, jobId), eq(processingJobs.projectId, projectId), eq(processingJobs.status, 'processing'), eq(processingJobs.leaseToken, leaseToken))).returning();
      if (!claimed) throw new Error('ANALYSIS_LEASE_LOST');
      if (candidates.length) await transaction.insert(evidenceItems).values(candidates.map((candidate) => ({
        id: randomUUID(), projectId, type: candidate.kind, claim: candidate.claim,
        originalClaim: candidate.claim, sourceAssetIds: candidate.sourceAssetIds,
        sourceExcerpt: candidate.sourceExcerpt, confidence: candidate.confidence,
        verificationStatus: 'proposed'
      })));
    });
  }

  async failAnalysis(jobId: string, leaseToken: string, message: string) {
    await this.database.update(processingJobs).set({status: 'failed', leaseToken: null, leaseExpiresAt: null, lastError: message, updatedAt: new Date()}).where(and(eq(processingJobs.id, jobId), eq(processingJobs.leaseToken, leaseToken)));
  }

  async createProposed(projectId: string, candidates: EvidenceCandidate[]) {
    if (!candidates.length) return [];
    const rows = await this.database.insert(evidenceItems).values(candidates.map((candidate) => ({id: randomUUID(), projectId, type: candidate.kind, claim: candidate.claim, originalClaim: candidate.claim, sourceAssetIds: candidate.sourceAssetIds, sourceExcerpt: candidate.sourceExcerpt, confidence: candidate.confidence, verificationStatus: 'proposed'}))).returning();
    return rows.map(mapEvidence);
  }

  async findById(id: string) {
    const row = await this.database.query.evidenceItems.findFirst({where: (table, {eq: equals}) => equals(table.id, id)});
    return row ? mapEvidence(row) : undefined;
  }

  async review(id: string, status: Exclude<VerificationStatus, 'proposed'>, correction?: string) {
    const [row] = await this.database.update(evidenceItems).set({verificationStatus: status, correction: correction ?? null, updatedAt: new Date()}).where(and(eq(evidenceItems.id, id), eq(evidenceItems.verificationStatus, 'proposed'))).returning();
    if (!row) throw new Error('EVIDENCE_ALREADY_REVIEWED');
    return mapEvidence(row);
  }

  async listByProject(projectId: string) {
    return (await this.database.query.evidenceItems.findMany({where: (table, {eq: equals}) => equals(table.projectId, projectId)})).map(mapEvidence);
  }
}

export class InMemoryEvidenceRepository implements EvidenceRepository {
  private readonly evidence = new Map<string, EvidenceItem>();
  private readonly jobs = new Map<string, AnalysisJob>();

  async findActiveAnalysisJob(projectId: string) { return [...this.jobs.values()].find((job) => job.projectId === projectId && ['pending', 'processing'].includes(job.status)); }
  async createAnalysisJob(projectId: string) {
    const active = [...this.jobs.values()].find((job) => job.projectId === projectId && ['pending', 'processing'].includes(job.status));
    if (active) return {...active};
    const job: AnalysisJob = {id: randomUUID(), projectId, status: 'pending', attemptCount: 0, processingStartedAt: null, leaseExpiresAt: null, leaseToken: null};
    this.jobs.set(job.id, job); return {...job};
  }
  async claimAnalysisJob(jobId: string, projectId: string, now: Date, leaseMs: number): Promise<ClaimResult> {
    const job = this.jobs.get(jobId);
    if (!job || job.projectId !== projectId) return {outcome: 'missing'};
    if (job.status === 'completed') return {outcome: 'completed'};
    const reclaimable = job.status === 'processing' && job.leaseExpiresAt !== null && job.leaseExpiresAt <= now;
    if (!['pending', 'failed'].includes(job.status) && !reclaimable) return {outcome: 'busy'};
    const leaseToken = randomUUID();
    this.jobs.set(jobId, {...job, status: 'processing', attemptCount: job.attemptCount + 1, processingStartedAt: now, leaseExpiresAt: new Date(now.getTime() + leaseMs), leaseToken});
    return {outcome: 'claimed', leaseToken};
  }
  async completeAnalysis(jobId: string, projectId: string, leaseToken: string, candidates: EvidenceCandidate[]) {
    const job = this.jobs.get(jobId);
    if (!job || job.projectId !== projectId || job.status !== 'processing' || job.leaseToken !== leaseToken) throw new Error('ANALYSIS_LEASE_LOST');
    await this.createProposed(projectId, candidates);
    this.jobs.set(jobId, {...job, status: 'completed', leaseToken: null, leaseExpiresAt: null});
  }
  async failAnalysis(jobId: string, leaseToken: string) { const job = this.jobs.get(jobId); if (job?.leaseToken === leaseToken) this.jobs.set(jobId, {...job, status: 'failed', leaseToken: null, leaseExpiresAt: null}); }
  async createProposed(projectId: string, candidates: EvidenceCandidate[]) {
    return candidates.map((candidate) => {
      const item: EvidenceItem = {id: randomUUID(), projectId, kind: candidate.kind, claim: candidate.claim, originalClaim: candidate.claim, sourceAssetIds: [...candidate.sourceAssetIds], sourceExcerpt: candidate.sourceExcerpt, confidence: candidate.confidence, verificationStatus: 'proposed', correction: null};
      this.evidence.set(item.id, item); return {...item, sourceAssetIds: [...item.sourceAssetIds]};
    });
  }
  async findById(id: string) { const item = this.evidence.get(id); return item ? {...item, sourceAssetIds: [...item.sourceAssetIds]} : undefined; }
  async review(id: string, status: Exclude<VerificationStatus, 'proposed'>, correction?: string) {
    const item = this.evidence.get(id);
    if (!item) throw new Error('EVIDENCE_NOT_FOUND');
    if (item.verificationStatus !== 'proposed') throw new Error('EVIDENCE_ALREADY_REVIEWED');
    const reviewed = {...item, verificationStatus: status, correction: correction ?? null};
    this.evidence.set(id, reviewed); return {...reviewed, sourceAssetIds: [...reviewed.sourceAssetIds]};
  }
  async listByProject(projectId: string) { return [...this.evidence.values()].filter((item) => item.projectId === projectId).map((item) => ({...item, sourceAssetIds: [...item.sourceAssetIds]})); }
  allJobsForProject(projectId: string) { return [...this.jobs.values()].filter((job) => job.projectId === projectId).map((job) => ({...job})); }
}

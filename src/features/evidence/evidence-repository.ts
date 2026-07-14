import {randomUUID} from 'node:crypto';
import {and, eq, inArray, sql} from 'drizzle-orm';

import type {Database} from '../../server/db/client';
import {evidenceItems, processingJobs} from '../../server/db/schema';
import type {EvidenceCandidate} from '../story/schemas';
import type {EvidenceItem, VerificationStatus} from './schemas';

export interface AnalysisJob {id: string; projectId: string; status: 'pending' | 'processing' | 'completed' | 'failed'}

export interface EvidenceRepository {
  findActiveAnalysisJob(projectId: string): Promise<AnalysisJob | undefined>;
  createAnalysisJob(projectId: string): Promise<AnalysisJob>;
  claimAnalysisJob(jobId: string, projectId: string): Promise<boolean>;
  completeAnalysis(jobId: string, projectId: string, candidates: EvidenceCandidate[]): Promise<void>;
  failAnalysis(jobId: string, message: string): Promise<void>;
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

export class PostgresEvidenceRepository implements EvidenceRepository {
  constructor(private readonly database: Database) {}

  async findActiveAnalysisJob(projectId: string) {
    const row = await this.database.query.processingJobs.findFirst({
      where: (table, {and: all, eq: equals, inArray: inList}) => all(equals(table.projectId, projectId), equals(table.jobType, 'analyze_collection'), inList(table.status, ['pending', 'processing']))
    });
    return row ? {id: row.id, projectId: row.projectId, status: row.status as AnalysisJob['status']} : undefined;
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
    return {id: row.id, projectId: row.projectId, status: row.status as AnalysisJob['status']};
  }

  async claimAnalysisJob(jobId: string, projectId: string) {
    const [row] = await this.database.update(processingJobs).set({status: 'processing', attemptCount: sql`${processingJobs.attemptCount} + 1`, lastError: null, updatedAt: new Date()}).where(and(eq(processingJobs.id, jobId), eq(processingJobs.projectId, projectId), inArray(processingJobs.status, ['pending', 'failed']))).returning();
    return Boolean(row);
  }

  async completeAnalysis(jobId: string, projectId: string, candidates: EvidenceCandidate[]) {
    await this.database.transaction(async (transaction) => {
      if (candidates.length) await transaction.insert(evidenceItems).values(candidates.map((candidate) => ({
        id: randomUUID(), projectId, type: candidate.kind, claim: candidate.claim,
        originalClaim: candidate.claim, sourceAssetIds: candidate.sourceAssetIds,
        sourceExcerpt: candidate.sourceExcerpt, confidence: candidate.confidence,
        verificationStatus: 'proposed'
      })));
      await transaction.update(processingJobs).set({status: 'completed', updatedAt: new Date()}).where(and(eq(processingJobs.id, jobId), eq(processingJobs.projectId, projectId), eq(processingJobs.status, 'processing')));
    });
  }

  async failAnalysis(jobId: string, message: string) {
    await this.database.update(processingJobs).set({status: 'failed', lastError: message, updatedAt: new Date()}).where(eq(processingJobs.id, jobId));
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
    const active = await this.findActiveAnalysisJob(projectId);
    if (active) return {...active};
    const job: AnalysisJob = {id: randomUUID(), projectId, status: 'pending'};
    this.jobs.set(job.id, job); return {...job};
  }
  async claimAnalysisJob(jobId: string, projectId: string) {
    const job = this.jobs.get(jobId);
    if (!job || job.projectId !== projectId || !['pending', 'failed'].includes(job.status)) return false;
    this.jobs.set(jobId, {...job, status: 'processing'}); return true;
  }
  async completeAnalysis(jobId: string, projectId: string, candidates: EvidenceCandidate[]) {
    const job = this.jobs.get(jobId);
    if (!job || job.projectId !== projectId || job.status !== 'processing') return;
    await this.createProposed(projectId, candidates);
    this.jobs.set(jobId, {...job, status: 'completed'});
  }
  async failAnalysis(jobId: string) { const job = this.jobs.get(jobId); if (job) this.jobs.set(jobId, {...job, status: 'failed'}); }
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
}

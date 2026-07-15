import {createHash, randomUUID} from 'node:crypto';
import {and, asc, eq, inArray} from 'drizzle-orm';

import type {Database} from '../../server/db/client';
import {evidenceItems, factualityAudits, storyboards} from '../../server/db/schema';
import type {ProviderResultWriter} from '../providers/types';
import {effectiveEvidenceClaim} from '../story/story-service';
import type {AuditFinding, FactualityAuditInput, FactualityAuditResult} from './schemas';

export type AuditSnapshot = Omit<FactualityAuditInput, 'evidenceHash'|'narrationHash'> & {durationSeconds: number};
export interface AuditRepository {
  loadSnapshot(projectId: string): Promise<AuditSnapshot>;
  persistAudit(writer: ProviderResultWriter, input: FactualityAuditInput, providerRunId: string, findings: AuditFinding[]): Promise<string>;
  findByProviderRun(projectId: string, providerRunId: string): Promise<FactualityAuditResult | undefined>;
  findById(projectId: string, auditId: string): Promise<FactualityAuditResult | undefined>;
  approve(projectId: string, audit: FactualityAuditResult): Promise<{narrationApproved: true; auditId: string}>;
}

const mapAudit = (row: typeof factualityAudits.$inferSelect): FactualityAuditResult => ({
  auditId: row.id, providerRunId: row.providerRunId, projectId: row.projectId,
  storyboardId: row.storyboardId, storyboardRevision: row.storyboardRevision,
  evidenceHash: row.evidenceHash, narrationHash: row.narrationHash,
  status: row.status as 'passed'|'blocked', findings: row.findings as AuditFinding[]
});

export class PostgresAuditRepository implements AuditRepository {
  constructor(private readonly database: Database) {}
  async loadSnapshot(projectId: string) {
    const board = await this.database.query.storyboards.findFirst({where: (table, {eq: equals}) => equals(table.projectId, projectId)});
    if (!board) throw new Error('STORYBOARD_NOT_FOUND');
    const scenes = await this.database.query.filmScenes.findMany({where: (table, {eq: equals}) => equals(table.storyboardId, board.id), orderBy: (table) => asc(table.sequenceOrder)});
    const citedIds = [...new Set(scenes.flatMap((scene) => (scene.evidenceItemIds as string[])))];
    const rows = citedIds.length ? await this.database.select().from(evidenceItems).where(and(eq(evidenceItems.projectId, projectId), inArray(evidenceItems.id, citedIds), inArray(evidenceItems.verificationStatus, ['confirmed', 'corrected']))) : [];
    if (rows.length !== citedIds.length) throw new Error('AUDIT_APPROVED_EVIDENCE_REQUIRED');
    const byId = new Map(rows.map((row) => [row.id, row]));
    return {
      projectId, storyboardId: board.id, storyboardRevision: board.revision,
      durationSeconds: scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0),
      evidence: citedIds.map((id) => { const row = byId.get(id)!; return {id, claim: effectiveEvidenceClaim({verificationStatus: row.verificationStatus, correction: row.correction, claim: row.claim} as never), sourceExcerpt: row.verificationStatus === 'corrected' ? `Creator correction: ${row.correction}` : row.sourceExcerpt, sourceAssetIds: row.sourceAssetIds as string[]}; }),
      narration: scenes.filter((scene) => Boolean(scene.narrationText?.trim())).map((scene) => ({sceneId: scene.id, text: scene.narrationText!.trim(), evidenceItemIds: [...(scene.evidenceItemIds as string[])]}))
    };
  }
  async persistAudit(writer: ProviderResultWriter, input: FactualityAuditInput, providerRunId: string, findings: AuditFinding[]) {
    const id = randomUUID(); const status = findings.some((finding) => finding.blocking) ? 'blocked' : 'passed';
    await writer.writeStructured(async (transaction) => {
      await transaction.insert(factualityAudits).values({id, projectId: input.projectId, storyboardId: input.storyboardId, providerRunId, storyboardRevision: input.storyboardRevision, evidenceHash: input.evidenceHash, narrationHash: input.narrationHash, status, findings});
      const [current] = await transaction.update(storyboards).set({currentAuditId: id, narrationApprovedAt: null, narrationApprovalAuditId: null, narrationApprovalEvidenceHash: null, narrationApprovalHash: null, audioApprovedAt: null, narrationTrackSelection: null, renderManifest: null, updatedAt: new Date()}).where(and(eq(storyboards.id, input.storyboardId), eq(storyboards.projectId, input.projectId), eq(storyboards.revision, input.storyboardRevision))).returning({id: storyboards.id});
      if (!current) throw new Error('AUDIT_STALE_DURING_DISPATCH');
    });
    return id;
  }
  async findByProviderRun(projectId: string, providerRunId: string) { const [row] = await this.database.select().from(factualityAudits).where(and(eq(factualityAudits.projectId, projectId), eq(factualityAudits.providerRunId, providerRunId))).limit(1); return row ? mapAudit(row) : undefined; }
  async findById(projectId: string, auditId: string) { const [row] = await this.database.select().from(factualityAudits).where(and(eq(factualityAudits.projectId, projectId), eq(factualityAudits.id, auditId))).limit(1); return row ? mapAudit(row) : undefined; }
  async approve(projectId: string, audit: FactualityAuditResult) {
    return this.database.transaction(async (transaction) => {
      const [board] = await transaction.select().from(storyboards).where(and(eq(storyboards.id, audit.storyboardId), eq(storyboards.projectId, projectId))).for('update');
      if (!board || board.revision !== audit.storyboardRevision || board.currentAuditId !== audit.auditId) throw new Error('AUDIT_STALE');
      const [updated] = await transaction.update(storyboards).set({narrationApprovedAt: new Date(), narrationApprovalAuditId: audit.auditId, narrationApprovalEvidenceHash: audit.evidenceHash, narrationApprovalHash: audit.narrationHash, updatedAt: new Date()}).where(and(eq(storyboards.id, board.id), eq(storyboards.revision, audit.storyboardRevision))).returning({id: storyboards.id});
      if (!updated) throw new Error('AUDIT_STALE');
      return {narrationApproved: true as const, auditId: audit.auditId};
    });
  }
}

export class InMemoryAuditRepository implements AuditRepository {
  private readonly audits = new Map<string, FactualityAuditResult>(); private approval?: FactualityAuditResult;
  constructor(private snapshot?: AuditSnapshot) {}
  async loadSnapshot(projectId: string) { if (!this.snapshot || this.snapshot.projectId !== projectId) throw new Error('STORYBOARD_NOT_FOUND'); return structuredClone(this.snapshot); }
  seedAudit(audit: FactualityAuditResult) { this.audits.set(audit.auditId, structuredClone(audit)); return structuredClone(audit); }
  async persistAudit(writer: ProviderResultWriter, input: FactualityAuditInput, providerRunId: string, findings: AuditFinding[]) { const audit = this.seedAudit({...input, auditId: randomUUID(), providerRunId, status: findings.some((finding) => finding.blocking) ? 'blocked' : 'passed', findings}); await writer.writeStructured(async () => undefined); return audit.auditId; }
  async findByProviderRun(projectId: string, providerRunId: string) { const audit = [...this.audits.values()].find((item) => item.projectId === projectId && item.providerRunId === providerRunId); return audit && structuredClone(audit); }
  async findById(projectId: string, auditId: string) { const audit = this.audits.get(auditId); return audit?.projectId === projectId ? structuredClone(audit) : undefined; }
  async approve(projectId: string, audit: FactualityAuditResult) { if (!this.snapshot || this.snapshot.projectId !== projectId || this.snapshot.storyboardId !== audit.storyboardId || this.snapshot.storyboardRevision !== audit.storyboardRevision) throw new Error('AUDIT_STALE'); this.approval = structuredClone(audit); return {narrationApproved: true as const, auditId: audit.auditId}; }
  setSnapshot(snapshot: AuditSnapshot) { this.snapshot = structuredClone(snapshot); this.approval = undefined; }
}

export const sha256Canonical = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

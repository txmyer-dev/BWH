import {createHash, randomUUID} from 'node:crypto';
import {and, asc, eq, inArray} from 'drizzle-orm';

import type {Database} from '../../server/db/client';
import {assets as mediaAssets, evidenceItems, factualityAudits, storyboards} from '../../server/db/schema';
import type {ProviderResultWriter} from '../providers/types';
import {effectiveEvidenceClaim} from '../story/story-service';
import type {EvidenceItem} from '../evidence/schemas';
import type {AuditFinding, FactualityAuditInput, FactualityAuditResult} from './schemas';

export type AuditSnapshot = Omit<FactualityAuditInput, 'evidenceHash'|'narrationHash'> & {durationSeconds: number};
export interface AuditRepository {
  loadSnapshot(projectId: string): Promise<AuditSnapshot>;
  persistAudit(writer: ProviderResultWriter, input: FactualityAuditInput, providerRunId: string, findings: AuditFinding[], contract: AuditContract): Promise<string>;
  findByProviderRun(projectId: string, providerRunId: string): Promise<FactualityAuditResult | undefined>;
  findById(projectId: string, auditId: string): Promise<FactualityAuditResult | undefined>;
  approve(projectId: string, audit: FactualityAuditResult): Promise<{narrationApproved: true; auditId: string}>;
  loadCreatorAudioSnapshot(projectId: string, assetId: string): Promise<AuditSnapshot & {auditScope: 'creator_audio'; assetId: string; transcriptId: string}>;
  approveCreatorAudio(projectId: string, assetId: string, audit: FactualityAuditResult): Promise<{creatorAudioApproved: true; auditId: string}>;
}
export type AuditContract = {auditPromptVersion: string; auditSchemaVersion: string; model: string};

export const projectApprovedEvidenceLedger = (items: EvidenceItem[]) => items
  .filter((item) => item.kind !== 'model_hypothesis' && ['confirmed', 'corrected'].includes(item.verificationStatus))
  .map((item) => ({id: item.id, claim: effectiveEvidenceClaim(item), sourceExcerpt: item.verificationStatus === 'corrected' ? `Creator correction: ${effectiveEvidenceClaim(item)}` : item.sourceExcerpt, sourceAssetIds: [...item.sourceAssetIds]}));
export const projectNarrationLedger = (scenes: {id: string; narrationText: string|null; evidenceItemIds: unknown}[]) => scenes
  .filter((scene) => Boolean(scene.narrationText?.trim()))
  .map((scene) => ({sceneId: scene.id, text: scene.narrationText!, evidenceItemIds: [...(scene.evidenceItemIds as string[])]}));

const mapAudit = (row: typeof factualityAudits.$inferSelect): FactualityAuditResult => ({
  auditId: row.id, providerRunId: row.providerRunId, projectId: row.projectId,
  storyboardId: row.storyboardId, storyboardRevision: row.storyboardRevision,
  evidenceHash: row.evidenceHash, narrationHash: row.narrationHash,
  status: row.status as 'passed'|'blocked', findings: row.findings as AuditFinding[],
  auditPromptVersion: row.auditPromptVersion, auditSchemaVersion: row.auditSchemaVersion, model: row.model,
  auditScope: row.auditScope as 'narration_text'|'creator_audio', assetId: row.creatorNarrationAssetId ?? undefined, transcriptId: row.creatorTranscriptId ?? undefined
});

export class PostgresAuditRepository implements AuditRepository {
  constructor(private readonly database: Database) {}
  async loadSnapshot(projectId: string) {
    const board = await this.database.query.storyboards.findFirst({where: (table, {eq: equals}) => equals(table.projectId, projectId)});
    if (!board) throw new Error('STORYBOARD_NOT_FOUND');
    const scenes = await this.database.query.filmScenes.findMany({where: (table, {eq: equals}) => equals(table.storyboardId, board.id), orderBy: (table) => asc(table.sequenceOrder)});
    const rows = await this.database.select().from(evidenceItems).where(and(eq(evidenceItems.projectId, projectId), inArray(evidenceItems.verificationStatus, ['confirmed', 'corrected']))).orderBy(asc(evidenceItems.id));
    const ledger = projectApprovedEvidenceLedger(rows.map((row) => ({id: row.id, projectId: row.projectId, kind: row.type as EvidenceItem['kind'], claim: row.claim, originalClaim: row.originalClaim, sourceAssetIds: row.sourceAssetIds as string[], sourceExcerpt: row.sourceExcerpt, confidence: row.confidence, verificationStatus: row.verificationStatus as EvidenceItem['verificationStatus'], correction: row.correction})));
    return {
      projectId, storyboardId: board.id, storyboardRevision: board.revision,
      durationSeconds: scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0),
      evidence: ledger,
      narration: projectNarrationLedger(scenes)
    };
  }
  async persistAudit(writer: ProviderResultWriter, input: FactualityAuditInput, providerRunId: string, findings: AuditFinding[], contract: AuditContract) {
    const id = randomUUID(); const status = findings.some((finding) => finding.blocking) ? 'blocked' : 'passed';
    await writer.writeStructured(async (transaction) => {
      await transaction.insert(factualityAudits).values({id, projectId: input.projectId, storyboardId: input.storyboardId, providerRunId, storyboardRevision: input.storyboardRevision, evidenceHash: input.evidenceHash, narrationHash: input.narrationHash, status, findings, auditScope: input.auditScope ?? 'narration_text', creatorNarrationAssetId: input.assetId, creatorTranscriptId: input.transcriptId, ...contract});
      if (input.auditScope === 'creator_audio') return;
      const [current] = await transaction.update(storyboards).set({currentAuditId: id, narrationApprovedAt: null, narrationApprovalAuditId: null, narrationApprovalEvidenceHash: null, narrationApprovalHash: null, audioApprovedAt: null, narrationTrackSelection: null, renderManifest: null, updatedAt: new Date()}).where(and(eq(storyboards.id, input.storyboardId), eq(storyboards.projectId, input.projectId), eq(storyboards.revision, input.storyboardRevision))).returning({id: storyboards.id});
      if (!current) throw new Error('AUDIT_STALE_DURING_DISPATCH');
    });
    return id;
  }
  async loadCreatorAudioSnapshot(projectId: string, assetId: string) {
    const board = await this.database.query.storyboards.findFirst({where: (table, {eq: same}) => same(table.projectId, projectId)}); if (!board) throw new Error('STORYBOARD_NOT_FOUND');
    const [asset] = await this.database.select().from(mediaAssets).where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.id, assetId))).limit(1);
    const transcript = await this.database.query.assetTranscripts.findFirst({where: (table, {and: all, eq: same}) => all(same(table.projectId, projectId), same(table.assetId, assetId))});
    const run = transcript ? await this.database.query.providerRuns.findFirst({where: (table, {and: all, eq: same}) => all(same(table.id, transcript.providerRunId), same(table.projectId, projectId))}) : undefined;
    if (!asset || asset.assetKind !== 'creator_narration' || asset.processingStatus !== 'ready' || !transcript || !run || run.provider !== 'deepgram' || run.model !== 'nova-3' || run.operation !== 'transcribe' || !run.activeResult || run.status !== 'completed') throw new Error('CREATOR_AUDIO_TRANSCRIPT_REQUIRED');
    const rows = await this.database.select().from(evidenceItems).where(and(eq(evidenceItems.projectId, projectId), inArray(evidenceItems.verificationStatus, ['confirmed', 'corrected']))).orderBy(asc(evidenceItems.id));
    const evidence = projectApprovedEvidenceLedger(rows.map((row) => ({id: row.id, projectId: row.projectId, kind: row.type as EvidenceItem['kind'], claim: row.claim, originalClaim: row.originalClaim, sourceAssetIds: row.sourceAssetIds as string[], sourceExcerpt: row.sourceExcerpt, confidence: row.confidence, verificationStatus: row.verificationStatus as EvidenceItem['verificationStatus'], correction: row.correction}))).filter((item) => !item.sourceAssetIds.includes(assetId));
    return {projectId, storyboardId: board.id, storyboardRevision: board.revision, durationSeconds: 120, evidence, narration: [{sceneId: assetId, text: transcript.text, evidenceItemIds: evidence.map((item) => item.id)}], auditScope: 'creator_audio' as const, assetId, transcriptId: transcript.id};
  }
  async approveCreatorAudio(projectId: string, assetId: string, audit: FactualityAuditResult) {
    if (audit.auditScope !== 'creator_audio' || audit.assetId !== assetId || !audit.transcriptId || audit.status !== 'passed' || audit.findings.some((finding) => finding.blocking)) throw new Error('CREATOR_AUDIO_AUDIT_REQUIRED');
    const [row] = await this.database.update(mediaAssets).set({creatorTranscriptAuditId: audit.auditId, creatorTranscriptApprovalHash: audit.narrationHash, updatedAt: new Date()}).where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.id, assetId), eq(mediaAssets.assetKind, 'creator_narration'))).returning({id: mediaAssets.id});
    if (!row) throw new Error('CREATOR_AUDIO_TRANSCRIPT_REQUIRED'); return {creatorAudioApproved: true as const, auditId: audit.auditId};
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
  private creator?: {projectId: string; assetId: string; transcriptId: string; transcriptText: string; auditId?: string; hash?: string};
  constructor(private snapshot?: AuditSnapshot) {}
  async loadSnapshot(projectId: string) { if (!this.snapshot || this.snapshot.projectId !== projectId) throw new Error('STORYBOARD_NOT_FOUND'); return structuredClone(this.snapshot); }
  seedAudit(audit: Omit<FactualityAuditResult, keyof AuditContract> & Partial<AuditContract>) { const complete = {auditPromptVersion: 'test-prompt', auditSchemaVersion: 'test-schema', model: 'test-model', ...audit} as FactualityAuditResult; this.audits.set(complete.auditId, structuredClone(complete)); return structuredClone(complete); }
  async persistAudit(writer: ProviderResultWriter, input: FactualityAuditInput, providerRunId: string, findings: AuditFinding[], contract: AuditContract) { const audit = this.seedAudit({...input, auditId: randomUUID(), providerRunId, status: findings.some((finding) => finding.blocking) ? 'blocked' : 'passed', findings, ...contract}); await writer.writeStructured(async () => undefined); return audit.auditId; }
  async findByProviderRun(projectId: string, providerRunId: string) { const audit = [...this.audits.values()].find((item) => item.projectId === projectId && item.providerRunId === providerRunId); return audit && structuredClone(audit); }
  async findById(projectId: string, auditId: string) { const audit = this.audits.get(auditId); return audit?.projectId === projectId ? structuredClone(audit) : undefined; }
  async approve(projectId: string, audit: FactualityAuditResult) { if (!this.snapshot || this.snapshot.projectId !== projectId || this.snapshot.storyboardId !== audit.storyboardId || this.snapshot.storyboardRevision !== audit.storyboardRevision) throw new Error('AUDIT_STALE'); this.approval = structuredClone(audit); return {narrationApproved: true as const, auditId: audit.auditId}; }
  seedCreatorAudio(input: {projectId: string; assetId: string; transcriptId: string; transcriptText: string}) { this.creator = {...input}; }
  async loadCreatorAudioSnapshot(projectId: string, assetId: string) { if (!this.snapshot || !this.creator || this.creator.projectId !== projectId || this.creator.assetId !== assetId) throw new Error('CREATOR_AUDIO_TRANSCRIPT_REQUIRED'); return {...structuredClone(this.snapshot), narration: [{sceneId: assetId, text: this.creator.transcriptText, evidenceItemIds: this.snapshot.evidence.map((item) => item.id)}], auditScope: 'creator_audio' as const, assetId, transcriptId: this.creator.transcriptId}; }
  async approveCreatorAudio(projectId: string, assetId: string, audit: FactualityAuditResult) { if (!this.creator || this.creator.projectId !== projectId || this.creator.assetId !== assetId || audit.auditScope !== 'creator_audio' || audit.assetId !== assetId || audit.status !== 'passed') throw new Error('CREATOR_AUDIO_AUDIT_REQUIRED'); this.creator.auditId = audit.auditId; this.creator.hash = audit.narrationHash; return {creatorAudioApproved: true as const, auditId: audit.auditId}; }
  setSnapshot(snapshot: AuditSnapshot) { this.snapshot = structuredClone(snapshot); this.approval = undefined; }
}

export const sha256Canonical = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

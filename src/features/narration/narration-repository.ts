import {createHash, randomUUID} from 'node:crypto';
import {and, asc, eq} from 'drizzle-orm';
import {z} from 'zod';

import type {Database} from '../../server/db/client';
import {assetTranscripts, assets, filmScenes, narrationSamples, narrationTracks, providerRuns, storyboards} from '../../server/db/schema';
import type {ProviderResultWriter} from '../providers/types';

export type ApprovedNarrationSnapshot = {projectId: string; storyboardId: string; revision: number; auditId: string; narrationHash: string; scenes: {id: string; text: string}[]};
export type NarrationSample = {id: string; projectId: string; storyboardId: string; providerRunId: string; provider: 'deepgram'|'azure'; model: string; voice: string; sourceTextHash: string; auditId: string; narrationHash: string; objectKey: string; durationMs: number; approvedAt: Date|null};
export type NarrationTrack = {id: string; projectId: string; storyboardId: string; sceneId: string; providerRunId: string; provider: 'deepgram'|'azure'; model: string; voice: string; sourceTextHash: string; auditId: string; narrationHash: string; objectKey: string; durationMs: number};
export type NarrationSelection = {kind: 'generated'; provider: 'deepgram'|'azure'; sampleId: string; model: string; voice: string; auditId: string; narrationHash: string}|{kind: 'creator'; assetId: string; transcriptId: string; transcriptHash: string; auditId: string};
const narrationSelectionSchema = z.discriminatedUnion('kind', [z.object({kind: z.literal('generated'), provider: z.enum(['deepgram','azure']), sampleId: z.string().uuid(), model: z.string().min(1), voice: z.string().min(1), auditId: z.string().uuid(), narrationHash: z.string().length(64)}).strict(), z.object({kind: z.literal('creator'), assetId: z.string().uuid(), transcriptId: z.string().uuid(), transcriptHash: z.string().length(64), auditId: z.string().uuid()}).strict()]);

export interface NarrationRepository {
  loadApprovedStoryboard(projectId: string): Promise<ApprovedNarrationSnapshot>;
  saveSample(writer: ProviderResultWriter, sample: Omit<NarrationSample, 'id'|'approvedAt'>): Promise<NarrationSample>;
  findSampleByProviderRun(projectId: string, providerRunId: string): Promise<NarrationSample|undefined>;
  findSample(projectId: string, sampleId: string): Promise<NarrationSample|undefined>;
  approveSample(projectId: string, sampleId: string): Promise<NarrationSample>;
  setSelection(projectId: string, selection: NarrationSelection): Promise<NarrationSelection>;
  getSelection(projectId: string): Promise<NarrationSelection|undefined>;
  findTrackByProviderRun(projectId: string, providerRunId: string): Promise<NarrationTrack|undefined>;
  findTrack(projectId: string, sceneId: string, sourceTextHash: string, provider: string, model: string, voice: string): Promise<NarrationTrack|undefined>;
  saveTrack(writer: ProviderResultWriter, track: Omit<NarrationTrack, 'id'>): Promise<NarrationTrack>;
  assertCreatorAudioApproved(projectId: string, assetId: string): Promise<{assetId: string; transcriptId: string; transcriptHash: string; auditId: string}>;
}

export class PostgresNarrationRepository implements NarrationRepository {
  constructor(private readonly database: Database) {}
  async loadApprovedStoryboard(projectId: string) {
    const board = await this.database.query.storyboards.findFirst({where: (table, {eq: same}) => same(table.projectId, projectId)});
    if (!board || !board.currentAuditId || !board.narrationApprovedAt || !board.narrationApprovalAuditId || !board.narrationApprovalHash || board.currentAuditId !== board.narrationApprovalAuditId) throw new Error('NARRATION_TEXT_APPROVAL_REQUIRED');
    const audit = await this.database.query.factualityAudits.findFirst({where: (table, {and: all, eq: same}) => all(same(table.id, board.currentAuditId!), same(table.projectId, projectId))});
    if (!audit || audit.status !== 'passed' || audit.narrationHash !== board.narrationApprovalHash || audit.storyboardRevision !== board.revision || (audit.findings as {blocking?: boolean}[]).some((item) => item.blocking)) throw new Error('NARRATION_TEXT_APPROVAL_STALE');
    const scenes = await this.database.select().from(filmScenes).where(eq(filmScenes.storyboardId, board.id)).orderBy(asc(filmScenes.sequenceOrder));
    return {projectId, storyboardId: board.id, revision: board.revision, auditId: audit.id, narrationHash: audit.narrationHash, scenes: scenes.filter((scene) => scene.narrationText?.trim()).map((scene) => ({id: scene.id, text: scene.narrationText!.trim()}))};
  }
  async saveSample(writer: ProviderResultWriter, sample: Omit<NarrationSample, 'id'|'approvedAt'>) { let saved: NarrationSample|undefined; await writer.writeStructured(async (tx) => { const [row] = await tx.insert(narrationSamples).values({id: randomUUID(), ...sample}).returning(); saved = {...row, provider: row.provider as 'deepgram'|'azure'}; }); if (!saved) throw new Error('NARRATION_SAMPLE_PERSIST_FAILED'); return saved; }
  async findSampleByProviderRun(projectId: string, providerRunId: string) { const [row] = await this.database.select().from(narrationSamples).where(and(eq(narrationSamples.projectId, projectId), eq(narrationSamples.providerRunId, providerRunId))).limit(1); return row ? {...row, provider: row.provider as 'deepgram'|'azure'} : undefined; }
  async findSample(projectId: string, sampleId: string) { const [row] = await this.database.select().from(narrationSamples).where(and(eq(narrationSamples.projectId, projectId), eq(narrationSamples.id, sampleId))).limit(1); return row ? {...row, provider: row.provider as 'deepgram'|'azure'} : undefined; }
  async approveSample(projectId: string, sampleId: string) { const snapshot = await this.loadApprovedStoryboard(projectId); const [row] = await this.database.update(narrationSamples).set({approvedAt: new Date()}).where(and(eq(narrationSamples.id, sampleId), eq(narrationSamples.projectId, projectId), eq(narrationSamples.auditId, snapshot.auditId), eq(narrationSamples.narrationHash, snapshot.narrationHash))).returning(); if (!row) throw new Error('NARRATION_SAMPLE_STALE'); return {...row, provider: row.provider as 'deepgram'|'azure'}; }
  async setSelection(projectId: string, selection: NarrationSelection) { const valid = narrationSelectionSchema.parse(selection); const [row] = await this.database.update(storyboards).set({narrationSource: valid.kind === 'creator' ? 'creator' : valid.provider, narratorVoice: valid.kind === 'generated' ? valid.voice : null, creatorNarrationAssetId: valid.kind === 'creator' ? valid.assetId : null, narrationTrackSelection: valid, audioApprovedAt: new Date(), renderManifest: null, updatedAt: new Date()}).where(eq(storyboards.projectId, projectId)).returning({id: storyboards.id}); if (!row) throw new Error('STORYBOARD_NOT_FOUND'); return valid; }
  async getSelection(projectId: string) { const board = await this.database.query.storyboards.findFirst({where: (table, {eq: same}) => same(table.projectId, projectId)}); return board?.narrationTrackSelection ? narrationSelectionSchema.parse(board.narrationTrackSelection) : undefined; }
  async findTrackByProviderRun(projectId: string, providerRunId: string) { const [row] = await this.database.select().from(narrationTracks).where(and(eq(narrationTracks.projectId, projectId), eq(narrationTracks.providerRunId, providerRunId))).limit(1); return row ? {...row, provider: row.provider as 'deepgram'|'azure'} : undefined; }
  async findTrack(projectId: string, sceneId: string, sourceTextHash: string, provider: string, model: string, voice: string) { const [row] = await this.database.select().from(narrationTracks).where(and(eq(narrationTracks.projectId, projectId), eq(narrationTracks.sceneId, sceneId), eq(narrationTracks.sourceTextHash, sourceTextHash), eq(narrationTracks.provider, provider), eq(narrationTracks.model, model), eq(narrationTracks.voice, voice))).limit(1); return row ? {...row, provider: row.provider as 'deepgram'|'azure'} : undefined; }
  async saveTrack(writer: ProviderResultWriter, track: Omit<NarrationTrack, 'id'>) { let saved: NarrationTrack|undefined; await writer.writeStructured(async (tx) => { const [row] = await tx.insert(narrationTracks).values({id: randomUUID(), ...track}).returning(); saved = {...row, provider: row.provider as 'deepgram'|'azure'}; }); if (!saved) throw new Error('NARRATION_TRACK_PERSIST_FAILED'); return saved; }
  async assertCreatorAudioApproved(projectId: string, assetId: string) {
    const [row] = await this.database.select({assetId: assets.id, kind: assets.assetKind, status: assets.processingStatus, transcriptId: assetTranscripts.id, transcriptText: assetTranscripts.text, transcriptAuditId: assets.creatorTranscriptAuditId, approvedHash: assets.creatorTranscriptApprovalHash, provider: providerRuns.provider, model: providerRuns.model, operation: providerRuns.operation, runActive: providerRuns.activeResult}).from(assets).innerJoin(assetTranscripts, eq(assetTranscripts.assetId, assets.id)).innerJoin(providerRuns, eq(providerRuns.id, assetTranscripts.providerRunId)).where(and(eq(assets.projectId, projectId), eq(assets.id, assetId))).limit(1);
    const hash = row ? createHash('sha256').update(JSON.stringify({text: row.transcriptText})).digest('hex') : '';
    if (!row || row.kind !== 'creator_narration' || row.status !== 'ready' || row.provider !== 'deepgram' || row.model !== 'nova-3' || row.operation !== 'transcribe' || !row.runActive || !row.transcriptAuditId || row.approvedHash !== hash) throw new Error('CREATOR_AUDIO_AUDIT_REQUIRED');
    const audit = await this.database.query.factualityAudits.findFirst({where: (table, {and: all, eq: same}) => all(same(table.id, row.transcriptAuditId!), same(table.projectId, projectId), same(table.auditScope, 'creator_audio'))});
    if (!audit || audit.status !== 'passed' || audit.narrationHash !== hash || (audit.findings as {blocking?: boolean}[]).some((finding) => finding.blocking)) throw new Error('CREATOR_AUDIO_AUDIT_REQUIRED');
    return {assetId, transcriptId: row.transcriptId, transcriptHash: hash, auditId: audit.id};
  }
}

export class InMemoryNarrationRepository implements NarrationRepository {
  private snapshot?: ApprovedNarrationSnapshot; private samples = new Map<string, NarrationSample>(); private tracks = new Map<string, NarrationTrack>(); private selection?: NarrationSelection; private creator = new Map<string, {projectId: string; assetId: string; transcriptText: string; transcriptId: string; provider: string; audited: boolean}>();
  seedApprovedStoryboard(snapshot: ApprovedNarrationSnapshot) { this.snapshot = structuredClone(snapshot); }
  async loadApprovedStoryboard(projectId: string) { if (!this.snapshot || this.snapshot.projectId !== projectId) throw new Error('NARRATION_TEXT_APPROVAL_REQUIRED'); return structuredClone(this.snapshot); }
  async saveSample(writer: ProviderResultWriter, input: Omit<NarrationSample, 'id'|'approvedAt'>) { const item = {...input, id: randomUUID(), approvedAt: null}; await writer.writeStructured(async () => { this.samples.set(item.id, item); }); return structuredClone(item); }
  async findSampleByProviderRun(projectId: string, providerRunId: string) { const found = [...this.samples.values()].find((item) => item.projectId === projectId && item.providerRunId === providerRunId); return found && structuredClone(found); }
  async findSample(projectId: string, id: string) { const found = this.samples.get(id); return found?.projectId === projectId ? structuredClone(found) : undefined; }
  async approveSample(projectId: string, id: string) { const sample = this.samples.get(id); if (!sample || sample.projectId !== projectId || !this.snapshot || sample.auditId !== this.snapshot.auditId || sample.narrationHash !== this.snapshot.narrationHash) throw new Error('NARRATION_SAMPLE_STALE'); sample.approvedAt = new Date(); return structuredClone(sample); }
  async setSelection(projectId: string, selection: NarrationSelection) { if (!this.snapshot || this.snapshot.projectId !== projectId) throw new Error('STORYBOARD_NOT_FOUND'); this.selection = structuredClone(selection); return selection; }
  async getSelection(projectId: string) { return this.snapshot?.projectId === projectId && this.selection ? structuredClone(this.selection) : undefined; }
  async findTrackByProviderRun(projectId: string, runId: string) { const found = [...this.tracks.values()].find((item) => item.projectId === projectId && item.providerRunId === runId); return found && structuredClone(found); }
  async findTrack(projectId: string, sceneId: string, hash: string, provider: string, model: string, voice: string) { const found = [...this.tracks.values()].find((item) => item.projectId === projectId && item.sceneId === sceneId && item.sourceTextHash === hash && item.provider === provider && item.model === model && item.voice === voice); return found && structuredClone(found); }
  async saveTrack(writer: ProviderResultWriter, input: Omit<NarrationTrack, 'id'>) { const item = {...input, id: randomUUID()}; await writer.writeStructured(async () => { this.tracks.set(item.id, item); }); return structuredClone(item); }
  seedCreatorAudio(input: {projectId: string; assetId: string; transcriptText: string; provider: string; audited: boolean}) { this.creator.set(input.assetId, {...input, transcriptId: randomUUID()}); }
  approveCreatorTranscript(projectId: string, assetId: string) { const row = this.creator.get(assetId); if (row?.projectId === projectId) row.audited = true; }
  async assertCreatorAudioApproved(projectId: string, assetId: string) { const row = this.creator.get(assetId); if (!row || row.projectId !== projectId || row.provider !== 'deepgram' || !row.audited) throw new Error('CREATOR_AUDIO_AUDIT_REQUIRED'); return {assetId, transcriptId: row.transcriptId, transcriptHash: createHash('sha256').update(JSON.stringify({text: row.transcriptText})).digest('hex'), auditId: randomUUID()}; }
}

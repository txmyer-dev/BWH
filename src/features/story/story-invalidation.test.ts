import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it, vi} from 'vitest';

import {assets, filmScenes, narrationTracks, processingJobs, projects, providerArtifacts, storyboards} from '../../server/db/schema';
import {invalidateDownstreamStoryState} from './story-service';

describe('story downstream invalidation', () => {
  it('clears every audit, text, audio, generated-track, manifest, and rendered-film field together', async () => {
    const sets = new Map<unknown, Record<string, unknown>>();
    const sceneId = crypto.randomUUID();
    const transaction = {
      execute: vi.fn(async () => undefined),
      select: () => ({from: (table: unknown) => ({where: async () => table === storyboards ? [{id: crypto.randomUUID()}] : []})}),
      insert: () => ({values: () => ({onConflictDoNothing: vi.fn(async () => undefined)})}),
      delete: () => ({where: vi.fn(async () => undefined)}),
      update: (table: unknown) => ({set: (value: Record<string, unknown>) => { sets.set(table, value); return {where: vi.fn(async () => undefined)}; }})
    };
    await invalidateDownstreamStoryState(transaction as never, crypto.randomUUID(), undefined, true, [sceneId]);
    expect(sets.get(storyboards)).toMatchObject({currentAuditId: null, narrationApprovedAt: null, narrationApprovalAuditId: null, narrationApprovalEvidenceHash: null, narrationApprovalHash: null, audioApprovedAt: null, narrationTrackSelection: null, renderManifest: null});
    expect(sets.get(storyboards)).toHaveProperty('revision');
    expect(sets.get(filmScenes)).toMatchObject({generatedNarrationObjectKey: null});
    expect(sets.get(assets)).toMatchObject({creatorTranscriptAuditId: null, creatorTranscriptApprovalHash: null});
    expect(sets.get(projects)).toMatchObject({renderedFilmObjectKey: null, renderedAt: null});
    expect(sets.get(processingJobs)).toMatchObject({status: 'superseded', leaseToken: null, leaseExpiresAt: null, lastError: 'RENDER_SUPERSEDED'});
  });

  it('wires invalidation into all storyboard and approved-evidence mutation transactions', () => {
    const story = readFileSync(join(process.cwd(), 'src/features/story/story-service.ts'), 'utf8');
    const evidence = readFileSync(join(process.cwd(), 'src/features/evidence/evidence-repository.ts'), 'utf8');
    const transcription = readFileSync(join(process.cwd(), 'src/features/transcription/transcription-repository.ts'), 'utf8');
    const audit = readFileSync(join(process.cwd(), 'src/features/audit/audit-repository.ts'), 'utf8');
    expect(story.match(/invalidateDownstreamStoryState\(transaction, projectId, storyboardId, false\)/g)).toHaveLength(2);
    expect(story.match(/invalidateDownstreamStoryState\(transaction, projectId, storyboardId, false, narrationChanged \? \[sceneId\] : undefined\)/g)).toHaveLength(2);
    expect(story.match(/invalidateDownstreamStoryState\(transaction, projectId\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(evidence).toContain('invalidateDownstreamStoryState(transaction, row.projectId)');
    for (const method of ['saveAnswer', 'addScene', 'editScene', 'reorderScenes', 'replaceScene']) {
      const start = story.indexOf(`async ${method}(`, story.indexOf('export class PostgresStoryRepository'));
      const transaction = story.indexOf('this.database.transaction', start);
      const lock = story.indexOf('lockNarrationProject(transaction, projectId)', transaction);
      const invalidation = story.indexOf('invalidateDownstreamStoryState(transaction, projectId', transaction);
      expect(lock, `${method} must take the narration lock`).toBeGreaterThan(transaction);
      expect(lock, `${method} must lock before invalidation or domain work`).toBeLessThan(invalidation);
    }
    expect(evidence.indexOf('lockNarrationProject(transaction, projectId)')).toBeLessThan(evidence.indexOf('transaction.update(evidenceItems)'));
    const transcriptWriter = transcription.indexOf('input.writer.writeStructured');
    const transcriptLock = transcription.indexOf('lockNarrationProject(transaction, input.projectId)', transcriptWriter);
    const transcriptRows = transcription.indexOf('transaction.select({providerRunId: assetTranscripts.providerRunId})', transcriptWriter);
    expect(transcriptLock).toBeGreaterThan(transcriptWriter); expect(transcriptLock).toBeLessThan(transcriptRows);
    expect(transcription.slice(transcriptWriter, transcription.indexOf('async createJob', transcriptWriter))).not.toContain('transaction.update(providerRuns)');
    const creatorApproval = audit.indexOf('async approveCreatorAudio(');
    expect(audit.indexOf('lockNarrationProject(transaction, projectId)', creatorApproval)).toBeLessThan(audit.indexOf('transaction.select().from(storyboards)', creatorApproval));
  });

  it('atomically makes only affected tracks unusable and records durable private-object cleanup', async () => {
    const sceneId = crypto.randomUUID(); const runId = crypto.randomUUID(); const inserted: unknown[] = []; const deleted: unknown[] = []; const sets = new Map<unknown, Record<string, unknown>>();
    const transaction = {execute: vi.fn(async () => undefined), select: () => ({from: (table: unknown) => ({where: async () => table === storyboards ? [{id: 'board'}] : table === narrationTracks ? [{providerRunId: runId, objectKey: 'private.wav'}] : []})}), insert: (table: unknown) => ({values: (rows: unknown) => { inserted.push({table, rows}); return {onConflictDoNothing: vi.fn(async () => undefined)}; }}), delete: (table: unknown) => ({where: vi.fn(async () => { deleted.push(table); })}), update: (table: unknown) => ({set: (value: Record<string, unknown>) => { sets.set(table, value); return {where: vi.fn(async () => undefined)}; }})};
    await invalidateDownstreamStoryState(transaction as never, crypto.randomUUID(), undefined, true, [sceneId]);
    expect(inserted).toEqual([expect.objectContaining({table: providerArtifacts, rows: [expect.objectContaining({provider: 'google_cloud_storage', providerRunId: runId, providerArtifactId: 'private.wav', status: 'cleanup_pending'})]})]);
    expect(deleted).toContain(narrationTracks);
  });
});

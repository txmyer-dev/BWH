import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it, vi} from 'vitest';

import {assets, filmScenes, narrationTracks, projects, providerArtifacts, providerRuns, storyboards} from '../../server/db/schema';
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
  });

  it('wires invalidation into all storyboard and approved-evidence mutation transactions', () => {
    const story = readFileSync(join(process.cwd(), 'src/features/story/story-service.ts'), 'utf8');
    const evidence = readFileSync(join(process.cwd(), 'src/features/evidence/evidence-repository.ts'), 'utf8');
    expect(story.match(/invalidateDownstreamStoryState\(transaction, projectId, storyboardId, false\)/g)).toHaveLength(2);
    expect(story.match(/invalidateDownstreamStoryState\(transaction, projectId, storyboardId, false, narrationChanged \? \[sceneId\] : undefined\)/g)).toHaveLength(2);
    expect(story.match(/invalidateDownstreamStoryState\(transaction, projectId\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(evidence).toContain('invalidateDownstreamStoryState(transaction, row.projectId)');
  });

  it('atomically makes only affected tracks unusable and records durable private-object cleanup', async () => {
    const sceneId = crypto.randomUUID(); const runId = crypto.randomUUID(); const inserted: unknown[] = []; const deleted: unknown[] = []; const sets = new Map<unknown, Record<string, unknown>>();
    const transaction = {execute: vi.fn(async () => undefined), select: () => ({from: (table: unknown) => ({where: async () => table === storyboards ? [{id: 'board'}] : table === narrationTracks ? [{providerRunId: runId, objectKey: 'private.wav'}] : []})}), insert: (table: unknown) => ({values: (rows: unknown) => { inserted.push({table, rows}); return {onConflictDoNothing: vi.fn(async () => undefined)}; }}), delete: (table: unknown) => ({where: vi.fn(async () => { deleted.push(table); })}), update: (table: unknown) => ({set: (value: Record<string, unknown>) => { sets.set(table, value); return {where: vi.fn(async () => undefined)}; }})};
    await invalidateDownstreamStoryState(transaction as never, crypto.randomUUID(), undefined, true, [sceneId]);
    expect(inserted).toEqual([expect.objectContaining({table: providerArtifacts, rows: [expect.objectContaining({provider: 'google_cloud_storage', providerRunId: runId, providerArtifactId: 'private.wav', status: 'cleanup_pending'})]})]);
    expect(sets.get(providerRuns)).toMatchObject({activeResult: false}); expect(deleted).toContain(narrationTracks);
  });
});

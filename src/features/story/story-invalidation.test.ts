import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it, vi} from 'vitest';

import {filmScenes, projects, storyboards} from '../../server/db/schema';
import {invalidateDownstreamStoryState} from './story-service';

describe('story downstream invalidation', () => {
  it('clears every audit, text, audio, generated-track, manifest, and rendered-film field together', async () => {
    const sets = new Map<unknown, Record<string, unknown>>();
    const transaction = {
      select: () => ({from: () => ({where: async () => [{id: crypto.randomUUID()}]})}),
      update: (table: unknown) => ({set: (value: Record<string, unknown>) => { sets.set(table, value); return {where: vi.fn(async () => undefined)}; }})
    };
    await invalidateDownstreamStoryState(transaction as never, crypto.randomUUID());
    expect(sets.get(storyboards)).toMatchObject({currentAuditId: null, narrationApprovedAt: null, narrationApprovalAuditId: null, narrationApprovalEvidenceHash: null, narrationApprovalHash: null, audioApprovedAt: null, narrationTrackSelection: null, renderManifest: null});
    expect(sets.get(storyboards)).toHaveProperty('revision');
    expect(sets.get(filmScenes)).toMatchObject({generatedNarrationObjectKey: null});
    expect(sets.get(projects)).toMatchObject({renderedFilmObjectKey: null, renderedAt: null});
  });

  it('wires invalidation into all storyboard and approved-evidence mutation transactions', () => {
    const story = readFileSync(join(process.cwd(), 'src/features/story/story-service.ts'), 'utf8');
    const evidence = readFileSync(join(process.cwd(), 'src/features/evidence/evidence-repository.ts'), 'utf8');
    expect(story.match(/invalidateDownstreamStoryState\(transaction, projectId, storyboardId, false\)/g)).toHaveLength(4);
    expect(story.match(/invalidateDownstreamStoryState\(transaction, projectId\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(evidence).toContain('invalidateDownstreamStoryState(transaction, row.projectId)');
  });
});

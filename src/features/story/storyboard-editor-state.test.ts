import {describe, expect, it} from 'vitest';

import type {EvidenceItem} from '../evidence/schemas';
import type {Asset} from '../media/asset-service';
import {
  buildStoryboardOptions,
  displayEvidenceClaim,
  mergeStoryboardResponse,
  rebaseStoryboardConflict,
  sceneEditorFields,
  shouldClearRequestDirty,
  serializeSceneEdit
} from './storyboard-editor-state';
import {RepositoryProjectAssetReader, type FilmScene, type Storyboard} from './story-service';

const scene = (id: string, title: string): FilmScene => ({
  id, sequenceOrder: 0, sceneType: 'media', title, narrationText: 'Narration.', captionText: 'Caption',
  durationSeconds: 120, assetIds: [], evidenceItemIds: [], motionPreset: 'hold', transitionPreset: 'crossfade'
});

const board = (revision: number, scenes: FilmScene[]): Storyboard => ({
  id: crypto.randomUUID(), projectId: crypto.randomUUID(), title: 'Film', theme: 'Family',
  targetDurationSeconds: 120, voiceProfile: {traits: [], coverage: 'restrained'}, revision, scenes
});

describe('storyboard editor state', () => {
  it('keeps dirty scene A while merging a save or regeneration response for scene B', () => {
    const a = scene(crypto.randomUUID(), 'Unsaved A');
    const b = scene(crypto.randomUUID(), 'Old B');
    const current = board(1, [a, b]);
    const incoming = {...current, revision: 2, scenes: [{...a, title: 'Server A'}, {...b, title: 'Saved B'}]};
    expect(mergeStoryboardResponse(current, incoming, {dirtySceneIds: new Set([a.id])}).scenes).toEqual([
      a,
      expect.objectContaining({id: b.id, title: 'Saved B'})
    ]);
  });

  it('applies server order while preserving dirty scene fields by ID', () => {
    const a = scene(crypto.randomUUID(), 'Unsaved A');
    const b = scene(crypto.randomUUID(), 'B');
    const merged = mergeStoryboardResponse(board(1, [a, b]), board(2, [{...b, sequenceOrder: 0}, {...a, title: 'Server A', sequenceOrder: 1}]), {dirtySceneIds: new Set([a.id])});
    expect(merged.scenes.map((item) => item.id)).toEqual([b.id, a.id]);
    expect(merged.scenes[1].title).toBe('Unsaved A');
    expect(merged.revision).toBe(2);
  });

  it('preserves typing that occurs in the target scene while save or regeneration is in flight', () => {
    expect(shouldClearRequestDirty(3, 4)).toBe(false);
    expect(shouldClearRequestDirty(4, 4)).toBe(true);
    const local = board(1, [scene('a0000000-0000-4000-8000-000000000001', 'Typed after request')]);
    const server = board(2, [scene('a0000000-0000-4000-8000-000000000001', 'Response value')]);
    expect(mergeStoryboardResponse(local, server, {dirtySceneIds: new Set([local.scenes[0].id])}).scenes[0].title).toBe('Typed after request');
  });

  it('rebases to the conflict revision while preserving dirty scenes and unsaved local order for explicit retry', () => {
    const a = scene(crypto.randomUUID(), 'Dirty A');
    const b = scene(crypto.randomUUID(), 'B');
    const local = board(1, [b, a]);
    const server = board(5, [{...a, title: 'Server A'}, b]);
    const rebased = mergeStoryboardResponse(local, server, {dirtySceneIds: new Set([a.id]), preserveLocalOrder: true});
    expect(rebased.revision).toBe(5);
    expect(rebased.scenes.map((item) => item.id)).toEqual([b.id, a.id]);
    expect(rebased.scenes[1].title).toBe('Dirty A');
  });

  it('recovers a 409 through the storyboard GET flow and returns the new revision for explicit retry', async () => {
    const a = scene(crypto.randomUUID(), 'Dirty A');
    const local = board(1, [a]);
    const server = board(7, [{...a, title: 'Server A'}]);
    const calls: string[] = [];
    let latest = local;
    const rebasedPromise = rebaseStoryboardConflict({
      projectId: local.projectId, getCurrent: () => latest, dirtySceneIds: new Set([a.id]), preserveLocalOrder: true,
      fetcher: async (url) => { calls.push(url); return {ok: true, json: async () => server}; }
    });
    latest = {...local, scenes: [{...a, title: 'Typed during recovery'}]};
    const rebased = await rebasedPromise;
    expect(calls).toEqual([`/api/projects/${local.projectId}/storyboard`]);
    expect(rebased).toMatchObject({revision: 7, scenes: [{title: 'Typed during recovery'}]});
  });

  it('keeps a newer local reorder when an unrelated or older reorder response arrives', () => {
    const a = scene(crypto.randomUUID(), 'A');
    const b = scene(crypto.randomUUID(), 'B');
    const merged = mergeStoryboardResponse(board(2, [b, a]), board(3, [a, b]), {dirtySceneIds: new Set(), preserveLocalOrder: true});
    expect(merged.scenes.map((item) => item.id)).toEqual([b.id, a.id]);
    expect(shouldClearRequestDirty(2, 3)).toBe(false);
  });

  it('serializes every editable scene field', () => {
    const value = scene(crypto.randomUUID(), 'All fields');
    expect(sceneEditorFields).toEqual(['sceneType', 'title', 'narrationText', 'captionText', 'durationSeconds', 'assetIds', 'evidenceItemIds', 'motionPreset', 'transitionPreset']);
    expect(serializeSceneEdit(value)).toEqual(Object.fromEntries(sceneEditorFields.map((field) => [field, value[field]])));
  });

  it('displays a correction as current truth while preserving the original audit label', () => {
    const item = {verificationStatus: 'corrected', claim: 'Wrong year', originalClaim: 'Wrong year', correction: 'Correct year'} as EvidenceItem;
    expect(displayEvidenceClaim(item)).toEqual({current: 'Correct year', originallyProposed: 'Wrong year'});
  });

  it('builds human-readable project-only asset and approved-evidence choices', () => {
    const projectId = crypto.randomUUID();
    const options = buildStoryboardOptions(projectId, [
      {id: 'a', projectId, kind: 'image', processingStatus: 'ready', caption: 'Mara outside the bakery', sequenceOrder: 0},
      {id: 'foreign', projectId: crypto.randomUUID(), kind: 'image', processingStatus: 'ready', caption: 'Foreign', sequenceOrder: 0}
    ], [
      {id: 'e', projectId, verificationStatus: 'corrected', claim: 'Wrong', originalClaim: 'Wrong', correction: 'Opened in 1964'} as EvidenceItem,
      {id: 'p', projectId, verificationStatus: 'proposed', claim: 'Maybe'} as EvidenceItem,
      {id: 'h', projectId, kind: 'model_hypothesis', verificationStatus: 'confirmed', claim: 'Perhaps'} as EvidenceItem
    ]);
    expect(options.assets).toEqual([{id: 'a', label: 'Mara outside the bakery'}]);
    expect(options.evidence).toEqual([{id: 'e', label: 'Opened in 1964'}]);
    expect(JSON.stringify(options)).not.toContain('foreign');
    expect(JSON.stringify(options)).not.toContain('Maybe');
    expect(JSON.stringify(options)).not.toContain('Perhaps');
  });

  it('offers exactly the project assets that the server asset reader accepts', async () => {
    const projectId = crypto.randomUUID();
    const asset = (id: string, owner: string, processingStatus: Asset['processingStatus']): Asset => ({
      id,
      projectId: owner,
      kind: 'image',
      originalName: `${id}.jpg`,
      mimeType: 'image/jpeg',
      originalObjectKey: `assets/${id}`,
      processingStatus,
      reservationExpiresAt: null,
      size: 1,
      caption: id,
      capturedAtText: null,
      knownPeople: [],
      sequenceOrder: 0,
      transcript: null
    });
    const assets = [
      asset('ready-project', projectId, 'ready'),
      asset('pending-project', projectId, 'pending'),
      asset('ready-foreign', crypto.randomUUID(), 'ready')
    ];
    const selectableIds = buildStoryboardOptions(projectId, assets, []).assets.map(({id}) => id);
    const acceptedIds = await new RepositoryProjectAssetReader({listByProject: async () => assets})
      .listReadyProjectAssetIds(projectId);

    expect(selectableIds).toEqual(['ready-project']);
    expect(acceptedIds).toEqual(selectableIds);
  });
});

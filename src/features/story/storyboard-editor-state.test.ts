import {describe, expect, it} from 'vitest';

import type {EvidenceItem} from '../evidence/schemas';
import {
  displayEvidenceClaim,
  mergeStoryboardResponse,
  sceneEditorFields,
  serializeSceneEdit
} from './storyboard-editor-state';
import type {FilmScene, Storyboard} from './story-service';

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
    expect(mergeStoryboardResponse(current, incoming, new Set([a.id])).scenes).toEqual([
      a,
      expect.objectContaining({id: b.id, title: 'Saved B'})
    ]);
  });

  it('applies server order while preserving dirty scene fields by ID', () => {
    const a = scene(crypto.randomUUID(), 'Unsaved A');
    const b = scene(crypto.randomUUID(), 'B');
    const merged = mergeStoryboardResponse(board(1, [a, b]), board(2, [{...b, sequenceOrder: 0}, {...a, title: 'Server A', sequenceOrder: 1}]), new Set([a.id]));
    expect(merged.scenes.map((item) => item.id)).toEqual([b.id, a.id]);
    expect(merged.scenes[1].title).toBe('Unsaved A');
    expect(merged.revision).toBe(2);
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
});

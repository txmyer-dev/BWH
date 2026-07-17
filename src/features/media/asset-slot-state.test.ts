import {describe, expect, it} from 'vitest';

import {hydrateImageSlots, mergeLocalImageDraft} from './asset-slot-state';

describe('hydrateImageSlots', () => {
  it('maps persisted images by sequence and leaves missing positions empty', () => {
    const slots = hydrateImageSlots([
      {id: 'b', kind: 'image', processingStatus: 'ready', caption: 'Second', sequenceOrder: 1},
      {id: 'a', kind: 'image', processingStatus: 'processing', caption: null, sequenceOrder: 0},
      {id: 'text', kind: 'text', processingStatus: 'ready', caption: null, sequenceOrder: 0}
    ], 3);

    expect(slots).toEqual([
      {kind: 'persisted', assetId: 'a', status: 'processing', label: 'Photograph 1'},
      {kind: 'persisted', assetId: 'b', status: 'ready', label: 'Second'},
      {kind: 'empty'}
    ]);
  });
});

describe('mergeLocalImageDraft', () => {
  it('prefers a local draft over a persisted slot', () => {
    const draft = {fileName: 'replacement.jpg'};

    expect(mergeLocalImageDraft(
      {kind: 'persisted', assetId: 'saved', status: 'ready', label: 'Saved photograph'},
      draft
    )).toBe(draft);
  });

  it('keeps the hydrated slot when there is no local draft', () => {
    const slot = {kind: 'persisted', assetId: 'saved', status: 'ready', label: 'Saved photograph'} as const;

    expect(mergeLocalImageDraft(slot, undefined)).toBe(slot);
  });
});

import {describe, expect, it} from 'vitest';

import {sceneVisualStyle} from './composition';

describe('sceneVisualStyle', () => {
  it('keeps hold scenes still and gives zoom scenes restrained motion', () => {
    expect(sceneVisualStyle('hold', 30, 300)).toEqual({scale: 1, translateX: 0});
    expect(sceneVisualStyle('slow_zoom_in', 0, 300).scale).toBe(1);
    expect(sceneVisualStyle('slow_zoom_in', 299, 300).scale).toBeCloseTo(1.06, 2);
  });
});

import {describe, expect, it} from 'vitest';
import {canUseAuditAction, shouldAcceptAuditResponse} from './audit-ui-state';

describe('audit UI state fencing', () => {
  it('requires all narration and order changes to be saved before request or approval', () => {
    expect(canUseAuditAction({dirtySceneCount: 1, orderDirty: false})).toBe(false);
    expect(canUseAuditAction({dirtySceneCount: 0, orderDirty: true})).toBe(false);
    expect(canUseAuditAction({dirtySceneCount: 0, orderDirty: false})).toBe(true);
  });

  it('discards an audit response when a local edit occurred while the request was in flight', () => {
    expect(shouldAcceptAuditResponse({startedGeneration: 4, currentGeneration: 5, dirtySceneCount: 1, orderDirty: false})).toBe(false);
    expect(shouldAcceptAuditResponse({startedGeneration: 4, currentGeneration: 4, dirtySceneCount: 0, orderDirty: false})).toBe(true);
  });
});

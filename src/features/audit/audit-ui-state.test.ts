import {describe, expect, it} from 'vitest';
import {canStartApproval, canUseAuditAction, shouldAcceptApprovalResponse, shouldAcceptAuditResponse} from './audit-ui-state';

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

  it('blocks duplicate, dirty, and reordered approval requests', () => {
    expect(canStartApproval({dirtySceneCount: 0, orderDirty: false, approvalPending: true})).toBe(false);
    expect(canStartApproval({dirtySceneCount: 1, orderDirty: false, approvalPending: false})).toBe(false);
    expect(canStartApproval({dirtySceneCount: 0, orderDirty: false, approvalPending: false})).toBe(true);
  });

  it('discards approval success after a mid-flight edit or displayed-audit change', () => {
    const base = {startedGeneration: 3, currentGeneration: 3, dirtySceneCount: 0, orderDirty: false, startedAuditId: 'audit-1', currentAuditId: 'audit-1'};
    expect(shouldAcceptApprovalResponse(base)).toBe(true);
    expect(shouldAcceptApprovalResponse({...base, currentGeneration: 4, dirtySceneCount: 1})).toBe(false);
    expect(shouldAcceptApprovalResponse({...base, currentAuditId: null})).toBe(false);
    expect(shouldAcceptApprovalResponse({...base, currentAuditId: 'audit-2'})).toBe(false);
  });
});

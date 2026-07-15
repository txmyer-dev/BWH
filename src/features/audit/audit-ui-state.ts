export type AuditActionState = {dirtySceneCount: number; orderDirty: boolean};
export const canUseAuditAction = (state: AuditActionState) => state.dirtySceneCount === 0 && !state.orderDirty;
export const shouldAcceptAuditResponse = (state: AuditActionState & {startedGeneration: number; currentGeneration: number}) => canUseAuditAction(state) && state.startedGeneration === state.currentGeneration;
export const canStartApproval = (state: AuditActionState & {approvalPending: boolean}) => canUseAuditAction(state) && !state.approvalPending;
export const shouldAcceptApprovalResponse = (state: AuditActionState & {startedGeneration: number; currentGeneration: number; startedAuditId: string; currentAuditId: string|null}) => canUseAuditAction(state) && state.startedGeneration === state.currentGeneration && state.startedAuditId === state.currentAuditId;

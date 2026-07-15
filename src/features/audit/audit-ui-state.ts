export type AuditActionState = {dirtySceneCount: number; orderDirty: boolean};
export const canUseAuditAction = (state: AuditActionState) => state.dirtySceneCount === 0 && !state.orderDirty;
export const shouldAcceptAuditResponse = (state: AuditActionState & {startedGeneration: number; currentGeneration: number}) => canUseAuditAction(state) && state.startedGeneration === state.currentGeneration;

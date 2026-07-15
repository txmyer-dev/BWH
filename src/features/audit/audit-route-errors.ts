type Phase = 'audit'|'approval';
const known: Record<string, number> = {
  PROJECT_FORBIDDEN: 403, PROJECT_NOT_FOUND: 404, STORYBOARD_NOT_FOUND: 404, AUDIT_NOT_FOUND: 404,
  PROCESSING_CONSENT_REQUIRED: 412, PROJECT_PROVIDER_BUDGET_EXCEEDED: 429, PROJECT_PROVIDER_REQUEST_BUDGET_EXCEEDED: 429,
  AUDIT_BLOCKING_FINDINGS: 409, AUDIT_HASH_MISMATCH: 409, AUDIT_STALE: 409, AUDIT_CONTRACT_STALE: 409,
  STORYBOARD_DURATION_OUT_OF_RANGE: 400, AUDIT_APPROVED_EVIDENCE_REQUIRED: 400,
  OPENAI_AUDIT_NOT_CONFIGURED: 503
};
export const safeAuditRouteError = (error: unknown, phase: Phase) => {
  const message = error instanceof Error ? error.message : '';
  if (Object.hasOwn(known, message)) return {code: message, status: known[message]};
  return phase === 'audit' ? {code: 'AUDIT_REVIEW_UNAVAILABLE', status: 502} : {code: 'NARRATION_APPROVAL_UNAVAILABLE', status: 500};
};

export const safeNarrationRouteError = (error: unknown) => {
  const code = error instanceof Error ? error.message : '';
  if (code === 'PROJECT_FORBIDDEN') return {status: 403, code};
  if (code === 'PROJECT_NOT_FOUND' || code === 'STORYBOARD_NOT_FOUND') return {status: 404, code: 'PROJECT_NOT_FOUND'};
  if (['PROCESSING_CONSENT_REQUIRED','NARRATION_TEXT_APPROVAL_REQUIRED','NARRATION_TEXT_APPROVAL_STALE','NARRATION_SAMPLE_APPROVAL_REQUIRED','NARRATION_SELECTION_REQUIRED','CREATOR_AUDIO_AUDIT_REQUIRED','CREATOR_AUDIO_TRANSCRIPT_REQUIRED'].includes(code)) return {status: 409, code};
  if (['AZURE_NARRATION_NOT_CONFIGURED','DEEPGRAM_NARRATION_NOT_CONFIGURED'].includes(code)) return {status: 503, code};
  if (code.startsWith('NARRATION_') || code.startsWith('AZURE_') || code.startsWith('DEEPGRAM_')) return {status: 400, code: 'NARRATION_REQUEST_FAILED'};
  return {status: 500, code: 'NARRATION_REQUEST_FAILED'};
};

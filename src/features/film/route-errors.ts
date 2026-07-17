const recoverable = new Set([
  'FILM_APPROVAL_REQUIRED',
  'FILM_DURATION_OUT_OF_RANGE',
  'FILM_NARRATION_TRACK_REQUIRED',
  'FILM_AUTHENTIC_CLIP_REQUIRED',
  'FILM_NOT_RENDERED',
  'FILM_APPROVAL_CHANGED_DURING_RENDER',
  'NARRATION_SELECTION_REQUIRED',
  'NARRATION_TEXT_APPROVAL_REQUIRED',
  'NARRATION_TEXT_APPROVAL_STALE',
  'CREATOR_AUDIO_AUDIT_REQUIRED'
]);

export const safeFilmRouteError = (error: unknown) => {
  const message = error instanceof Error ? error.message : '';
  if (message === 'PROJECT_FORBIDDEN') return {code: message, status: 403};
  if (message === 'PROJECT_NOT_FOUND') return {code: message, status: 404};
  if (message === 'RENDER_JOB_LAUNCH_FAILED') return {code: message, status: 502};
  if (recoverable.has(message)) return {code: message, status: 409};
  return {code: 'FILM_PREPARATION_FAILED', status: 500};
};

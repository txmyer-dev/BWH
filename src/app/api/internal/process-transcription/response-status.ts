export const internalTranscriptionErrorStatus = (code: string) => {
  if (code === 'CLOUD_TASK_UNAUTHORIZED') return 401;
  if (code === 'TRANSCRIPTION_JOB_BUSY') return 503;
  if (code === 'TRANSCRIPTION_JOB_NOT_FOUND') return 404;
  if (code === 'TRANSCRIPTION_FAILED') return 422;
  return 400;
};

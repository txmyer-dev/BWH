export const internalAnalysisErrorStatus = (code: string) => {
  if (code === 'CLOUD_TASK_UNAUTHORIZED') return 401;
  if (code === 'ANALYSIS_JOB_BUSY') return 503;
  return 500;
};

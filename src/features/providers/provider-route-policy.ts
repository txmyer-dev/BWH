type SafeRouteError = {code: string; status: number};

export const providerRunsLoadError = (message: string): SafeRouteError =>
  message === 'PROJECT_FORBIDDEN'
    ? {code: message, status: 403}
    : {code: 'PROVIDER_RUNS_LOAD_FAILED', status: 500};

export const providerRetryError = (message: string): SafeRouteError => {
  if (message === 'PROJECT_FORBIDDEN') return {code: message, status: 403};
  if (message === 'PROVIDER_RUN_NOT_FOUND') return {code: message, status: 404};
  if (['PROVIDER_RUN_NOT_AMBIGUOUS','PROJECT_PROVIDER_BUDGET_EXCEEDED','PROJECT_PROVIDER_REQUEST_BUDGET_EXCEEDED','PROCESSING_CONSENT_REQUIRED'].includes(message)) return {code: message, status: 409};
  return {code: 'PROVIDER_RETRY_FAILED', status: 500};
};

export const providerReconciliationError = (message: string): SafeRouteError =>
  message === 'CLOUD_TASK_UNAUTHORIZED'
    ? {code: message, status: 401}
    : {code: 'PROVIDER_RECONCILIATION_FAILED', status: 500};

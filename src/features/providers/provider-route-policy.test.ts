import {describe, expect, it} from 'vitest';

import {providerReconciliationError, providerRetryError, providerRunsLoadError} from './provider-route-policy';

describe('provider route privacy policy', () => {
  it('maps arbitrary internal errors to stable safe codes', () => {
    expect(providerRunsLoadError('signed-url-secret')).toEqual({code: 'PROVIDER_RUNS_LOAD_FAILED', status: 500});
    expect(providerRetryError('signed-url-secret')).toEqual({code: 'PROVIDER_RETRY_FAILED', status: 500});
    expect(providerReconciliationError('signed-url-secret')).toEqual({code: 'PROVIDER_RECONCILIATION_FAILED', status: 500});
  });

  it('preserves only explicitly supported client-actionable errors', () => {
    expect(providerRetryError('PROJECT_FORBIDDEN')).toEqual({code: 'PROJECT_FORBIDDEN', status: 403});
    expect(providerRetryError('PROVIDER_RUN_NOT_FOUND')).toEqual({code: 'PROVIDER_RUN_NOT_FOUND', status: 404});
    expect(providerRetryError('PROVIDER_RUN_NOT_AMBIGUOUS')).toEqual({code: 'PROVIDER_RUN_NOT_AMBIGUOUS', status: 409});
  });
});

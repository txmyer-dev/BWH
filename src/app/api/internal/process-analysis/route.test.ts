import {describe, expect, it} from 'vitest';

import {internalAnalysisErrorStatus} from './response-status';

describe('internal analysis retry responses', () => {
  it('returns a retryable non-2xx response while another unexpired lease owns work', () => {
    expect(internalAnalysisErrorStatus('ANALYSIS_JOB_BUSY')).toBe(503);
  });

  it('does not turn authentication or processing failures into success responses', () => {
    expect(internalAnalysisErrorStatus('CLOUD_TASK_UNAUTHORIZED')).toBe(401);
    expect(internalAnalysisErrorStatus('TEMPORARY_PROVIDER_FAILURE')).toBe(500);
  });
});

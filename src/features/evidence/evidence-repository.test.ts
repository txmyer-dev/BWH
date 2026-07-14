import {describe, expect, it} from 'vitest';

import {claimDisposition, type AnalysisJob} from './evidence-repository';

const now = new Date('2026-07-14T12:00:00Z');
const job = (status: AnalysisJob['status'], leaseExpiresAt: Date | null = null) => ({status, leaseExpiresAt});

describe('analysis job claim contract shared by repository adapters', () => {
  it('claims only pending or expired processing jobs', () => {
    expect(claimDisposition(job('pending'), now)).toBe('claimable');
    expect(claimDisposition(job('processing', new Date('2026-07-14T11:59:59Z')), now)).toBe('claimable');
    expect(claimDisposition(job('processing', new Date('2026-07-14T12:00:01Z')), now)).toBe('busy');
  });

  it('treats failed and completed jobs as terminal outcomes', () => {
    expect(claimDisposition(job('failed'), now)).toBe('terminal');
    expect(claimDisposition(job('completed'), now)).toBe('completed');
  });
});

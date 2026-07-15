import {describe, expect, it} from 'vitest';
import {safeAuditRouteError} from './audit-route-errors';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

describe('safe audit route errors', () => {
  it('maps known application failures and never returns raw provider or secret text', () => {
    expect(safeAuditRouteError(new Error('PROJECT_FORBIDDEN'), 'audit')).toEqual({code: 'PROJECT_FORBIDDEN', status: 403});
    const secret = safeAuditRouteError(new Error('OpenAI 401 sk-secret-family-data'), 'audit');
    expect(secret).toEqual({code: 'AUDIT_REVIEW_UNAVAILABLE', status: 502});
    expect(JSON.stringify(secret)).not.toContain('secret-family-data');
    expect(safeAuditRouteError(new Error('database password=hunter2'), 'approval')).toEqual({code: 'NARRATION_APPROVAL_UNAVAILABLE', status: 500});
  });
  it('wires both public routes through the bounded mapper instead of returning Error.message', () => {
    for (const file of ['src/app/api/projects/[projectId]/audit/route.ts', 'src/app/api/projects/[projectId]/narration-text/approve/route.ts']) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      expect(source).toContain('safeAuditRouteError(error'); expect(source).not.toContain('error.message');
    }
  });
});

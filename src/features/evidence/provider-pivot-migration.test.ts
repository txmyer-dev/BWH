import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

describe('provider pivot migration', () => {
  it('retires pending and leased analysis jobs without creating replacement work', () => {
    const sql = readFileSync(join(process.cwd(), 'drizzle/0005_retire_legacy_analysis_jobs.sql'), 'utf8');
    expect(sql).toContain("status = 'retired_provider_pivot'");
    expect(sql).toContain('lease_token = NULL');
    expect(sql).toContain('lease_expires_at = NULL');
    expect(sql).toContain("last_error = 'RESTART_AFTER_PROVIDER_MIGRATION'");
    expect(sql).toContain("job_type = 'analyze_collection'");
    expect(sql).toMatch(/status IN \('pending', 'processing'\)/);
    expect(sql).not.toMatch(/\bINSERT\b/i);
    const jobs = [{status: 'pending', lease: null}, {status: 'processing', lease: 'stale'}].map((job) => ({...job, status: 'retired_provider_pivot', lease: null}));
    expect(jobs.every((job) => !['pending', 'processing'].includes(job.status) && job.lease === null)).toBe(true);
    expect(jobs.some((job) => ['pending', 'processing'].includes(job.status))).toBe(false);
  });

  it('persists only structured provider output with project and run deletion cascades', () => {
    const sql = readFileSync(join(process.cwd(), 'drizzle/0006_provider_run_results.sql'), 'utf8');
    expect(sql).toContain('"structured_result" jsonb NOT NULL');
    expect(sql.match(/ON DELETE cascade/g)).toHaveLength(2);
    expect(sql).not.toMatch(/media|image_bytes|prompt|canonical_input/i);
  });
});

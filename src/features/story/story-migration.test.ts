import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

const directory = join(process.cwd(), 'drizzle');

describe('storyboard revision migration history', () => {
  it('upgrades an existing 0000 database with a truthful 0001 ALTER', () => {
    const migrations = readdirSync(directory).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
    expect(migrations).toHaveLength(9);
    const initial = readFileSync(join(directory, migrations[0]), 'utf8');
    const revision = readFileSync(join(directory, migrations[1]), 'utf8');
    expect(initial).not.toContain('"revision" integer');
    expect(revision.trim()).toBe('ALTER TABLE "storyboards" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;');
  });

  it('adds project consent history without rewriting existing family data', () => {
    const migrations = readdirSync(directory).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
    const consent = readFileSync(join(directory, migrations[2]), 'utf8');
    expect(consent).toContain('CREATE TABLE "project_consents"');
    expect(consent).toContain('"project_id" uuid NOT NULL');
    expect(consent).toContain('FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade');
    expect(consent).toContain(
      'CREATE UNIQUE INDEX "project_consents_valid_project_purpose_unique" ON "project_consents" USING btree ("project_id","purpose") WHERE "project_consents"."invalidated_at" IS NULL;'
    );
    expect(consent).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM|UPDATE "projects"/);
  });

  it('enforces provider retry lineage integrity', () => {
    const provider = readFileSync(join(directory, '0004_provider_control_plane_review_fixes.sql'), 'utf8');
    expect(provider).toContain('provider_runs_retry_of_run_id_provider_runs_id_fk');
    expect(provider).toContain('FOREIGN KEY ("retry_of_run_id") REFERENCES "public"."provider_runs"("id") ON DELETE set null');
    expect(provider).toContain('CREATE INDEX "provider_runs_retry_of_run_idx"');
  });

  it('keeps the Task 9 migration strictly additive', () => {
    const migration = readFileSync(join(directory, '0007_asset_transcripts.sql'), 'utf8');
    expect(migration).not.toMatch(/DROP\s|TRUNCATE\s|DELETE FROM/);
    expect(migration).toContain('CREATE TABLE "transcript_evidence_segments"');
    expect(migration).toContain('ALTER TABLE "processing_jobs" ADD COLUMN "provider_run_id" uuid');
  });

  it('keeps the factuality audit migration strictly additive', () => {
    const migration = readFileSync(join(directory, '0008_factuality_audits.sql'), 'utf8');
    expect(migration).not.toMatch(/DROP\s|TRUNCATE\s|DELETE FROM/);
    expect(migration).toContain('CREATE TABLE "factuality_audits"');
    expect(migration).toContain('ALTER TABLE "storyboards" ADD COLUMN "narration_approval_hash"');
    expect(migration).toContain('"audit_prompt_version" varchar(40) NOT NULL');
    expect(migration).toContain('"audit_schema_version" varchar(40) NOT NULL');
    expect(migration).toContain('"model" varchar(120) NOT NULL');
  });

  it('keeps fresh and upgraded processing-job index predicates in parity', () => {
    const initial = readFileSync(join(directory, '0000_hard_shadowcat.sql'), 'utf8');
    const task9 = readFileSync(join(directory, '0007_asset_transcripts.sql'), 'utf8');
    const before = JSON.parse(readFileSync(join(directory, 'meta', '0006_snapshot.json'), 'utf8')) as {tables: Record<string, {indexes: Record<string, {where: string}>}>};
    const after = JSON.parse(readFileSync(join(directory, 'meta', '0007_snapshot.json'), 'utf8')) as typeof before;
    const historical = before.tables['public.processing_jobs'].indexes.processing_jobs_active_analysis_unique.where;
    expect(initial).toContain('CREATE UNIQUE INDEX "processing_jobs_active_analysis_unique" ON "processing_jobs" USING btree ("project_id","job_type") WHERE "processing_jobs"."status" IN (\'pending\', \'processing\');');
    expect(historical).toBe('"processing_jobs"."status" IN (\'pending\', \'processing\')');
    expect(after.tables['public.processing_jobs'].indexes.processing_jobs_active_analysis_unique.where).toBe(historical);
    expect(task9).not.toContain('processing_jobs_active_analysis_unique');
    expect(task9).toContain('CREATE UNIQUE INDEX "processing_jobs_active_transcription_asset_unique"');
  });

  it('ships a fresh ordered sequence with a valid journal and snapshot chain', () => {
    const journal = JSON.parse(readFileSync(join(directory, 'meta', '_journal.json'), 'utf8')) as {entries: {idx: number; tag: string}[]};
    const initial = JSON.parse(readFileSync(join(directory, 'meta', '0000_snapshot.json'), 'utf8')) as {id: string; prevId: string; tables: Record<string, {columns: Record<string, unknown>}>};
    const next = JSON.parse(readFileSync(join(directory, 'meta', '0001_snapshot.json'), 'utf8')) as {id: string; prevId: string; tables: Record<string, {columns: Record<string, unknown>}>};
    const consent = JSON.parse(readFileSync(join(directory, 'meta', '0002_snapshot.json'), 'utf8')) as {prevId: string; tables: Record<string, {columns: Record<string, unknown>}>};
    const providers = JSON.parse(readFileSync(join(directory, 'meta', '0003_snapshot.json'), 'utf8')) as {prevId: string; tables: Record<string, {columns: Record<string, unknown>}>};
    const providerFixes = JSON.parse(readFileSync(join(directory, 'meta', '0004_snapshot.json'), 'utf8')) as {prevId: string; tables: Record<string, {columns: Record<string, unknown>}>};
    const transcripts = JSON.parse(readFileSync(join(directory, 'meta', '0007_snapshot.json'), 'utf8')) as {prevId: string; tables: Record<string, {columns: Record<string, unknown>}>};
    const audits = JSON.parse(readFileSync(join(directory, 'meta', '0008_snapshot.json'), 'utf8')) as {prevId: string; tables: Record<string, {columns: Record<string, unknown>}>};
    expect(journal.entries.map(({idx, tag}) => ({idx, tag}))).toEqual([
      {idx: 0, tag: '0000_hard_shadowcat'},
      {idx: 1, tag: expect.stringMatching(/^0001_/)},
      {idx: 2, tag: '0002_project_consents'},
      {idx: 3, tag: '0003_provider_control_plane'},
      {idx: 4, tag: '0004_provider_control_plane_review_fixes'},
      {idx: 5, tag: '0005_retire_legacy_analysis_jobs'},
      {idx: 6, tag: '0006_provider_run_results'},
      {idx: 7, tag: '0007_asset_transcripts'},
      {idx: 8, tag: '0008_factuality_audits'}
    ]);
    expect(initial.tables['public.storyboards'].columns).not.toHaveProperty('revision');
    expect(next.prevId).toBe(initial.id);
    expect(next.tables['public.storyboards'].columns).toHaveProperty('revision');
    expect(consent.prevId).toBe(next.id);
    expect(consent.tables).toHaveProperty('public.project_consents');
    expect(providers.prevId).toBe((JSON.parse(readFileSync(join(directory, 'meta', '0002_snapshot.json'), 'utf8')) as {id: string}).id);
    expect(providers.tables).toHaveProperty('public.provider_runs');
    expect(providers.tables).toHaveProperty('public.provider_artifacts');
    expect(providers.tables).toHaveProperty('public.project_provider_budgets');
    expect(providerFixes.prevId).toBe((JSON.parse(readFileSync(join(directory, 'meta', '0003_snapshot.json'), 'utf8')) as {id: string}).id);
    expect(providerFixes.tables['public.provider_runs'].columns).toHaveProperty('consent_snapshot_hash');
    expect(transcripts.prevId).toBe((JSON.parse(readFileSync(join(directory, 'meta', '0006_snapshot.json'), 'utf8')) as {id: string}).id);
    expect(transcripts.tables).toHaveProperty('public.asset_transcripts');
    expect(transcripts.tables).toHaveProperty('public.transcript_evidence_segments');
    expect(transcripts.tables['public.film_scenes'].columns).toHaveProperty('authentic_clip');
    expect(transcripts.tables['public.processing_jobs'].columns).toHaveProperty('provider_run_id');
    expect(audits.prevId).toBe((JSON.parse(readFileSync(join(directory, 'meta', '0007_snapshot.json'), 'utf8')) as {id: string}).id);
    expect(audits.tables).toHaveProperty('public.factuality_audits');
    expect(audits.tables['public.storyboards'].columns).toHaveProperty('narration_approval_hash');
  });
});

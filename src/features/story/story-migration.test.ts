import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

const directory = join(process.cwd(), 'drizzle');

describe('storyboard revision migration history', () => {
  it('upgrades an existing 0000 database with a truthful 0001 ALTER', () => {
    const migrations = readdirSync(directory).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
    expect(migrations).toHaveLength(3);
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

  it('ships a fresh ordered sequence with a valid journal and snapshot chain', () => {
    const journal = JSON.parse(readFileSync(join(directory, 'meta', '_journal.json'), 'utf8')) as {entries: {idx: number; tag: string}[]};
    const initial = JSON.parse(readFileSync(join(directory, 'meta', '0000_snapshot.json'), 'utf8')) as {id: string; prevId: string; tables: Record<string, {columns: Record<string, unknown>}>};
    const next = JSON.parse(readFileSync(join(directory, 'meta', '0001_snapshot.json'), 'utf8')) as {id: string; prevId: string; tables: Record<string, {columns: Record<string, unknown>}>};
    const consent = JSON.parse(readFileSync(join(directory, 'meta', '0002_snapshot.json'), 'utf8')) as {prevId: string; tables: Record<string, {columns: Record<string, unknown>}>};
    expect(journal.entries.map(({idx, tag}) => ({idx, tag}))).toEqual([
      {idx: 0, tag: '0000_hard_shadowcat'},
      {idx: 1, tag: expect.stringMatching(/^0001_/)},
      {idx: 2, tag: '0002_project_consents'}
    ]);
    expect(initial.tables['public.storyboards'].columns).not.toHaveProperty('revision');
    expect(next.prevId).toBe(initial.id);
    expect(next.tables['public.storyboards'].columns).toHaveProperty('revision');
    expect(consent.prevId).toBe(next.id);
    expect(consent.tables).toHaveProperty('public.project_consents');
  });
});

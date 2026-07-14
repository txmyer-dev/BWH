import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {getTableConfig} from 'drizzle-orm/pg-core';
import {describe, expect, it} from 'vitest';

import {assets} from '../../server/db/schema';

describe('asset database constraints', () => {
  it('enforces kind cardinality, sequence slots, and immutable object-key uniqueness', () => {
    const config = getTableConfig(assets);
    expect(config.checks.map((check) => check.name)).toContain('assets_kind_sequence_check');
    expect(config.checks.map((check) => check.name)).toContain('assets_pending_expiry_check');
    expect(config.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        'assets_project_kind_sequence_unique',
        'assets_original_object_key_unique'
      ])
    );
  });

  it('ships one fresh migration with every media invariant from table creation', () => {
    const migrationDirectory = join(process.cwd(), 'drizzle');
    const migrations = readdirSync(migrationDirectory).filter((name) =>
      /^\d+_.+\.sql$/.test(name)
    );
    expect(migrations).toHaveLength(1);
    expect(migrations[0]).toMatch(/^0000_/);

    const sql = readFileSync(join(migrationDirectory, migrations[0]), 'utf8');
    expect(sql).toContain('"asset_kind" varchar(30) NOT NULL');
    expect(sql).toContain('"reservation_expires_at" timestamp with time zone');
    expect(sql).toContain('assets_kind_sequence_check');
    expect(sql).toContain('assets_pending_expiry_check');
    expect(sql).toContain(
      `"assets"."asset_kind" IN ('text', 'source_audio', 'creator_narration')`
    );
    expect(sql).toContain('"assets"."sequence_order" BETWEEN 0 AND 6');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "assets_project_kind_sequence_unique" ON "assets" USING btree ("project_id","asset_kind","sequence_order")'
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "assets_original_object_key_unique" ON "assets" USING btree ("original_object_key")'
    );
    expect(sql).toContain(
      `"processing_status" <> 'pending' OR "assets"."reservation_expires_at" IS NOT NULL`
    );
    expect(sql).toContain("WHERE \"assets\".\"processing_status\" <> 'cleanup_pending'");
    expect(sql).not.toContain('ALTER TABLE "assets" ADD COLUMN "asset_kind"');
  });
});

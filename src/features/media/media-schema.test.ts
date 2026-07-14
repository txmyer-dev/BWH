import {getTableConfig} from 'drizzle-orm/pg-core';
import {describe, expect, it} from 'vitest';

import {assets} from '../../server/db/schema';

describe('asset database constraints', () => {
  it('enforces kind cardinality, sequence slots, and immutable object-key uniqueness', () => {
    const config = getTableConfig(assets);
    expect(config.checks.map((check) => check.name)).toContain('assets_kind_sequence_check');
    expect(config.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        'assets_project_kind_sequence_unique',
        'assets_original_object_key_unique'
      ])
    );
  });
});

import {sql} from 'drizzle-orm';

import type {ProviderDatabaseTransaction} from '../providers/types';

/** Canonical first lock for every transaction that can invalidate narration state. */
export const lockNarrationProject = async (
  transaction: ProviderDatabaseTransaction,
  projectId: string
) => {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtext(${projectId}), hashtext('narration'))`
  );
};

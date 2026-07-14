import {storyProviderMigrationPendingResponse} from '../../../../../server/providers/provider-migration-gate';

export async function POST() {
  return storyProviderMigrationPendingResponse();
}

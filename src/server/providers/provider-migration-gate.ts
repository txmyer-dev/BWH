export const storyProviderMigrationPendingResponse = () =>
  Response.json(
    {error: 'STORY_PROVIDER_MIGRATION_PENDING'},
    {status: 503}
  );

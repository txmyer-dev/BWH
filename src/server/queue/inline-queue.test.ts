import {describe, expect, it} from 'vitest';

import {InlineQueue} from './inline-queue';

describe('InlineQueue cleanup identity', () => {
  it('delivers the same artifact identifier once per provider without exposing it as identity', async () => {
    const queue = new InlineQueue(); const base = {type: 'cleanup_provider_artifact' as const, projectId: crypto.randomUUID(), providerRunId: null, providerArtifactId: 'files/shared'};
    await queue.enqueue({...base, provider: 'google_gemini'}); await queue.enqueue({...base, provider: 'another_provider'}); await queue.enqueue({...base, provider: 'google_gemini'});
    expect(queue.tasks).toHaveLength(2);
  });
});

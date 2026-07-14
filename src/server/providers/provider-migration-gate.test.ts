import {describe, expect, it, vi} from 'vitest';

const openAIConstructor = vi.fn();
vi.mock('openai', () => ({default: openAIConstructor}));

describe('legacy story provider migration gate', () => {
  it.each([
    ['project analysis', async () => {
      const {POST} = await import('../../app/api/projects/[projectId]/analyze/route');
      return POST();
    }],
    ['internal analysis', async () => {
      const {POST} = await import('../../app/api/internal/process-analysis/route');
      return POST();
    }],
    ['question generation', async () => {
      const {POST} = await import('../../app/api/projects/[projectId]/questions/route');
      return POST();
    }],
    ['question answer mutation', async () => {
      const {PATCH} = await import('../../app/api/projects/[projectId]/questions/route');
      return PATCH();
    }],
    ['storyboard retrieval', async () => {
      const {GET} = await import('../../app/api/projects/[projectId]/storyboard/route');
      return GET();
    }],
    ['storyboard mutation', async () => {
      const {POST} = await import('../../app/api/projects/[projectId]/storyboard/route');
      return POST();
    }],
    ['storyboard patch', async () => {
      const {PATCH} = await import('../../app/api/projects/[projectId]/storyboard/route');
      return PATCH();
    }]
  ])('returns 503 before constructing OpenAI for %s', async (_name, invoke) => {
    const response = await invoke();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({error: 'STORY_PROVIDER_MIGRATION_PENDING'});
    expect(openAIConstructor).not.toHaveBeenCalled();
  });
});

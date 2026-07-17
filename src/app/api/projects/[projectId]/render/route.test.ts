import {describe, expect, it, vi} from 'vitest';

import {createRenderHandlers} from './route';

const projectId = '11111111-1111-4111-8111-111111111111';
const context = {params: Promise.resolve({projectId})};
const request = new Request(`http://localhost/api/projects/${projectId}/render`);

describe('render route handlers', () => {
  it('returns 202 for an accepted render and exposes normalized GET status', async () => {
    const coordinator = {
      request: vi.fn(async () => ({jobId: 'job-1', status: 'pending' as const, attemptCount: 0, created: true as const})),
      status: vi.fn(async () => ({jobId: 'job-1', status: 'pending' as const, attemptCount: 0}))
    };
    const {POST, GET} = createRenderHandlers(coordinator);

    const post = await POST(request, context);
    const get = await GET(request, context);

    expect(post.status).toBe(202);
    expect(await post.json()).toEqual({jobId: 'job-1', status: 'pending', attemptCount: 0, created: true});
    expect(await get.json()).toEqual({jobId: 'job-1', status: 'pending', attemptCount: 0});
  });

  it('returns 200 for completed render reuse', async () => {
    const handlers = createRenderHandlers({
      request: async () => ({status: 'completed' as const, manifestHash: 'a'.repeat(64), reused: true as const}),
      status: async () => ({status: 'idle' as const})
    });

    const response = await handlers.POST(request, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({status: 'completed', manifestHash: 'a'.repeat(64), reused: true});
  });

  it.each([
    ['PROJECT_FORBIDDEN', 403],
    ['FILM_APPROVAL_REQUIRED', 409],
    ['RENDER_JOB_LAUNCH_FAILED', 502]
  ])('maps %s to a safe HTTP response', async (code, status) => {
    const handlers = createRenderHandlers({
      request: async () => { throw new Error(code); },
      status: async () => { throw new Error(code); }
    });

    const post = await handlers.POST(request, context);
    const get = await handlers.GET(request, context);

    expect(post.status).toBe(status);
    expect(await post.json()).toEqual({error: code});
    expect(get.status).toBe(status);
    expect(await get.json()).toEqual({error: code});
  });
});

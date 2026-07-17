import {afterEach, describe, expect, it, vi} from 'vitest';

import {abortableWait, pollRenderStatus, type RenderStatus} from './render-polling';

afterEach(() => {
  vi.useRealTimers();
});

describe('render status polling', () => {
  it('polls pending through processing and stops at completed', async () => {
    vi.useFakeTimers();
    const statuses: RenderStatus[] = [
      {status: 'pending', jobId: 'job-1'},
      {status: 'processing', jobId: 'job-1'},
      {status: 'completed', jobId: 'job-1'}
    ];
    const load = vi.fn(async () => statuses.shift()!);
    const controller = new AbortController();

    const result = pollRenderStatus({
      load,
      signal: controller.signal,
      wait: abortableWait
    });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual({status: 'completed', jobId: 'job-1'});
    expect(load).toHaveBeenCalledTimes(3);
  });

  it.each([
    {status: 'failed', jobId: 'job-1', error: 'RENDER_EXECUTION_FAILED'},
    {status: 'superseded', jobId: 'job-1', error: 'RENDER_SUPERSEDED'}
  ] satisfies RenderStatus[])('stops polling at $status', async (terminal) => {
    const load = vi.fn(async () => terminal);

    await expect(pollRenderStatus({
      load,
      signal: new AbortController().signal,
      wait: abortableWait
    })).resolves.toEqual(terminal);
    expect(load).toHaveBeenCalledOnce();
  });

  it('cancels an active delay when aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const result = pollRenderStatus({
      load: vi.fn(async () => ({status: 'pending', jobId: 'job-1'} as const)),
      signal: controller.signal,
      wait: abortableWait
    });
    await Promise.resolve();

    controller.abort();

    await expect(result).rejects.toMatchObject({name: 'AbortError'});
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401, 403])('stops without retry after an auth failure (%s)', async (httpStatus) => {
    const load = vi.fn(async () => {
      throw new Error(httpStatus === 401 ? 'PROJECT_UNAUTHORIZED' : 'PROJECT_FORBIDDEN');
    });

    await expect(pollRenderStatus({
      load,
      signal: new AbortController().signal,
      wait: abortableWait
    })).rejects.toThrow(httpStatus === 401 ? 'PROJECT_UNAUTHORIZED' : 'PROJECT_FORBIDDEN');
    expect(load).toHaveBeenCalledOnce();
  });
});

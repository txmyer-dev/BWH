import {describe, expect, it, vi} from 'vitest';

import {runRenderFilmLifecycle} from './render-film';

const input = {
  projectId: '00000000-0000-4000-8000-000000000001',
  jobId: '00000000-0000-4000-8000-000000000002'
};

const setup = (run: () => Promise<void>) => {
  const close = vi.fn().mockResolvedValue(undefined);
  const info = vi.fn();
  const error = vi.fn();
  return {
    close,
    info,
    error,
    execute: () => runRenderFilmLifecycle(input, {run}, {close, info, error})
  };
};

describe('runRenderFilmLifecycle', () => {
  it('closes the database after logging a successful render', async () => {
    const lifecycle = setup(vi.fn().mockResolvedValue(undefined));

    await expect(lifecycle.execute()).resolves.toBe(0);

    expect(lifecycle.info.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      {event: 'render_job_started', ...input},
      {event: 'render_job_finished', ...input}
    ]);
    expect(lifecycle.close).toHaveBeenCalledOnce();
    expect(lifecycle.close.mock.invocationCallOrder[0]).toBeGreaterThan(lifecycle.info.mock.invocationCallOrder[1]);
  });

  it('closes the database and returns failure without logging renderer details', async () => {
    const lifecycle = setup(vi.fn().mockRejectedValue(new Error('Chromium included C:\\private\\film.mp4')));

    await expect(lifecycle.execute()).resolves.toBe(1);

    expect(lifecycle.error).toHaveBeenCalledWith(JSON.stringify({
      event: 'render_job_failed',
      ...input,
      code: 'RENDER_EXECUTION_FAILED'
    }));
    expect(lifecycle.error.mock.calls.flat().join(' ')).not.toContain('Chromium');
    expect(lifecycle.close).toHaveBeenCalledOnce();
    expect(lifecycle.close.mock.invocationCallOrder[0]).toBeGreaterThan(lifecycle.error.mock.invocationCallOrder[0]);
  });

  it('closes the database when a busy claim returns without rendering', async () => {
    const lifecycle = setup(vi.fn().mockResolvedValue(undefined));

    await expect(lifecycle.execute()).resolves.toBe(0);

    expect(lifecycle.close).toHaveBeenCalledOnce();
  });

  it('closes the database and returns failure when the job is missing', async () => {
    const lifecycle = setup(vi.fn().mockRejectedValue(new Error('RENDER_JOB_NOT_FOUND')));

    await expect(lifecycle.execute()).resolves.toBe(1);

    expect(lifecycle.error).toHaveBeenCalledWith(JSON.stringify({
      event: 'render_job_failed',
      ...input,
      code: 'RENDER_EXECUTION_FAILED'
    }));
    expect(lifecycle.close).toHaveBeenCalledOnce();
  });
});

import {describe, expect, it, vi} from 'vitest';

import {InMemoryRenderJobRepository} from './render-job-repository';
import {RenderWorker} from './render-worker';

describe('RenderWorker', () => {
  it('claims, renders, and completes a job', async () => {
    const jobs = new InMemoryRenderJobRepository();
    const {job} = await jobs.request('00000000-0000-4000-8000-000000000001');
    const render = vi.fn().mockResolvedValue(undefined);
    const worker = new RenderWorker(jobs, render);

    await worker.run({projectId: job.projectId, jobId: job.id});

    expect(render).toHaveBeenCalledWith(job.projectId);
    expect(await jobs.latest(job.projectId)).toMatchObject({status: 'completed'});
  });

  it('records a bounded failure and rejects so Cloud Run marks the execution failed', async () => {
    const jobs = new InMemoryRenderJobRepository();
    const {job} = await jobs.request('00000000-0000-4000-8000-000000000002');
    const render = vi.fn().mockRejectedValueOnce(new Error('Chromium included private filesystem detail'));
    const worker = new RenderWorker(jobs, render);

    await expect(worker.run({projectId: job.projectId, jobId: job.id})).rejects.toThrow('RENDER_EXECUTION_FAILED');

    expect(await jobs.latest(job.projectId)).toMatchObject({status: 'failed', lastError: 'RENDER_EXECUTION_FAILED'});
  });

  it('does nothing when another execution owns an unexpired lease', async () => {
    const jobs = new InMemoryRenderJobRepository();
    const {job} = await jobs.request('00000000-0000-4000-8000-000000000003');
    await jobs.claim(job.id, job.projectId, new Date(), 3_600_000);
    const render = vi.fn().mockResolvedValue(undefined);
    const worker = new RenderWorker(jobs, render);

    await expect(worker.run({projectId: job.projectId, jobId: job.id})).resolves.toBeUndefined();

    expect(render).not.toHaveBeenCalled();
  });

  it('does not overwrite a superseded state when edits race a render', async () => {
    const jobs = new InMemoryRenderJobRepository();
    const {job} = await jobs.request('00000000-0000-4000-8000-000000000004');
    const render = vi.fn().mockImplementationOnce(async () => {
      await jobs.supersedeProject(job.projectId);
    });
    const worker = new RenderWorker(jobs, render);

    await expect(worker.run({projectId: job.projectId, jobId: job.id})).rejects.toThrow('RENDER_SUPERSEDED');

    expect(await jobs.latest(job.projectId)).toMatchObject({status: 'superseded'});
  });

  it('rejects a missing job with a bounded lifecycle code', async () => {
    const jobs = new InMemoryRenderJobRepository();
    const worker = new RenderWorker(jobs, vi.fn());

    await expect(worker.run({
      projectId: '00000000-0000-4000-8000-000000000005',
      jobId: '00000000-0000-4000-8000-000000000006'
    })).rejects.toThrow('RENDER_JOB_NOT_FOUND');
  });
});

import {describe, expect, it} from 'vitest';

import {InMemoryRenderJobRepository} from './render-job-repository';

describe('render job lifecycle', () => {
  it('deduplicates active requests and completes only the lease owner', async () => {
    const repository = new InMemoryRenderJobRepository();
    const first = await repository.request('project');
    const duplicate = await repository.request('project');

    expect(first.created).toBe(true);
    expect(duplicate).toMatchObject({created: false, job: {id: first.job.id}});

    const claim = await repository.claim(first.job.id, 'project', new Date('2026-07-16T12:00:00Z'), 3_600_000);
    expect(claim.outcome).toBe('claimed');
    if (claim.outcome !== 'claimed') throw new Error('expected claim');

    await expect(repository.complete(first.job.id, crypto.randomUUID())).rejects.toThrow('RENDER_JOB_LEASE_LOST');
    await repository.complete(first.job.id, claim.job.leaseToken!);
    expect(await repository.latest('project')).toMatchObject({status: 'completed'});
  });

  it('reclaims an expired processing lease and fences the old lease owner', async () => {
    const repository = new InMemoryRenderJobRepository();
    const {job} = await repository.request('project');
    const firstClaim = await repository.claim(job.id, 'project', new Date('2026-07-16T12:00:00Z'), 1_000);
    const reclaimed = await repository.claim(job.id, 'project', new Date('2026-07-16T12:00:02Z'), 1_000);

    expect(reclaimed.outcome).toBe('claimed');
    if (firstClaim.outcome !== 'claimed' || reclaimed.outcome !== 'claimed') throw new Error('expected claims');
    expect(reclaimed.job.attemptCount).toBe(2);
    await expect(repository.fail(job.id, firstClaim.job.leaseToken!, 'STALE_WORKER')).rejects.toThrow('RENDER_JOB_LEASE_LOST');
    await repository.fail(job.id, reclaimed.job.leaseToken!, 'RENDER_FAILED');
    expect(await repository.latest('project')).toMatchObject({status: 'failed', lastError: 'RENDER_FAILED'});
    expect((await repository.request('project')).created).toBe(true);
  });

  it('keeps an old render terminal after it is superseded', async () => {
    const repository = new InMemoryRenderJobRepository();
    const {job} = await repository.request('project');
    const claim = await repository.claim(job.id, 'project', new Date('2026-07-16T12:00:00Z'), 1_000);
    if (claim.outcome !== 'claimed') throw new Error('expected claim');

    await repository.supersedeProject('project');
    await repository.supersedeProject('project');

    expect(await repository.latest('project')).toMatchObject({id: job.id, status: 'superseded', lastError: 'RENDER_SUPERSEDED'});
    await expect(repository.complete(job.id, claim.job.leaseToken!)).rejects.toThrow('RENDER_JOB_LEASE_LOST');
    expect(await repository.latest('project')).toMatchObject({id: job.id, status: 'superseded'});
    expect((await repository.request('project')).created).toBe(true);
  });

  it('does not let a pending-launch failure overwrite a terminal job', async () => {
    const repository = new InMemoryRenderJobRepository();
    const {job} = await repository.request('project');
    await repository.failPendingLaunch(job.id, 'QUEUE_LAUNCH_FAILED');
    await repository.failPendingLaunch(job.id, 'LATE_DUPLICATE_FAILURE');

    expect(await repository.latest('project')).toMatchObject({status: 'failed', lastError: 'QUEUE_LAUNCH_FAILED'});
  });
});

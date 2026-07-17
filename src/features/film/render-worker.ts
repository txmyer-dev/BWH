import type {RenderJobRepository} from './render-job-repository';

export class RenderWorker {
  constructor(
    private readonly jobs: RenderJobRepository,
    private readonly render: (projectId: string) => Promise<unknown>,
    private readonly now: () => Date = () => new Date(),
    private readonly leaseMs = 3_600_000
  ) {}

  async run({projectId, jobId}: {projectId: string; jobId: string}): Promise<void> {
    const claim = await this.jobs.claim(jobId, projectId, this.now(), this.leaseMs);
    if (claim.outcome !== 'claimed') {
      if (claim.outcome === 'busy') return;
      throw new Error('RENDER_JOB_NOT_FOUND');
    }

    try {
      await this.render(projectId);
      await this.jobs.complete(jobId, claim.job.leaseToken!);
    } catch {
      const latest = await this.jobs.latest(projectId);
      if (latest?.id === jobId && latest.status === 'superseded') {
        throw new Error('RENDER_SUPERSEDED');
      }
      await this.jobs.fail(jobId, claim.job.leaseToken!, 'RENDER_EXECUTION_FAILED');
      throw new Error('RENDER_EXECUTION_FAILED');
    }
  }
}

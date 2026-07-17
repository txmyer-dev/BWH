import type {RenderJobLauncher} from './cloud-run-render-launcher';
import {buildRenderManifest} from './manifest';
import type {RenderJobRepository} from './render-job-repository';
import type {FilmRepository} from './render-service';

const publicError = (error: string | null): string | undefined => {
  if (error === 'RENDER_JOB_LAUNCH_FAILED' || error === 'RENDER_SUPERSEDED') return error;
  return error ? 'RENDER_EXECUTION_FAILED' : undefined;
};

export class RenderCoordinator {
  constructor(
    private readonly films: FilmRepository,
    private readonly jobs: RenderJobRepository,
    private readonly launcher: RenderJobLauncher,
    private readonly assertOwner: (projectId: string) => Promise<void>
  ) {}

  async request(projectId: string) {
    await this.assertOwner(projectId);
    const manifest = buildRenderManifest(await this.films.loadSource(projectId));
    const completed = await this.films.findCompleted(projectId, manifest.manifestHash);
    if (completed) {
      return {status: 'completed' as const, manifestHash: manifest.manifestHash, reused: true as const};
    }

    const requested = await this.jobs.request(projectId);
    if (requested.created) {
      const completedAfterCreation = await this.films.findCompleted(projectId, manifest.manifestHash);
      if (completedAfterCreation) {
        await this.jobs.supersedePending(requested.job.id);
        return {status: 'completed' as const, manifestHash: manifest.manifestHash, reused: true as const};
      }
      try {
        await this.launcher.launch({projectId, jobId: requested.job.id});
      } catch {
        await this.jobs.failPendingLaunch(requested.job.id, 'RENDER_JOB_LAUNCH_FAILED');
        throw new Error('RENDER_JOB_LAUNCH_FAILED');
      }
    }
    return {
      jobId: requested.job.id,
      status: requested.job.status,
      attemptCount: requested.job.attemptCount,
      created: requested.created
    };
  }

  async status(projectId: string) {
    await this.assertOwner(projectId);
    const job = await this.jobs.latest(projectId);
    if (!job) return {status: 'idle' as const};
    const error = publicError(job.lastError);
    return {
      jobId: job.id,
      status: job.status,
      attemptCount: job.attemptCount,
      ...(error ? {error} : {})
    };
  }
}

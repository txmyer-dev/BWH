import {describe, expect, it, vi} from 'vitest';
import {CloudRunRenderJobLauncher} from './cloud-run-render-launcher';

describe('CloudRunRenderJobLauncher', () => {
  it('starts the named job with only project and render job identifiers', async () => {
    const runJob = vi.fn().mockResolvedValue([{}]);
    const launcher = new CloudRunRenderJobLauncher(
      {runJob} as never,
      'projects/demo/locations/us-central1/jobs/legacy-studio-render'
    );

    await launcher.launch({projectId: 'project-id', jobId: 'job-id'});

    expect(runJob).toHaveBeenCalledWith({
      name: 'projects/demo/locations/us-central1/jobs/legacy-studio-render',
      overrides: {
        containerOverrides: [{
          env: [
            {name: 'PROJECT_ID', value: 'project-id'},
            {name: 'RENDER_JOB_ID', value: 'job-id'}
          ]
        }]
      }
    });
  });
});

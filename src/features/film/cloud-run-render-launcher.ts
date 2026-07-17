import {JobsClient} from '@google-cloud/run';

export interface RenderJobLauncher {
  launch(input: {projectId: string; jobId: string}): Promise<void>;
}

export class CloudRunRenderJobLauncher implements RenderJobLauncher {
  constructor(
    private readonly client: Pick<JobsClient, 'runJob'>,
    private readonly name: string
  ) {}

  async launch({projectId, jobId}: {projectId: string; jobId: string}): Promise<void> {
    await this.client.runJob({
      name: this.name,
      overrides: {
        containerOverrides: [{
          env: [
            {name: 'PROJECT_ID', value: projectId},
            {name: 'RENDER_JOB_ID', value: jobId}
          ]
        }]
      }
    });
  }
}

export const renderJobResourceName = (env: {
  GCP_PROJECT_ID: string;
  GCP_LOCATION: string;
  RENDER_JOB_NAME: string;
}): string => env.RENDER_JOB_NAME.startsWith('projects/')
  ? env.RENDER_JOB_NAME
  : `projects/${env.GCP_PROJECT_ID}/locations/${env.GCP_LOCATION}/jobs/${env.RENDER_JOB_NAME}`;

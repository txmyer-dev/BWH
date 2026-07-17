import {resolve} from 'node:path';
import {z} from 'zod';

import {factualityAuditDeployment} from '@/features/audit/audit-deployment';
import {PostgresRenderJobRepository} from '@/features/film/render-job-repository';
import {FilmRenderService, PostgresFilmRepository, RemotionFilmRenderer} from '@/features/film/render-service';
import {RenderWorker} from '@/features/film/render-worker';
import {GcsMediaStorage} from '@/features/media/gcs-storage';
import {PostgresNarrationRepository} from '@/features/narration/narration-repository';
import {createDatabase} from '@/server/db/client';
import {parseRenderWorkerEnv} from '@/server/env';

const input = z.object({
  PROJECT_ID: z.string().uuid(),
  RENDER_JOB_ID: z.string().uuid()
}).parse(process.env);
const env = parseRenderWorkerEnv(process.env);
const database = createDatabase(env.DATABASE_URL);
const storage = new GcsMediaStorage(env.GCS_BUCKET);
const narration = new PostgresNarrationRepository(
  database,
  factualityAuditDeployment(env).contract,
  env.DEEPGRAM_TRANSCRIPTION_MODEL
);
const films = new FilmRenderService(
  new PostgresFilmRepository(database, narration),
  storage,
  new RemotionFilmRenderer({
    bundlePath: resolve(env.REMOTION_BUNDLE_PATH),
    browserExecutable: env.REMOTION_BROWSER_EXECUTABLE,
    concurrency: env.REMOTION_CONCURRENCY
  }),
  async () => undefined
);
const worker = new RenderWorker(
  new PostgresRenderJobRepository(database),
  (projectId) => films.render(projectId)
);

console.info(JSON.stringify({event: 'render_job_started', projectId: input.PROJECT_ID, jobId: input.RENDER_JOB_ID}));
worker.run({projectId: input.PROJECT_ID, jobId: input.RENDER_JOB_ID}).then(
  () => console.info(JSON.stringify({event: 'render_job_finished', projectId: input.PROJECT_ID, jobId: input.RENDER_JOB_ID})),
  () => {
    console.error(JSON.stringify({
      event: 'render_job_failed',
      projectId: input.PROJECT_ID,
      jobId: input.RENDER_JOB_ID,
      code: 'RENDER_EXECUTION_FAILED'
    }));
    process.exitCode = 1;
  }
);

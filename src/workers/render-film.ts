import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';

import {factualityAuditDeployment} from '../features/audit/audit-deployment';
import {PostgresRenderJobRepository} from '../features/film/render-job-repository';
import {FilmRenderService, PostgresFilmRepository, RemotionFilmRenderer} from '../features/film/render-service';
import {RenderWorker} from '../features/film/render-worker';
import {GcsMediaStorage} from '../features/media/gcs-storage';
import {PostgresNarrationRepository} from '../features/narration/narration-repository';
import {createDatabase} from '../server/db/client';
import {parseRenderWorkerEnv} from '../server/env';

type RenderInput = {projectId: string; jobId: string};
type WorkerRunner = {run(input: RenderInput): Promise<void>};
type LifecycleDependencies = {
  close: () => Promise<void>;
  info: (line: string) => void;
  error: (line: string) => void;
};

const lifecycleEvent = (event: string, input: RenderInput, code?: string) => JSON.stringify({
  event,
  projectId: input.projectId,
  jobId: input.jobId,
  ...(code ? {code} : {})
});

export const runRenderFilmLifecycle = async (
  input: RenderInput,
  worker: WorkerRunner,
  dependencies: LifecycleDependencies
): Promise<number> => {
  try {
    dependencies.info(lifecycleEvent('render_job_started', input));
    await worker.run(input);
    dependencies.info(lifecycleEvent('render_job_finished', input));
    return 0;
  } catch {
    dependencies.error(lifecycleEvent('render_job_failed', input, 'RENDER_EXECUTION_FAILED'));
    return 1;
  } finally {
    await dependencies.close();
  }
};

const inputSchema = z.object({
  PROJECT_ID: z.string().uuid(),
  RENDER_JOB_ID: z.string().uuid()
});

export const main = async (processEnv: NodeJS.ProcessEnv = process.env): Promise<number> => {
  const parsed = inputSchema.parse(processEnv);
  const input = {projectId: parsed.PROJECT_ID, jobId: parsed.RENDER_JOB_ID};
  const env = parseRenderWorkerEnv(processEnv);
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

  return runRenderFilmLifecycle(input, worker, {
    close: () => database.$client.end(),
    info: (line) => console.info(line),
    error: (line) => console.error(line)
  });
};

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (import.meta.url === invokedPath) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    () => {
      console.error(JSON.stringify({event: 'render_job_failed', code: 'RENDER_CONFIGURATION_INVALID'}));
      process.exitCode = 1;
    }
  );
}

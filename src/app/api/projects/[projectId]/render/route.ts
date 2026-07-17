import {JobsClient} from '@google-cloud/run';
import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';

import {factualityAuditDeployment} from '../../../../../features/audit/audit-deployment';
import {CloudRunRenderJobLauncher, renderJobResourceName} from '../../../../../features/film/cloud-run-render-launcher';
import {RenderCoordinator} from '../../../../../features/film/render-coordinator';
import {PostgresRenderJobRepository} from '../../../../../features/film/render-job-repository';
import {PostgresFilmRepository} from '../../../../../features/film/render-service';
import {safeFilmRouteError} from '../../../../../features/film/route-errors';
import {PostgresNarrationRepository} from '../../../../../features/narration/narration-repository';
import {PostgresProjectRepository} from '../../../../../features/projects/project-repository';
import {ProjectService} from '../../../../../features/projects/project-service';
import {getDatabase} from '../../../../../server/db/client';
import {parseEnv} from '../../../../../server/env';

type Context = {params: Promise<{projectId: string}>};

export const createRenderHandlers = (coordinator: Pick<RenderCoordinator, 'request' | 'status'>) => ({
  POST: async (_request: Request, context: Context) => {
    try {
      const result = await coordinator.request((await context.params).projectId);
      return NextResponse.json(result, {status: result.status === 'completed' ? 200 : 202});
    } catch (error) {
      const safe = safeFilmRouteError(error);
      return NextResponse.json({error: safe.code}, {status: safe.status});
    }
  },
  GET: async (_request: Request, context: Context) => {
    try {
      return NextResponse.json(await coordinator.status((await context.params).projectId));
    } catch (error) {
      const safe = safeFilmRouteError(error);
      return NextResponse.json({error: safe.code}, {status: safe.status});
    }
  }
});

const coordinator = async (projectId: string) => {
  const database = getDatabase();
  const env = parseEnv(process.env);
  const token = (await cookies()).get(`legacy_owner_${projectId}`)?.value ?? '';
  const projects = new ProjectService(new PostgresProjectRepository(database));
  const narration = new PostgresNarrationRepository(
    database,
    factualityAuditDeployment(env).contract,
    env.DEEPGRAM_TRANSCRIPTION_MODEL
  );
  return new RenderCoordinator(
    new PostgresFilmRepository(database, narration),
    new PostgresRenderJobRepository(database),
    new CloudRunRenderJobLauncher(new JobsClient(), renderJobResourceName(env)),
    (id) => projects.assertProjectOwner(id, token)
  );
};

export async function POST(request: Request, context: Context) {
  const {projectId} = await context.params;
  return createRenderHandlers(await coordinator(projectId)).POST(request, context);
}

export async function GET(request: Request, context: Context) {
  const {projectId} = await context.params;
  return createRenderHandlers(await coordinator(projectId)).GET(request, context);
}

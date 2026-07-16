import {resolve} from 'node:path';
import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';

import {FilmRenderService, PostgresFilmRepository, RemotionFilmRenderer} from '@/features/film/render-service';
import {safeFilmRouteError} from '@/features/film/route-errors';
import {factualityAuditDeployment} from '@/features/audit/audit-deployment';
import {GcsMediaStorage} from '@/features/media/gcs-storage';
import {PostgresNarrationRepository} from '@/features/narration/narration-repository';
import {PostgresProjectRepository} from '@/features/projects/project-repository';
import {ProjectService} from '@/features/projects/project-service';
import {getDatabase} from '@/server/db/client';
import {parseEnv} from '@/server/env';

type Context = {params: Promise<{projectId: string}>};

export async function POST(_request: Request, context: Context) {
  const {projectId} = await context.params;
  try {
    const database = getDatabase();
    const env = parseEnv(process.env);
    const token = (await cookies()).get(`legacy_owner_${projectId}`)?.value ?? '';
    const projects = new ProjectService(new PostgresProjectRepository(database));
    const narration = new PostgresNarrationRepository(database, factualityAuditDeployment(env).contract, env.DEEPGRAM_TRANSCRIPTION_MODEL);
    const service = new FilmRenderService(
      new PostgresFilmRepository(database, narration),
      new GcsMediaStorage(env.GCS_BUCKET),
      new RemotionFilmRenderer({
        bundlePath: resolve(env.REMOTION_BUNDLE_PATH),
        browserExecutable: env.REMOTION_BROWSER_EXECUTABLE,
        concurrency: env.REMOTION_CONCURRENCY
      }),
      (id) => projects.assertProjectOwner(id, token)
    );
    const result = await service.render(projectId);
    return NextResponse.json({status: 'completed', manifestHash: result.manifestHash, reused: result.reused});
  } catch (error) {
    const safe = safeFilmRouteError(error);
    return NextResponse.json({error: safe.code}, {status: safe.status});
  }
}

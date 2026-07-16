import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';

import {FilmRenderService, PostgresFilmRepository} from '@/features/film/render-service';
import {safeFilmRouteError} from '@/features/film/route-errors';
import {factualityAuditDeployment} from '@/features/audit/audit-deployment';
import {GcsMediaStorage} from '@/features/media/gcs-storage';
import {PostgresNarrationRepository} from '@/features/narration/narration-repository';
import {PostgresProjectRepository} from '@/features/projects/project-repository';
import {ProjectService} from '@/features/projects/project-service';
import {getDatabase} from '@/server/db/client';
import {parseEnv} from '@/server/env';

type Context = {params: Promise<{projectId: string}>};

export async function GET(_request: Request, context: Context) {
  const {projectId} = await context.params;
  try {
    const database = getDatabase();
    const env = parseEnv(process.env);
    const token = (await cookies()).get(`legacy_owner_${projectId}`)?.value ?? '';
    const projects = new ProjectService(new PostgresProjectRepository(database));
    const storage = new GcsMediaStorage(env.GCS_BUCKET);
    const narration = new PostgresNarrationRepository(database, factualityAuditDeployment(env).contract, env.DEEPGRAM_TRANSCRIPTION_MODEL);
    const service = new FilmRenderService(
      new PostgresFilmRepository(database, narration),
      storage,
      {render: async () => { throw new Error('FILM_RENDER_NOT_AVAILABLE'); }},
      (id) => projects.assertProjectOwner(id, token)
    );
    const result = await service.getDownload(projectId);
    return NextResponse.json({url: result.url, expiresAt: result.expiresAt.toISOString()});
  } catch (error) {
    const safe = safeFilmRouteError(error);
    return NextResponse.json({error: safe.code}, {status: safe.status});
  }
}

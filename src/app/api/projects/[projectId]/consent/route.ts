import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';

import {PostgresConsentRepository} from '@/features/consent/consent-repository';
import {ConsentService} from '@/features/consent/consent-service';
import {acceptConsentSchema} from '@/features/consent/schemas';
import {PostgresProjectRepository} from '@/features/projects/project-repository';
import {ProjectService} from '@/features/projects/project-service';
import {getDatabase} from '@/server/db/client';

type RouteContext = {params: Promise<{projectId: string}>};

export async function POST(request: Request, context: RouteContext) {
  const {projectId} = await context.params;
  try {
    const body = acceptConsentSchema.parse(await request.json());
    const database = getDatabase();
    const projects = new ProjectService(new PostgresProjectRepository(database));
    const token = (await cookies()).get(`legacy_owner_${projectId}`)?.value ?? '';
    const service = new ConsentService(
      new PostgresConsentRepository(database),
      (id) => projects.assertProjectOwner(id, token)
    );
    return NextResponse.json(await service.accept({...body, projectId}), {status: 201});
  } catch (error) {
    const code = error instanceof Error ? error.message : 'CONSENT_SAVE_FAILED';
    return NextResponse.json(
      {error: code},
      {status: code === 'PROJECT_FORBIDDEN' ? 403 : 400}
    );
  }
}

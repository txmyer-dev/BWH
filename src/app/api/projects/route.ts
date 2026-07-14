import {NextResponse} from 'next/server';
import {ZodError} from 'zod';

import {PostgresProjectRepository} from '@/features/projects/project-repository';
import {ProjectService} from '@/features/projects/project-service';
import {getDatabase} from '@/server/db/client';

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const service = new ProjectService(
      new PostgresProjectRepository(getDatabase())
    );
    const created = await service.createProject({
      title: String(form.get('title') ?? ''),
      subjectName: String(form.get('subjectName') ?? ''),
      creatorName: String(form.get('creatorName') ?? ''),
      creatorRelationship: String(form.get('creatorRelationship') ?? ''),
      giftIntention: String(form.get('giftIntention') ?? '') || undefined
    });
    const response = NextResponse.redirect(
      new URL(`/projects/${created.projectId}`, request.url),
      303
    );
    response.cookies.set(
      `legacy_owner_${created.projectId}`,
      created.ownerToken,
      {
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production',
        path: '/'
      }
    );
    return response;
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json({error: 'INVALID_PROJECT'}, {status: 400});
    }
    throw error;
  }
}

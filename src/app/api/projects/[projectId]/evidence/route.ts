import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {z} from 'zod';

import {PostgresEvidenceRepository} from '@/features/evidence/evidence-repository';
import {PostgresProjectRepository} from '@/features/projects/project-repository';
import {ProjectService} from '@/features/projects/project-service';
import {getDatabase} from '@/server/db/client';

type RouteContext = {params: Promise<{projectId: string}>};
const reviewSchema = z.discriminatedUnion('action', [
  z.object({action: z.literal('confirm'), evidenceId: z.string().uuid()}).strict(),
  z.object({action: z.literal('correct'), evidenceId: z.string().uuid(), correction: z.string().trim().min(1)}).strict(),
  z.object({action: z.literal('reject'), evidenceId: z.string().uuid()}).strict()
]);

const dependencies = async (projectId: string) => {
  const database = getDatabase();
  const repository = new PostgresEvidenceRepository(database);
  const projects = new ProjectService(new PostgresProjectRepository(database));
  const token = (await cookies()).get(`legacy_owner_${projectId}`)?.value ?? '';
  const authorize = (id: string) => projects.assertProjectOwner(id, token);
  return {repository, authorize};
};

export async function GET(_request: Request, context: RouteContext) {
  const {projectId} = await context.params;
  try {
    const {repository, authorize} = await dependencies(projectId);
    await authorize(projectId);
    return NextResponse.json(await repository.listByProject(projectId));
  } catch (error) {
    const code = error instanceof Error ? error.message : 'EVIDENCE_LIST_FAILED';
    return NextResponse.json({error: code}, {status: code === 'PROJECT_FORBIDDEN' ? 403 : 400});
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const {projectId} = await context.params;
  try {
    const {repository, authorize} = await dependencies(projectId);
    const body = reviewSchema.parse(await request.json());
    const item = await repository.findById(body.evidenceId);
    if (!item || item.projectId !== projectId) throw new Error('EVIDENCE_NOT_FOUND');
    await authorize(projectId);
    if (body.action === 'reject') return NextResponse.json(await repository.review(body.evidenceId, 'rejected'));
    return NextResponse.json(await repository.review(body.evidenceId, body.action === 'correct' ? 'corrected' : 'confirmed', body.action === 'correct' ? body.correction : undefined));
  } catch (error) {
    const code = error instanceof Error ? error.message : 'EVIDENCE_REVIEW_FAILED';
    return NextResponse.json({error: code}, {status: code === 'PROJECT_FORBIDDEN' ? 403 : code === 'EVIDENCE_NOT_FOUND' ? 404 : 400});
  }
}

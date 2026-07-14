import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {z} from 'zod';

import {PostgresConsentRepository} from '@/features/consent/consent-repository';
import {ConsentService} from '@/features/consent/consent-service';
import {PostgresEvidenceRepository} from '@/features/evidence/evidence-repository';
import {PostgresAssetRepository} from '@/features/media/asset-service';
import {PostgresProjectRepository} from '@/features/projects/project-repository';
import {ProjectService} from '@/features/projects/project-service';
import {PostgresStoryRepository, RepositoryProjectAssetReader, StoryService} from '@/features/story/story-service';
import {getDatabase} from '@/server/db/client';
import {parseEnv} from '@/server/env';
import {createProviderServices} from '@/server/providers/factory';

type RouteContext = {params: Promise<{projectId: string}>};
const answerSchema = z.object({questionId: z.string().uuid(), answer: z.string().trim().min(1)}).strict();

const createService = async (projectId: string) => {
  const database = getDatabase(); const env = parseEnv(process.env);
  const token = (await cookies()).get(`legacy_owner_${projectId}`)?.value ?? '';
  const projects = new ProjectService(new PostgresProjectRepository(database));
  await projects.assertProjectOwner(projectId, token);
  await new ConsentService(new PostgresConsentRepository(database), async () => undefined).assertProcessingConsent(projectId, 'google_gemini', ['approved_story_context']);
  const {storyAgent} = createProviderServices(env, {database});
  return new StoryService(new PostgresStoryRepository(database), storyAgent, new PostgresEvidenceRepository(database), new RepositoryProjectAssetReader(new PostgresAssetRepository(database)), (id) => projects.assertProjectOwner(id, token));
};

export async function POST(_request: Request, context: RouteContext) {
  const {projectId} = await context.params;
  try { return NextResponse.json(await (await createService(projectId)).generateQuestions(projectId)); }
  catch (error) { const code = error instanceof Error ? error.message : 'QUESTION_GENERATION_FAILED'; return NextResponse.json({error: code}, {status: code === 'PROJECT_FORBIDDEN' ? 403 : 400}); }
}

export async function PATCH(request: Request, context: RouteContext) {
  const {projectId} = await context.params;
  try { const body = answerSchema.parse(await request.json()); await (await createService(projectId)).saveAnswer(projectId, body.questionId, body.answer); return NextResponse.json({saved: true}); }
  catch (error) { const code = error instanceof Error ? error.message : 'ANSWER_SAVE_FAILED'; return NextResponse.json({error: code}, {status: code === 'PROJECT_FORBIDDEN' ? 403 : code === 'QUESTION_NOT_FOUND' ? 404 : 400}); }
}

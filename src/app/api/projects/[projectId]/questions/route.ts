import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import OpenAI from 'openai';
import {z} from 'zod';

import {PostgresEvidenceRepository} from '@/features/evidence/evidence-repository';
import {PostgresProjectRepository} from '@/features/projects/project-repository';
import {ProjectService} from '@/features/projects/project-service';
import {OpenAIStoryAgent} from '@/features/story/openai-story-agent';
import {PostgresStoryRepository, StoryService} from '@/features/story/story-service';
import {getDatabase} from '@/server/db/client';
import {parseEnv} from '@/server/env';

type RouteContext = {params: Promise<{projectId: string}>};
const answerSchema = z.object({questionId: z.string().uuid(), answer: z.string().trim().min(1)}).strict();

const createService = async (projectId: string) => {
  const database = getDatabase();
  const token = (await cookies()).get(`legacy_owner_${projectId}`)?.value ?? '';
  const projects = new ProjectService(new PostgresProjectRepository(database));
  return new StoryService(
    new PostgresStoryRepository(database),
    new OpenAIStoryAgent(new OpenAI({apiKey: parseEnv(process.env).OPENAI_API_KEY})),
    new PostgresEvidenceRepository(database),
    (id) => projects.assertProjectOwner(id, token)
  );
};

export async function POST(_request: Request, context: RouteContext) {
  const {projectId} = await context.params;
  try {
    const service = await createService(projectId);
    return NextResponse.json(await service.generateQuestions(projectId));
  } catch (error) {
    const code = error instanceof Error ? error.message : 'QUESTION_GENERATION_FAILED';
    return NextResponse.json({error: code}, {status: code === 'PROJECT_FORBIDDEN' ? 403 : 400});
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const {projectId} = await context.params;
  try {
    const body = answerSchema.parse(await request.json());
    await (await createService(projectId)).saveAnswer(projectId, body.questionId, body.answer);
    return NextResponse.json({saved: true});
  } catch (error) {
    const code = error instanceof Error ? error.message : 'ANSWER_SAVE_FAILED';
    return NextResponse.json({error: code}, {status: code === 'PROJECT_FORBIDDEN' ? 403 : code === 'QUESTION_NOT_FOUND' ? 404 : 400});
  }
}

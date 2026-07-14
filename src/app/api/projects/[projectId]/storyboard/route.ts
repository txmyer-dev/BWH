import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import OpenAI from 'openai';
import {z} from 'zod';

import {PostgresEvidenceRepository} from '@/features/evidence/evidence-repository';
import {PostgresProjectRepository} from '@/features/projects/project-repository';
import {ProjectService} from '@/features/projects/project-service';
import {OpenAIStoryAgent} from '@/features/story/openai-story-agent';
import {filmSceneInputSchema, PostgresStoryRepository, StoryService} from '@/features/story/story-service';
import {getDatabase} from '@/server/db/client';
import {parseEnv} from '@/server/env';

type RouteContext = {params: Promise<{projectId: string}>};
const postSchema = z.discriminatedUnion('action', [
  z.object({action: z.literal('compose')}).strict(),
  z.object({action: z.literal('regenerate_scene'), storyboardId: z.string().uuid(), sceneId: z.string().uuid()}).strict(),
  z.object({action: z.literal('add_scene'), storyboardId: z.string().uuid(), scene: filmSceneInputSchema}).strict()
]);
const patchSchema = z.discriminatedUnion('action', [
  z.object({action: z.literal('edit_scene'), storyboardId: z.string().uuid(), sceneId: z.string().uuid(), change: filmSceneInputSchema.partial()}).strict(),
  z.object({action: z.literal('reorder_scenes'), storyboardId: z.string().uuid(), orderedSceneIds: z.array(z.string().uuid()).min(1)}).strict()
]);

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

const failure = (error: unknown) => {
  const code = error instanceof Error ? error.message : 'STORYBOARD_REQUEST_FAILED';
  return NextResponse.json({error: code}, {status: code === 'PROJECT_FORBIDDEN' ? 403 : code.endsWith('NOT_FOUND') ? 404 : 400});
};

export async function GET(_request: Request, context: RouteContext) {
  const {projectId} = await context.params;
  try { return NextResponse.json(await (await createService(projectId)).getStoryboard(projectId)); }
  catch (error) { return failure(error); }
}

export async function POST(request: Request, context: RouteContext) {
  const {projectId} = await context.params;
  try {
    const body = postSchema.parse(await request.json());
    const service = await createService(projectId);
    if (body.action === 'compose') return NextResponse.json(await service.composeStoryboard(projectId));
    if (body.action === 'regenerate_scene') return NextResponse.json(await service.regenerateScene(projectId, body.storyboardId, body.sceneId));
    return NextResponse.json(await service.addScene(projectId, body.storyboardId, body.scene));
  } catch (error) { return failure(error); }
}

export async function PATCH(request: Request, context: RouteContext) {
  const {projectId} = await context.params;
  try {
    const body = patchSchema.parse(await request.json());
    const service = await createService(projectId);
    if (body.action === 'edit_scene') return NextResponse.json(await service.editScene(projectId, body.storyboardId, body.sceneId, body.change));
    return NextResponse.json(await service.reorderScenes(projectId, body.storyboardId, body.orderedSceneIds));
  } catch (error) { return failure(error); }
}

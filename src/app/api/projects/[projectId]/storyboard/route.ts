import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {z} from 'zod';

import {PostgresConsentRepository} from '@/features/consent/consent-repository';
import {ConsentService} from '@/features/consent/consent-service';
import {PostgresEvidenceRepository} from '@/features/evidence/evidence-repository';
import {PostgresAssetRepository} from '@/features/media/asset-service';
import {PostgresProjectRepository} from '@/features/projects/project-repository';
import {ProjectService} from '@/features/projects/project-service';
import {filmSceneInputSchema, PostgresStoryRepository, RepositoryProjectAssetReader, StoryService} from '@/features/story/story-service';
import {getDatabase} from '@/server/db/client';
import {parseEnv} from '@/server/env';
import {createProviderServices} from '@/server/providers/factory';
import {storyboardErrorStatus} from './response-status';

type RouteContext = {params: Promise<{projectId: string}>};
const postSchema = z.discriminatedUnion('action', [z.object({action: z.literal('compose')}).strict(), z.object({action: z.literal('regenerate_scene'), storyboardId: z.string().uuid(), sceneId: z.string().uuid(), expectedRevision: z.number().int().nonnegative()}).strict(), z.object({action: z.literal('add_scene'), storyboardId: z.string().uuid(), scene: filmSceneInputSchema, expectedRevision: z.number().int().nonnegative()}).strict()]);
const patchSchema = z.discriminatedUnion('action', [z.object({action: z.literal('edit_scene'), storyboardId: z.string().uuid(), sceneId: z.string().uuid(), change: filmSceneInputSchema.partial(), expectedRevision: z.number().int().nonnegative()}).strict(), z.object({action: z.literal('reorder_scenes'), storyboardId: z.string().uuid(), orderedSceneIds: z.array(z.string().uuid()).min(1), expectedRevision: z.number().int().nonnegative()}).strict()]);

const createService = async (projectId: string) => {
  const database = getDatabase(); const env = parseEnv(process.env);
  const token = (await cookies()).get(`legacy_owner_${projectId}`)?.value ?? '';
  const projects = new ProjectService(new PostgresProjectRepository(database));
  await projects.assertProjectOwner(projectId, token);
  await new ConsentService(new PostgresConsentRepository(database), async () => undefined).assertProcessingConsent(projectId, 'google_gemini', ['approved_story_context']);
  const {storyAgent} = createProviderServices(env, {database});
  return new StoryService(new PostgresStoryRepository(database), storyAgent, new PostgresEvidenceRepository(database), new RepositoryProjectAssetReader(new PostgresAssetRepository(database)), (id) => projects.assertProjectOwner(id, token));
};
const failure = (error: unknown) => { const code = error instanceof Error ? error.message : 'STORYBOARD_REQUEST_FAILED'; return NextResponse.json({error: code}, {status: storyboardErrorStatus(code)}); };

export async function GET(_request: Request, context: RouteContext) { const {projectId} = await context.params; try { return NextResponse.json(await (await createService(projectId)).getStoryboard(projectId)); } catch (error) { return failure(error); } }
export async function POST(request: Request, context: RouteContext) { const {projectId} = await context.params; try { const body = postSchema.parse(await request.json()); const service = await createService(projectId); if (body.action === 'compose') return NextResponse.json(await service.composeStoryboard(projectId)); if (body.action === 'regenerate_scene') return NextResponse.json(await service.regenerateScene(projectId, body.storyboardId, body.sceneId, body.expectedRevision)); return NextResponse.json(await service.addScene(projectId, body.storyboardId, body.scene, body.expectedRevision)); } catch (error) { return failure(error); } }
export async function PATCH(request: Request, context: RouteContext) { const {projectId} = await context.params; try { const body = patchSchema.parse(await request.json()); const service = await createService(projectId); if (body.action === 'edit_scene') return NextResponse.json(await service.editScene(projectId, body.storyboardId, body.sceneId, body.change, body.expectedRevision)); return NextResponse.json(await service.reorderScenes(projectId, body.storyboardId, body.orderedSceneIds, body.expectedRevision)); } catch (error) { return failure(error); } }

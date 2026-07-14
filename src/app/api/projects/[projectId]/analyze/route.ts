import {CloudTasksClient} from '@google-cloud/tasks';
import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import OpenAI from 'openai';

import {PostgresEvidenceRepository} from '@/features/evidence/evidence-repository';
import {EvidenceService, PrivateAnalysisAssetSource} from '@/features/evidence/evidence-service';
import {PostgresAssetRepository} from '@/features/media/asset-service';
import {GcsMediaStorage} from '@/features/media/gcs-storage';
import {PostgresProjectRepository} from '@/features/projects/project-repository';
import {ProjectService} from '@/features/projects/project-service';
import {OpenAIStoryAgent} from '@/features/story/openai-story-agent';
import {CloudTasksQueue} from '@/server/queue/cloud-tasks';
import {getDatabase} from '@/server/db/client';
import {parseEnv} from '@/server/env';

type RouteContext = {params: Promise<{projectId: string}>};

export async function POST(_request: Request, context: RouteContext) {
  const {projectId} = await context.params;
  try {
    const env = parseEnv(process.env);
    if (!env.CLOUD_TASKS_QUEUE_PATH || !env.CLOUD_TASKS_TARGET_URL || !env.CLOUD_TASKS_AUDIENCE || !env.CLOUD_TASKS_SERVICE_ACCOUNT) throw new Error('CLOUD_TASKS_NOT_CONFIGURED');
    const database = getDatabase();
    const projects = new ProjectService(new PostgresProjectRepository(database));
    const storage = new GcsMediaStorage(env.GCS_BUCKET);
    const token = (await cookies()).get(`legacy_owner_${projectId}`)?.value ?? '';
    const service = new EvidenceService(
      new PostgresEvidenceRepository(database),
      new CloudTasksQueue(new CloudTasksClient(), {queuePath: env.CLOUD_TASKS_QUEUE_PATH, targetUrl: env.CLOUD_TASKS_TARGET_URL, audience: env.CLOUD_TASKS_AUDIENCE, serviceAccountEmail: env.CLOUD_TASKS_SERVICE_ACCOUNT}),
      new OpenAIStoryAgent(new OpenAI({apiKey: env.OPENAI_API_KEY})),
      new PrivateAnalysisAssetSource(new PostgresAssetRepository(database), storage),
      (id) => projects.assertProjectOwner(id, token)
    );
    return NextResponse.json(await service.requestAnalysis(projectId), {status: 202});
  } catch (error) {
    const code = error instanceof Error ? error.message : 'ANALYSIS_REQUEST_FAILED';
    return NextResponse.json({error: code}, {status: code === 'PROJECT_FORBIDDEN' ? 403 : 400});
  }
}

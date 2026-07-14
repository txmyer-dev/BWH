import {CloudTasksClient} from '@google-cloud/tasks';
import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {z} from 'zod';

import {PostgresEvidenceRepository} from '@/features/evidence/evidence-repository';
import {PostgresAssetRepository} from '@/features/media/asset-service';
import {GcsMediaStorage} from '@/features/media/gcs-storage';
import {PostgresProjectRepository} from '@/features/projects/project-repository';
import {ProjectService} from '@/features/projects/project-service';
import {PostgresTranscriptionRepository} from '@/features/transcription/transcription-repository';
import {TranscriptionService} from '@/features/transcription/transcription-service';
import {getDatabase} from '@/server/db/client';
import {parseEnv} from '@/server/env';
import {createProviderServices} from '@/server/providers/factory';
import {CloudTasksQueue} from '@/server/queue/cloud-tasks';

const bodySchema = z.object({assetId: z.string().uuid(), creatorTranscript: z.string().trim().min(1).max(100_000).optional()}).strict();
type RouteContext = {params: Promise<{projectId: string}>};

export async function POST(request: Request, context: RouteContext) {
  const {projectId} = await context.params;
  try {
    const body = bodySchema.parse(await request.json());
    const env = parseEnv(process.env);
    const database = getDatabase();
    const projects = new ProjectService(new PostgresProjectRepository(database));
    const token = (await cookies()).get(`legacy_owner_${projectId}`)?.value ?? '';
    await projects.assertProjectOwner(projectId, token);
    if (body.creatorTranscript) {
      const unavailableExecutor = {execute: async () => { throw new Error('PROVIDER_NOT_USED'); }};
      const unavailableTranscriber = {transcribe: async () => { throw new Error('PROVIDER_NOT_USED'); }};
      const manual = new TranscriptionService(
        new PostgresAssetRepository(database), new GcsMediaStorage(env.GCS_BUCKET), unavailableExecutor,
        unavailableTranscriber, new PostgresTranscriptionRepository(database), new PostgresEvidenceRepository(database),
        undefined, async () => undefined, env.DEEPGRAM_TRANSCRIPTION_MODEL
      );
      return NextResponse.json(await manual.addCreatorTranscript({projectId, assetId: body.assetId, text: body.creatorTranscript}), {status: 201});
    }
    if (!env.CLOUD_TASKS_QUEUE_PATH || !env.CLOUD_TASKS_TARGET_URL || !env.CLOUD_TASKS_AUDIENCE || !env.CLOUD_TASKS_SERVICE_ACCOUNT) throw new Error('CLOUD_TASKS_NOT_CONFIGURED');
    const {executor, deepgramTranscriber} = createProviderServices(env, {database});
    if (!deepgramTranscriber) throw new Error('DEEPGRAM_NOT_CONFIGURED');
    const queue = new CloudTasksQueue(new CloudTasksClient(), {
      queuePath: env.CLOUD_TASKS_QUEUE_PATH,
      targetUrl: new URL('/api/internal/process-transcription', env.CLOUD_TASKS_TARGET_URL).toString(),
      audience: env.CLOUD_TASKS_AUDIENCE, serviceAccountEmail: env.CLOUD_TASKS_SERVICE_ACCOUNT
    });
    const service = new TranscriptionService(
      new PostgresAssetRepository(database), new GcsMediaStorage(env.GCS_BUCKET), executor,
      deepgramTranscriber, new PostgresTranscriptionRepository(database), new PostgresEvidenceRepository(database),
      queue, (id) => projects.assertProjectOwner(id, token), env.DEEPGRAM_TRANSCRIPTION_MODEL
    );
    return NextResponse.json(await service.request(projectId, body.assetId), {status: 202});
  } catch (error) {
    const code = error instanceof Error ? error.message : 'TRANSCRIPTION_REQUEST_FAILED';
    return NextResponse.json({error: code}, {status: code === 'PROJECT_FORBIDDEN' ? 403 : 400});
  }
}

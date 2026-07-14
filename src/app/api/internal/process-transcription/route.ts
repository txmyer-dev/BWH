import {OAuth2Client} from 'google-auth-library/build/src/auth/oauth2client';
import {NextResponse} from 'next/server';
import {z} from 'zod';

import {PostgresEvidenceRepository} from '@/features/evidence/evidence-repository';
import {PostgresAssetRepository} from '@/features/media/asset-service';
import {GcsMediaStorage} from '@/features/media/gcs-storage';
import {PostgresTranscriptionRepository} from '@/features/transcription/transcription-repository';
import {TranscriptionService} from '@/features/transcription/transcription-service';
import {getDatabase} from '@/server/db/client';
import {parseEnv} from '@/server/env';
import {createProviderServices} from '@/server/providers/factory';
import {verifyCloudTaskRequest} from '@/server/queue/cloud-tasks';
import {internalTranscriptionErrorStatus} from './response-status';

const taskSchema = z.object({type: z.literal('transcribe_asset'), projectId: z.string().uuid(), assetId: z.string().uuid(), jobId: z.string().uuid(), providerRunId: z.string().uuid()}).strict();

export async function POST(request: Request) {
  try {
    const env = parseEnv(process.env);
    if (!env.CLOUD_TASKS_AUDIENCE || !env.CLOUD_TASKS_SERVICE_ACCOUNT) throw new Error('CLOUD_TASKS_NOT_CONFIGURED');
    await verifyCloudTaskRequest(request, new OAuth2Client(), {audience: env.CLOUD_TASKS_AUDIENCE, serviceAccountEmail: env.CLOUD_TASKS_SERVICE_ACCOUNT});
    const task = taskSchema.parse(await request.json());
    const database = getDatabase(); const {executor, deepgramTranscriber} = createProviderServices(env, {database});
    if (!deepgramTranscriber) throw new Error('DEEPGRAM_NOT_CONFIGURED');
    const service = new TranscriptionService(
      new PostgresAssetRepository(database), new GcsMediaStorage(env.GCS_BUCKET), executor,
      deepgramTranscriber, new PostgresTranscriptionRepository(database), new PostgresEvidenceRepository(database),
      undefined, async () => undefined, env.DEEPGRAM_TRANSCRIPTION_MODEL
    );
    const status = await service.processTask(task);
    if (status === 'busy' || status === 'in_flight') throw new Error('TRANSCRIPTION_JOB_BUSY');
    if (status === 'missing') throw new Error('TRANSCRIPTION_JOB_NOT_FOUND');
    return NextResponse.json({status});
  } catch (error) {
    const code = error instanceof Error ? error.message : 'TRANSCRIPTION_FAILED';
    return NextResponse.json({error: code}, {status: internalTranscriptionErrorStatus(code)});
  }
}

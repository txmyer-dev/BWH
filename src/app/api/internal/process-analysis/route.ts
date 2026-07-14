import {OAuth2Client} from 'google-auth-library/build/src/auth/oauth2client';
import {NextResponse} from 'next/server';
import {z} from 'zod';

import {PostgresEvidenceRepository} from '@/features/evidence/evidence-repository';
import {EvidenceService, PrivateAnalysisAssetSource} from '@/features/evidence/evidence-service';
import {PostgresAssetRepository} from '@/features/media/asset-service';
import {GcsMediaStorage} from '@/features/media/gcs-storage';
import {getDatabase} from '@/server/db/client';
import {parseEnv} from '@/server/env';
import {createProviderServices} from '@/server/providers/factory';
import {verifyCloudTaskRequest} from '@/server/queue/cloud-tasks';
import {InlineQueue} from '@/server/queue/inline-queue';
import {internalAnalysisErrorStatus} from './response-status';

const taskSchema = z.object({type: z.literal('analyze_collection'), projectId: z.string().uuid(), jobId: z.string().uuid()}).strict();

export async function POST(request: Request) {
  try {
    const env = parseEnv(process.env);
    if (!env.CLOUD_TASKS_AUDIENCE || !env.CLOUD_TASKS_SERVICE_ACCOUNT) throw new Error('CLOUD_TASKS_NOT_CONFIGURED');
    await verifyCloudTaskRequest(request, new OAuth2Client(), {audience: env.CLOUD_TASKS_AUDIENCE, serviceAccountEmail: env.CLOUD_TASKS_SERVICE_ACCOUNT});
    const task = taskSchema.parse(await request.json());
    const database = getDatabase();
    const {storyAgent} = createProviderServices(env, {database});
    const service = new EvidenceService(
      new PostgresEvidenceRepository(database), new InlineQueue(), storyAgent,
      new PrivateAnalysisAssetSource(new PostgresAssetRepository(database), new GcsMediaStorage(env.GCS_BUCKET)), async () => undefined
    );
    await service.processAnalysis(task);
    return NextResponse.json({status: 'completed'});
  } catch (error) {
    const code = error instanceof Error ? error.message : 'ANALYSIS_PROCESSING_FAILED';
    return NextResponse.json({error: code}, {status: internalAnalysisErrorStatus(code)});
  }
}

import {CloudTasksClient} from '@google-cloud/tasks';
import {cookies} from 'next/headers';

import {PostgresProjectRepository} from '@/features/projects/project-repository';
import {ProjectService} from '@/features/projects/project-service';
import {PostgresProviderRunRepository} from '@/features/providers/provider-run-repository';
import {ProviderRetryOrchestrator} from '@/features/providers/provider-retry-orchestrator';
import {providerRunSummary, ProviderRunService} from '@/features/providers/provider-run-service';
import {providerRetryError} from '@/features/providers/provider-route-policy';
import {PostgresTranscriptionRepository} from '@/features/transcription/transcription-repository';
import {getDatabase} from '@/server/db/client';
import {parseEnv} from '@/server/env';
import {CloudTasksQueue} from '@/server/queue/cloud-tasks';

type RouteContext = {params: Promise<{projectId: string; runId: string}>};
export async function POST(_request: Request, context: RouteContext) {
  const {projectId, runId} = await context.params;
  try {
    const env = parseEnv(process.env); const database = getDatabase();
    const token = (await cookies()).get(`legacy_owner_${projectId}`)?.value ?? '';
    await new ProjectService(new PostgresProjectRepository(database)).assertProjectOwner(projectId, token);
    const service = new ProviderRunService(new PostgresProviderRunRepository(database), {fingerprintSecret: env.PROVIDER_FINGERPRINT_SECRET ?? 'development-only-provider-fingerprint', defaultBudgetMicros: env.PROVIDER_DEFAULT_BUDGET_MICROS, defaultRequestBudget: env.PROVIDER_DEFAULT_REQUEST_BUDGET, leaseMs: env.PROVIDER_RUN_LEASE_MS});
    const original = await service.get(runId); if (!original || original.projectId !== projectId) throw new Error('PROVIDER_RUN_NOT_FOUND');
    let queue: CloudTasksQueue | undefined;
    if (original.operation === 'transcribe') {
      if (!env.CLOUD_TASKS_QUEUE_PATH || !env.CLOUD_TASKS_TARGET_URL || !env.CLOUD_TASKS_AUDIENCE || !env.CLOUD_TASKS_SERVICE_ACCOUNT) throw new Error('PROVIDER_RETRY_QUEUE_NOT_CONFIGURED');
      queue = new CloudTasksQueue(new CloudTasksClient(), {queuePath: env.CLOUD_TASKS_QUEUE_PATH, targetUrl: new URL('/api/internal/process-transcription', env.CLOUD_TASKS_TARGET_URL).toString(), audience: env.CLOUD_TASKS_AUDIENCE, serviceAccountEmail: env.CLOUD_TASKS_SERVICE_ACCOUNT});
    }
    const retried = await new ProviderRetryOrchestrator(service, new PostgresTranscriptionRepository(database), queue, async () => undefined).retry(projectId, runId);
    return Response.json({...providerRunSummary(retried.run), ...(retried.transcriptionJob ? {transcriptionJob: {id: retried.transcriptionJob.id, assetId: retried.transcriptionJob.assetId, providerRunId: retried.transcriptionJob.providerRunId, status: retried.transcriptionJob.status}} : {})}, {status: 201});
  } catch (error) {
    const safe = providerRetryError(error instanceof Error ? error.message : '');
    return Response.json({error: safe.code}, {status: safe.status});
  }
}

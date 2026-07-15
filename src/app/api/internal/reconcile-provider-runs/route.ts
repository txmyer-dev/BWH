import {OAuth2Client} from 'google-auth-library';
import {and, eq} from 'drizzle-orm';

import {PostgresProviderArtifactRepository, ProviderArtifactService, type ProviderArtifact} from '../../../../features/providers/provider-artifact-service';
import {PostgresProviderRunRepository} from '../../../../features/providers/provider-run-repository';
import {providerReconciliationError} from '../../../../features/providers/provider-route-policy';
import {ProviderRunService} from '../../../../features/providers/provider-run-service';
import {getDatabase} from '../../../../server/db/client';
import {parseEnv} from '../../../../server/env';
import {verifyCloudTaskRequest} from '../../../../server/queue/cloud-tasks';
import {GcsMediaStorage} from '../../../../features/media/gcs-storage';
import {providerRuns} from '../../../../server/db/schema';

type Dependencies = {
  verifier: Parameters<typeof verifyCloudTaskRequest>[1];
  auth: Parameters<typeof verifyCloudTaskRequest>[2];
  reconcileExpired: () => Promise<number>;
  reconcileArtifacts: () => Promise<number>;
};

type ArtifactRemovalDependencies = {
  gcs: Pick<GcsMediaStorage, 'deleteMany'>;
  deactivateProviderRun?: (providerRunId: string, projectId: string) => Promise<void>;
  geminiApiKey?: string;
  fetchImpl?: typeof fetch;
};

export const removeProviderArtifact = async (
  artifact: Pick<ProviderArtifact, 'projectId' | 'providerRunId' | 'provider' | 'providerArtifactId'>,
  dependencies: ArtifactRemovalDependencies
) => {
  if (artifact.provider === 'google_cloud_storage') {
    if (!artifact.providerRunId || !dependencies.deactivateProviderRun) throw new Error('PROVIDER_ARTIFACT_GCS_KEY_INVALID');
    const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
    const escapedProjectId = artifact.projectId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedRunId = artifact.providerRunId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const safeKey = new RegExp(`^projects/${escapedProjectId}/narration/${escapedRunId}/(?:sample\\.wav|scenes/${uuid}\\.wav)$`, 'i');
    if (!safeKey.test(artifact.providerArtifactId)) throw new Error('PROVIDER_ARTIFACT_GCS_KEY_INVALID');
    await dependencies.deactivateProviderRun(artifact.providerRunId, artifact.projectId);
    await dependencies.gcs.deleteMany([artifact.providerArtifactId]);
    return;
  }
  if (artifact.provider === 'provider_run_cache') {
    if (!artifact.providerRunId || !dependencies.deactivateProviderRun || artifact.providerArtifactId !== `provider-run:${artifact.providerRunId}`) throw new Error('PROVIDER_ARTIFACT_CACHE_KEY_INVALID');
    await dependencies.deactivateProviderRun(artifact.providerRunId, artifact.projectId);
    return;
  }
  if (artifact.provider !== 'google_gemini' || !dependencies.geminiApiKey) {
    throw new Error('PROVIDER_ARTIFACT_DELETE_HANDLER_REQUIRED');
  }
  const response = await (dependencies.fetchImpl ?? fetch)(
    `https://generativelanguage.googleapis.com/v1beta/${encodeURI(artifact.providerArtifactId)}`,
    {method: 'DELETE', headers: {'x-goog-api-key': dependencies.geminiApiKey}}
  );
  if (!response.ok && response.status !== 404) throw new Error('PROVIDER_ARTIFACT_DELETE_FAILED');
};

export const reconcileProviderRuns = async (request: Request, dependencies: Dependencies) => {
  try {
    await verifyCloudTaskRequest(request, dependencies.verifier, dependencies.auth);
    const [runs, artifacts] = await Promise.all([dependencies.reconcileExpired(), dependencies.reconcileArtifacts()]);
    return Response.json({runs, artifacts});
  } catch (error) {
    const safe = providerReconciliationError(error instanceof Error ? error.message : '');
    return Response.json({error: safe.code}, {status: safe.status});
  }
};

export async function POST(request: Request) {
  const env = parseEnv(process.env);
  if (!env.CLOUD_TASKS_AUDIENCE || !env.CLOUD_TASKS_SERVICE_ACCOUNT || !env.PROVIDER_FINGERPRINT_SECRET) return Response.json({error: 'PROVIDER_CONTROL_PLANE_NOT_CONFIGURED'}, {status: 503});
  const database = getDatabase();
  const runs = new ProviderRunService(new PostgresProviderRunRepository(database), {fingerprintSecret: env.PROVIDER_FINGERPRINT_SECRET, defaultBudgetMicros: env.PROVIDER_DEFAULT_BUDGET_MICROS, defaultRequestBudget: env.PROVIDER_DEFAULT_REQUEST_BUDGET, leaseMs: env.PROVIDER_RUN_LEASE_MS});
  const artifacts = new ProviderArtifactService(new PostgresProviderArtifactRepository(database));
  const gcs = new GcsMediaStorage(env.GCS_BUCKET);
  const deactivateProviderRun = async (providerRunId: string, projectId: string) => {
    await database.update(providerRuns).set({activeResult: false, updatedAt: new Date()}).where(and(eq(providerRuns.id, providerRunId), eq(providerRuns.projectId, projectId)));
  };
  return reconcileProviderRuns(request, {
    verifier: new OAuth2Client(),
    auth: {audience: env.CLOUD_TASKS_AUDIENCE, serviceAccountEmail: env.CLOUD_TASKS_SERVICE_ACCOUNT},
    reconcileExpired: () => runs.reconcileExpired(),
    reconcileArtifacts: () => artifacts.reconcile(
      new Date(),
      (artifact) => removeProviderArtifact(artifact, {gcs, geminiApiKey: env.GEMINI_API_KEY, deactivateProviderRun})
    )
  });
}

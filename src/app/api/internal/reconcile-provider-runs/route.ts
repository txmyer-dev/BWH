import {OAuth2Client} from 'google-auth-library';

import {PostgresProviderArtifactRepository, ProviderArtifactService, type ProviderArtifact} from '../../../../features/providers/provider-artifact-service';
import {PostgresProviderRunRepository} from '../../../../features/providers/provider-run-repository';
import {providerReconciliationError} from '../../../../features/providers/provider-route-policy';
import {ProviderRunService} from '../../../../features/providers/provider-run-service';
import {getDatabase} from '../../../../server/db/client';
import {parseEnv} from '../../../../server/env';
import {verifyCloudTaskRequest} from '../../../../server/queue/cloud-tasks';
import {GcsMediaStorage} from '../../../../features/media/gcs-storage';

type Dependencies = {
  verifier: Parameters<typeof verifyCloudTaskRequest>[1];
  auth: Parameters<typeof verifyCloudTaskRequest>[2];
  reconcileExpired: () => Promise<number>;
  reconcileArtifacts: () => Promise<number>;
};

type ArtifactRemovalDependencies = {
  gcs: Pick<GcsMediaStorage, 'deleteMany'>;
  geminiApiKey?: string;
  fetchImpl?: typeof fetch;
};

export const removeProviderArtifact = async (
  artifact: Pick<ProviderArtifact, 'provider' | 'providerArtifactId'>,
  dependencies: ArtifactRemovalDependencies
) => {
  if (artifact.provider === 'google_cloud_storage') {
    await dependencies.gcs.deleteMany([artifact.providerArtifactId]);
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
  return reconcileProviderRuns(request, {
    verifier: new OAuth2Client(),
    auth: {audience: env.CLOUD_TASKS_AUDIENCE, serviceAccountEmail: env.CLOUD_TASKS_SERVICE_ACCOUNT},
    reconcileExpired: () => runs.reconcileExpired(),
    reconcileArtifacts: () => artifacts.reconcile(
      new Date(),
      (artifact) => removeProviderArtifact(artifact, {gcs, geminiApiKey: env.GEMINI_API_KEY})
    )
  });
}

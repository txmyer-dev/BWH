import {OAuth2Client} from 'google-auth-library';

import {PostgresProviderArtifactRepository, ProviderArtifactService} from '../../../../features/providers/provider-artifact-service';
import {PostgresProviderRunRepository} from '../../../../features/providers/provider-run-repository';
import {ProviderRunService} from '../../../../features/providers/provider-run-service';
import {getDatabase} from '../../../../server/db/client';
import {parseEnv} from '../../../../server/env';
import {verifyCloudTaskRequest} from '../../../../server/queue/cloud-tasks';

type Dependencies = {
  verifier: Parameters<typeof verifyCloudTaskRequest>[1];
  auth: Parameters<typeof verifyCloudTaskRequest>[2];
  reconcileExpired: () => Promise<number>;
  reconcileArtifacts: () => Promise<number>;
};

export const reconcileProviderRuns = async (request: Request, dependencies: Dependencies) => {
  try {
    await verifyCloudTaskRequest(request, dependencies.verifier, dependencies.auth);
    const [runs, artifacts] = await Promise.all([dependencies.reconcileExpired(), dependencies.reconcileArtifacts()]);
    return Response.json({runs, artifacts});
  } catch (error) {
    const code = error instanceof Error ? error.message : 'PROVIDER_RECONCILIATION_FAILED';
    return Response.json({error: code}, {status: code === 'CLOUD_TASK_UNAUTHORIZED' ? 401 : 500});
  }
};

export async function POST(request: Request) {
  const env = parseEnv(process.env);
  if (!env.CLOUD_TASKS_AUDIENCE || !env.CLOUD_TASKS_SERVICE_ACCOUNT || !env.PROVIDER_FINGERPRINT_SECRET) return Response.json({error: 'PROVIDER_CONTROL_PLANE_NOT_CONFIGURED'}, {status: 503});
  const database = getDatabase();
  const runs = new ProviderRunService(new PostgresProviderRunRepository(database), {fingerprintSecret: env.PROVIDER_FINGERPRINT_SECRET, defaultBudgetMicros: env.PROVIDER_DEFAULT_BUDGET_MICROS, defaultRequestBudget: env.PROVIDER_DEFAULT_REQUEST_BUDGET, leaseMs: env.PROVIDER_RUN_LEASE_MS});
  const artifacts = new ProviderArtifactService(new PostgresProviderArtifactRepository(database));
  return reconcileProviderRuns(request, {
    verifier: new OAuth2Client(),
    auth: {audience: env.CLOUD_TASKS_AUDIENCE, serviceAccountEmail: env.CLOUD_TASKS_SERVICE_ACCOUNT},
    reconcileExpired: () => runs.reconcileExpired(),
    reconcileArtifacts: () => artifacts.reconcile(new Date(), async (artifact) => {
      if (artifact.provider !== 'google_gemini' || !env.GEMINI_API_KEY) throw new Error('PROVIDER_ARTIFACT_DELETE_HANDLER_REQUIRED');
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${encodeURI(artifact.providerArtifactId)}`, {method: 'DELETE', headers: {'x-goog-api-key': env.GEMINI_API_KEY}});
      if (!response.ok && response.status !== 404) throw new Error('PROVIDER_ARTIFACT_DELETE_FAILED');
    })
  });
}

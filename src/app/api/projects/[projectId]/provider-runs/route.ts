import {cookies} from 'next/headers';

import {PostgresProjectRepository} from '@/features/projects/project-repository';
import {ProjectService} from '@/features/projects/project-service';
import {PostgresProviderRunRepository} from '@/features/providers/provider-run-repository';
import {providerRunSummary, ProviderRunService} from '@/features/providers/provider-run-service';
import {providerRunsLoadError} from '@/features/providers/provider-route-policy';
import {getDatabase} from '@/server/db/client';
import {parseEnv} from '@/server/env';

type RouteContext = {params: Promise<{projectId: string}>};

export async function GET(_request: Request, context: RouteContext) {
  const {projectId} = await context.params;
  try {
    const env = parseEnv(process.env); const database = getDatabase();
    const token = (await cookies()).get(`legacy_owner_${projectId}`)?.value ?? '';
    await new ProjectService(new PostgresProjectRepository(database)).assertProjectOwner(projectId, token);
    const service = new ProviderRunService(new PostgresProviderRunRepository(database), {fingerprintSecret: env.PROVIDER_FINGERPRINT_SECRET ?? 'development-only-provider-fingerprint', defaultBudgetMicros: env.PROVIDER_DEFAULT_BUDGET_MICROS, defaultRequestBudget: env.PROVIDER_DEFAULT_REQUEST_BUDGET, leaseMs: env.PROVIDER_RUN_LEASE_MS});
    const runs = await service.list(projectId);
    return Response.json(runs.map(providerRunSummary));
  } catch (error) {
    const safe = providerRunsLoadError(error instanceof Error ? error.message : '');
    return Response.json({error: safe.code}, {status: safe.status});
  }
}

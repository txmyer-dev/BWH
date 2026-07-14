import {cookies} from 'next/headers';

import {PostgresProjectRepository} from '@/features/projects/project-repository';
import {ProjectService} from '@/features/projects/project-service';
import {PostgresProviderRunRepository} from '@/features/providers/provider-run-repository';
import {ProviderRunService} from '@/features/providers/provider-run-service';
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
    return Response.json(runs.map(({id, operation, provider, status, cacheHitCount, requestCount, estimatedCostMicros, createdAt}) => ({id, operation, provider, status, cacheHitCount, requestCount, estimatedCostMicros, createdAt})));
  } catch (error) {
    const code = error instanceof Error ? error.message : 'PROVIDER_RUNS_LOAD_FAILED';
    return Response.json({error: code}, {status: code === 'PROJECT_FORBIDDEN' ? 403 : 500});
  }
}

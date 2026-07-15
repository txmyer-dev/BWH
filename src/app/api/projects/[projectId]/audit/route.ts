import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';

import {PostgresAuditRepository} from '@/features/audit/audit-repository';
import {AuditService} from '@/features/audit/audit-service';
import {safeAuditRouteError} from '@/features/audit/audit-route-errors';
import {PostgresConsentRepository} from '@/features/consent/consent-repository';
import {ConsentService} from '@/features/consent/consent-service';
import {PostgresProjectRepository} from '@/features/projects/project-repository';
import {ProjectService} from '@/features/projects/project-service';
import {getDatabase} from '@/server/db/client';
import {parseEnv} from '@/server/env';
import {createProviderServices} from '@/server/providers/factory';

type RouteContext = {params: Promise<{projectId: string}>};

export async function POST(_request: Request, context: RouteContext) {
  const {projectId} = await context.params;
  try {
    const database = getDatabase(); const env = parseEnv(process.env); const token = (await cookies()).get(`legacy_owner_${projectId}`)?.value ?? '';
    const projects = new ProjectService(new PostgresProjectRepository(database));
    await projects.assertProjectOwner(projectId, token);
    await new ConsentService(new PostgresConsentRepository(database), async () => undefined).assertProcessingConsent(projectId, 'openai', ['approved_narration_text', 'source_references']);
    const repository = new PostgresAuditRepository(database);
    const auditor = createProviderServices(env, {database, auditRepository: repository}).factualityAuditor;
    if (!auditor) throw new Error('OPENAI_AUDIT_NOT_CONFIGURED');
    return NextResponse.json(await new AuditService(repository, auditor, (id) => projects.assertProjectOwner(id, token)).requestAudit(projectId));
  } catch (error) { const safe = safeAuditRouteError(error, 'audit'); return NextResponse.json({error: safe.code}, {status: safe.status}); }
}

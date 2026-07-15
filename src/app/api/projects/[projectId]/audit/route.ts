import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';

import {PostgresAuditRepository} from '@/features/audit/audit-repository';
import {AuditService} from '@/features/audit/audit-service';
import {PostgresConsentRepository} from '@/features/consent/consent-repository';
import {ConsentService} from '@/features/consent/consent-service';
import {PostgresProjectRepository} from '@/features/projects/project-repository';
import {ProjectService} from '@/features/projects/project-service';
import {getDatabase} from '@/server/db/client';
import {parseEnv} from '@/server/env';
import {createProviderServices} from '@/server/providers/factory';

type RouteContext = {params: Promise<{projectId: string}>};
const status = (code: string) => code.includes('FORBIDDEN') ? 403 : code.includes('NOT_FOUND') ? 404 : code.includes('CONSENT') ? 412 : code.includes('BUDGET') ? 429 : 400;

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
  } catch (error) { const code = error instanceof Error ? error.message : 'AUDIT_REQUEST_FAILED'; return NextResponse.json({error: code}, {status: status(code)}); }
}

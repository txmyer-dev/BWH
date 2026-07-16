import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {z} from 'zod';

import {PostgresAuditRepository} from '@/features/audit/audit-repository';
import {AuditService} from '@/features/audit/audit-service';
import {safeAuditRouteError} from '@/features/audit/audit-route-errors';
import {factualityAuditDeployment} from '@/features/audit/audit-deployment';
import {PostgresProjectRepository} from '@/features/projects/project-repository';
import {ProjectService} from '@/features/projects/project-service';
import {getDatabase} from '@/server/db/client';
import {parseEnv} from '@/server/env';

const bodySchema = z.object({auditId: z.string().uuid(), narrationHash: z.string().length(64), evidenceHash: z.string().length(64), storyboardRevision: z.number().int().nonnegative()}).strict();
type RouteContext = {params: Promise<{projectId: string}>};

export async function POST(request: Request, context: RouteContext) {
  const {projectId} = await context.params;
  try {
    const database = getDatabase(); const env = parseEnv(process.env); const token = (await cookies()).get(`legacy_owner_${projectId}`)?.value ?? ''; const projects = new ProjectService(new PostgresProjectRepository(database));
    await projects.assertProjectOwner(projectId, token);
    const body = bodySchema.parse(await request.json());
    const repository = new PostgresAuditRepository(database);
    const unavailable = {audit: async () => { throw new Error('AUDIT_NOT_CONFIGURED'); }};
    return NextResponse.json(await new AuditService(repository, unavailable, (id) => projects.assertProjectOwner(id, token), factualityAuditDeployment(env).contract).approveNarrationText(projectId, body.auditId, body.narrationHash, body.evidenceHash, body.storyboardRevision));
  } catch (error) { const safe = safeAuditRouteError(error, 'approval'); return NextResponse.json({error: safe.code}, {status: safe.status}); }
}

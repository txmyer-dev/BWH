import {randomUUID} from 'node:crypto';
import {and, eq, inArray, lte, notInArray, or, sql, type SQL} from 'drizzle-orm';

import type {Database} from '../../server/db/client';
import {providerArtifacts} from '../../server/db/schema';

export type ProviderArtifactStatus = 'active'|'cleanup_pending'|'deletion_pending'|'cleanup_processing'|'deletion_processing'|'deleted'|'expired_confirmed';
export type ProviderArtifact = {id: string; projectId: string; providerRunId: string | null; provider: string; providerArtifactId: string; status: ProviderArtifactStatus; expiresAt: Date; cleanupAttempts: number; cleanupClaimToken: string | null; cleanupLeaseExpiresAt: Date | null; lastCleanupError: string | null; createdAt: Date; updatedAt: Date};
export type ProviderArtifactClaim = {artifact: ProviderArtifact; claimToken: string};
type NewArtifact = Pick<ProviderArtifact, 'projectId'|'provider'|'providerArtifactId'|'expiresAt'> & {providerRunId?: string};

export interface ProviderArtifactRepository {
  create(input: NewArtifact): Promise<ProviderArtifact>;
  get(id: string): Promise<ProviderArtifact | undefined>;
  claim(id: string, now: Date, leaseMs: number): Promise<ProviderArtifactClaim>;
  claimDue(now: Date, leaseMs: number): Promise<ProviderArtifactClaim[]>;
  markDeleted(claim: ProviderArtifactClaim): Promise<void>;
  markFailure(claim: ProviderArtifactClaim, error: string): Promise<void>;
  markProjectDeletionPending(projectId: string): Promise<void>;
}

const clone = (artifact: ProviderArtifact) => ({...artifact, expiresAt: new Date(artifact.expiresAt), cleanupLeaseExpiresAt: artifact.cleanupLeaseExpiresAt && new Date(artifact.cleanupLeaseExpiresAt), createdAt: new Date(artifact.createdAt), updatedAt: new Date(artifact.updatedAt)});
export class InMemoryProviderArtifactRepository implements ProviderArtifactRepository {
  private readonly artifacts = new Map<string, ProviderArtifact>();
  async create(input: NewArtifact) { const now = new Date(); const artifact: ProviderArtifact = {id: randomUUID(), ...input, providerRunId: input.providerRunId ?? null, status: 'active', cleanupAttempts: 0, cleanupClaimToken: null, cleanupLeaseExpiresAt: null, lastCleanupError: null, createdAt: now, updatedAt: now}; this.artifacts.set(artifact.id, artifact); return clone(artifact); }
  async get(id: string) { const artifact = this.artifacts.get(id); return artifact && clone(artifact); }
  async claim(id: string, now: Date, leaseMs: number) { const artifact = this.artifacts.get(id); if (!artifact || ['deleted','expired_confirmed'].includes(artifact.status) || (['cleanup_processing','deletion_processing'].includes(artifact.status) && artifact.cleanupLeaseExpiresAt && artifact.cleanupLeaseExpiresAt > now)) throw new Error('PROVIDER_ARTIFACT_NOT_CLAIMABLE'); const deletion = ['deletion_pending','deletion_processing'].includes(artifact.status); artifact.status = deletion ? 'deletion_processing' : 'cleanup_processing'; artifact.cleanupClaimToken = randomUUID(); artifact.cleanupLeaseExpiresAt = new Date(now.getTime() + leaseMs); artifact.updatedAt = now; return {artifact: clone(artifact), claimToken: artifact.cleanupClaimToken}; }
  async claimDue(now: Date, leaseMs: number) { const due = [...this.artifacts.values()].filter((artifact) => (['cleanup_pending','deletion_pending'].includes(artifact.status) || (artifact.status === 'active' && artifact.expiresAt <= now) || (['cleanup_processing','deletion_processing'].includes(artifact.status) && artifact.cleanupLeaseExpiresAt && artifact.cleanupLeaseExpiresAt <= now))); const claims: ProviderArtifactClaim[] = []; for (const artifact of due) claims.push(await this.claim(artifact.id, now, leaseMs)); return claims; }
  private claimed(claim: ProviderArtifactClaim) { const artifact = this.artifacts.get(claim.artifact.id); if (!artifact || artifact.cleanupClaimToken !== claim.claimToken || !['cleanup_processing','deletion_processing'].includes(artifact.status)) throw new Error('PROVIDER_ARTIFACT_CLAIM_FENCED'); return artifact; }
  async markDeleted(claim: ProviderArtifactClaim) { const artifact = this.claimed(claim); artifact.status = 'deleted'; artifact.cleanupAttempts += 1; artifact.cleanupClaimToken = null; artifact.cleanupLeaseExpiresAt = null; artifact.lastCleanupError = null; }
  async markFailure(claim: ProviderArtifactClaim, error: string) { const artifact = this.claimed(claim); artifact.status = artifact.status === 'deletion_processing' ? 'deletion_pending' : 'cleanup_pending'; artifact.cleanupAttempts += 1; artifact.cleanupClaimToken = null; artifact.cleanupLeaseExpiresAt = null; artifact.lastCleanupError = error; }
  async markProjectDeletionPending(projectId: string) { for (const artifact of this.artifacts.values()) if (artifact.projectId === projectId && !['deleted', 'expired_confirmed'].includes(artifact.status)) artifact.status = ['cleanup_processing','deletion_processing'].includes(artifact.status) ? 'deletion_processing' : 'deletion_pending'; }
}

export class ProviderArtifactService {
  constructor(private readonly repository: ProviderArtifactRepository, private readonly leaseMs = 60_000) {}
  async record(input: NewArtifact) { return this.repository.create(input); }
  async claim(id: string, now: Date = new Date()) { return this.repository.claim(id, now, this.leaseMs); }
  async remove(claim: ProviderArtifactClaim, deleteProviderArtifact: (providerArtifactId: string) => Promise<void>) {
    try { await deleteProviderArtifact(claim.artifact.providerArtifactId); await this.repository.markDeleted(claim); }
    catch (error) { await this.repository.markFailure(claim, error instanceof Error ? error.message : 'CLEANUP_FAILED'); throw error; }
  }
  async prepareProjectDeletion(projectId: string) { await this.repository.markProjectDeletionPending(projectId); }
  async reconcile(now: Date, remove: (artifact: ProviderArtifact) => Promise<void>) { const claims = await this.repository.claimDue(now, this.leaseMs); for (const claim of claims) await this.remove(claim, () => remove(claim.artifact)).catch(() => undefined); return claims.length; }
}

const mapArtifact = (row: typeof providerArtifacts.$inferSelect): ProviderArtifact => ({...row, status: row.status as ProviderArtifactStatus});
export const providerArtifactClaimablePredicate = (now: Date): SQL => and(
  notInArray(providerArtifacts.status, ['deleted', 'expired_confirmed']),
  or(
    notInArray(providerArtifacts.status, ['cleanup_processing', 'deletion_processing']),
    lte(providerArtifacts.cleanupLeaseExpiresAt, now)
  )
)!;

export class PostgresProviderArtifactRepository implements ProviderArtifactRepository {
  constructor(private readonly database: Database) {}
  async create(input: NewArtifact) { const [row] = await this.database.insert(providerArtifacts).values({id: randomUUID(), ...input, providerRunId: input.providerRunId ?? null}).returning(); return mapArtifact(row); }
  async get(id: string) { const [row] = await this.database.select().from(providerArtifacts).where(eq(providerArtifacts.id, id)).limit(1); return row && mapArtifact(row); }
  async claim(id: string, now: Date, leaseMs: number) { return this.database.transaction(async (transaction) => { const token = randomUUID(); const [row] = await transaction.update(providerArtifacts).set({status: sql`case when ${providerArtifacts.status} in ('deletion_pending','deletion_processing') then 'deletion_processing' else 'cleanup_processing' end`, cleanupClaimToken: token, cleanupLeaseExpiresAt: new Date(now.getTime() + leaseMs), updatedAt: now}).where(and(eq(providerArtifacts.id, id), providerArtifactClaimablePredicate(now))).returning(); if (!row) throw new Error('PROVIDER_ARTIFACT_NOT_CLAIMABLE'); return {artifact: mapArtifact(row), claimToken: token}; }); }
  async claimDue(now: Date, leaseMs: number) { return this.database.transaction(async (transaction) => { const rows = await transaction.select().from(providerArtifacts).where(or(inArray(providerArtifacts.status, ['cleanup_pending','deletion_pending']), and(eq(providerArtifacts.status, 'active'), lte(providerArtifacts.expiresAt, now)), and(inArray(providerArtifacts.status, ['cleanup_processing','deletion_processing']), lte(providerArtifacts.cleanupLeaseExpiresAt, now)))).for('update', {skipLocked: true}); const claims: ProviderArtifactClaim[] = []; for (const row of rows) { const token = randomUUID(); const status = ['deletion_pending','deletion_processing'].includes(row.status) ? 'deletion_processing' : 'cleanup_processing'; const [updated] = await transaction.update(providerArtifacts).set({status, cleanupClaimToken: token, cleanupLeaseExpiresAt: new Date(now.getTime() + leaseMs), updatedAt: now}).where(eq(providerArtifacts.id, row.id)).returning(); claims.push({artifact: mapArtifact(updated), claimToken: token}); } return claims; }); }
  async markDeleted(claim: ProviderArtifactClaim) { const [row] = await this.database.update(providerArtifacts).set({status: 'deleted', cleanupAttempts: sql`${providerArtifacts.cleanupAttempts} + 1`, cleanupClaimToken: null, cleanupLeaseExpiresAt: null, lastCleanupError: null}).where(and(eq(providerArtifacts.id, claim.artifact.id), eq(providerArtifacts.cleanupClaimToken, claim.claimToken), inArray(providerArtifacts.status, ['cleanup_processing','deletion_processing']))).returning({id: providerArtifacts.id}); if (!row) throw new Error('PROVIDER_ARTIFACT_CLAIM_FENCED'); }
  async markFailure(claim: ProviderArtifactClaim, error: string) { const [row] = await this.database.update(providerArtifacts).set({status: sql`case when ${providerArtifacts.status} = 'deletion_processing' then 'deletion_pending' else 'cleanup_pending' end`, cleanupAttempts: sql`${providerArtifacts.cleanupAttempts} + 1`, cleanupClaimToken: null, cleanupLeaseExpiresAt: null, lastCleanupError: error.slice(0, 500)}).where(and(eq(providerArtifacts.id, claim.artifact.id), eq(providerArtifacts.cleanupClaimToken, claim.claimToken), inArray(providerArtifacts.status, ['cleanup_processing','deletion_processing']))).returning({id: providerArtifacts.id}); if (!row) throw new Error('PROVIDER_ARTIFACT_CLAIM_FENCED'); }
  async markProjectDeletionPending(projectId: string) { await this.database.update(providerArtifacts).set({status: sql`case when ${providerArtifacts.status} in ('cleanup_processing','deletion_processing') then 'deletion_processing' else 'deletion_pending' end`}).where(and(eq(providerArtifacts.projectId, projectId), sql`${providerArtifacts.status} not in ('deleted','expired_confirmed')`)); }
}

export const prepareProviderArtifactsForProjectDeletion = async (repository: ProviderArtifactRepository, projectId: string) =>
  new ProviderArtifactService(repository).prepareProjectDeletion(projectId);

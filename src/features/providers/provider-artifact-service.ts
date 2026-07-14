import {randomUUID} from 'node:crypto';
import {and, eq, inArray, lte, or} from 'drizzle-orm';

import type {Database} from '../../server/db/client';
import {providerArtifacts} from '../../server/db/schema';

export type ProviderArtifactStatus = 'active'|'cleanup_pending'|'deletion_pending'|'cleanup_processing'|'deletion_processing'|'deleted'|'expired_confirmed';
export type ProviderArtifact = {id: string; projectId: string; providerRunId: string | null; provider: string; providerArtifactId: string; status: ProviderArtifactStatus; expiresAt: Date; cleanupAttempts: number; lastCleanupError: string | null; createdAt: Date; updatedAt: Date};
type NewArtifact = Pick<ProviderArtifact, 'projectId'|'provider'|'providerArtifactId'|'expiresAt'> & {providerRunId?: string};

export interface ProviderArtifactRepository {
  create(input: NewArtifact): Promise<ProviderArtifact>;
  get(id: string): Promise<ProviderArtifact | undefined>;
  update(id: string, change: Partial<ProviderArtifact>): Promise<void>;
  markProjectDeletionPending(projectId: string): Promise<void>;
  due(now: Date): Promise<ProviderArtifact[]>;
}

const clone = (artifact: ProviderArtifact) => ({...artifact, expiresAt: new Date(artifact.expiresAt), createdAt: new Date(artifact.createdAt), updatedAt: new Date(artifact.updatedAt)});
export class InMemoryProviderArtifactRepository implements ProviderArtifactRepository {
  private readonly artifacts = new Map<string, ProviderArtifact>();
  async create(input: NewArtifact) { const now = new Date(); const artifact: ProviderArtifact = {id: randomUUID(), ...input, providerRunId: input.providerRunId ?? null, status: 'active', cleanupAttempts: 0, lastCleanupError: null, createdAt: now, updatedAt: now}; this.artifacts.set(artifact.id, artifact); return clone(artifact); }
  async get(id: string) { const artifact = this.artifacts.get(id); return artifact && clone(artifact); }
  async update(id: string, change: Partial<ProviderArtifact>) { const artifact = this.artifacts.get(id); if (artifact) Object.assign(artifact, change, {updatedAt: new Date()}); }
  async markProjectDeletionPending(projectId: string) { for (const artifact of this.artifacts.values()) if (artifact.projectId === projectId && !['deleted', 'expired_confirmed'].includes(artifact.status)) artifact.status = 'deletion_pending'; }
  async due(now: Date) { const due = [...this.artifacts.values()].filter((artifact) => ['cleanup_pending', 'deletion_pending'].includes(artifact.status) || (artifact.status === 'active' && artifact.expiresAt <= now)); for (const artifact of due) { artifact.status = artifact.status === 'deletion_pending' ? 'deletion_processing' : 'cleanup_processing'; artifact.updatedAt = new Date(now); } return due.map(clone); }
}

export class ProviderArtifactService {
  constructor(private readonly repository: ProviderArtifactRepository) {}
  async record(input: NewArtifact) { return this.repository.create(input); }
  async remove(id: string, deleteProviderArtifact: (providerArtifactId: string) => Promise<void>) {
    const artifact = await this.repository.get(id); if (!artifact) throw new Error('PROVIDER_ARTIFACT_NOT_FOUND');
    try { await deleteProviderArtifact(artifact.providerArtifactId); await this.repository.update(id, {status: 'deleted', cleanupAttempts: artifact.cleanupAttempts + 1, lastCleanupError: null}); }
    catch (error) { await this.repository.update(id, {status: ['deletion_pending','deletion_processing'].includes(artifact.status) ? 'deletion_pending' : 'cleanup_pending', cleanupAttempts: artifact.cleanupAttempts + 1, lastCleanupError: error instanceof Error ? error.message : 'CLEANUP_FAILED'}); throw error; }
  }
  async markProjectDeletionPending(projectId: string) { return this.repository.markProjectDeletionPending(projectId); }
  async reconcile(now: Date, remove: (artifact: ProviderArtifact) => Promise<void>) { const due = await this.repository.due(now); for (const artifact of due) await this.remove(artifact.id, () => remove(artifact)).catch(() => undefined); return due.length; }
}

const mapArtifact = (row: typeof providerArtifacts.$inferSelect): ProviderArtifact => ({...row, status: row.status as ProviderArtifactStatus});
export class PostgresProviderArtifactRepository implements ProviderArtifactRepository {
  constructor(private readonly database: Database) {}
  async create(input: NewArtifact) { const [row] = await this.database.insert(providerArtifacts).values({id: randomUUID(), ...input, providerRunId: input.providerRunId ?? null}).returning(); return mapArtifact(row); }
  async get(id: string) { const [row] = await this.database.select().from(providerArtifacts).where(eq(providerArtifacts.id, id)).limit(1); return row && mapArtifact(row); }
  async update(id: string, change: Partial<ProviderArtifact>) { await this.database.update(providerArtifacts).set(change).where(eq(providerArtifacts.id, id)); }
  async markProjectDeletionPending(projectId: string) { await this.database.update(providerArtifacts).set({status: 'deletion_pending'}).where(and(eq(providerArtifacts.projectId, projectId), inArray(providerArtifacts.status, ['active','cleanup_pending']))); }
  async due(now: Date) { return this.database.transaction(async (transaction) => { const stale = new Date(now.getTime() - 300_000); const rows = await transaction.select().from(providerArtifacts).where(or(inArray(providerArtifacts.status, ['cleanup_pending','deletion_pending']), and(eq(providerArtifacts.status, 'active'), lte(providerArtifacts.expiresAt, now)), and(inArray(providerArtifacts.status, ['cleanup_processing','deletion_processing']), lte(providerArtifacts.updatedAt, stale)))).for('update', {skipLocked: true}); const claimed: ProviderArtifact[] = []; for (const row of rows) { const status = ['deletion_pending','deletion_processing'].includes(row.status) ? 'deletion_processing' : 'cleanup_processing'; const [updated] = await transaction.update(providerArtifacts).set({status, updatedAt: now}).where(eq(providerArtifacts.id, row.id)).returning(); claimed.push(mapArtifact(updated)); } return claimed; }); }
}

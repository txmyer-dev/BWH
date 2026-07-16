import {describe, expect, it, vi} from 'vitest';
import {PgDialect} from 'drizzle-orm/pg-core';

import {
  InMemoryProviderArtifactRepository,
  prepareProviderArtifactsForProjectDeletion,
  providerArtifactClaimablePredicate,
  ProviderArtifactService
} from './provider-artifact-service';

describe('provider artifact cleanup', () => {
  it('encodes cleanup lease dates before postgres.js receives query parameters', () => {
    const now = new Date('2026-07-16T12:34:56.789Z');
    const query = new PgDialect().sqlToQuery(providerArtifactClaimablePredicate(now));
    expect(query.params).not.toContainEqual(now);
    expect(query.params.filter((value) => typeof value === 'string'))
      .toContain(now.toISOString());
  });

  it('persists an identifier before use and marks successful deletion', async () => {
    const repository = new InMemoryProviderArtifactRepository();
    const service = new ProviderArtifactService(repository);
    const artifact = await service.record({projectId: crypto.randomUUID(), provider: 'google_gemini', providerArtifactId: 'files/123', expiresAt: new Date(Date.now() + 1000)});
    const remove = vi.fn().mockResolvedValue(undefined);
    const claim = await service.claim(artifact.id);
    await service.remove(claim, remove);
    expect(remove).toHaveBeenCalledWith('files/123');
    expect((await repository.get(artifact.id))?.status).toBe('deleted');
  });

  it('retains cleanup rows as cleanup_pending when provider deletion fails or project deletion begins', async () => {
    const repository = new InMemoryProviderArtifactRepository();
    const service = new ProviderArtifactService(repository);
    const artifact = await service.record({projectId: crypto.randomUUID(), provider: 'google_gemini', providerArtifactId: 'files/456', expiresAt: new Date(Date.now() + 1000)});
    await expect(service.remove(await service.claim(artifact.id), vi.fn().mockRejectedValue(new Error('down')))).rejects.toThrow('down');
    await service.prepareProjectDeletion(artifact.projectId);
    expect((await repository.get(artifact.id))?.status).toBe('deletion_pending');
    expect(await repository.claimDue(new Date(Date.now() + 2_000), 1_000)).toHaveLength(1);
  });

  it('preserves deletion_pending across repeated provider cleanup failures', async () => {
    const repository = new InMemoryProviderArtifactRepository();
    const service = new ProviderArtifactService(repository);
    const artifact = await service.record({projectId: crypto.randomUUID(), provider: 'google_gemini', providerArtifactId: 'files/789', expiresAt: new Date()});
    await service.prepareProjectDeletion(artifact.projectId);
    await service.remove(await service.claim(artifact.id), vi.fn().mockRejectedValue(new Error('still down'))).catch(() => undefined);
    expect((await repository.get(artifact.id))?.status).toBe('deletion_pending');
  });

  it('claims due cleanup once across concurrent reconcilers', async () => {
    const repository = new InMemoryProviderArtifactRepository();
    await repository.create({projectId: crypto.randomUUID(), provider: 'google_gemini', providerArtifactId: 'files/claimed', expiresAt: new Date(0)});
    const claims = await Promise.all([repository.claimDue(new Date(), 1_000), repository.claimDue(new Date(), 1_000)]);
    expect(claims.map((items) => items.length).sort()).toEqual([0, 1]);
  });

  it('fences a stale cleanup worker after the claim is reclaimed', async () => {
    const repository = new InMemoryProviderArtifactRepository(); const service = new ProviderArtifactService(repository, 10);
    const artifact = await service.record({projectId: crypto.randomUUID(), provider: 'google_gemini', providerArtifactId: 'files/fenced', expiresAt: new Date(0)});
    const stale = await service.claim(artifact.id, new Date(0));
    const fresh = await service.claim(artifact.id, new Date(11));
    await service.remove(fresh, vi.fn().mockResolvedValue(undefined));
    await expect(service.remove(stale, vi.fn().mockRejectedValue(new Error('late')))).rejects.toThrow('PROVIDER_ARTIFACT_CLAIM_FENCED');
    expect((await repository.get(artifact.id))?.status).toBe('deleted');
  });

  it('provides the project-deletion orchestration path consumed by project deletion', async () => {
    const repository = new InMemoryProviderArtifactRepository(); const service = new ProviderArtifactService(repository); const projectId = crypto.randomUUID();
    const artifact = await service.record({projectId, provider: 'google_gemini', providerArtifactId: 'files/delete-project', expiresAt: new Date(Date.now() + 60_000)});
    await prepareProviderArtifactsForProjectDeletion(repository, projectId); const remove = vi.fn().mockResolvedValue(undefined); await service.reconcile(new Date(), async (item) => remove(item.providerArtifactId));
    expect(remove).toHaveBeenCalledWith('files/delete-project'); expect((await repository.get(artifact.id))?.status).toBe('deleted');
  });

  it('coordinates project deletion with an in-flight cleanup claim', async () => {
    const repository = new InMemoryProviderArtifactRepository(); const service = new ProviderArtifactService(repository); const projectId = crypto.randomUUID();
    const artifact = await service.record({projectId, provider: 'google_gemini', providerArtifactId: 'files/in-flight', expiresAt: new Date(0)}); const claim = await service.claim(artifact.id);
    await service.prepareProjectDeletion(projectId); await service.remove(claim, vi.fn().mockResolvedValue(undefined));
    expect((await repository.get(artifact.id))?.status).toBe('deleted');
  });
});

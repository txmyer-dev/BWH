import {describe, expect, it, vi} from 'vitest';

import {InMemoryProviderArtifactRepository, ProviderArtifactService} from './provider-artifact-service';

describe('provider artifact cleanup', () => {
  it('persists an identifier before use and marks successful deletion', async () => {
    const repository = new InMemoryProviderArtifactRepository();
    const service = new ProviderArtifactService(repository);
    const artifact = await service.record({projectId: crypto.randomUUID(), provider: 'google_gemini', providerArtifactId: 'files/123', expiresAt: new Date(Date.now() + 1000)});
    const remove = vi.fn().mockResolvedValue(undefined);
    await service.remove(artifact.id, remove);
    expect(remove).toHaveBeenCalledWith('files/123');
    expect((await repository.get(artifact.id))?.status).toBe('deleted');
  });

  it('retains cleanup rows as cleanup_pending when provider deletion fails or project deletion begins', async () => {
    const repository = new InMemoryProviderArtifactRepository();
    const service = new ProviderArtifactService(repository);
    const artifact = await service.record({projectId: crypto.randomUUID(), provider: 'google_gemini', providerArtifactId: 'files/456', expiresAt: new Date(Date.now() + 1000)});
    await expect(service.remove(artifact.id, vi.fn().mockRejectedValue(new Error('down')))).rejects.toThrow('down');
    await service.markProjectDeletionPending(artifact.projectId);
    expect((await repository.get(artifact.id))?.status).toBe('deletion_pending');
    expect(await repository.due(new Date(Date.now() + 2_000))).toHaveLength(1);
  });

  it('preserves deletion_pending across repeated provider cleanup failures', async () => {
    const repository = new InMemoryProviderArtifactRepository();
    const service = new ProviderArtifactService(repository);
    const artifact = await service.record({projectId: crypto.randomUUID(), provider: 'google_gemini', providerArtifactId: 'files/789', expiresAt: new Date()});
    await service.markProjectDeletionPending(artifact.projectId);
    await service.remove(artifact.id, vi.fn().mockRejectedValue(new Error('still down'))).catch(() => undefined);
    expect((await repository.get(artifact.id))?.status).toBe('deletion_pending');
  });

  it('claims due cleanup once across concurrent reconcilers', async () => {
    const repository = new InMemoryProviderArtifactRepository();
    await repository.create({projectId: crypto.randomUUID(), provider: 'google_gemini', providerArtifactId: 'files/claimed', expiresAt: new Date(0)});
    const claims = await Promise.all([repository.due(new Date()), repository.due(new Date())]);
    expect(claims.map((items) => items.length).sort()).toEqual([0, 1]);
  });
});

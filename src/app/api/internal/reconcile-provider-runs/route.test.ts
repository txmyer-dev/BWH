import {describe, expect, it, vi} from 'vitest';

import {removeProviderArtifact, reconcileProviderRuns} from './route';

describe('provider reconciliation route', () => {
  it('deletes retired private media from GCS without calling a provider API', async () => {
    const gcs = {deleteMany: vi.fn().mockResolvedValue(undefined)};
    const fetchImpl = vi.fn();

    await removeProviderArtifact(
      {provider: 'google_cloud_storage', providerArtifactId: 'projects/p/scenes/s.wav'},
      {gcs, fetchImpl}
    );

    expect(gcs.deleteMany).toHaveBeenCalledWith(['projects/p/scenes/s.wav']);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('rejects unverified callers before reconciliation', async () => {
    const reconcileExpired = vi.fn(); const reconcileArtifacts = vi.fn();
    const response = await reconcileProviderRuns(new Request('https://service.example/internal'), {verifier: {verifyIdToken: vi.fn()}, auth: {audience: 'https://service.example', serviceAccountEmail: 'tasks@example.com'}, reconcileExpired, reconcileArtifacts});
    expect(response.status).toBe(401); expect(reconcileExpired).not.toHaveBeenCalled(); expect(reconcileArtifacts).not.toHaveBeenCalled();
  });

  it('reconciles ambiguous deadlines and artifact cleanup for verified Google OIDC', async () => {
    const verifier = {verifyIdToken: vi.fn().mockResolvedValue({getPayload: () => ({iss: 'https://accounts.google.com', aud: 'https://service.example', email: 'tasks@example.com', email_verified: true})})};
    const response = await reconcileProviderRuns(new Request('https://service.example/internal', {method: 'POST', headers: {authorization: 'Bearer token'}}), {verifier, auth: {audience: 'https://service.example', serviceAccountEmail: 'tasks@example.com'}, reconcileExpired: vi.fn().mockResolvedValue(2), reconcileArtifacts: vi.fn().mockResolvedValue(3)});
    expect(response.status).toBe(200); await expect(response.json()).resolves.toEqual({runs: 2, artifacts: 3});
  });

  it('does not expose internal reconciliation errors', async () => {
    const verifier = {verifyIdToken: vi.fn().mockResolvedValue({getPayload: () => ({iss: 'https://accounts.google.com', aud: 'https://service.example', email: 'tasks@example.com', email_verified: true})})};
    const response = await reconcileProviderRuns(new Request('https://service.example/internal', {method: 'POST', headers: {authorization: 'Bearer token'}}), {verifier, auth: {audience: 'https://service.example', serviceAccountEmail: 'tasks@example.com'}, reconcileExpired: vi.fn().mockRejectedValue(new Error('signed-url-secret')), reconcileArtifacts: vi.fn()});
    expect(response.status).toBe(500); await expect(response.json()).resolves.toEqual({error: 'PROVIDER_RECONCILIATION_FAILED'});
  });
});

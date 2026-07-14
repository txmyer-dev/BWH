import {describe, expect, it, vi} from 'vitest';

import {reconcileProviderRuns} from './route';

describe('provider reconciliation route', () => {
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
});
